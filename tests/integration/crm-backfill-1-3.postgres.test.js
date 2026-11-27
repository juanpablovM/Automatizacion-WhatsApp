// =============================================================================
// CRM 1.3 backfill (U8: S9, S11; also S2-S5, S8, S10) through the real SQL:
// crm_backfill_start / crm_backfill_abandon (migration 059), the dispatcher's
// backfill stage (select 15, Build Backfill Events, insert 16), the live
// stages that wait for a contact's backfill (01, 05, 07, 09, 11, 13) and the
// delivery stage (03/04). Feature document: odd/tasks/crm-1-3-customer-threads.md.
// Every test runs inside a transaction that is rolled back; rows live in 2100,
// with an explicit backfill cutoff, so other suites never mix in.
// =============================================================================
import fs from 'node:fs';
import { createRequire } from 'node:module';
import pg from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'vitest';

const require = createRequire(import.meta.url);
const {
  buildLeadQualifiedEvent,
  buildMessageNewEvent,
  buildOwnershipEvent,
  buildHandoffCreatedEvent,
  buildContactUpsertedEvent,
  classifyCrmResponse,
  isCrmEventDeferred,
} = require('../fixtures/workflow-nodes/crm-events-dispatcher/crm-events-runtime.js');
const { validateCrmEvent } = require('../support/crm-events-validator.js');

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
const SQL = {
  selectLeads: sql('01_select_lead_qualified_candidates.sql'),
  insertLead: sql('02_insert_lead_qualified_event.sql'),
  claim: sql('03_claim_crm_events.sql'),
  complete: sql('04_complete_crm_event.sql'),
  selectMessages: sql('05_select_message_candidates.sql'),
  insertMessages: sql('06_insert_message_events.sql'),
  selectOwnership: sql('07_select_ownership_candidates.sql'),
  insertOwnership: sql('08_insert_ownership_events.sql'),
  selectHandoffs: sql('09_select_handoff_candidates.sql'),
  insertHandoffs: sql('10_insert_handoff_events.sql'),
  selectContacts: sql('11_select_contact_candidates.sql'),
  insertContacts: sql('12_insert_contact_events.sql'),
  selectStates: sql('13_select_contact_state_candidates.sql'),
  insertStates: sql('14_insert_contact_state_events.sql'),
  selectBackfill: sql('15_select_backfill_candidates.sql'),
  insertBackfill: sql('16_insert_backfill_events.sql'),
};
const opsSql = (file) => fs.readFileSync(`db/queries/ops/crm-backfill-1-3/${file}`, 'utf8');

const fixture = (rel) => fs.readFileSync(`tests/fixtures/workflow-nodes/${rel}`, 'utf8');
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const node = (runtimes, file) => {
  const source = [...runtimes, file].map(fixture).join('\n\n');
  return (items, env) => new AsyncFunction('items', '$env', 'require', source)(items, env, require);
};
const RUNTIME = 'crm-events-dispatcher/crm-events-runtime.js';
const buildBackfillNode = node([RUNTIME], 'crm-events-dispatcher/build-backfill-events.js');
const buildStateNode = node([
  RUNTIME, 'shared/v3-line-items.js', 'shared/v3-policy-builder.js', 'crm-events-dispatcher/contact-state-runtime.js',
], 'crm-events-dispatcher/build-contact-state-events.js');

const SINCE = '2100-01-01T00:00:00.000Z';
const CUTOFF = '2100-06-01T00:00:00.000Z';
const PREFIX = 'prd';
const SELLER_UUID = '6f1c2a34-5b6d-4e7f-8a9b-0c1d2e3f4a5b';
const CUSTOMER_UUID = '11111111-2222-4333-8444-555555555555';
const OPPORTUNITY_UUID = '66666666-7777-4888-9999-aaaaaaaaaaaa';
const DEV_OPPORTUNITY_UUID = '99999999-8888-4777-9666-555555555555';
const envFor = (prefix = PREFIX, revision = '1.3') => ({
  CRM_EVENTS_ENABLED: 'true',
  CRM_EVENTS_URL: 'https://crm.example.test/api/integrations/whatsapp/events',
  CRM_EVENTS_HMAC_SECRET: 'test-crm-secret',
  CRM_EVENTS_SINCE: SINCE,
  CRM_EVENTS_PROTOCOL_REVISION: revision,
  CRM_EVENTS_ID_PREFIX: prefix,
  CRM_EVENTS_HANDOFFS_ENABLED: 'true',
  AI_PRD_V3_LINE_ITEMS: 'enabled',
});
const cfgFor = (prefix = PREFIX, revision = '1.3') => ({ protocol_revision: revision, id_prefix: prefix, handoffs_enabled: true });

describeIntegration('CRM 1.3 backfill', () => {
  const client = new pg.Client(connection);
  const statusIds = {};
  let leadStatusId;
  let sellerId;
  let sourceNumberId;
  let sequence = 0;
  let delivered = [];

  beforeAll(async () => { await client.connect(); });
  afterAll(async () => { await client.end(); });

  beforeEach(async () => {
    delivered = [];
    await client.query('BEGIN');
    const { rows } = await client.query('SELECT id, code FROM conversation_statuses');
    for (const { id, code } of rows) statusIds[code] = id;
    ({ rows: [{ id: leadStatusId }] } = await client.query(
      `INSERT INTO lead_statuses (code, label, sort_order) VALUES ('assigned', 'Assigned', 2)
       ON CONFLICT (code) DO UPDATE SET code = EXCLUDED.code RETURNING id`,
    ));
    ({ rows: [{ id: sellerId }] } = await client.query(
      `INSERT INTO sellers (name, is_active, sort_order, crm_user_id, clickup_user_id)
       VALUES ('CRM Seller', TRUE, 90000 + (random() * 9000)::int, $1, 'cu-1') RETURNING id`,
      [SELLER_UUID],
    ));
    ({ rows: [{ id: sourceNumberId }] } = await client.query(
      `INSERT INTO whatsapp_numbers (display_name, phone_number, phone_number_id)
       VALUES ('Ventas', '56223456789', 'crm-backfill-' || gen_random_uuid()) RETURNING id`,
    ));
  });
  afterEach(async () => { await client.query('ROLLBACK'); });

  const nextPhone = () => {
    sequence += 1;
    return `5695${String(1000000 + sequence).slice(-7)}`;
  };

  const insertConversation = async ({ phone = nextPhone(), at = '2100-05-01T00:00:00Z', status = 'active', leadId = null } = {}) => {
    const { rows: [conversation] } = await client.query(
      `INSERT INTO conversations (lead_id, phone_number, conversation_status_id, source_number_id, started_at, created_at)
       VALUES ($1, $2, $3, $4, $5, $5) RETURNING id`,
      [leadId, phone, statusIds[status], sourceNumberId, at],
    );
    const { rows: [{ id: contactId }] } = await client.query('SELECT crm_contact_ref($1, $2) AS id', [sourceNumberId, phone]);
    return { conversationId: String(conversation.id), contactId: String(contactId), phone };
  };

  const insertLead = async (phone, conversationId, { at = '2100-05-01T00:00:00Z', status = null, statusAt = null } = {}) => {
    const { rows: [lead] } = await client.query(
      `INSERT INTO leads (whatsapp_name, phone_number, service, city, requirement, lead_status_id, assigned_seller_id,
                          source_number_id, source_conversation_id, clickup_status, clickup_status_at, created_at)
       VALUES ('Ana', $1, 'instalacion', 'Santiago', '50 bloques', $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
      [phone, leadStatusId, sellerId, sourceNumberId, conversationId, status, statusAt, at],
    );
    await client.query('UPDATE conversations SET lead_id = $2 WHERE id = $1 AND lead_id IS NULL', [conversationId, lead.id]);
    return String(lead.id);
  };

  const insertMessage = async (conversationId, { at, external = null, text = 'Hola', direction = 'incoming' }) => (await client.query(
    `INSERT INTO messages (conversation_id, direction, sender_type, message_type, text_body, raw_payload,
                           external_timestamp, delivery_status, created_at)
     VALUES ($1, $2, $3, 'text', $4, '{}'::jsonb, $5, 'sent', $6) RETURNING id`,
    [conversationId, direction, direction === 'incoming' ? 'customer' : 'bot', text, external, at],
  )).rows[0].id;

  const insertHandoff = async (conversationId, phone, { at = '2100-05-02T00:00:00Z', estado = 'pending', resolvedAt = null } = {}) => (await client.query(
    `INSERT INTO handoffs (idempotency_key, conversation_id, phone_number, source_number_id, motivo, area, area_label,
                           prioridad, responsable, estado, resolved_at, created_at)
     VALUES ('crm-backfill-' || gen_random_uuid(), $1, $2, $3, 'talk_human', 'sales', 'Ventas', 'alta', 'Ejecutiva comercial',
             $4, $5, $6) RETURNING id`,
    [conversationId, phone, sourceNumberId, estado, resolvedAt, at],
  )).rows[0].id;

  const insertLease = (conversationId) => client.query(
    `INSERT INTO lead_chat_ownerships (conversation_id, response_due_at, acquired_via, owner_seller_id)
     VALUES ($1::bigint, NOW() + INTERVAL '2 hours', 'crm', $2)`, [conversationId, sellerId],
  );

  const start = async ({ prefix = PREFIX, allowlist = '', testPhones = '', cutoff = CUTOFF } = {}) => (await client.query(
    'SELECT * FROM crm_backfill_start($1, $2, $3, $4::timestamptz)', [prefix, allowlist, testPhones, cutoff],
  )).rows[0];

  // ---------------------------------------------------------------------------
  // One dispatcher pass, in the workflow's branch order.
  // ---------------------------------------------------------------------------
  const runContacts = async (cfg) => {
    const { rows } = await client.query(SQL.selectContacts, [cfg.protocol_revision, SINCE, cfg.id_prefix, '', '500']);
    const events = rows.map((row) => {
      const built = buildContactUpsertedEvent(row, cfg);
      return { contact_id: Number(row.contact_id), revision: built.revision ?? Number(row.revision), event_id: built.event_id, body: built.body, blocked_reason: built.blocked_reason };
    });
    await client.query(SQL.insertContacts, [JSON.stringify(events)]);
  };
  const runLeads = async (cfg) => {
    const { rows } = await client.query(SQL.selectLeads, [SINCE, '200', cfg.protocol_revision, '']);
    for (const row of rows) {
      const event = buildLeadQualifiedEvent(row, cfg);
      if (isCrmEventDeferred(event)) continue;
      await client.query(SQL.insertLead, [
        String(row.lead_id), String(event.revision ?? row.revision), event.event_id ?? '', event.conversation_id ?? '',
        event.body ?? '', String(row.requirement ?? ''), event.blocked_reason ?? '', event.record_hash ?? '', String(row.crm_source_hash ?? ''),
      ]);
    }
  };
  const runMessages = async (cfg) => {
    const { rows } = await client.query(SQL.selectMessages, [cfg.protocol_revision, SINCE, cfg.id_prefix, '500']);
    const events = rows.map((row) => ({ row, built: buildMessageNewEvent(row, cfg) }))
      .filter(({ built }) => !isCrmEventDeferred(built))
      .map(({ row, built }) => ({ message_id: Number(row.message_id), event_id: built.event_id, conversation_id: built.conversation_id, body: built.body, blocked_reason: built.blocked_reason }));
    await client.query(SQL.insertMessages, [JSON.stringify(events)]);
  };
  const runOwnership = async (cfg) => {
    const { rows } = await client.query(SQL.selectOwnership, [cfg.protocol_revision, SINCE, cfg.id_prefix, '500']);
    const events = rows.map((row) => ({ row, built: buildOwnershipEvent(row, cfg) }))
      .filter(({ built }) => !isCrmEventDeferred(built))
      .map(({ row, built }) => ({ change_id: Number(row.change_id), event_id: built.event_id, conversation_id: built.conversation_id, event_type: built.body ? JSON.parse(built.body).type : null, body: built.body, blocked_reason: built.blocked_reason }));
    await client.query(SQL.insertOwnership, [JSON.stringify(events)]);
  };
  const runHandoffs = async (cfg) => {
    const { rows } = await client.query(SQL.selectHandoffs, ['true', SINCE, '200', '', '', '']);
    const events = rows.map((row) => ({ row, built: buildHandoffCreatedEvent(row, cfg) }))
      .filter(({ built }) => !isCrmEventDeferred(built))
      .map(({ row, built }) => ({
        handoff_id: Number(row.handoff_id), revision: built.revision ?? Number(row.revision), event_id: built.event_id,
        conversation_id: built.conversation_id, body: built.body, blocked_reason: built.blocked_reason,
        crm_opportunity_id: row.crm_opportunity_id, crm_seller_id: row.crm_seller_id,
      }));
    await client.query(SQL.insertHandoffs, [JSON.stringify(events)]);
  };
  const runBackfill = async (cfg, { messageBatch = '100', contactBatch = '20' } = {}) => {
    const { rows } = await client.query(SQL.selectBackfill, [cfg.protocol_revision, cfg.id_prefix, 'true', messageBatch, contactBatch]);
    const out = await buildBackfillNode(rows.map((json) => ({ json })), envFor(cfg.id_prefix, cfg.protocol_revision));
    if (out.length === 0) return { rows, result: null };
    return { rows, result: (await client.query(SQL.insertBackfill, [out[0].json.events_json])).rows[0] };
  };
  const runStates = async (cfg) => {
    const { rows } = await client.query(SQL.selectStates, [cfg.protocol_revision, SINCE, cfg.id_prefix, '', '500']);
    const out = await buildStateNode(rows.map((json) => ({ json })), envFor(cfg.id_prefix, cfg.protocol_revision));
    if (out.length > 0) await client.query(SQL.insertStates, [out[0].json.events_json]);
  };

  // The CRM: an open lead gets an opportunity, a historical won/lost one is
  // stored on the thread only.
  const responseFor = (row) => {
    const body = JSON.parse(row.body);
    switch (row.event_type) {
      case 'lead.qualified':
        return ['won', 'lost'].includes(body.data.outcome)
          ? { event_id: row.event_id, status: 'historical', crm_customer_id: null, crm_opportunity_id: null }
          : { event_id: row.event_id, crm_customer_id: CUSTOMER_UUID, crm_opportunity_id: OPPORTUNITY_UUID, status: 'created' };
      case 'message.new': return { event_id: row.event_id, crm_message_id: `m-${row.event_id}`, status: 'created' };
      case 'handoff.created': return { event_id: row.event_id, external_handoff_id: body.data.handoff_id, crm_case_id: null, status: 'associated' };
      case 'contact.upserted':
      case 'contact.state': return { event_id: row.event_id, result: 'applied' };
      default: return { event_id: row.event_id, ownership_version: body.data.version, owner: 'seller' };
    }
  };
  const deliver = async ({ status = 200 } = {}) => {
    const claimed = (await client.query(SQL.claim, ['500', '900'])).rows;
    for (const row of claimed) {
      const classified = classifyCrmResponse({ statusCode: status, body: JSON.stringify(status === 200 ? responseFor(row) : { error: 'unavailable' }) }, row.event_id, row.event_type);
      await client.query(SQL.complete, [
        String(row.crm_event_id), row.claim_token, classified.outcome, String(classified.http_status ?? ''), classified.error ?? '',
        classified.response_json ?? '', classified.crm_customer_id ?? '', classified.crm_opportunity_id ?? '', '0',
      ]);
      if (classified.outcome === 'delivered') delivered.push(row);
    }
    // A retry is due at once in the test (backoff 0 s is clamped to 1 s).
    await client.query("UPDATE crm_events SET next_attempt_at = NOW() - INTERVAL '1 second' WHERE status = 'pending'");
  };
  const pass = async (cfg = cfgFor(), options = {}) => {
    await runContacts(cfg);
    await runLeads(cfg);
    await runMessages(cfg);
    await runOwnership(cfg);
    await runHandoffs(cfg);
    const backfill = await runBackfill(cfg);
    await deliver(options);
    await runStates(cfg);
    return backfill;
  };
  const passes = async (count, cfg = cfgFor()) => { for (let i = 0; i < count; i += 1) await pass(cfg); };
  const backfillRow = async (contactId, prefix = PREFIX) => (await client.query(
    'SELECT * FROM crm_contact_backfills WHERE contact_id = $1 AND id_prefix = $2', [contactId, prefix],
  )).rows[0];
  const eventsOf = async (contactId, prefix = PREFIX) => (await client.query(
    'SELECT * FROM crm_events WHERE contact_id = $1 AND id_prefix = $2 ORDER BY id', [contactId, prefix],
  )).rows;
  const deliveredOf = (contactId) => delivered.filter((row) => JSON.parse(row.body).contact_id === `wa-${PREFIX}-contact-${contactId}`);

  // A customer with closed and open history and a live seller lease.
  const richCustomer = async () => {
    const old = await insertConversation({ at: '2100-02-01T00:00:00Z', status: 'closed' });
    const lostLeadId = await insertLead(old.phone, old.conversationId, { at: '2100-02-01T00:00:00Z', status: 'cerrada', statusAt: '2100-02-10T00:00:00Z' });
    const resolvedHandoffId = await insertHandoff(old.conversationId, old.phone, { at: '2100-02-02T00:00:00Z', estado: 'resolved', resolvedAt: '2100-02-03T00:00:00Z' });
    const m1 = await insertMessage(old.conversationId, { at: '2100-02-01T10:00:00Z' });
    const current = await insertConversation({ phone: old.phone, at: '2100-05-20T00:00:00Z' });
    const openLeadId = await insertLead(old.phone, current.conversationId, { at: '2100-05-20T00:00:00Z' });
    // Stored after m3 but sent before it (provider timestamp): sent_at order wins.
    const m3 = await insertMessage(current.conversationId, { at: '2100-05-20T12:00:00Z', direction: 'outgoing', text: 'Te ayudo' });
    const m2 = await insertMessage(current.conversationId, { at: '2100-05-20T13:00:00Z', external: '2100-05-20T11:00:00Z' });
    const openHandoffId = await insertHandoff(current.conversationId, old.phone, { at: '2100-05-21T00:00:00Z' });
    await insertLease(current.conversationId);
    return { ...old, current, lostLeadId, openLeadId, resolvedHandoffId, openHandoffId, messages: [m1, m2, m3] };
  };

  describe('order per contact (S9)', () => {
    test('contact.upserted, leads and resolved handoffs oldest first, open handoffs, messages in sent_at order, the holder, then contact.state', async () => {
      const c = await richCustomer();
      expect(await start()).toMatchObject({ result: 'started', pending_contacts: 1, skipped_contacts: 0 });
      await passes(8);
      expect((await backfillRow(c.contactId)).status).toBe('completed');

      const sequenceOf = deliveredOf(c.contactId).map((row) => {
        const body = JSON.parse(row.body);
        return body.type === 'lead.qualified' ? `lead:${body.data.outcome}` : body.type;
      });
      expect(sequenceOf).toEqual([
        'contact.upserted', 'lead:lost', 'handoff.created', 'lead:open', 'handoff.created',
        'message.new', 'message.new', 'message.new', 'ownership.taken', 'contact.state',
      ]);
      for (const row of deliveredOf(c.contactId)) expect(validateCrmEvent(row.body)).toEqual([]);

      const bodies = deliveredOf(c.contactId).map((row) => JSON.parse(row.body));
      const [resolved, open] = bodies.filter((body) => body.type === 'handoff.created');
      expect(resolved.data).toMatchObject({ handoff_id: `wa-prd-handoff-${c.resolvedHandoffId}`, historical: true, resolved_at: '2100-02-03T00:00:00Z' });
      expect('crm_seller_id' in resolved.data || 'crm_opportunity_id' in resolved.data).toBe(false);
      // The open handoff is live and carries the opportunity the CRM returned for the open lead.
      expect(open.data).toMatchObject({ handoff_id: `wa-prd-handoff-${c.openHandoffId}`, historical: true, crm_opportunity_id: OPPORTUNITY_UUID });
      expect('resolved_at' in open.data).toBe(false);
      expect(bodies.filter((body) => body.type === 'message.new').map((body) => body.data.message_id))
        .toEqual([c.messages[0], c.messages[1], c.messages[2]].map((id) => `wa-prd-message-${id}`));
      expect(bodies.filter((body) => body.type === 'message.new').every((body) => body.data.historical === true)).toBe(true);
      expect(bodies.at(-1).data.state).toBe('seller_held');
    });

    test('a 503 keeps the contact waiting until the event is delivered', async () => {
      const c = await richCustomer();
      await start();
      await pass(cfgFor(), { status: 503 });
      await passes(3);
      const before = (await eventsOf(c.contactId)).filter((e) => e.event_type === 'message.new').length;
      expect(before).toBe(0);
      await passes(6);
      expect((await backfillRow(c.contactId)).status).toBe('completed');
    });
  });

  describe('holder (S8)', () => {
    test('the current holder is sent once as ownership.taken with the next contact counter', async () => {
      const c = await richCustomer();
      const { rows: [{ ownership_version: counter }] } = await client.query('SELECT ownership_version FROM crm_contacts WHERE id = $1', [c.contactId]);
      await start();
      await passes(8);
      const taken = (await eventsOf(c.contactId)).filter((e) => e.event_type === 'ownership.taken');
      expect(taken).toHaveLength(1);
      expect(JSON.parse(taken[0].body)).toMatchObject({
        event_id: `wa-prd-ownership-c${c.contactId}-v${Number(counter) + 1}`, conversation_id: `wa-prd-conversation-${c.current.conversationId}`,
        data: { version: Number(counter) + 1, crm_seller_id: SELLER_UUID, source: 'crm' },
      });
      const { rows: [after] } = await client.query('SELECT ownership_version FROM crm_contacts WHERE id = $1', [c.contactId]);
      expect(Number(after.ownership_version)).toBe(Number(counter) + 1);
    });

    test('without a live lease no ownership event is sent', async () => {
      const a = await insertConversation();
      await insertMessage(a.conversationId, { at: '2100-05-02T00:00:00Z' });
      await start();
      await passes(5);
      expect((await backfillRow(a.contactId)).status).toBe('completed');
      expect((await eventsOf(a.contactId)).map((e) => e.event_type)).toEqual(['contact.upserted', 'message.new', 'contact.state']);
    });
  });

  describe('outcome rule (S11)', () => {
    const outcome = async (status, statusAt, createdAt, lastActivity) => (await client.query(
      `SELECT outcome, to_char(closed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS closed_at
       FROM crm_backfill_lead_outcome($1, $2::timestamptz, $3::timestamptz, $4::timestamptz, $5::timestamptz)`,
      [status, statusAt, createdAt, lastActivity, CUTOFF],
    )).rows[0];

    test('each ClickUp status', async () => {
      expect(await outcome('concretada', '2100-03-01T00:00:00Z', '2100-02-01T00:00:00Z', '2100-04-01T00:00:00Z'))
        .toEqual({ outcome: 'won', closed_at: '2100-03-01T00:00:00Z' });
      expect(await outcome('no concretada', '2100-03-02T00:00:00Z', '2100-05-30T00:00:00Z', '2100-04-01T00:00:00Z'))
        .toEqual({ outcome: 'lost', closed_at: '2100-03-02T00:00:00Z' });
      expect(await outcome(' Cerrada ', '2100-03-03T00:00:00Z', '2100-05-30T00:00:00Z', '2100-04-01T00:00:00Z'))
        .toEqual({ outcome: 'lost', closed_at: '2100-03-03T00:00:00Z' });
    });

    test('no status: open up to 30 days old, lost from 30 days and one second, closed at the last activity', async () => {
      expect(await outcome(null, null, '2100-05-02T00:00:00Z', '2100-05-10T00:00:00Z')).toEqual({ outcome: 'open', closed_at: null });
      expect(await outcome(null, null, '2100-05-01T23:59:59Z', '2100-05-10T00:00:00Z')).toEqual({ outcome: 'lost', closed_at: '2100-05-10T00:00:00Z' });
    });

    test('a closed status without its timestamp closes at the last activity', async () => {
      expect(await outcome('cerrada', null, '2100-02-01T00:00:00Z', '2100-02-05T00:00:00Z')).toEqual({ outcome: 'lost', closed_at: '2100-02-05T00:00:00Z' });
    });

    test('the backfill sends the outcome from the lead and its last message', async () => {
      const a = await insertConversation({ at: '2100-03-01T00:00:00Z' });
      const leadId = await insertLead(a.phone, a.conversationId, { at: '2100-03-01T00:00:00Z' });
      await insertMessage(a.conversationId, { at: '2100-03-04T08:00:00Z' });
      await start();
      await passes(3);
      const [event] = (await eventsOf(a.contactId)).filter((e) => e.event_type === 'lead.qualified');
      expect(Number(event.lead_id)).toBe(Number(leadId));
      expect(JSON.parse(event.body).data).toMatchObject({ historical: true, outcome: 'lost', closed_at: '2100-03-04T08:00:00Z' });
    });

    test('a won/lost lead is never sent again by the live stage', async () => {
      const a = await insertConversation({ at: '2100-03-01T00:00:00Z' });
      const leadId = await insertLead(a.phone, a.conversationId, { at: '2100-03-01T00:00:00Z', status: 'concretada', statusAt: '2100-03-05T00:00:00Z' });
      await start();
      await passes(4);
      await client.query("UPDATE leads SET requirement = 'otra cosa' WHERE id = $1", [leadId]);
      await passes(2);
      const leads = (await eventsOf(a.contactId)).filter((e) => e.event_type === 'lead.qualified');
      expect(leads).toHaveLength(1);
      expect(JSON.parse(leads[0].body).data.outcome).toBe('won');
    });
  });

  describe('scope (S9, S10)', () => {
    test('test phones are never backfilled and their live events do not wait', async () => {
      const t = await insertConversation();
      await insertMessage(t.conversationId, { at: '2100-05-02T00:00:00Z' });
      await insertMessage(t.conversationId, { at: '2100-06-02T00:00:00Z' });
      expect(await start({ testPhones: t.phone })).toMatchObject({ pending_contacts: 0, skipped_contacts: 1 });
      await passes(3);
      const messages = (await eventsOf(t.contactId)).filter((e) => e.event_type === 'message.new');
      // Only the live stage sends them, never as historical.
      expect(messages).toHaveLength(2);
      expect(messages.every((e) => !('historical' in JSON.parse(e.body).data))).toBe(true);
    });

    test('with an allowlist only listed contacts are backfilled', async () => {
      const listed = await insertConversation();
      const other = await insertConversation();
      await insertMessage(listed.conversationId, { at: '2100-05-02T00:00:00Z' });
      await insertMessage(other.conversationId, { at: '2100-05-02T00:00:00Z' });
      expect(await start({ allowlist: listed.phone })).toMatchObject({ pending_contacts: 1 });
      expect(await backfillRow(other.contactId)).toBeUndefined();
      expect(await backfillRow(listed.contactId)).toMatchObject({ status: 'pending' });
    });

    test('nothing after the cutoff is historical', async () => {
      const a = await insertConversation();
      await insertMessage(a.conversationId, { at: '2100-05-02T00:00:00Z' });
      const late = await insertMessage(a.conversationId, { at: '2100-06-02T00:00:00Z' });
      await start();
      await passes(5);
      const messages = (await eventsOf(a.contactId)).filter((e) => e.event_type === 'message.new').map((e) => JSON.parse(e.body).data);
      expect(messages.map((m) => [m.message_id, m.historical ?? false])).toEqual([
        [expect.not.stringContaining(`-${late}`), true], [`wa-prd-message-${late}`, false],
      ]);
    });
  });

  describe('live events wait for the backfill (S9)', () => {
    test('a pending contact gets no live message, lead, handoff, ownership or state before completion', async () => {
      const c = await richCustomer();
      const liveMessage = await insertMessage(c.current.conversationId, { at: '2100-06-02T00:00:00Z' });
      await start();
      await pass();
      const early = await eventsOf(c.contactId);
      expect(early.map((e) => e.event_type)).toEqual(['contact.upserted']);
      await passes(8);
      expect((await backfillRow(c.contactId)).status).toBe('completed');
      const all = await eventsOf(c.contactId);
      const live = all.find((e) => Number(e.message_id) === Number(liveMessage));
      expect(live).toBeDefined();
      expect('historical' in JSON.parse(live.body).data).toBe(false);
      // The live message comes after the backfill prefix: after the holder.
      expect(Number(live.id)).toBeGreaterThan(Number(all.find((e) => e.event_type === 'ownership.taken').id));
    });
  });

  describe('idempotent and resumable (S9)', () => {
    test('a second start enqueues nothing new; extra passes after completion enqueue nothing', async () => {
      const c = await richCustomer();
      await start();
      expect(await start()).toMatchObject({ result: 'already_started', pending_contacts: 1 });
      await passes(8);
      const count = (await eventsOf(c.contactId)).length;
      const again = await runBackfill(cfgFor());
      expect(again.rows).toHaveLength(0);
      await passes(3);
      expect((await eventsOf(c.contactId)).length).toBe(count);
    });

    test('a backfill item built twice (two overlapping passes) is enqueued once', async () => {
      const a = await insertConversation();
      await insertMessage(a.conversationId, { at: '2100-05-02T00:00:00Z' });
      await start();
      await pass();
      const { rows } = await client.query(SQL.selectBackfill, ['1.3', PREFIX, 'true', '100', '20']);
      const out = await buildBackfillNode(rows.map((json) => ({ json })), envFor());
      await client.query(SQL.insertBackfill, [out[0].json.events_json]);
      await client.query(SQL.insertBackfill, [out[0].json.events_json]);
      expect((await eventsOf(a.contactId)).filter((e) => e.event_type === 'message.new')).toHaveLength(1);
    });

    test('start refuses a prefix that already has events', async () => {
      const a = await insertConversation();
      await insertMessage(a.conversationId, { at: '2100-05-02T00:00:00Z' });
      await runContacts(cfgFor());
      await expect(start()).rejects.toThrow(/crm_backfill_prefix_in_use/);
    });

    test('under 1.2 the backfill stage returns nothing', async () => {
      const a = await insertConversation();
      await insertMessage(a.conversationId, { at: '2100-05-02T00:00:00Z' });
      await start();
      const { rows } = await client.query(SQL.selectBackfill, ['1.2', PREFIX, 'true', '100', '20']);
      expect(rows).toEqual([]);
    });
  });

  describe('prefix scoping (dev deliveries never count for production)', () => {
    test('CRM ids from the dev prefix are archived and replaced; an open handoff routed to a dev opportunity is re-routed', async () => {
      const c = await richCustomer();
      // What the dev receiver left behind under prefix "dev".
      await client.query('UPDATE leads SET crm_customer_id = $2, crm_opportunity_id = $3 WHERE id = $1', [c.openLeadId, CUSTOMER_UUID, DEV_OPPORTUNITY_UUID]);
      await client.query('UPDATE handoffs SET crm_opportunity_id = $2 WHERE id = $1', [c.openHandoffId, DEV_OPPORTUNITY_UUID]);
      await client.query(
        `INSERT INTO crm_events (event_id, event_type, conversation_id, handoff_id, contact_id, revision, body, status)
         VALUES ($1, 'handoff.created', $2, $3, $4, 1, '{}', 'delivered')`,
        [`wa-dev-handoff-${c.openHandoffId}-r1`, `wa-dev-conversation-${c.current.conversationId}`, c.openHandoffId, c.contactId],
      );
      await start();
      const archived = (await backfillRow(c.contactId)).previous_crm_ids;
      expect(archived.leads).toEqual([{ id: Number(c.openLeadId), crm_customer_id: CUSTOMER_UUID, crm_opportunity_id: DEV_OPPORTUNITY_UUID }]);
      expect(archived.handoffs).toEqual([{ id: Number(c.openHandoffId), crm_opportunity_id: DEV_OPPORTUNITY_UUID }]);
      await passes(8);
      const handoffs = (await eventsOf(c.contactId)).filter((e) => e.event_type === 'handoff.created');
      expect(handoffs.map((e) => [Number(e.handoff_id), e.revision])).toEqual([[Number(c.resolvedHandoffId), 1], [Number(c.openHandoffId), 2]]);
      expect(JSON.parse(handoffs[1].body).data.crm_opportunity_id).toBe(OPPORTUNITY_UUID);
      const { rows: [lead] } = await client.query('SELECT crm_opportunity_id FROM leads WHERE id = $1', [c.openLeadId]);
      expect(lead.crm_opportunity_id).toBe(OPPORTUNITY_UUID);
    });

    test('abandon restores the archived ids and removes the run', async () => {
      const c = await richCustomer();
      await client.query('UPDATE leads SET crm_customer_id = $2, crm_opportunity_id = $3 WHERE id = $1', [c.openLeadId, CUSTOMER_UUID, DEV_OPPORTUNITY_UUID]);
      await start();
      expect((await client.query('SELECT crm_opportunity_id FROM leads WHERE id = $1', [c.openLeadId])).rows[0].crm_opportunity_id).toBeNull();
      expect((await client.query('SELECT * FROM crm_backfill_abandon($1)', [PREFIX])).rows[0]).toMatchObject({ restored_contacts: 1 });
      expect((await client.query('SELECT crm_opportunity_id FROM leads WHERE id = $1', [c.openLeadId])).rows[0].crm_opportunity_id).toBe(DEV_OPPORTUNITY_UUID);
      expect(await backfillRow(c.contactId)).toBeUndefined();
    });
  });

  describe('operator dry run', () => {
    test('counts per event type without writing anything', async () => {
      await richCustomer();
      const t = await insertConversation();
      await insertMessage(t.conversationId, { at: '2100-05-02T00:00:00Z' });
      const plan = opsSql('plan.sql')
        .replaceAll(":'id_prefix'", `'${PREFIX}'`).replaceAll(":'allowlist'", "''")
        .replaceAll(":'test_phones'", `'${t.phone}'`).replaceAll(":'cutoff'", `'${CUTOFF}'`)
        .replaceAll(":'handoffs_enabled'", "'true'");
      const { rows } = await client.query(plan);
      const counts = Object.fromEntries(rows.map((row) => [row.item, Number(row.count)]));
      expect(counts).toMatchObject({
        contacts_pending: expect.any(Number), contacts_skipped_test_phone: expect.any(Number),
        'lead.qualified:lost': expect.any(Number), 'lead.qualified:open': expect.any(Number),
        'handoff.created:resolved': expect.any(Number), 'handoff.created:open': expect.any(Number),
        'message.new': expect.any(Number), 'ownership.taken': expect.any(Number),
      });
      expect(counts.contacts_skipped_test_phone).toBeGreaterThanOrEqual(1);
      expect((await client.query('SELECT COUNT(*)::int AS n FROM crm_backfill_runs')).rows[0].n).toBe(0);
    });
  });
});
