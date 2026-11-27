// =============================================================================
// CRM dispatcher, contact.state stage under revision 1.3 (U5: S4, S2, S10):
// select 13, the Build Contact State Events node as n8n composes it, insert 14
// and migration 057. Each state from real rows and their priority, progress
// from the stored context, stage normalization, state_version growing only on
// change, a seller lease expiring by time, handed_off only with a delivered
// handoff.created under the current id prefix, the contact.upserted ordering
// rule, the allowlist and CRM_EVENTS_SINCE, and 1.2 as a no-op.
// Feature document: odd/tasks/crm-1-3-customer-threads.md. Every test runs in
// a transaction that is rolled back, with rows dated 2100 so no suite mixes in.
// =============================================================================
import fs from 'node:fs';
import { createRequire } from 'node:module';
import pg from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'vitest';

const require = createRequire(import.meta.url);
const { validateCrmEvent } = require('../support/crm-events-validator.js');
const { buildContactUpsertedEvent, classifyCrmResponse } = require('../fixtures/workflow-nodes/crm-events-dispatcher/crm-events-runtime.js');

const enabled = process.env.TEST_PG_INTEGRATION === '1';
const describeIntegration = enabled ? describe : describe.skip;
const connection = {
  host: process.env.TEST_PGHOST || '127.0.0.1',
  port: Number(process.env.TEST_PGPORT || 55433),
  database: process.env.TEST_PGDATABASE || 'testdb',
  user: process.env.TEST_PGUSER || 'test',
  password: process.env.TEST_PGPASSWORD || 'test',
};

const sqlDir = 'db/queries/n8n/crm-events-dispatcher';
const sql = (file) => fs.readFileSync(`${sqlDir}/${file}`, 'utf8');
const selectContactsSql = sql('11_select_contact_candidates.sql');
const insertContactsSql = sql('12_insert_contact_events.sql');
const selectStatesSql = sql('13_select_contact_state_candidates.sql');
const insertStatesSql = sql('14_insert_contact_state_events.sql');
const claimSql = sql('03_claim_crm_events.sql');
const completeSql = sql('04_complete_crm_event.sql');

// Build Contact State Events exactly as the workflow composes it.
const fixture = (rel) => fs.readFileSync(`tests/fixtures/workflow-nodes/${rel}`, 'utf8');
const nodeSource = [
  'crm-events-dispatcher/crm-events-runtime.js',
  'shared/v3-line-items.js',
  'shared/v3-policy-builder.js',
  'crm-events-dispatcher/contact-state-runtime.js',
  'crm-events-dispatcher/build-contact-state-events.js',
].map(fixture).join('\n\n');
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const buildNode = (items, env) => new AsyncFunction('items', '$env', nodeSource)(items, env);

const SINCE = '2100-01-01T00:00:00.000Z';
const envFor = (revision = '1.3', prefix = 'test') => ({
  CRM_EVENTS_ENABLED: 'true',
  CRM_EVENTS_URL: 'https://crm.example.test/api/integrations/whatsapp/events',
  CRM_EVENTS_HMAC_SECRET: 'test-crm-secret',
  CRM_EVENTS_SINCE: SINCE,
  CRM_EVENTS_PROTOCOL_REVISION: revision,
  CRM_EVENTS_ID_PREFIX: prefix,
  AI_PRD_V3_LINE_ITEMS: 'enabled',
});

describeIntegration('CRM dispatcher, contact.state (1.3)', () => {
  const client = new pg.Client(connection);
  const statusIds = {};
  let sourceNumberId;
  let sequence = 0;

  beforeAll(async () => { await client.connect(); });
  afterAll(async () => { await client.end(); });

  beforeEach(async () => {
    await client.query('BEGIN');
    const { rows } = await client.query('SELECT id, code FROM conversation_statuses');
    for (const { id, code } of rows) statusIds[code] = id;
    ({ rows: [{ id: sourceNumberId }] } = await client.query(
      `INSERT INTO whatsapp_numbers (display_name, phone_number, phone_number_id)
       VALUES ('Ventas', '56223456789', 'crm-state-' || gen_random_uuid()) RETURNING id`,
    ));
  });
  afterEach(async () => { await client.query('ROLLBACK'); });

  const nextPhone = () => {
    sequence += 1;
    return `5694${String(1000000 + sequence).slice(-7)}`;
  };

  const insertConversation = async ({
    phone = nextPhone(), status = 'active', pending = null, context = {}, startedAt = '2100-01-02T00:00:00Z',
  } = {}) => {
    const { rows: [conversation] } = await client.query(
      `INSERT INTO conversations (phone_number, conversation_status_id, source_number_id, pending_question_key,
                                  qualification_context, started_at, created_at)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6, $6) RETURNING id`,
      [phone, statusIds[status], sourceNumberId, pending, JSON.stringify(context), startedAt],
    );
    const { rows: [{ id: contactId }] } = await client.query('SELECT crm_contact_ref($1, $2) AS id', [sourceNumberId, phone]);
    return { conversationId: String(conversation.id), contactId: String(contactId), phone };
  };

  const setConversation = (conversationId, { status, pending, context }) => client.query(
    `UPDATE conversations
     SET conversation_status_id = COALESCE($2, conversation_status_id),
         pending_question_key = CASE WHEN $3::boolean THEN $4 ELSE pending_question_key END,
         qualification_context = COALESCE($5::jsonb, qualification_context)
     WHERE id = $1`,
    [conversationId, status ? statusIds[status] : null, pending !== undefined, pending ?? null, context ? JSON.stringify(context) : null],
  );

  const insertHandoff = async (conversationId, phone, estado = 'pending') => (await client.query(
    `INSERT INTO handoffs (idempotency_key, conversation_id, phone_number, source_number_id, motivo, area, area_label,
                           prioridad, responsable, estado, created_at)
     VALUES ('crm-state-' || gen_random_uuid(), $1, $2, $3, 'talk_human', 'sales', 'Ventas', 'alta', 'Ejecutiva comercial', $4, '2100-01-03T00:00:00Z')
     RETURNING id`, [conversationId, phone, sourceNumberId, estado],
  )).rows[0].id;

  // A handoff.created row as the handoff stage leaves it (status as given).
  const recordHandoffCreated = (handoffId, conversationId, contactId, { prefix = 'test', status = 'delivered' } = {}) => client.query(
    `INSERT INTO crm_events (event_id, event_type, conversation_id, handoff_id, contact_id, revision, body, status)
     VALUES ($1, 'handoff.created', $2, $3, $4, 1, '{}', $5)`,
    [`wa-${prefix}-handoff-${handoffId}-r1`, `wa-${prefix}-conversation-${conversationId}`, handoffId, contactId, status],
  );

  const insertSellerLease = (conversationId, due = "NOW() + INTERVAL '2 hours'") => client.query(
    `INSERT INTO lead_chat_ownerships (conversation_id, response_due_at, acquired_via)
     VALUES ($1::bigint, ${due}, 'crm') RETURNING id`, [conversationId],
  );

  // Stage F (contact.upserted), as the workflow chains it.
  const runContacts = async ({ prefix = 'test', allowlist = '', since = SINCE } = {}) => {
    const cfg = { protocol_revision: '1.3', id_prefix: prefix };
    const { rows } = await client.query(selectContactsSql, ['1.3', since, prefix, allowlist, '500']);
    const events = rows.map((row) => {
      const built = buildContactUpsertedEvent(row, cfg);
      return { contact_id: Number(row.contact_id), revision: built.revision, event_id: built.event_id, body: built.body, blocked_reason: built.blocked_reason };
    });
    await client.query(insertContactsSql, [JSON.stringify(events)]);
  };

  // The contact.state stage: select 13, the real node, insert 14.
  const runStates = async ({ revision = '1.3', prefix = 'test', allowlist = '', since = SINCE, batch = '500' } = {}) => {
    const { rows: candidates } = await client.query(selectStatesSql, [revision, since, prefix, allowlist, batch]);
    const out = await buildNode(candidates.map((json) => ({ json })), envFor(revision, prefix));
    const result = out.length > 0 ? (await client.query(insertStatesSql, [out[0].json.events_json])).rows[0] : null;
    return { candidates, result };
  };

  const stateEvents = async (contactId, prefix = 'test') => (await client.query(
    "SELECT * FROM crm_events WHERE contact_id = $1 AND event_type = 'contact.state' AND id_prefix = $2 ORDER BY revision",
    [contactId, prefix],
  )).rows;
  const states = async (contactId, prefix) => (await stateEvents(contactId, prefix)).map((event) => JSON.parse(event.body).data);
  const lastState = async (contactId, prefix) => (await states(contactId, prefix)).at(-1);

  const announced = async (options) => {
    const created = await insertConversation(options);
    await runContacts();
    return created;
  };

  describe('state per contact', () => {
    test('qualifying: progress from the stored context, normalized stage, the latest conversation', async () => {
      const { contactId, conversationId } = await announced({
        pending: 'confirm', context: { product: 'Adoquín', quantity: '120 m2', service_scope: 'material' },
      });
      await runStates();
      const [event] = await stateEvents(contactId);
      expect(event).toMatchObject({ revision: 1, conversation_id: null, status: 'pending', event_id: `wa-test-contact-${contactId}-state-1` });
      const body = JSON.parse(event.body);
      expect(Object.keys(body)).toEqual(['schema_version', 'protocol_revision', 'event_id', 'type', 'contact_id', 'data']);
      expect(body).toMatchObject({ protocol_revision: '1.3', type: 'contact.state', contact_id: `wa-test-contact-${contactId}` });
      expect(body.data).toMatchObject({
        state_version: 1, state: 'qualifying', progress: 66, stage: 'final_confirmation',
        conversation_id: `wa-test-conversation-${conversationId}`,
      });
      expect(body.data.changed_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
      // The shared receiver model accepts the real body (contract §3).
      expect(validateCrmEvent(event.body)).toEqual([]);
    });

    test.each(['waiting_user', 'out_of_flow'])('%s is qualifying', async (status) => {
      const { contactId } = await announced({ status, pending: 'quantity' });
      await runStates();
      expect(await lastState(contactId)).toMatchObject({ state: 'qualifying', stage: 'quantity' });
    });

    test('the latest conversation decides (started_at, then id)', async () => {
      const { contactId, phone } = await announced({ status: 'closed', startedAt: '2100-01-02T00:00:00Z' });
      const newer = await insertConversation({ phone, status: 'active', startedAt: '2100-01-05T00:00:00Z' });
      await runStates();
      expect(await lastState(contactId)).toMatchObject({ state: 'qualifying', conversation_id: `wa-test-conversation-${newer.conversationId}` });
    });

    test('priority: seller_held > handed_off > ready_to_quote > qualifying > idle', async () => {
      const { contactId, conversationId, phone } = await announced({ pending: 'service_scope', context: { service_scope: 'material' } });
      await runStates();
      expect(await lastState(contactId)).toMatchObject({ state: 'qualifying', progress: 33 });

      await setConversation(conversationId, { status: 'handed_to_sales', pending: null });
      await runStates();
      expect(await lastState(contactId)).toMatchObject({ state: 'ready_to_quote', progress: 100, stage: null });

      const handoffId = await insertHandoff(conversationId, phone);
      await recordHandoffCreated(handoffId, conversationId, contactId);
      await runStates();
      expect(await lastState(contactId)).toMatchObject({ state: 'handed_off', conversation_id: `wa-test-conversation-${conversationId}` });

      await insertSellerLease(conversationId);
      await runStates();
      expect(await lastState(contactId)).toMatchObject({ state: 'seller_held' });

      await client.query("UPDATE lead_chat_ownerships SET released_at = NOW(), release_reason = 'manual' WHERE conversation_id = $1", [conversationId]);
      await runStates();
      expect(await lastState(contactId)).toMatchObject({ state: 'handed_off' });

      await client.query("UPDATE handoffs SET estado = 'resolved', resolved_at = NOW() WHERE id = $1", [handoffId]);
      await setConversation(conversationId, { status: 'closed' });
      await runStates();
      expect(await lastState(contactId)).toEqual({
        state_version: 6, state: 'idle', progress: 0, stage: null, conversation_id: null, changed_at: expect.any(String),
      });
      expect((await stateEvents(contactId)).map((event) => event.revision)).toEqual([1, 2, 3, 4, 5, 6]);
    });

    test('a known contact whose only conversation is gone becomes idle', async () => {
      const { contactId, conversationId } = await announced();
      await runStates();
      await client.query('UPDATE conversations SET deleted_at = NOW() WHERE id = $1', [conversationId]);
      await runStates();
      expect(await lastState(contactId)).toMatchObject({ state_version: 2, state: 'idle', progress: 0, conversation_id: null });
    });

    test('progress counts a variant the catalog requires (v3.1 policy)', async () => {
      await client.query(
        `INSERT INTO catalog_items (sku, name, item_type, metadata)
         VALUES ('state-bloques-' || gen_random_uuid(), 'Bloques Estado Test', 'product',
                 '{"technical_sheet": {"variants": [{"name": "Bloque 14"}, {"name": "Bloque 19"}], "source_files": ["x.pdf"]}}'::jsonb)`,
      );
      const context = { product: 'Bloques Estado Test', quantity: '100 unidades', service_scope: 'material', fulfillment: 'pickup' };
      const { contactId, conversationId } = await announced({ context });
      await runStates();
      expect(await lastState(contactId)).toMatchObject({ progress: 66 });
      await setConversation(conversationId, {
        context: { ...context, line_items: [{ item_id: 'li_1', product: 'Bloques Estado Test', quantity: '100 unidades', variant: 'Bloque 14' }] },
      });
      await runStates();
      expect(await lastState(contactId)).toMatchObject({ progress: 100, state_version: 2 });
    });
  });

  describe('change detection', () => {
    test('state_version grows only when state, progress, stage or conversation change', async () => {
      const { contactId, conversationId } = await announced({ pending: 'quantity', context: { service_scope: 'material' } });
      await runStates();
      const second = await runStates();
      expect(second.candidates).toEqual([]);
      // An optional answer changes the inputs, not the snapshot: re-checked, nothing sent.
      await setConversation(conversationId, { context: { service_scope: 'material', use_case: 'muro' } });
      const third = await runStates();
      expect(third.candidates).toHaveLength(1);
      expect(third.result.enqueued).toBe(0);
      expect((await runStates()).candidates).toEqual([]);
      await setConversation(conversationId, { pending: 'fulfillment' });
      await runStates();
      expect((await states(contactId)).map((data) => [data.state_version, data.stage])).toEqual([[1, 'quantity'], [2, 'fulfillment']]);
    });

    test('a seller lease that expires by time yields the new state on the next pass', async () => {
      const { contactId, conversationId } = await announced({ status: 'handed_to_sales' });
      await insertSellerLease(conversationId, "NOW() + INTERVAL '1 hour'");
      await runStates();
      expect(await lastState(contactId)).toMatchObject({ state: 'seller_held' });
      // Time passes: the lease is now past its response_due_at (no row write by the bot).
      await client.query("UPDATE lead_chat_ownerships SET response_due_at = NOW() - INTERVAL '1 second' WHERE conversation_id = $1", [conversationId]);
      await runStates();
      expect(await lastState(contactId)).toMatchObject({ state: 'ready_to_quote', state_version: 2 });
    });

    test('a stale proposal (version already taken) inserts nothing', async () => {
      const { contactId } = await announced();
      const { rows: candidates } = await client.query(selectStatesSql, ['1.3', SINCE, 'test', '', '500']);
      const [out] = await buildNode(candidates.map((json) => ({ json })), envFor());
      const first = (await client.query(insertStatesSql, [out.json.events_json])).rows[0];
      const second = (await client.query(insertStatesSql, [out.json.events_json])).rows[0];
      expect([first.enqueued, second.enqueued]).toEqual([1, 0]);
      expect(await stateEvents(contactId)).toHaveLength(1);
    });

    test('a new id prefix starts again at version 1; the old prefix is untouched', async () => {
      const { contactId } = await announced();
      await runStates();
      await runContacts({ prefix: 'prodx' });
      await runStates({ prefix: 'prodx' });
      await runStates({ prefix: 'prodx' });
      expect((await stateEvents(contactId, 'prodx')).map((event) => [event.revision, event.event_id]))
        .toEqual([[1, `wa-prodx-contact-${contactId}-state-1`]]);
      expect(await stateEvents(contactId, 'test')).toHaveLength(1);
    });

    test('a blocked row is recorded, sent last, and retried every pass', async () => {
      const bad = await announced();
      const good = await announced();
      const { rows: candidates } = await client.query(selectStatesSql, ['1.3', SINCE, 'test', '', '500']);
      const [out] = await buildNode(candidates.map((json) => ({ json })), envFor());
      const events = JSON.parse(out.json.events_json).map((event) => (String(event.contact_id) === bad.contactId
        ? { ...event, event_id: null, body: null, blocked_reason: 'invalid_state' } : event));
      const result = (await client.query(insertStatesSql, [JSON.stringify(events)])).rows[0];
      expect(result).toMatchObject({ enqueued: 1, blocked: 1 });
      const { rows: [mark] } = await client.query('SELECT input_hash, blocked_reason FROM crm_contact_state_marks WHERE contact_id = $1', [bad.contactId]);
      expect(mark).toEqual({ input_hash: null, blocked_reason: 'invalid_state' });
      await insertConversation();
      await runContacts();
      const next = await runStates();
      expect(next.candidates.map((row) => String(row.contact_id)).at(-1)).toBe(bad.contactId);
      expect(await stateEvents(bad.contactId)).toHaveLength(1);
      expect(await stateEvents(good.contactId)).toHaveLength(1);
      const { rows: [cleared] } = await client.query('SELECT blocked_reason FROM crm_contact_state_marks WHERE contact_id = $1', [bad.contactId]);
      expect(cleared.blocked_reason).toBeNull();
    });
  });

  describe('handed_off only with an open handoff the CRM already has', () => {
    test('needs a delivered handoff.created under the current prefix and an open handoff', async () => {
      const { contactId, conversationId, phone } = await announced({ status: 'handed_to_sales' });
      const handoffId = await insertHandoff(conversationId, phone);
      await runStates();
      expect(await lastState(contactId)).toMatchObject({ state: 'ready_to_quote' });

      await recordHandoffCreated(handoffId, conversationId, contactId, { status: 'pending' });
      await recordHandoffCreated(handoffId, conversationId, contactId, { prefix: 'prodx', status: 'delivered' });
      await runStates();
      expect(await lastState(contactId)).toMatchObject({ state: 'ready_to_quote', state_version: 1 });

      await client.query("UPDATE crm_events SET status = 'delivered' WHERE handoff_id = $1 AND id_prefix = 'test'", [handoffId]);
      await runStates();
      expect(await lastState(contactId)).toMatchObject({ state: 'handed_off', state_version: 2 });

      await client.query("UPDATE handoffs SET estado = 'acknowledged', acknowledged_at = NOW() WHERE id = $1", [handoffId]);
      await runStates();
      expect(await lastState(contactId)).toMatchObject({ state: 'handed_off', state_version: 2 });

      await client.query("UPDATE handoffs SET estado = 'resolved', resolved_at = NOW() WHERE id = $1", [handoffId]);
      await runStates();
      expect(await lastState(contactId)).toMatchObject({ state: 'ready_to_quote', state_version: 3 });
    });
  });

  describe('scope', () => {
    test('waits for the contact.upserted under the current prefix (ordering rule)', async () => {
      const { contactId } = await insertConversation();
      expect((await runStates()).candidates).toEqual([]);
      await runContacts({ prefix: 'prodx' });
      expect((await runStates()).candidates).toEqual([]);
      await runContacts();
      await runStates();
      expect(await stateEvents(contactId)).toHaveLength(1);
      const { rows: [order] } = await client.query(
        `SELECT bool_and(u.id < s.id) AS after FROM crm_events u JOIN crm_events s ON s.contact_id = u.contact_id
         WHERE u.contact_id = $1 AND u.event_type = 'contact.upserted' AND u.id_prefix = 'test' AND s.event_type = 'contact.state'`, [contactId]);
      expect(order.after).toBe(true);
    });

    test('respects the allowlist and CRM_EVENTS_SINCE, and the batch size', async () => {
      const listed = await announced();
      const other = await announced();
      const old = await insertConversation({ startedAt: '2099-06-01T00:00:00Z' });
      await runContacts({ since: '2099-01-01T00:00:00Z' });
      const onlyListed = await runStates({ allowlist: listed.phone });
      expect(onlyListed.candidates.map((row) => String(row.contact_id))).toEqual([listed.contactId]);
      expect((await runStates({ batch: '1' })).candidates).toHaveLength(1);
      await runStates();
      expect(await stateEvents(other.contactId)).toHaveLength(1);
      expect(await stateEvents(old.contactId)).toHaveLength(0);
    });

    test('is a no-op under 1.2', async () => {
      const { contactId } = await announced();
      const { rows } = await client.query(selectStatesSql, ['1.2', SINCE, 'test', '', '500']);
      expect(rows).toEqual([]);
      expect(await buildNode([{ json: { contact_id: Number(contactId), state: 'idle', state_version: 1 } }], envFor('1.2'))).toEqual([]);
      expect(await stateEvents(contactId)).toHaveLength(0);
    });
  });

  test.each(['applied', 'ignored_stale', 'duplicate'])('a contact.state answered 200 %s is delivered', async (result) => {
    const { contactId } = await announced();
    await runStates();
    const claimed = (await client.query(claimSql, ['500', '900'])).rows;
    for (const row of claimed) {
      const classified = classifyCrmResponse({ statusCode: 200, body: JSON.stringify({ event_id: row.event_id, result }) }, row.event_id, row.event_type);
      await client.query(completeSql, [
        String(row.crm_event_id), row.claim_token, classified.outcome, String(classified.http_status ?? ''), classified.error ?? '',
        classified.response_json ?? '', '', '', '',
      ]);
    }
    const [event] = await stateEvents(contactId);
    expect(event).toMatchObject({ status: 'delivered', last_error: null });
  });
});
