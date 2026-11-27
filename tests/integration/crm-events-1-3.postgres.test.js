// =============================================================================
// CRM dispatcher under protocol revision 1.3 (U3: S2, S3, S10): the
// contact.upserted stage (select 11, insert 12, migration 055), the ordering
// rule (a contact's other 1.3 events wait for its contact.upserted under the
// current id prefix), the root contact_id on every 1.3 body and in
// crm_events.contact_id, and 1.2 unchanged. Feature document:
// odd/tasks/crm-1-3-customer-threads.md. Every test runs inside a transaction
// that is rolled back, with rows created in 2100 and a matching
// CRM_EVENTS_SINCE so other suites never mix in.
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
const selectLeadsSql = sql('01_select_lead_qualified_candidates.sql');
const insertLeadSql = sql('02_insert_lead_qualified_event.sql');
const claimSql = sql('03_claim_crm_events.sql');
const completeSql = sql('04_complete_crm_event.sql');
const selectMessagesSql = sql('05_select_message_candidates.sql');
const insertMessagesSql = sql('06_insert_message_events.sql');
const selectOwnershipSql = sql('07_select_ownership_candidates.sql');
const insertOwnershipSql = sql('08_insert_ownership_events.sql');
const selectHandoffsSql = sql('09_select_handoff_candidates.sql');
const insertHandoffsSql = sql('10_insert_handoff_events.sql');
const selectContactsSql = sql('11_select_contact_candidates.sql');
const insertContactsSql = sql('12_insert_contact_events.sql');

const SINCE = '2100-01-01T00:00:00.000Z';
const SELLER_UUID = '6f1c2a34-5b6d-4e7f-8a9b-0c1d2e3f4a5b';
const CUSTOMER_UUID = '11111111-2222-4333-8444-555555555555';
const OPPORTUNITY_UUID = '66666666-7777-4888-9999-aaaaaaaaaaaa';
const config = (revision, prefix = 'test') => ({ protocol_revision: revision, id_prefix: prefix, handoffs_enabled: true });
const C12 = config('1.2');
const C13 = config('1.3');

describeIntegration('CRM dispatcher, revision 1.3', () => {
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
       VALUES ('Ventas', '56223456789', 'crm-13-' || gen_random_uuid()) RETURNING id`,
    ));
  });
  afterEach(async () => { await client.query('ROLLBACK'); });

  const nextPhone = () => {
    sequence += 1;
    return `5693${String(1000000 + sequence).slice(-7)}`;
  };

  const insertLead = async ({ phone = nextPhone(), name = 'Ana' } = {}) => {
    const { rows: [lead] } = await client.query(
      `INSERT INTO leads (whatsapp_name, phone_number, service, city, requirement, lead_status_id, assigned_seller_id,
                          source_number_id, created_at)
       VALUES ($1, $2, 'instalacion', 'Santiago', '50 bloques', $3, $4, $5, '2100-01-02T00:00:00Z') RETURNING id`,
      [name, phone, leadStatusId, sellerId, sourceNumberId],
    );
    const { rows: [conversation] } = await client.query(
      `INSERT INTO conversations (lead_id, phone_number, conversation_status_id, source_number_id, created_at)
       VALUES ($1, $2, $3, $4, '2100-01-02T00:00:00Z') RETURNING id`,
      [lead.id, phone, conversationStatusId, sourceNumberId],
    );
    await client.query('UPDATE leads SET source_conversation_id = $2 WHERE id = $1', [lead.id, conversation.id]);
    const { rows: [{ id: contactId }] } = await client.query(
      'SELECT crm_contact_ref($1, $2) AS id', [sourceNumberId, phone],
    );
    return { leadId: String(lead.id), conversationId: String(conversation.id), contactId: String(contactId), phone };
  };

  const insertConversationOnly = async ({ phone = nextPhone(), createdAt = '2100-01-02T00:00:00Z' } = {}) => {
    const { rows: [conversation] } = await client.query(
      `INSERT INTO conversations (phone_number, conversation_status_id, source_number_id, created_at)
       VALUES ($1, $2, $3, $4) RETURNING id`,
      [phone, conversationStatusId, sourceNumberId, createdAt],
    );
    const { rows: [{ id: contactId }] } = await client.query('SELECT crm_contact_ref($1, $2) AS id', [sourceNumberId, phone]);
    return { conversationId: String(conversation.id), contactId: String(contactId), phone };
  };

  const insertMessage = async (conversationId, overrides = {}) => (await client.query(
    `INSERT INTO messages (conversation_id, direction, sender_type, message_type, text_body, raw_payload, created_at)
     VALUES ($1, $2, $3, 'text', $4, $5::jsonb, '2100-01-03T00:00:00Z') RETURNING id`,
    [conversationId, overrides.direction ?? 'incoming', overrides.sender_type ?? 'customer', overrides.text ?? 'Hola',
      JSON.stringify(overrides.raw_payload ?? {})],
  )).rows[0].id;

  // Stage F as the workflow chains it: select, build, insert.
  const runContacts = async (cfg = C13, allowlist = '') => {
    const { rows: candidates } = await client.query(selectContactsSql, [cfg.protocol_revision, SINCE, cfg.id_prefix, allowlist, '500']);
    const events = candidates.map((row) => {
      const built = buildContactUpsertedEvent(row, cfg);
      return { contact_id: Number(row.contact_id), revision: built.revision ?? Number(row.revision), event_id: built.event_id, body: built.body, blocked_reason: built.blocked_reason };
    });
    const { rows: [result] } = await client.query(insertContactsSql, [JSON.stringify(events)]);
    return { candidates, result };
  };

  const runLeads = async (cfg = C13, allowlist = '') => {
    const { rows: candidates } = await client.query(selectLeadsSql, [SINCE, '200', cfg.protocol_revision, allowlist]);
    const built = [];
    for (const row of candidates) {
      const event = buildLeadQualifiedEvent(row, cfg);
      built.push(event);
      if (isCrmEventDeferred(event)) continue;
      const structured = cfg.protocol_revision !== '1.1';
      await client.query(insertLeadSql, [
        String(row.lead_id), String(event.revision ?? row.revision), event.event_id ?? '', event.conversation_id ?? '',
        event.body ?? '', String(row.requirement ?? ''), event.blocked_reason ?? '',
        structured ? event.record_hash ?? '' : '', structured ? String(row.crm_source_hash ?? '') : '',
      ]);
    }
    return { candidates, built };
  };

  const runMessages = async (cfg = C13) => {
    const { rows: candidates } = await client.query(selectMessagesSql, [cfg.protocol_revision, SINCE, cfg.id_prefix, '500']);
    const events = candidates.map((row) => ({ row, built: buildMessageNewEvent(row, cfg) }))
      .filter(({ built }) => !isCrmEventDeferred(built))
      .map(({ row, built }) => ({ message_id: Number(row.message_id), event_id: built.event_id, conversation_id: built.conversation_id, body: built.body, blocked_reason: built.blocked_reason }));
    await client.query(insertMessagesSql, [JSON.stringify(events)]);
    return candidates;
  };

  const runOwnership = async (cfg = C13) => {
    const { rows: candidates } = await client.query(selectOwnershipSql, [cfg.protocol_revision, SINCE, cfg.id_prefix, '500']);
    const events = candidates.map((row) => ({ row, built: buildOwnershipEvent(row, cfg) }))
      .filter(({ built }) => !isCrmEventDeferred(built))
      .map(({ row, built }) => ({ change_id: Number(row.change_id), event_id: built.event_id, conversation_id: built.conversation_id, event_type: built.body ? JSON.parse(built.body).type : null, body: built.body, blocked_reason: built.blocked_reason }));
    await client.query(insertOwnershipSql, [JSON.stringify(events)]);
    return candidates;
  };

  // The test phone goes to the test seller (p5/p6), so no rotation is needed.
  const runHandoffs = async (testPhone, cfg = C13) => {
    const { rows: candidates } = await client.query(selectHandoffsSql, ['true', SINCE, '200', '', testPhone, String(sellerId)]);
    const events = candidates.map((row) => ({ row, built: buildHandoffCreatedEvent(row, cfg) }))
      .filter(({ built }) => !isCrmEventDeferred(built))
      .map(({ row, built }) => ({
        handoff_id: Number(row.handoff_id), revision: built.revision ?? Number(row.revision), event_id: built.event_id,
        conversation_id: built.conversation_id, body: built.body, blocked_reason: built.blocked_reason,
        crm_opportunity_id: row.crm_opportunity_id, crm_seller_id: row.crm_seller_id,
      }));
    await client.query(insertHandoffsSql, [JSON.stringify(events)]);
    return candidates;
  };

  const eventsOf = async (where, params) => (await client.query(`SELECT * FROM crm_events WHERE ${where} ORDER BY id`, params)).rows;
  const contactEvents = (contactId) => eventsOf("contact_id = $1 AND event_type = 'contact.upserted'", [contactId]);

  // Deliver everything pending with the given response per event type.
  const deliverAll = async () => {
    const claimed = (await client.query(claimSql, ['500', '900'])).rows;
    for (const row of claimed) {
      const responses = {
        'lead.qualified': { event_id: row.event_id, crm_customer_id: CUSTOMER_UUID, crm_opportunity_id: OPPORTUNITY_UUID, status: 'created' },
        'contact.upserted': { event_id: row.event_id, result: 'applied' },
      };
      const classified = classifyCrmResponse({ statusCode: 200, body: JSON.stringify(responses[row.event_type] ?? {}) }, row.event_id, row.event_type);
      await client.query(completeSql, [
        String(row.crm_event_id), row.claim_token, classified.outcome, String(classified.http_status ?? ''), classified.error ?? '',
        classified.response_json ?? '', classified.crm_customer_id ?? '', classified.crm_opportunity_id ?? '', '',
      ]);
    }
    return claimed;
  };

  describe('contact.upserted stage', () => {
    test('enqueues one contact.upserted per contact, with no conversation, and is idempotent', async () => {
      const { contactId, phone } = await insertLead({ name: '  Ana Soto ' });
      await runContacts();
      await runContacts();
      const events = await contactEvents(contactId);
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ revision: 1, conversation_id: null, id_prefix: 'test', status: 'pending', event_id: `wa-test-contact-${contactId}-r1` });
      expect(JSON.parse(events[0].body)).toEqual({
        schema_version: 1, protocol_revision: '1.3', event_id: `wa-test-contact-${contactId}-r1`, type: 'contact.upserted',
        contact_id: `wa-test-contact-${contactId}`, data: { revision: 1, phone: `+${phone}`, name: 'Ana Soto' },
      });
      expect(validateCrmEvent(events[0].body)).toEqual([]);
    });

    test('a name change is the next revision; an unchanged name is not', async () => {
      const { leadId, contactId } = await insertLead({ name: 'Ana' });
      await runContacts();
      await client.query("UPDATE leads SET whatsapp_name = 'Ana María' WHERE id = $1", [leadId]);
      await runContacts();
      await runContacts();
      const events = await contactEvents(contactId);
      expect(events.map((event) => [event.revision, JSON.parse(event.body).data.name])).toEqual([[1, 'Ana'], [2, 'Ana María']]);
    });

    test('without a lead name it uses the newest incoming pushName, else null', async () => {
      const { conversationId, contactId } = await insertConversationOnly();
      await runContacts();
      await insertMessage(conversationId, { raw_payload: { data: { pushName: 'Pedro' } } });
      await runContacts();
      const events = await contactEvents(contactId);
      expect(events.map((event) => JSON.parse(event.body).data.name)).toEqual([null, 'Pedro']);
    });

    test('a new id prefix starts the contact again at revision 1; the old prefix is untouched', async () => {
      const { contactId } = await insertLead();
      await runContacts(config('1.3', 'test'));
      await runContacts(config('1.3', 'prodx'));
      await runContacts(config('1.3', 'prodx'));
      const events = await contactEvents(contactId);
      expect(events.map((event) => [event.id_prefix, event.revision])).toEqual([['test', 1], ['prodx', 1]]);
    });

    test('respects the allowlist and CRM_EVENTS_SINCE, and does nothing under 1.2', async () => {
      const listed = await insertLead();
      const other = await insertLead();
      const old = await insertConversationOnly({ createdAt: '2099-06-01T00:00:00Z' });
      const { rows: under12 } = await client.query(selectContactsSql, ['1.2', SINCE, 'test', '', '500']);
      expect(under12).toEqual([]);
      const { candidates } = await runContacts(C13, listed.phone);
      expect(candidates.map((row) => String(row.contact_id))).toEqual([listed.contactId]);
      await runContacts();
      expect(await contactEvents(other.contactId)).toHaveLength(1);
      expect(await contactEvents(old.contactId)).toHaveLength(0);
    });

    test('an invalid phone blocks the contact (last in the batch) and stores no event', async () => {
      const bad = await insertConversationOnly({ phone: '123' });
      const good = await insertConversationOnly();
      await runContacts();
      expect(await contactEvents(bad.contactId)).toHaveLength(0);
      const { rows: [row] } = await client.query('SELECT crm_blocked_reason FROM crm_contacts WHERE id = $1', [bad.contactId]);
      expect(row.crm_blocked_reason).toBe('invalid_phone');
      const { candidates } = await runContacts();
      expect(candidates.map((candidate) => String(candidate.contact_id)).at(-1)).toBe(bad.contactId);
      expect(await contactEvents(good.contactId)).toHaveLength(1);
    });

    test('a stale proposal (revision already taken) inserts nothing', async () => {
      const { contactId } = await insertLead();
      const { rows: [candidate] } = await client.query(selectContactsSql, ['1.3', SINCE, 'test', '', '500']);
      const built = buildContactUpsertedEvent(candidate, C13);
      const payload = JSON.stringify([{ contact_id: Number(contactId), revision: built.revision, event_id: built.event_id, body: built.body, blocked_reason: null }]);
      const first = (await client.query(insertContactsSql, [payload])).rows[0];
      const second = (await client.query(insertContactsSql, [payload])).rows[0];
      expect([first.enqueued, second.enqueued]).toEqual([1, 0]);
    });

    test('a contact.upserted 200 applied is delivered', async () => {
      const { contactId } = await insertLead();
      await runContacts();
      await deliverAll();
      const [event] = await contactEvents(contactId);
      expect(event).toMatchObject({ status: 'delivered', last_error: null });
    });
  });

  describe('ordering rule and contact_id on the other stages', () => {
    // Independent verification of U3 (B1): a handoff whose contact row is
    // missing (a skipped contact trigger) is delayed, never lost.
    test('a handoff whose contact row is missing is delayed, never lost', async () => {
      const { conversationId, phone } = await insertConversationOnly();
      const { rows: [{ id: handoffId }] } = await client.query(
        `INSERT INTO handoffs (idempotency_key, conversation_id, phone_number, source_number_id, motivo, area, area_label,
                               prioridad, responsable, estado, created_at)
         VALUES ('crm-13-' || gen_random_uuid(), $1, $2, $3, 'talk_human', 'sales', 'Ventas', 'alta', 'Ejecutiva comercial', 'pending', '2100-01-03T00:00:00Z')
         RETURNING id`, [conversationId, phone, sourceNumberId]);
      await client.query('DELETE FROM crm_contacts WHERE source_number_id = $1 AND phone_number = $2', [sourceNumberId, phone]);
      for (let pass = 0; pass < 3; pass += 1) { await runHandoffs(phone); await runContacts(); }
      const [event] = await eventsOf('handoff_id = $1', [handoffId]);
      expect(event).toBeDefined();
      expect(JSON.parse(event.body).contact_id).toBe(`wa-test-contact-${event.contact_id}`);
    });

    test('a lead waits (not blocked) until its contact is upserted, then carries contact_id', async () => {
      const { leadId, contactId, conversationId } = await insertLead();
      const first = await runLeads();
      expect(first.built.map((event) => event.blocked_reason)).toEqual(['contact_not_upserted']);
      expect(await eventsOf('lead_id = $1', [leadId])).toHaveLength(0);
      const { rows: [lead] } = await client.query('SELECT crm_blocked_reason, crm_checked_source_hash FROM leads WHERE id = $1', [leadId]);
      expect(lead).toEqual({ crm_blocked_reason: null, crm_checked_source_hash: null });

      await runContacts();
      await runLeads();
      const [event] = await eventsOf('lead_id = $1', [leadId]);
      expect(String(event.contact_id)).toBe(contactId);
      const body = JSON.parse(event.body);
      expect(body).toMatchObject({ protocol_revision: '1.3', conversation_id: `wa-test-conversation-${conversationId}`, contact_id: `wa-test-contact-${contactId}` });
      expect(validateCrmEvent(event.body)).toEqual([]);
    });

    test('a contact upserted only under another prefix still waits', async () => {
      const { leadId } = await insertLead();
      await runContacts(config('1.3', 'prodx'));
      await runLeads(C13);
      expect(await eventsOf('lead_id = $1', [leadId])).toHaveLength(0);
    });

    test('message.new and ownership.* of an announced conversation carry contact_id under 1.3', async () => {
      const { conversationId, contactId } = await insertLead();
      await runContacts();
      await runLeads();
      await deliverAll();
      const messageId = await insertMessage(conversationId);
      await client.query(
        `INSERT INTO crm_ownership_changes (conversation_id, ownership_version, change_kind, seller_id, source, changed_at)
         VALUES ($1, 1, 'taken', $2, 'crm', '2100-01-03T00:00:00Z')`, [conversationId, sellerId],
      );
      await runMessages();
      await runOwnership();
      const [message] = await eventsOf("message_id = $1 AND event_type = 'message.new'", [messageId]);
      const [ownership] = await eventsOf("conversation_id = $1 AND event_type = 'ownership.taken'", [`wa-test-conversation-${conversationId}`]);
      for (const event of [message, ownership]) {
        expect(String(event.contact_id)).toBe(contactId);
        expect(JSON.parse(event.body)).toMatchObject({ protocol_revision: '1.3', contact_id: `wa-test-contact-${contactId}` });
        expect(validateCrmEvent(event.body)).toEqual([]);
      }
    });

    test('messages and ownership of a contact not upserted under this prefix are not selected', async () => {
      const { conversationId } = await insertLead();
      await runContacts(config('1.3', 'prodx'));
      // Announce the conversation under 'test' without a contact.upserted there.
      await client.query(
        `INSERT INTO crm_events (event_id, event_type, conversation_id, lead_id, revision, body, status)
         SELECT 'wa-test-lead-' || l.id || '-r1', 'lead.qualified', 'wa-test-conversation-' || $1, l.id, 1, '{}', 'delivered'
         FROM leads l WHERE l.source_conversation_id = $1::bigint`, [conversationId],
      );
      await insertMessage(conversationId);
      await client.query(
        `INSERT INTO crm_ownership_changes (conversation_id, ownership_version, change_kind, seller_id, source, changed_at)
         VALUES ($1, 1, 'taken', $2, 'crm', '2100-01-03T00:00:00Z')`, [conversationId, sellerId],
      );
      expect(await runMessages()).toEqual([]);
      expect(await runOwnership()).toEqual([]);
      const { rows: under12 } = await client.query(selectMessagesSql, ['1.2', SINCE, 'test', '500']);
      expect(under12).toHaveLength(1);
    });

    test('handoff.created waits for the contact, keeps its routing, then carries contact_id', async () => {
      const { conversationId, contactId, phone } = await insertConversationOnly();
      const { rows: [{ id: handoffId }] } = await client.query(
        `INSERT INTO handoffs (idempotency_key, conversation_id, phone_number, source_number_id, motivo, area, area_label,
                               prioridad, responsable, estado, created_at)
         VALUES ('crm-13-' || gen_random_uuid(), $1, $2, $3, 'talk_human', 'sales', 'Ventas', 'alta', 'Ejecutiva comercial', 'pending', '2100-01-03T00:00:00Z')
         RETURNING id`, [conversationId, phone, sourceNumberId],
      );
      const first = await runHandoffs(phone);
      expect(first.map((row) => String(row.contact_id))).toEqual([contactId]);
      expect(await eventsOf('handoff_id = $1', [handoffId])).toHaveLength(0);
      const { rows: [routed] } = await client.query('SELECT crm_routing_seller_id, crm_blocked_reason FROM handoffs WHERE id = $1', [handoffId]);
      expect(routed.crm_routing_seller_id).not.toBeNull();
      expect(routed.crm_blocked_reason).toBeNull();

      await runContacts();
      await runHandoffs(phone);
      const [event] = await eventsOf('handoff_id = $1', [handoffId]);
      expect(String(event.contact_id)).toBe(contactId);
      expect(JSON.parse(event.body)).toMatchObject({ protocol_revision: '1.3', contact_id: `wa-test-contact-${contactId}` });
      expect(validateCrmEvent(event.body)).toEqual([]);
    });
  });

  describe('1.2 unchanged', () => {
    test('1.2 events store no contact_id and their bodies carry none', async () => {
      const { leadId, conversationId } = await insertLead();
      await runLeads(C12);
      await deliverAll();
      const messageId = await insertMessage(conversationId);
      await runMessages(C12);
      const events = [...await eventsOf('lead_id = $1', [leadId]), ...await eventsOf('message_id = $1', [messageId])];
      expect(events).toHaveLength(2);
      for (const event of events) {
        expect(event.contact_id).toBeNull();
        expect(JSON.parse(event.body)).not.toHaveProperty('contact_id');
        expect(JSON.parse(event.body).protocol_revision).toBe('1.2');
      }
    });
  });
});
