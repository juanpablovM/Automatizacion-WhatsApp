// =============================================================================
// CRM outbox under protocol revision 1.2 (migration 039): the full
// lead.qualified record with record-hash corrections, and the message.new
// stage. Every test runs inside a transaction that is rolled back, with rows
// created in 2100 and a matching CRM_EVENTS_SINCE so other suites never mix in.
// =============================================================================
import fs from 'node:fs';
import { createRequire } from 'node:module';
import pg from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'vitest';

const require = createRequire(import.meta.url);
const { buildLeadQualifiedEvent, buildMessageNewEvent } = require('../fixtures/workflow-nodes/crm-events-dispatcher/crm-events-runtime.js');
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
const selectLeadsSql = fs.readFileSync(`${sqlDir}/01_select_lead_qualified_candidates.sql`, 'utf8');
const insertLeadSql = fs.readFileSync(`${sqlDir}/02_insert_lead_qualified_event.sql`, 'utf8');
const claimSql = fs.readFileSync(`${sqlDir}/03_claim_crm_events.sql`, 'utf8');
const completeSql = fs.readFileSync(`${sqlDir}/04_complete_crm_event.sql`, 'utf8');
const selectMessagesSql = fs.readFileSync(`${sqlDir}/05_select_message_candidates.sql`, 'utf8');
const insertMessagesSql = fs.readFileSync(`${sqlDir}/06_insert_message_events.sql`, 'utf8');

const SINCE = '2100-01-01T00:00:00.000Z';
const SELLER_UUID = '6f1c2a34-5b6d-4e7f-8a9b-0c1d2e3f4a5b';
const CUSTOMER_UUID = '11111111-2222-4333-8444-555555555555';
const OPPORTUNITY_UUID = '66666666-7777-4888-9999-aaaaaaaaaaaa';
const CONFIG_11 = { protocol_revision: '1.1', id_prefix: 'test' };
const CONFIG_12 = { protocol_revision: '1.2', id_prefix: 'test' };

describeIntegration('CRM outbox, revision 1.2', () => {
  const client = new pg.Client(connection);
  let leadStatusId;
  let conversationStatusId;
  let sellerId;
  let sourceNumberId;
  let sequence = 0;

  beforeAll(async () => { await client.connect(); });
  afterAll(async () => { await client.end(); });

  beforeEach(async () => {
    await client.query('BEGIN');
    ({ rows: [{ id: leadStatusId }] } = await client.query(
      `INSERT INTO lead_statuses (code, label, sort_order) VALUES ('assigned', 'Assigned', 2)
       ON CONFLICT (code) DO UPDATE SET code = EXCLUDED.code RETURNING id`,
    ));
    ({ rows: [{ id: conversationStatusId }] } = await client.query(
      `INSERT INTO conversation_statuses (code, label, sort_order) VALUES ('open', 'Open', 1)
       ON CONFLICT (code) DO UPDATE SET code = EXCLUDED.code RETURNING id`,
    ));
    ({ rows: [{ id: sellerId }] } = await client.query(
      `INSERT INTO sellers (name, is_active, sort_order, crm_user_id)
       VALUES ('CRM Seller', TRUE, 90000 + (random() * 9000)::int, $1) RETURNING id`,
      [SELLER_UUID],
    ));
    ({ rows: [{ id: sourceNumberId }] } = await client.query(
      `INSERT INTO whatsapp_numbers (display_name, phone_number, phone_number_id)
       VALUES ('Ventas', '56223456789', 'crm-12-' || gen_random_uuid()) RETURNING id`,
    ));
  });
  afterEach(async () => { await client.query('ROLLBACK'); });

  const insertLead = async ({ seller = sellerId, qualification = {} } = {}) => {
    sequence += 1;
    const phone = `5692${String(1000000 + sequence).slice(-7)}`;
    const { rows: [lead] } = await client.query(
      `INSERT INTO leads (whatsapp_name, phone_number, service, city, requirement, lead_status_id, assigned_seller_id,
                          source_number_id, qualification_context, created_at)
       VALUES ('Ana', $1, 'instalacion', 'Santiago', '50 bloques', $2, $3, $4, $5::jsonb, '2100-01-02T00:00:00Z') RETURNING id`,
      [phone, leadStatusId, seller, sourceNumberId, JSON.stringify(qualification)],
    );
    const { rows: [conversation] } = await client.query(
      `INSERT INTO conversations (lead_id, phone_number, conversation_status_id, source_number_id)
       VALUES ($1, $2, $3, $4) RETURNING id`,
      [lead.id, phone, conversationStatusId, sourceNumberId],
    );
    await client.query('UPDATE leads SET source_conversation_id = $2 WHERE id = $1', [lead.id, conversation.id]);
    return { leadId: String(lead.id), conversationId: String(conversation.id) };
  };

  // Stage A as the workflow chains it: select, build, insert.
  const runLeadEnqueue = async (config = CONFIG_12) => {
    const { rows: candidates } = await client.query(selectLeadsSql, [SINCE, '200', config.protocol_revision]);
    const results = [];
    for (const row of candidates) {
      const built = buildLeadQualifiedEvent(row, config);
      const isRevision12 = config.protocol_revision === '1.2';
      const { rows } = await client.query(insertLeadSql, [
        String(row.lead_id), String(built.revision ?? row.revision), built.event_id ?? '', built.conversation_id ?? '',
        built.body ?? '', String(row.requirement ?? ''), built.blocked_reason ?? '',
        isRevision12 ? built.record_hash ?? '' : '', isRevision12 ? String(row.crm_source_hash ?? '') : '',
      ]);
      results.push(...rows);
    }
    return { candidates, results };
  };

  const leadEventsOf = async (leadId) => (await client.query(
    "SELECT * FROM crm_events WHERE lead_id = $1 AND event_type = 'lead.qualified' ORDER BY revision", [leadId],
  )).rows;
  const leadOf = async (leadId) => (await client.query('SELECT * FROM leads WHERE id = $1', [leadId])).rows[0];
  const claim = async () => (await client.query(claimSql, ['500', '900'])).rows;
  const complete = async (row, outcome, extra = {}) => (await client.query(completeSql, [
    String(row.crm_event_id), row.claim_token, outcome,
    extra.http_status ?? '', extra.error ?? '', extra.response_json ?? '',
    extra.crm_customer_id ?? '', extra.crm_opportunity_id ?? '', String(extra.retry_delay_seconds ?? ''),
  ])).rows;

  describe('lead.qualified record', () => {
    test('sends the full record, with source number and AI summary, and passes the validator', async () => {
      const { leadId, conversationId } = await insertLead({
        qualification: { commune: 'Ñuñoa', invoice_required: true, line_items: [{ product: 'Adoquín', quantity: '120 m2' }] },
      });
      await client.query(
        `INSERT INTO advisor_decisions (conversation_id, lead_id, decision_type, output_payload)
         VALUES ($1, $2, 'qualification', $3::jsonb)`,
        [conversationId, leadId, JSON.stringify({ lead_class: 'A', executive_summary: 'Cliente listo' })],
      );
      await runLeadEnqueue();
      const [event] = await leadEventsOf(leadId);
      expect(validateCrmEvent(event.body)).toEqual([]);
      const { data } = JSON.parse(event.body);
      expect(data).toMatchObject({
        city: 'Santiago', commune: 'Ñuñoa', tax_document: 'factura', source_number: '+56223456789',
        items: [{ product: 'Adoquín', quantity: 120, unit: 'm2' }],
        ai_summary: { lead_class: 'A', executive_summary: 'Cliente listo' },
      });
      const lead = await leadOf(leadId);
      expect(lead.crm_enqueued_record_hash).toMatch(/^[0-9a-f]{64}$/);
      expect(lead.crm_checked_source_hash).toMatch(/^[0-9a-f]{32}$/);
      expect(lead.crm_enqueued_requirement).toBe('50 bloques');
    });

    test('re-running enqueues nothing new and does not reselect the lead', async () => {
      const { leadId } = await insertLead();
      await runLeadEnqueue();
      const { candidates } = await runLeadEnqueue();
      expect(candidates.map((row) => String(row.lead_id))).not.toContain(leadId);
      expect(await leadEventsOf(leadId)).toHaveLength(1);
    });

    test('a change in any business field (city, items) is a new revision', async () => {
      const { leadId } = await insertLead();
      await runLeadEnqueue();
      await client.query("UPDATE leads SET city = 'Valparaíso' WHERE id = $1", [leadId]);
      await runLeadEnqueue();
      await client.query(
        `UPDATE leads SET qualification_context = '{"line_items":[{"product":"Bloque","quantity":"80"}]}'::jsonb WHERE id = $1`, [leadId],
      );
      await runLeadEnqueue();
      const events = await leadEventsOf(leadId);
      expect(events.map((event) => event.revision)).toEqual([1, 2, 3]);
      expect(JSON.parse(events[1].body).data.city).toBe('Valparaíso');
      expect(JSON.parse(events[2].body).data.items).toEqual([{ product: 'Bloque', variant: null, quantity: 80, unit: null, measurements: null }]);
    });

    test('AI-summary churn and unmapped qualification keys do not create a revision', async () => {
      const { leadId, conversationId } = await insertLead();
      await runLeadEnqueue();
      await client.query(
        `INSERT INTO advisor_decisions (conversation_id, lead_id, decision_type, output_payload)
         VALUES ($1, $2, 'qualification', '{"executive_summary":"nuevo resumen"}'::jsonb)`,
        [conversationId, leadId],
      );
      await client.query(`UPDATE leads SET qualification_context = '{"photos":"si"}'::jsonb WHERE id = $1`, [leadId]);
      const { candidates } = await runLeadEnqueue();
      expect(candidates.map((row) => String(row.lead_id))).toContain(leadId);
      await runLeadEnqueue();
      expect(await leadEventsOf(leadId)).toHaveLength(1);
    });

    test('switching from 1.1 sends the full record once as the next revision; 1.1 after 1.2 sends nothing', async () => {
      const { leadId } = await insertLead({ qualification: { commune: 'Maipú' } });
      await runLeadEnqueue(CONFIG_11);
      await runLeadEnqueue(CONFIG_12);
      await runLeadEnqueue(CONFIG_12);
      await runLeadEnqueue(CONFIG_11);
      const events = await leadEventsOf(leadId);
      expect(events.map((event) => JSON.parse(event.body).protocol_revision)).toEqual(['1.1', '1.2']);
      expect(JSON.parse(events[1].body).data).toMatchObject({ revision: 2, commune: 'Maipú' });
    });

    test('a builder rejection blocks the lead once and records the source it saw', async () => {
      const { leadId } = await insertLead();
      await client.query("UPDATE leads SET phone_number = '123' WHERE id = $1", [leadId]);
      await runLeadEnqueue();
      expect(await leadEventsOf(leadId)).toHaveLength(0);
      expect((await leadOf(leadId)).crm_blocked_reason).toBe('invalid_phone');
      const { candidates } = await runLeadEnqueue();
      expect(candidates.map((row) => String(row.lead_id))).not.toContain(leadId);
      await client.query("UPDATE leads SET phone_number = '56922222222' WHERE id = $1", [leadId]);
      await runLeadEnqueue();
      expect(await leadEventsOf(leadId)).toHaveLength(1);
      expect((await leadOf(leadId)).crm_blocked_reason).toBeNull();
    });

    test('a stale snapshot (the lead changed after the select) inserts nothing', async () => {
      const { leadId } = await insertLead();
      const { rows: candidates } = await client.query(selectLeadsSql, [SINCE, '200', '1.2']);
      const row = candidates.find((candidate) => String(candidate.lead_id) === leadId);
      const built = buildLeadQualifiedEvent(row, CONFIG_12);
      await client.query("UPDATE leads SET city = 'Talca' WHERE id = $1", [leadId]);
      const [result] = (await client.query(insertLeadSql, [
        leadId, '1', built.event_id, built.conversation_id, built.body, '50 bloques', '', built.record_hash, row.crm_source_hash,
      ])).rows;
      expect(result.enqueued).toBe(false);
      expect(await leadEventsOf(leadId)).toHaveLength(0);
    });
  });

  describe('message.new', () => {
    const deliverLead = async (leadId) => {
      const mine = (await claim()).find((row) => row.event_id === `wa-test-lead-${leadId}-r1`);
      await complete(mine, 'delivered', { http_status: '200', crm_customer_id: CUSTOMER_UUID, crm_opportunity_id: OPPORTUNITY_UUID });
    };
    const announcedConversation = async (options) => {
      const ids = await insertLead(options);
      await runLeadEnqueue();
      await deliverLead(ids.leadId);
      return ids;
    };
    const insertMessage = async (conversationId, leadId, overrides = {}) => {
      const values = {
        direction: 'incoming', sender_type: 'customer', message_type: 'text', delivery_status: null,
        text_body: 'hola', created_at: '2100-01-02T10:00:00Z', external_timestamp: null, ...overrides,
      };
      const { rows: [row] } = await client.query(
        `INSERT INTO messages (conversation_id, lead_id, direction, sender_type, message_type, delivery_status, text_body,
                               created_at, external_timestamp, raw_payload)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb) RETURNING id`,
        [conversationId, leadId, values.direction, values.sender_type, values.message_type, values.delivery_status,
          values.text_body, values.created_at, values.external_timestamp, JSON.stringify(values.raw_payload ?? {})],
      );
      return String(row.id);
    };
    const selectMessages = async (revision = '1.2', batch = '500') => (await client.query(selectMessagesSql, [revision, SINCE, 'test', batch])).rows;
    const runMessageEnqueue = async (revision = '1.2', batch = '500') => {
      const candidates = await selectMessages(revision, batch);
      const events = candidates.map((row) => {
        const built = buildMessageNewEvent(row, { protocol_revision: revision, id_prefix: 'test' });
        return { message_id: Number(row.message_id), event_id: built.event_id, conversation_id: built.conversation_id, body: built.body, blocked_reason: built.blocked_reason };
      });
      if (events.length === 0) return { candidates, result: null };
      const { rows: [result] } = await client.query(insertMessagesSql, [JSON.stringify(events)]);
      return { candidates, result };
    };
    const messageEventOf = async (messageId) => (await client.query(
      "SELECT * FROM crm_events WHERE message_id = $1 AND event_type = 'message.new'", [messageId],
    )).rows[0];
    const blockOf = async (messageId) => (await client.query('SELECT * FROM crm_message_blocks WHERE message_id = $1', [messageId])).rows[0];

    test('enqueues each sender with the exact body, once, ordered by creation', async () => {
      const { leadId, conversationId } = await announcedConversation();
      const customer = await insertMessage(conversationId, leadId, { external_timestamp: '2100-01-02T09:59:58.5-03:00' });
      const bot = await insertMessage(conversationId, leadId, {
        direction: 'outgoing', sender_type: 'bot', delivery_status: 'sent', text_body: 'Hola Ana', created_at: '2100-01-02T10:00:01Z',
      });
      const seller = await insertMessage(conversationId, leadId, {
        direction: 'outgoing', sender_type: 'human', delivery_status: 'sent', message_type: 'image', text_body: 'foto', created_at: '2100-01-02T10:00:02Z',
      });
      const system = await insertMessage(conversationId, leadId, {
        direction: 'outgoing', sender_type: 'system', delivery_status: 'sent', created_at: '2100-01-02T10:00:03Z',
      });
      const candidates = await selectMessages();
      expect(candidates.map((row) => String(row.message_id))).toEqual([customer, bot, seller, system]);

      const { result } = await runMessageEnqueue();
      expect(result.enqueued).toBe(4);
      await runMessageEnqueue();

      const customerEvent = await messageEventOf(customer);
      expect(customerEvent).toMatchObject({ event_id: `wa-test-message-${customer}-e1`, lead_id: null, revision: 1, status: 'pending' });
      expect(customerEvent.conversation_id).toBe(`wa-test-conversation-${conversationId}`);
      const bodies = await Promise.all([customer, bot, seller, system].map(async (id) => JSON.parse((await messageEventOf(id)).body)));
      for (const body of bodies) expect(validateCrmEvent(body)).toEqual([]);
      expect(bodies.map((body) => body.data.sender)).toEqual(['customer', 'bot', 'seller', 'system']);
      expect(bodies[0].data.sent_at).toBe('2100-01-02T12:59:58.500Z');
      expect(bodies[1].data.sent_at).toBe('2100-01-02T10:00:01.000Z');
      expect(bodies[2].data).toMatchObject({ text: '[image]\nfoto', crm_seller_id: SELLER_UUID });
      expect((await client.query("SELECT count(*)::int AS n FROM crm_events WHERE event_type = 'message.new' AND message_id = ANY($1::bigint[])",
        [[customer, bot, seller, system]])).rows[0].n).toBe(4);
    });

    test('selects nothing under 1.1', async () => {
      const { leadId, conversationId } = await announcedConversation();
      await insertMessage(conversationId, leadId);
      expect(await selectMessages('1.1')).toHaveLength(0);
    });

    test('skips unsent outgoing, deleted, pre-SINCE messages and conversations whose lead is not delivered', async () => {
      const { leadId, conversationId } = await announcedConversation();
      const pending = await insertLead();
      await runLeadEnqueue();
      const queued = await insertMessage(conversationId, leadId, { direction: 'outgoing', sender_type: 'bot', delivery_status: 'queued' });
      const failed = await insertMessage(conversationId, leadId, { direction: 'outgoing', sender_type: 'bot', delivery_status: 'failed' });
      const old = await insertMessage(conversationId, leadId, { created_at: '2099-12-31T23:00:00Z' });
      const deleted = await insertMessage(conversationId, leadId);
      await client.query('UPDATE messages SET deleted_at = NOW() WHERE id = $1', [deleted]);
      const notAnnounced = await insertMessage(pending.conversationId, pending.leadId);
      const ids = (await selectMessages()).map((row) => String(row.message_id));
      for (const id of [queued, failed, old, deleted, notAnnounced]) expect(ids).not.toContain(id);
    });

    test('a document carries its file name from the attachment', async () => {
      const { leadId, conversationId } = await announcedConversation();
      const doc = await insertMessage(conversationId, leadId, { message_type: 'document', text_body: null });
      await client.query("INSERT INTO message_attachments (message_id, attachment_type, filename) VALUES ($1, 'document', 'oc-118.pdf')", [doc]);
      const outgoingDoc = await insertMessage(conversationId, leadId, {
        direction: 'outgoing', sender_type: 'bot', delivery_status: 'sent', message_type: 'document', text_body: null,
        raw_payload: { fileName: 'ficha-adoquin.pdf', media: 'AAAA' },
      });
      await runMessageEnqueue();
      expect(JSON.parse((await messageEventOf(doc)).body).data.text).toBe('[document] oc-118.pdf');
      expect(JSON.parse((await messageEventOf(outgoingDoc)).body).data.text).toBe('[document] ficha-adoquin.pdf');
    });

    test('a seller reply with an unmapped seller is blocked until the seller is mapped', async () => {
      const { leadId, conversationId } = await announcedConversation();
      await client.query('UPDATE sellers SET crm_user_id = NULL WHERE id = $1', [sellerId]);
      const reply = await insertMessage(conversationId, leadId, { direction: 'outgoing', sender_type: 'human', delivery_status: 'sent' });
      const after = await insertMessage(conversationId, leadId, { created_at: '2100-01-02T11:00:00Z' });
      await runMessageEnqueue();
      expect(await messageEventOf(reply)).toBeUndefined();
      expect(await blockOf(reply)).toMatchObject({ reason: 'seller_not_mapped' });
      expect(await messageEventOf(after)).toBeDefined();

      await client.query('UPDATE sellers SET crm_user_id = $2 WHERE id = $1', [sellerId, SELLER_UUID]);
      await runMessageEnqueue();
      expect(JSON.parse((await messageEventOf(reply)).body).data).toMatchObject({ sender: 'seller', crm_seller_id: SELLER_UUID });
      expect(await blockOf(reply)).toBeUndefined();
    });

    test('blocked messages go last so they cannot starve the batch', async () => {
      const { leadId, conversationId } = await announcedConversation();
      await client.query('UPDATE sellers SET crm_user_id = NULL WHERE id = $1', [sellerId]);
      await insertMessage(conversationId, leadId, { direction: 'outgoing', sender_type: 'human', delivery_status: 'sent', created_at: '2100-01-02T09:00:00Z' });
      await runMessageEnqueue();
      const fresh = await insertMessage(conversationId, leadId, { created_at: '2100-01-02T12:00:00Z' });
      const rows = await selectMessages('1.2', '1');
      expect(rows.map((row) => String(row.message_id))).toEqual([fresh]);
    });

    test('a claimed message.new is delivered without touching the lead', async () => {
      const { leadId, conversationId } = await announcedConversation();
      const messageId = await insertMessage(conversationId, leadId);
      await runMessageEnqueue();
      const claimed = (await claim()).find((row) => row.event_id === `wa-test-message-${messageId}-e1`);
      expect(claimed).toMatchObject({ event_type: 'message.new', lead_id: null });
      const before = await leadOf(leadId);
      const [result] = await complete(claimed, 'delivered', { http_status: '200', response_json: '{"status":"created"}' });
      expect(result).toMatchObject({ status: 'delivered', lead_updated: false });
      const after = await leadOf(leadId);
      expect(after.crm_revision).toBe(before.crm_revision);
      expect(after.crm_opportunity_id).toBe(before.crm_opportunity_id);
    });
  });

  describe('migration 039 constraints', () => {
    const tryQuery = async (sql, params) => {
      await client.query('SAVEPOINT attempt');
      try {
        await client.query(sql, params);
        await client.query('RELEASE SAVEPOINT attempt');
        return null;
      } catch (error) {
        await client.query('ROLLBACK TO SAVEPOINT attempt');
        return error;
      }
    };

    test('lead.qualified needs a lead and message.new needs a message, once per message', async () => {
      const { leadId, conversationId } = await insertLead();
      const { rows: [{ id: messageId }] } = await client.query(
        `INSERT INTO messages (conversation_id, lead_id, direction, sender_type, message_type, text_body)
         VALUES ($1, $2, 'incoming', 'customer', 'text', 'hola') RETURNING id`, [conversationId, leadId],
      );
      expect(await tryQuery(
        "INSERT INTO crm_events (event_id, event_type, conversation_id, revision, body) VALUES ('x-1', 'lead.qualified', 'c', 1, '{}')",
      )).toMatchObject({ message: expect.stringMatching(/crm_events_identity_check/) });
      expect(await tryQuery(
        "INSERT INTO crm_events (event_id, event_type, conversation_id, revision, body) VALUES ('x-2', 'message.new', 'c', 1, '{}')",
      )).toMatchObject({ message: expect.stringMatching(/crm_events_identity_check/) });
      expect(await tryQuery(
        "INSERT INTO crm_events (event_id, event_type, conversation_id, message_id, revision, body) VALUES ('x-3', 'message.new', 'c', $1, 1, '{}')",
        [messageId],
      )).toBeNull();
      expect(await tryQuery(
        "INSERT INTO crm_events (event_id, event_type, conversation_id, message_id, revision, body) VALUES ('x-4', 'message.new', 'c', $1, 1, '{}')",
        [messageId],
      )).toMatchObject({ message: expect.stringMatching(/crm_events_message_type_key/) });
      expect(await tryQuery("UPDATE crm_events SET message_id = NULL WHERE event_id = 'x-3'"))
        .toMatchObject({ message: expect.stringMatching(/immutable/) });
    });
  });
});
