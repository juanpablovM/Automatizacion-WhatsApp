import fs from 'node:fs';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';

const enabled = process.env.TEST_PG_INTEGRATION === '1';
const describeIntegration = enabled ? describe : describe.skip;
const connection = {
  host: process.env.TEST_PGHOST || '127.0.0.1',
  port: Number(process.env.TEST_PGPORT || 55433),
  database: process.env.TEST_PGDATABASE || 'testdb',
  user: process.env.TEST_PGUSER || 'test',
  password: process.env.TEST_PGPASSWORD || 'test',
};

// A deferral means "the dispatcher cannot deliver this yet, wait for someone to
// fix the configuration". That is a reasonable thing to say once. Said forever
// it becomes indistinguishable from a healthy queue: handoffs 15 and 16 in
// production produced 5223 deferral audit rows over three days because the
// attempt is handed back on every pass, so max_attempts never fires.
describeIntegration('a deferral cannot wait forever', () => {
  const client = new pg.Client(connection);
  const claimSql = fs.readFileSync('db/queries/n8n/handoff-routing/02_claim_notification.sql', 'utf8');
  const completeSql = fs.readFileSync('db/queries/n8n/handoff-routing/03_complete_notification.sql', 'utf8');

  let sourceNumberId;
  let conversationId;
  let sequence = 0;

  const createdIds = [];

  // Other integration files share this database and vitest runs them in
  // parallel, so a claim batch is never guaranteed to be ours alone. Pick our
  // own handoff out of the batch instead of assuming it is the only row.
  const claimOwn = async (handoffId) => {
    const { rows } = await client.query(claimSql, ['200', '900']);
    const mine = rows.find((row) => String(row.handoff_id) === String(handoffId));
    expect(mine, `handoff ${handoffId} was not claimed`).toBeDefined();
    return mine;
  };

  const claimedIds = async () => {
    const { rows } = await client.query(claimSql, ['200', '900']);
    return rows.map((row) => String(row.handoff_id));
  };

  const complete = async (operationId, claimToken, outcome, error = null) => {
    const { rows } = await client.query(completeSql, [
      String(operationId), claimToken, outcome, '', '', '', error, '', 'false',
    ]);
    return rows[0];
  };

  // ageHours backdates the handoff so the deferral window can be exercised
  // without waiting for real time to pass.
  const insertHandoff = async ({ area = 'b2b', ageHours = 0 }) => {
    sequence += 1;
    const { rows } = await client.query(`
      INSERT INTO handoffs (
        idempotency_key, conversation_id, phone_number, source_number_id,
        motivo, area, area_label, prioridad, responsable,
        estado, notification_attempt_count, max_attempts,
        next_notification_at, created_at
      ) VALUES ($1, $2, '15550009999', $3, $4, $4, upper($4), 'alta', 'Área de prueba',
                'pending', 0, 3, NOW() - INTERVAL '1 minute', NOW() - ($5 || ' hours')::interval)
      RETURNING id
    `, [`deferral-cap-${sequence}`, conversationId, sourceNumberId, area, String(ageHours)]);
    createdIds.push(rows[0].id);
    return rows[0].id;
  };

  const readOperation = async (handoffId) => {
    const { rows } = await client.query(`
      SELECT status, retry_safe, attempt_count, last_error
      FROM external_operations WHERE entity_type = 'handoff' AND entity_id = $1
    `, [handoffId]);
    return rows[0];
  };

  const auditResults = async (handoffId) => {
    const { rows } = await client.query(`
      SELECT result FROM audit_logs
      WHERE entity_type = 'handoff' AND entity_id = $1
        AND event_name = 'handoff_clickup_notification'
      ORDER BY id
    `, [handoffId]);
    return rows.map((row) => row.result);
  };

  beforeAll(async () => {
    await client.connect();

    const number = await client.query(`
      INSERT INTO whatsapp_numbers (display_name, phone_number, phone_number_id, is_active)
      VALUES ('deferral-cap-test', '15550000013', 'pn-deferral-cap-test', TRUE)
      RETURNING id
    `);
    sourceNumberId = number.rows[0].id;

    const conversation = await client.query(`
      INSERT INTO conversations (
        source_number_id, phone_number, conversation_status_id, started_at, last_message_at
      ) VALUES ($1, '15550009999',
        (SELECT id FROM conversation_statuses WHERE code = 'escalation_required'), NOW(), NOW())
      RETURNING id
    `, [sourceNumberId]);
    conversationId = conversation.rows[0].id;
  });

  beforeEach(async () => {
    // Retire only the handoffs this file created. A blanket update would soft
    // delete rows belonging to the other integration files running in parallel
    // against this same database.
    if (createdIds.length) {
      await client.query(
        'UPDATE handoffs SET deleted_at = NOW() WHERE id = ANY($1::bigint[]) AND deleted_at IS NULL',
        [createdIds],
      );
    }
  });

  afterAll(async () => {
    await client.end();
  });

  test('a fresh deferral still waits: the attempt is handed back and it is rescheduled', async () => {
    const handoffId = await insertHandoff({ ageHours: 0 });

    const claimed = await claimOwn(handoffId);
    const result = await complete(
      claimed.operation_id, claimed.claim_token, 'deferred',
      'HANDOFF_CLICKUP_AREA_unsupported:b2b',
    );

    expect(result.result).toBe('deferred_config');
    const operation = await readOperation(handoffId);
    expect(operation.status).toBe('pending');
    expect(operation.attempt_count).toBe(0);
    expect(await auditResults(handoffId)).toEqual(['deferred_config']);
  });

  test('a deferral older than the window becomes terminal instead of rescheduling', async () => {
    const handoffId = await insertHandoff({ ageHours: 48 });

    const claimed = await claimOwn(handoffId);
    const result = await complete(
      claimed.operation_id, claimed.claim_token, 'deferred',
      'HANDOFF_CLICKUP_AREA_unsupported:b2b',
    );

    expect(result.result).toBe('deferred_config_exhausted');
    const operation = await readOperation(handoffId);
    expect(operation.status).toBe('failed');
    expect(operation.retry_safe).toBe(false);
    expect(operation.last_error).toMatch(/deferred/i);
    expect(await auditResults(handoffId)).toEqual(['deferred_config_exhausted']);
  });

  test('an exhausted deferral is never claimed again: that is what ends the loop', async () => {
    const handoffId = await insertHandoff({ ageHours: 48 });

    const claimed = await claimOwn(handoffId);
    await complete(claimed.operation_id, claimed.claim_token, 'deferred', 'HANDOFF_CLICKUP_AREA_unsupported:b2b');

    await client.query(
      'UPDATE handoffs SET next_notification_at = NOW() - INTERVAL \'1 minute\' WHERE id = $1',
      [handoffId],
    );
    expect(await claimedIds()).not.toContain(String(handoffId));
  });

  test('a successful dispatch is unaffected by the window', async () => {
    const handoffId = await insertHandoff({ area: 'sales', ageHours: 72 });

    const claimed = await claimOwn(handoffId);
    const result = await complete(claimed.operation_id, claimed.claim_token, 'succeeded');

    expect(result.result).toBe('succeeded');
    expect(result.handoff_estado).toBe('notified');
  });
});
