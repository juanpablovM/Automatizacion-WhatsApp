// =============================================================================
// Inbound debounce (migration 034): a contact's pending inbound messages become
// ONE turn once the queue has been quiet for the window. The webhook claim only
// queues customer events; the recovery claim admits a queue once its newest
// pending event is older than the window (or its oldest is older than the max
// wait), claims the oldest event as the turn's leader and attaches the
// consecutive text events behind it as followers. The turn's text is the batch
// joined with "\n"; every original message keeps its own `messages` row; the
// followers finish with their leader.
// =============================================================================
import fs from 'node:fs';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';

const enabled = process.env.TEST_PG_INTEGRATION === '1';
const describeIntegration = enabled ? describe : describe.skip;
const connection = {
  host: process.env.TEST_PGHOST || '127.0.0.1',
  port: Number(process.env.TEST_PGPORT || 55433),
  database: process.env.TEST_PGDATABASE || 'testdb',
  user: process.env.TEST_PGUSER || 'test',
  password: process.env.TEST_PGPASSWORD || 'test',
};

const read = (file) => fs.readFileSync(file, 'utf8');
const claimSql = read('db/queries/n8n/inbound-events/01_claim_inbound_event.sql');
const recoverSql = read('db/queries/n8n/inbound-events/02_recover_and_claim_inbound_events.sql');
const routeSql = read('db/queries/n8n/wa-conversation-orchestrator/07_route_v3_turn.sql');
const persistSql = read('db/queries/n8n/wa-conversation-orchestrator/07_persist_conversation_state.sql');
const rollbackSql = read('infra/postgres/rollback/034_inbound_debounce_batches.down.sql');
const migrationSql = read('infra/postgres/migrations/034_inbound_debounce_batches.sql');
const markProcessedSql = JSON.parse(read('n8n/workflows/wa-inbound-downstream-dispatcher.json'))
  .nodes.find((node) => node.name === 'Mark Inbox Processed').parameters.query;

const INSTANCE = 'debounce-test';

describeIntegration('inbound debounce batching', () => {
  const client = new pg.Client(connection);
  let sourceNumberId;
  let sequence = 0;

  const cleanup = async () => {
    const source = "SELECT id FROM whatsapp_numbers WHERE instance_name = 'debounce-test'";
    await client.query(`
      BEGIN;
      DELETE FROM audit_logs WHERE entity_type = 'conversation'
        AND entity_id IN (SELECT id FROM conversations WHERE source_number_id IN (${source}));
      DELETE FROM messages WHERE conversation_id IN (
        SELECT id FROM conversations WHERE source_number_id IN (${source}));
      DELETE FROM conversation_turn_executions WHERE conversation_id IN (
        SELECT id FROM conversations WHERE source_number_id IN (${source}));
      DELETE FROM conversations WHERE source_number_id IN (${source});
      DELETE FROM inbound_events WHERE instance_name = 'debounce-test';
      DELETE FROM whatsapp_numbers WHERE instance_name = 'debounce-test';
      COMMIT;
    `);
  };

  const newPhone = () => {
    sequence += 1;
    return `5699${String(process.pid).slice(-3)}${String(sequence).padStart(4, '0')}`;
  };

  // The 22 parameters of the Persist Durable Inbox node, in order.
  const claim = async ({
    phone, text = null, type = 'text', fromMe = false, debounce = '6', attachment = null, id,
  }) => {
    sequence += 1;
    const externalId = id || `debounce-${sequence}`;
    const { rows } = await client.query(claimSql, [
      INSTANCE, externalId, phone, 'messages.upsert', 'MESSAGES_UPSERT', 'true',
      JSON.stringify({ data: { key: { id: externalId } } }), 'Customer', `${phone}@s.whatsapp.net`,
      '1789000000', type, text, attachment, null, null, null, null, null, null,
      String(fromMe), fromMe ? 'own_message' : 'customer', debounce,
    ]);
    return { ...rows[0], external_message_id: externalId };
  };

  const recover = async ({ scope, debounce = 6, maxWait = 30, stale = 600, attempts = 5 }) => (
    await client.query(recoverSql, [stale, 20, attempts, debounce, maxWait, scope == null ? '' : String(scope)])
  ).rows;

  // Ages every pending event of a contact, as if `seconds` had passed.
  const age = (phone, seconds) => client.query(`
    UPDATE inbound_events
    SET received_at = received_at - make_interval(secs => $2::double precision),
        created_at = created_at - make_interval(secs => $2::double precision)
    WHERE instance_name = $3 AND phone_number = $1
  `, [phone, seconds, INSTANCE]);

  const events = async (phone) => (await client.query(`
    SELECT id, processing_status, batch_leader_event_id, attempt_count
    FROM inbound_events WHERE instance_name = $2 AND phone_number = $1 ORDER BY id
  `, [phone, INSTANCE])).rows;

  const markProcessed = (event) => client.query(`
    WITH durable AS (
      UPDATE inbound_events SET downstream_payload = '{"done":true}'::jsonb WHERE id = $1 RETURNING id
    ) SELECT id FROM durable
  `, [event.inbound_event_id]).then(() => client.query(markProcessedSql, [
    String(event.inbound_event_id), event.processing_token,
  ]));

  beforeAll(async () => {
    await client.connect();
    await cleanup();
    sourceNumberId = (await client.query(`
      INSERT INTO whatsapp_numbers (display_name, phone_number, phone_number_id, instance_name, is_active)
      VALUES ('debounce tests', '15550003434', 'pn-debounce', $1, TRUE)
      RETURNING id
    `, [INSTANCE])).rows[0].id;
  });

  afterAll(async () => {
    await cleanup();
    await client.end();
  });

  test('the webhook claim only queues customer events and asks for a drain', async () => {
    const phone = newPhone();
    const first = await claim({ phone, text: 'Hola' });
    const second = await claim({ phone, text: 'Necesito 50 adoquines' });

    for (const row of [first, second]) {
      expect(row).toMatchObject({ should_process: false, duplicate_event: false, debounce_pending: true, debounce_seconds: 6 });
      expect(row.processing_token).toBeNull();
    }
    expect((await events(phone)).map((event) => event.processing_status)).toEqual(['received', 'received']);
  });

  test('a duplicate delivery never schedules another drain', async () => {
    const phone = newPhone();
    const first = await claim({ phone, text: 'Hola', id: `dup-${phone}` });
    const again = await claim({ phone, text: 'Hola', id: `dup-${phone}` });
    expect(again).toMatchObject({ duplicate_event: true, should_process: false, debounce_pending: false });
    expect(again.inbound_event_id).toBe(first.inbound_event_id);
  });

  test('the live burst becomes one turn with the texts joined in arrival order', async () => {
    const phone = newPhone();
    const hola = await claim({ phone, text: 'Hola' });
    const adoquines = await claim({ phone, text: 'Necesito 50 adoquines' });
    const despacho = await claim({ phone, text: 'Con despacho a Maipú' });

    expect(await recover({ scope: despacho.inbound_event_id })).toEqual([]);
    await age(phone, 7);
    const claimed = await recover({ scope: despacho.inbound_event_id });

    expect(claimed).toHaveLength(1);
    expect(claimed[0].inbound_event_id).toBe(hola.inbound_event_id);
    expect(claimed[0].inbound_batch_event_ids.map(String)).toEqual(
      [hola, adoquines, despacho].map((event) => String(event.inbound_event_id)),
    );
    expect(claimed[0].normalized_payload.text_body).toBe('Hola\nNecesito 50 adoquines\nCon despacho a Maipú');
    expect(claimed[0].normalized_payload.external_message_id).toBe(hola.external_message_id);

    expect(await events(phone)).toEqual([
      { id: hola.inbound_event_id, processing_status: 'processing', batch_leader_event_id: hola.inbound_event_id, attempt_count: 1 },
      { id: adoquines.inbound_event_id, processing_status: 'received', batch_leader_event_id: hola.inbound_event_id, attempt_count: 0 },
      { id: despacho.inbound_event_id, processing_status: 'received', batch_leader_event_id: hola.inbound_event_id, attempt_count: 0 },
    ]);
  });

  test('the window slides with every new message and the max wait bounds it', async () => {
    const phone = newPhone();
    const first = await claim({ phone, text: 'Hola' });
    await age(phone, 5);
    await claim({ phone, text: 'Quiero cotizar' });
    await age(phone, 4);
    // 9 s since the first message but only 4 s since the newest one.
    expect(await recover({ scope: first.inbound_event_id })).toEqual([]);

    await age(phone, 25);
    const latest = await claim({ phone, text: 'Pastelones' });
    // The newest is brand new, but the oldest has waited past the max wait.
    const claimed = await recover({ scope: latest.inbound_event_id });
    expect(claimed).toHaveLength(1);
    expect(claimed[0].normalized_payload.text_body).toBe('Hola\nQuiero cotizar\nPastelones');
  });

  test('a scoped drain never claims another contact queue', async () => {
    const mine = newPhone();
    const other = newPhone();
    const mineEvent = await claim({ phone: mine, text: 'Hola' });
    const otherEvent = await claim({ phone: other, text: 'Hola' });
    await age(mine, 7);
    await age(other, 7);

    const claimed = await recover({ scope: mineEvent.inbound_event_id });
    expect(claimed.map((row) => row.inbound_event_id)).toEqual([mineEvent.inbound_event_id]);
    expect((await events(other))[0].processing_status).toBe('received');
    expect((await recover({ scope: otherEvent.inbound_event_id })).map((row) => row.inbound_event_id))
      .toEqual([otherEvent.inbound_event_id]);
  });

  test('a lone message is a turn of its own with its text untouched', async () => {
    const phone = newPhone();
    const only = await claim({ phone, text: 'Necesito 50 adoquines' });
    await age(phone, 7);
    const [claimed] = await recover({ scope: only.inbound_event_id });

    expect(claimed.inbound_batch_event_ids.map(String)).toEqual([String(only.inbound_event_id)]);
    expect(claimed.normalized_payload.text_body).toBe('Necesito 50 adoquines');
    expect((await events(phone))[0].batch_leader_event_id).toBeNull();
  });

  test('a message arriving during a turn waits and becomes the next turn', async () => {
    const phone = newPhone();
    const hola = await claim({ phone, text: 'Hola' });
    const adoquines = await claim({ phone, text: 'Necesito 50 adoquines' });
    await age(phone, 7);
    const [leader] = await recover({ scope: hola.inbound_event_id });

    const late = await claim({ phone, text: 'Con despacho a Maipú' });
    expect(late).toMatchObject({ should_process: false, debounce_pending: true });
    await age(phone, 7);
    // One turn per contact at a time: the queue is busy with the batch.
    expect(await recover({ scope: late.inbound_event_id })).toEqual([]);

    const completed = await markProcessed(leader);
    expect(completed.rows).toHaveLength(1);
    expect(await events(phone)).toEqual([
      { id: hola.inbound_event_id, processing_status: 'processed', batch_leader_event_id: hola.inbound_event_id, attempt_count: 1 },
      { id: adoquines.inbound_event_id, processing_status: 'processed', batch_leader_event_id: hola.inbound_event_id, attempt_count: 0 },
      { id: late.inbound_event_id, processing_status: 'received', batch_leader_event_id: null, attempt_count: 0 },
    ]);

    const [next] = await recover({ scope: late.inbound_event_id });
    expect(next.inbound_event_id).toBe(late.inbound_event_id);
    expect(next.normalized_payload.text_body).toBe('Con despacho a Maipú');
  });

  test('media and own messages break a batch and keep their FIFO turn', async () => {
    const phone = newPhone();
    const hola = await claim({ phone, text: 'Hola' });
    const photo = await claim({ phone, type: 'image', text: 'esta', attachment: 'image' });
    const after = await claim({ phone, text: 'cuánto sale?' });
    await age(phone, 7);

    const [first] = await recover({ scope: hola.inbound_event_id });
    expect(first.inbound_batch_event_ids.map(String)).toEqual([String(hola.inbound_event_id)]);
    expect(first.normalized_payload.text_body).toBe('Hola');
    await markProcessed(first);

    const [second] = await recover({ scope: photo.inbound_event_id });
    expect(second.inbound_event_id).toBe(photo.inbound_event_id);
    expect(second.inbound_batch_event_ids.map(String)).toEqual([String(photo.inbound_event_id)]);
    await markProcessed(second);

    const [third] = await recover({ scope: after.inbound_event_id });
    expect(third.inbound_event_id).toBe(after.inbound_event_id);

    const ownPhone = newPhone();
    const customer = await claim({ phone: ownPhone, text: 'Hola' });
    await claim({ phone: ownPhone, text: 'Te escribo enseguida', fromMe: true });
    await claim({ phone: ownPhone, text: 'Gracias' });
    await age(ownPhone, 7);
    const [own] = await recover({ scope: customer.inbound_event_id });
    expect(own.normalized_payload.text_body).toBe('Hola');
  });

  test('an own message on an idle queue is still processed inline', async () => {
    const phone = newPhone();
    const own = await claim({ phone, text: 'Hola, te ayudo', fromMe: true });
    expect(own).toMatchObject({ should_process: true, debounce_pending: false });
    expect(own.processing_token).toBeTruthy();
  });

  test('a window of 0 keeps the inline claim and one turn per message', async () => {
    const phone = newPhone();
    const first = await claim({ phone, text: 'Hola', debounce: '0' });
    const second = await claim({ phone, text: 'Necesito 50 adoquines', debounce: '0' });
    expect(first).toMatchObject({ should_process: true, debounce_pending: false, debounce_seconds: 0 });
    expect(second).toMatchObject({ should_process: false, debounce_pending: false });

    await markProcessed(first);
    const [next] = await recover({ scope: second.inbound_event_id, debounce: 0, maxWait: 0 });
    expect(next.inbound_event_id).toBe(second.inbound_event_id);
    expect(next.normalized_payload.text_body).toBe('Necesito 50 adoquines');
    expect((await events(phone)).every((event) => event.batch_leader_event_id === null)).toBe(true);
  });

  test('the legacy 3-argument recovery call still claims FIFO events', async () => {
    const phone = newPhone();
    const first = await claim({ phone, text: 'Hola', debounce: '0' });
    await claim({ phone, text: 'Necesito', debounce: '0' });
    await markProcessed(first);
    // The workflows still deployed while the migration is applied call the
    // 3-argument form. It claims every queue, so it runs in a rolled-back
    // transaction to leave the queues of parallel test files untouched.
    await client.query('BEGIN');
    try {
      const result = await client.query('SELECT * FROM recover_and_claim_inbound_events(600, 100, 5)');
      expect(result.fields.map((field) => field.name)).toEqual(
        ['inbound_event_id', 'processing_token', 'source_number_id', 'normalized_payload', 'downstream_payload'],
      );
      expect((await events(phone))[1].processing_status).toBe('processing');
    } finally {
      await client.query('ROLLBACK');
    }
  });

  test('a stale batch is retried with the same members and never absorbs new messages', async () => {
    const phone = newPhone();
    const hola = await claim({ phone, text: 'Hola' });
    const adoquines = await claim({ phone, text: 'Necesito 50 adoquines' });
    await age(phone, 7);
    const [leader] = await recover({ scope: hola.inbound_event_id });
    const late = await claim({ phone, text: 'Con despacho a Maipú' });
    await client.query(`
      UPDATE inbound_events SET processing_started_at = NOW() - INTERVAL '20 minutes'
      WHERE id = $1
    `, [leader.inbound_event_id]);
    await age(phone, 7);

    const [retried] = await recover({ scope: late.inbound_event_id, stale: 60 });
    expect(retried.inbound_event_id).toBe(hola.inbound_event_id);
    expect(retried.processing_token).not.toBe(leader.processing_token);
    expect(retried.normalized_payload.text_body).toBe('Hola\nNecesito 50 adoquines');
    expect(retried.inbound_batch_event_ids.map(String)).toEqual(
      [hola, adoquines].map((event) => String(event.inbound_event_id)),
    );

    // Out of attempts: the whole batch fails together, the late message survives.
    await client.query(`
      UPDATE inbound_events SET processing_started_at = NOW() - INTERVAL '20 minutes'
      WHERE id = $1
    `, [leader.inbound_event_id]);
    await recover({ scope: late.inbound_event_id, stale: 60, attempts: 2 });
    const final = await events(phone);
    expect(final.map((event) => event.processing_status)).toEqual(['failed', 'failed', 'processing']);
    expect(final[2].id).toBe(late.inbound_event_id);
  });

  test('the v3 route stores every message of the batch as its own row', async () => {
    const phone = newPhone();
    const hola = await claim({ phone, text: 'Hola' });
    const adoquines = await claim({ phone, text: 'Necesito 50 adoquines' });
    const despacho = await claim({ phone, text: 'Con despacho a Maipú' });
    await age(phone, 7);
    const [leader] = await recover({ scope: hola.inbound_event_id });

    const route = () => client.query(routeSql, [
      leader.inbound_event_id, leader.processing_token, null, sourceNumberId, phone,
      'enforce', 'debounce-rule', 'service', 'text', hola.external_message_id, '1789000000',
      leader.normalized_payload.text_body, JSON.stringify({ data: { key: { id: hola.external_message_id } } }),
    ]);
    const routed = await route();
    expect(routed.rows[0]).toMatchObject({ claim_valid: true, route_matches: true, state: 'routed' });
    await route();

    const stored = await client.query(`
      SELECT inbound_event_id, external_message_id, text_body, conversation_id
      FROM messages WHERE inbound_event_id = ANY($1::bigint[]) AND direction = 'incoming'
      ORDER BY id
    `, [[hola, adoquines, despacho].map((event) => event.inbound_event_id)]);
    expect(stored.rows.map((row) => [row.inbound_event_id, row.external_message_id, row.text_body])).toEqual([
      [hola.inbound_event_id, hola.external_message_id, 'Hola'],
      [adoquines.inbound_event_id, adoquines.external_message_id, 'Necesito 50 adoquines'],
      [despacho.inbound_event_id, despacho.external_message_id, 'Con despacho a Maipú'],
    ]);
    expect(new Set(stored.rows.map((row) => row.conversation_id))).toEqual(new Set([routed.rows[0].conversation_id]));
    expect(String(routed.rows[0].incoming_message_id)).toBe(String((await client.query(
      "SELECT id FROM messages WHERE inbound_event_id = $1 AND direction = 'incoming'", [hola.inbound_event_id],
    )).rows[0].id));
  });

  test('the control path stores every message of the batch as its own row', async () => {
    const phone = newPhone();
    const hola = await claim({ phone, text: 'Hola' });
    const asesor = await claim({ phone, text: 'asesor' });
    await age(phone, 7);
    const [leader] = await recover({ scope: hola.inbound_event_id });

    const values = [
      null, phone, sourceNumberId, 'escalation', null,
      hola.external_message_id, '1789000000', 'text', leader.normalized_payload.text_body, '{}',
      null, null, null, null, null, null, null,
      'escalation_required', 'conversation_state_evaluated', 'escalation_routing',
      '{}', '{}', '{}', false, false, true,
      null, null, null, null, null, null, null, null, null, null,
      0, '[]', '{}', '{}', null, 'human_requested', false, '[]',
      null, null, null, '{}', null, null, null, '[]', '{}', null,
      leader.inbound_event_id, leader.processing_token, JSON.stringify({ response_text: 'Claro.' }), null,
    ];
    expect(values).toHaveLength(58);
    const { rows } = await client.query(persistSql, values);
    expect(rows).toHaveLength(1);

    const stored = await client.query(`
      SELECT id, inbound_event_id, external_message_id, text_body, sender_type
      FROM messages WHERE inbound_event_id = ANY($1::bigint[]) AND direction = 'incoming'
      ORDER BY id
    `, [[hola.inbound_event_id, asesor.inbound_event_id]]);
    expect(stored.rows.map((row) => [row.inbound_event_id, row.external_message_id, row.text_body, row.sender_type])).toEqual([
      [hola.inbound_event_id, hola.external_message_id, 'Hola', 'customer'],
      [asesor.inbound_event_id, asesor.external_message_id, 'asesor', 'customer'],
    ]);
    expect(String(rows[0].message_id)).toBe(String(stored.rows[0].id));
  });

  test('the rollback refuses an in-flight batch, then restores the 007 contract', async () => {
    const phone = newPhone();
    const hola = await claim({ phone, text: 'Hola' });
    await claim({ phone, text: 'Necesito 50 adoquines' });
    await age(phone, 7);
    await recover({ scope: hola.inbound_event_id });

    await client.query('BEGIN');
    try {
      await expect(client.query(rollbackSql)).rejects.toThrow(/in-flight inbound batch/);
    } finally {
      await client.query('ROLLBACK');
    }

    await cleanup();
    sourceNumberId = (await client.query(`
      INSERT INTO whatsapp_numbers (display_name, phone_number, phone_number_id, instance_name, is_active)
      VALUES ('debounce tests', '15550003434', 'pn-debounce', $1, TRUE)
      RETURNING id
    `, [INSTANCE])).rows[0].id;

    await client.query('BEGIN');
    try {
      await client.query(rollbackSql);
      const signatures = await client.query(`
        SELECT proname, pg_get_function_identity_arguments(oid) AS args, pg_get_function_result(oid) AS result
        FROM pg_proc WHERE proname IN ('claim_inbound_event', 'recover_and_claim_inbound_events')
        ORDER BY proname, args
      `);
      expect(signatures.rows.map((row) => [row.proname, row.args])).toEqual([
        ['claim_inbound_event', 'p_payload jsonb'],
        ['recover_and_claim_inbound_events', 'p_stale_seconds integer, p_batch_size integer, p_max_attempts integer'],
      ]);
      expect(signatures.rows[0].result).not.toContain('debounce_pending');
      const column = await client.query(`
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = current_schema()
          AND table_name = 'inbound_events' AND column_name = 'batch_leader_event_id'
      `);
      expect(column.rows).toHaveLength(0);
      // Re-applying the forward migration after the rollback is clean.
      await client.query(migrationSql);
    } finally {
      await client.query('ROLLBACK');
    }
  });
});
