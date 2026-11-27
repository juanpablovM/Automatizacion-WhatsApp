// =============================================================================
// CRM -> bot 1.3 (migration 058): chat.take / chat.release / message.send
// keyed by customer (S6), the per-contact counter in command responses (S8)
// and contact.opportunity_linked with its effect on handoff routing and
// lead.qualified (S7).
//
// The SQL is the exact node queries: crm-inbound-events 07, 08 and 03 (1.3),
// 01/02/04/05 (1.2, unchanged), crm-events-dispatcher 01 and 09. Every test
// runs inside a transaction that is rolled back, except the two-client race,
// which commits its own rows and deletes them.
// Feature document: odd/tasks/crm-1-3-customer-threads.md (S6, S7, S8).
// =============================================================================
import crypto from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import pg from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'vitest';

const require = createRequire(import.meta.url);
const { buildLeadQualifiedEvent } = require('../fixtures/workflow-nodes/crm-events-dispatcher/crm-events-runtime.js');
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

const read = (file) => fs.readFileSync(file, 'utf8');
const applyChatSql = read('db/queries/n8n/crm-inbound-events/01_apply_crm_chat_event.sql');
const completeSendSql = read('db/queries/n8n/crm-inbound-events/03_complete_crm_message_send.sql');
const applyConversationChatSql = read('db/queries/n8n/crm-inbound-events/04_apply_crm_conversation_chat_event.sql');
const applyContactSql = read('db/queries/n8n/crm-inbound-events/07_apply_crm_contact_event.sql');
const claimContactSendSql = read('db/queries/n8n/crm-inbound-events/08_claim_crm_contact_message_send.sql');
const selectLeadsSql = read('db/queries/n8n/crm-events-dispatcher/01_select_lead_qualified_candidates.sql');
const selectHandoffsSql = read('db/queries/n8n/crm-events-dispatcher/09_select_handoff_candidates.sql');

const PREFIX = 'u7';
const SELLER_A = '1a1c2a34-5b6d-4e7f-8a9b-0c1d2e3f4a5b';
const SELLER_B = '2b2d3b45-6c7e-4f80-9bac-1d2e3f4a5b6c';
const ADMIN = '3c3e4c56-7d8f-4091-8cbd-2e3f4a5b6c7d';
const INACTIVE = '4d4f5d67-8e90-41a2-9dce-3f4a5b6c7d8e';
const OPPORTUNITY = '77777777-8888-4999-aaaa-bbbbbbbbbbbb';
const OTHER_OPPORTUNITY = '88888888-9999-4aaa-bbbb-cccccccccccc';
const hash = (value) => crypto.createHash('sha256').update(value).digest('hex');
const newEventId = () => `crm-evt-${crypto.randomUUID()}`;
const ALL_SELLERS = [SELLER_A, SELLER_B, ADMIN, INACTIVE];

describeIntegration('CRM 1.3 inbound by customer (migration 058)', () => {
  const client = new pg.Client(connection);
  let leadStatusId;
  let activeStatusId;
  let sellers;
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
    ({ rows: [{ id: activeStatusId }] } = await client.query(`SELECT id FROM conversation_statuses WHERE code = 'active'`));
    await client.query('UPDATE sellers SET crm_user_id = NULL WHERE crm_user_id = ANY($1::uuid[])', [ALL_SELLERS]);
    await client.query('UPDATE leads SET crm_opportunity_id = NULL WHERE crm_opportunity_id IN ($1, $2)', [OPPORTUNITY, OTHER_OPPORTUNITY]);
    const seller = async (name, uuid, { active = true, admin = false } = {}) => String((await client.query(
      `INSERT INTO sellers (name, is_active, crm_is_admin, sort_order, crm_user_id, clickup_user_id)
       VALUES ($1, $2, $3, 90000 + (random() * 9000)::int, $4, 'cu-' || gen_random_uuid()) RETURNING id`,
      [name, active, admin, uuid],
    )).rows[0].id);
    sellers = {
      a: await seller('Seller A', SELLER_A),
      b: await seller('Seller B', SELLER_B),
      admin: await seller('Admin', ADMIN, { active: false, admin: true }),
      inactive: await seller('Inactive', INACTIVE, { active: false }),
    };
    ({ rows: [{ id: sourceNumberId }] } = await client.query(
      `INSERT INTO whatsapp_numbers (display_name, phone_number, phone_number_id, instance_name)
       VALUES ('Ventas', '56223456789', 'crm-u7-' || gen_random_uuid(), 'inst-' || gen_random_uuid()) RETURNING id`,
    ));
  });
  afterEach(async () => { await client.query('ROLLBACK'); });

  // A customer still qualifying with the bot: conversations (oldest first),
  // one customer message in each, no lead, no handoff.
  const customer = async ({ conversations = 1, withLead = false, opportunity = null, db = client, source = sourceNumberId } = {}) => {
    sequence += 1;
    const phone = `5697${String(1000000 + sequence + Math.floor(Math.random() * 900000)).slice(-7)}`;
    const ids = [];
    for (let index = 0; index < conversations; index += 1) {
      const { rows: [{ id }] } = await db.query(
        `INSERT INTO conversations (phone_number, conversation_status_id, source_number_id, started_at)
         VALUES ($1, $2, $3, NOW() - make_interval(hours => $4)) RETURNING id`,
        [phone, activeStatusId, source, conversations - index],
      );
      await db.query(
        `INSERT INTO messages (conversation_id, direction, sender_type, message_type, text_body, raw_payload)
         VALUES ($1, 'incoming', 'customer', 'text', 'hola, quiero cotizar', '{}'::jsonb)`, [id],
      );
      ids.push(String(id));
    }
    let leadId = null;
    if (withLead) {
      ({ rows: [{ id: leadId }] } = await db.query(
        `INSERT INTO leads (whatsapp_name, phone_number, lead_status_id, source_number_id, crm_opportunity_id, channel,
                            assigned_seller_id, source_conversation_id)
         VALUES ('Ana', $1, $2, $3, $4, 'whatsapp', $5, $6) RETURNING id`,
        [phone, leadStatusId, source, opportunity, sellers.a, ids[ids.length - 1]],
      ));
      await db.query('UPDATE conversations SET lead_id = $1 WHERE id = $2', [leadId, ids[ids.length - 1]]);
      leadId = String(leadId);
    }
    const contactId = String((await db.query('SELECT crm_contact_ref($1, $2) AS id', [source, phone])).rows[0].id);
    return {
      phone,
      conversations: ids,
      latest: ids[ids.length - 1],
      leadId,
      contactId,
      contactRef: `wa-${PREFIX}-contact-${contactId}`,
      ref: (id) => `wa-${PREFIX}-conversation-${id}`,
    };
  };

  // One 1.3 chat event through node 07. identity: { contact } | { conversation } | { opportunity }.
  const chat13 = async (identity, {
    eventId = newEventId(), type = 'chat.take', seller = SELLER_A, version = 0, bodyHash, db = client,
  } = {}) => {
    const { rows } = await db.query(applyContactSql, [
      eventId, bodyHash ?? hash(eventId), type,
      identity.opportunity ?? '',
      identity.conversation ? `wa-${PREFIX}-conversation-${identity.conversation}` : (identity.conversationRef ?? ''),
      identity.conversation ?? '',
      identity.contact ? `wa-${PREFIX}-contact-${identity.contact}` : (identity.contactRef ?? ''),
      identity.contact ?? '',
      PREFIX, seller, String(version),
    ]);
    expect(rows).toHaveLength(1);
    return { ...rows[0], eventId };
  };
  const link = async (contactId, {
    eventId = newEventId(), opportunity = OPPORTUNITY, seller = SELLER_A, bodyHash, contactRef,
  } = {}) => {
    const { rows } = await client.query(applyContactSql, [
      eventId, bodyHash ?? hash(eventId), 'contact.opportunity_linked', opportunity, '', '',
      contactRef ?? `wa-${PREFIX}-contact-${contactId}`, contactId ?? '', PREFIX, seller, '',
    ]);
    expect(rows).toHaveLength(1);
    return { ...rows[0], eventId };
  };
  const send13 = async (identity, {
    eventId = newEventId(), seller = SELLER_A, version = 0, clientMessageId = crypto.randomUUID(), text = 'Hola, soy Ana de Hormiglass',
  } = {}) => {
    const { rows } = await client.query(claimContactSendSql, [
      eventId, hash(`${eventId}|${clientMessageId}`), identity.opportunity ?? '',
      identity.conversation ? `wa-${PREFIX}-conversation-${identity.conversation}` : '', identity.conversation ?? '',
      identity.contact ? `wa-${PREFIX}-contact-${identity.contact}` : '', identity.contact ?? '',
      PREFIX, seller, clientMessageId, String(version), text,
    ]);
    expect(rows).toHaveLength(1);
    return { ...rows[0], eventId, text };
  };
  const complete = async (claimed) => (await client.query(completeSendSql, [
    String(claimed.outbound_id), String(claimed.attempt), 'sent', `BAE5${crypto.randomUUID().slice(0, 8).toUpperCase()}`,
    '201', '', PREFIX,
  ])).rows[0];

  const counterOf = async (contactId, db = client) => Number((await db.query(
    'SELECT ownership_version FROM crm_contacts WHERE id = $1', [contactId],
  )).rows[0].ownership_version);
  const conversationVersionOf = async (conversationId) => Number((await client.query(
    'SELECT ownership_version FROM crm_conversation_ownership WHERE conversation_id = $1', [conversationId],
  )).rows[0]?.ownership_version ?? 0);
  const liveLeases = async (c, db = client) => (await db.query(
    `SELECT * FROM lead_chat_ownerships
     WHERE (conversation_id = ANY($1::bigint[]) OR lead_id = $2) AND released_at IS NULL AND deleted_at IS NULL ORDER BY id`,
    [c.conversations, c.leadId],
  )).rows;
  const allLeases = async (c) => (await client.query(
    'SELECT * FROM lead_chat_ownerships WHERE conversation_id = ANY($1::bigint[]) OR lead_id = $2 ORDER BY id',
    [c.conversations, c.leadId],
  )).rows;
  const silenced = async (c) => (await client.query(
    'SELECT inbound_contact_seller_owned($1, $2) AS owned', [sourceNumberId, c.phone],
  )).rows[0].owned;
  const inboxOf = async (eventId) => (await client.query('SELECT * FROM crm_inbound_events WHERE event_id = $1', [eventId])).rows[0];
  const contactOf = async (contactId) => (await client.query('SELECT * FROM crm_contacts WHERE id = $1', [contactId])).rows[0];

  describe('S6: chat actions keyed by customer', () => {
    test('chat.take by contact_id takes a customer still qualifying: lease on the latest conversation, bot silenced', async () => {
      const c = await customer({ conversations: 2 });
      expect(await silenced(c)).toBe(false);
      const taken = await chat13({ contact: c.contactId });
      expect(taken).toMatchObject({
        http_status: 200, replayed: false,
        response: { event_id: taken.eventId, result: 'applied', ownership_version: 1 },
      });
      const leases = await liveLeases(c);
      expect(leases).toMatchObject([{
        lead_id: null, conversation_id: c.latest, acquired_via: 'crm', owner_seller_id: sellers.a, sla_mode: 'standard',
      }]);
      expect(await silenced(c)).toBe(true);
      expect(await counterOf(c.contactId)).toBe(1);
      expect(await inboxOf(taken.eventId)).toMatchObject({
        event_type: 'chat.take', http_status: 200, response: taken.response, conversation_id: c.latest, lead_id: null,
      });
    });

    test('a conversation_id of an older conversation acts on the customer, with no handoff needed', async () => {
      const c = await customer({ conversations: 2 });
      const taken = await chat13({ conversation: c.conversations[0] });
      expect(taken).toMatchObject({ http_status: 200, response: { result: 'applied', ownership_version: 1 } });
      expect(await liveLeases(c)).toMatchObject([{ conversation_id: c.latest, owner_seller_id: sellers.a }]);
      const released = await chat13({ contact: c.contactId }, { type: 'chat.release', version: 1 });
      expect(released).toMatchObject({ http_status: 200, response: { result: 'applied', ownership_version: 2 } });
      expect(await liveLeases(c)).toEqual([]);
      expect(await silenced(c)).toBe(false);
    });

    test('a customer with a lead: the lease is the latest lead\'s, by any of the three keys', async () => {
      const c = await customer({ withLead: true, opportunity: OPPORTUNITY });
      const taken = await chat13({ opportunity: OPPORTUNITY });
      expect(taken).toMatchObject({ http_status: 200, response: { result: 'applied', ownership_version: 1 } });
      expect(await liveLeases(c)).toMatchObject([{ lead_id: c.leadId, owner_seller_id: sellers.a }]);
      expect(await chat13({ contact: c.contactId }, { version: 1 }))
        .toMatchObject({ http_status: 200, response: { result: 'applied', ownership_version: 1 } });
      expect(await chat13({ conversation: c.latest }, { type: 'chat.release', version: 1 }))
        .toMatchObject({ http_status: 200, response: { result: 'applied', ownership_version: 2 } });
    });

    test('a CRM admin out of the rotation may take any customer; an inactive seller is 422 invalid_seller', async () => {
      const c = await customer();
      const bad = await chat13({ contact: c.contactId }, { seller: INACTIVE });
      expect(bad).toMatchObject({ http_status: 422, response: { error: 'invalid_seller', event_id: bad.eventId } });
      expect(await liveLeases(c)).toEqual([]);
      expect(await chat13({ contact: c.contactId }, { seller: ADMIN }))
        .toMatchObject({ http_status: 200, response: { result: 'applied', ownership_version: 1 } });
      expect(await liveLeases(c)).toMatchObject([{ owner_seller_id: sellers.admin }]);
    });

    test('holder rules unchanged: another seller is 409 ownership_conflict for take and release', async () => {
      const c = await customer();
      await chat13({ contact: c.contactId });
      for (const type of ['chat.take', 'chat.release']) {
        const conflict = await chat13({ conversation: c.latest }, { type, seller: SELLER_B, version: 1 });
        expect(conflict).toMatchObject({
          http_status: 409, response: { error: 'ownership_conflict', holder_crm_seller_id: SELLER_A, ownership_version: 1 },
        });
      }
      expect(await liveLeases(c)).toMatchObject([{ owner_seller_id: sellers.a }]);
      expect(await counterOf(c.contactId)).toBe(1);
    });

    test('a stale version changes nothing: ignored_stale, or 409 while another seller holds the chat', async () => {
      const c = await customer();
      await client.query('UPDATE crm_contacts SET ownership_version = 7 WHERE id = $1', [c.contactId]);
      const stale = await chat13({ contact: c.contactId }, { version: 6 });
      expect(stale).toMatchObject({ http_status: 200, response: { event_id: stale.eventId, result: 'ignored_stale', ownership_version: 7 } });
      expect(await allLeases(c)).toEqual([]);
      expect(await counterOf(c.contactId)).toBe(7);
      expect(await inboxOf(`1.3/${stale.eventId}`)).toBeUndefined();

      expect(await chat13({ contact: c.contactId }, { version: 7 }))
        .toMatchObject({ http_status: 200, response: { result: 'applied', ownership_version: 8 } });
      const conflict = await chat13({ contact: c.contactId }, { seller: SELLER_B, version: 3 });
      expect(conflict).toMatchObject({ http_status: 409, response: { error: 'ownership_conflict', holder_crm_seller_id: SELLER_A, ownership_version: 8 } });
      const staleRelease = await chat13({ contact: c.contactId }, { type: 'chat.release', version: 7 });
      expect(staleRelease).toMatchObject({ http_status: 200, response: { result: 'ignored_stale', ownership_version: 8 } });
      expect(await liveLeases(c)).toHaveLength(1);
      expect(await counterOf(c.contactId)).toBe(8);
    });

    test('S8: responses carry the contact counter, the 1.2 path keeps the conversation version', async () => {
      const c = await customer({ withLead: true, opportunity: OPPORTUNITY });
      await client.query('UPDATE crm_contacts SET ownership_version = 40 WHERE id = $1', [c.contactId]);
      const take12 = newEventId();
      expect((await client.query(applyChatSql, [take12, hash(take12), 'chat.take', OPPORTUNITY, SELLER_A, '0'])).rows[0])
        .toMatchObject({ http_status: 200, response: { result: 'applied', ownership_version: 1 } });
      expect(await counterOf(c.contactId)).toBe(41);
      expect(await chat13({ contact: c.contactId }, { type: 'chat.release', version: 41 }))
        .toMatchObject({ http_status: 200, response: { result: 'applied', ownership_version: 42 } });
      expect(await conversationVersionOf(c.latest)).toBe(2);
    });

    test('422 by identity: unknown_contact, unknown_conversation, invalid_opportunity; nothing stored but the answer', async () => {
      const c = await customer();
      const cases = [
        [{ contact: '999999999' }, 'unknown_contact'],
        [{ contactRef: 'wa-prod-contact-1' }, 'unknown_contact'],
        [{ conversation: '999999999' }, 'unknown_conversation'],
        [{ conversationRef: 'wa-prod-conversation-1' }, 'unknown_conversation'],
        [{ opportunity: OTHER_OPPORTUNITY }, 'invalid_opportunity'],
      ];
      for (const [identity, error] of cases) {
        const answer = await chat13(identity);
        expect(answer).toMatchObject({ http_status: 422, response: { error, event_id: answer.eventId } });
        expect(await inboxOf(answer.eventId)).toMatchObject({ http_status: 422 });
      }
      expect(await liveLeases(c)).toEqual([]);
    });

    test('same event_id and bytes replay the stored answer; other bytes are 409 event_conflict', async () => {
      const c = await customer();
      const first = await chat13({ contact: c.contactId });
      const again = await chat13({ contact: c.contactId }, { eventId: first.eventId });
      expect(again).toMatchObject({ http_status: 200, replayed: true, response: first.response });
      const other = await chat13({ contact: c.contactId }, { eventId: first.eventId, bodyHash: hash('other') });
      expect(other).toMatchObject({ http_status: 409, response: { error: 'event_conflict', event_id: first.eventId } });
      expect(await counterOf(c.contactId)).toBe(1);
    });

    test('message.send by contact_id: implicit take, claim, completion with the contact counter', async () => {
      const c = await customer({ conversations: 2 });
      await client.query('UPDATE crm_contacts SET ownership_version = 5 WHERE id = $1', [c.contactId]);
      const claimed = await send13({ contact: c.contactId });
      expect(claimed).toMatchObject({ send: true, attempt: 1, phone_number: c.phone, http_status: null });
      const outbound = (await client.query('SELECT * FROM crm_outbound_messages WHERE event_id = $1', [claimed.eventId])).rows[0];
      expect(outbound).toMatchObject({
        contact_id: c.contactId, conversation_id: c.latest, crm_conversation_ref: c.ref(c.latest), status: 'sending',
      });
      expect(await liveLeases(c)).toMatchObject([{ conversation_id: c.latest, owner_seller_id: sellers.a }]);
      const done = await complete(claimed);
      expect(done).toMatchObject({ http_status: 200, response: { event_id: claimed.eventId, result: 'sent', ownership_version: 6 } });
      expect(await inboxOf(claimed.eventId)).toMatchObject({ http_status: 200, response: done.response });
      const replay = await send13({ contact: c.contactId }, { eventId: claimed.eventId, clientMessageId: outbound.client_message_id });
      expect(replay).toMatchObject({ send: false, replayed: true, http_status: 200, response: done.response });
    });

    test('message.send while another seller holds the chat is 409 with the contact counter, stored as answered', async () => {
      const c = await customer();
      await chat13({ contact: c.contactId });
      const blocked = await send13({ conversation: c.latest }, { seller: SELLER_B, version: 1 });
      expect(blocked).toMatchObject({
        send: false, http_status: 409, response: { error: 'ownership_conflict', holder_crm_seller_id: SELLER_A, ownership_version: 1 },
      });
      expect(await inboxOf(blocked.eventId)).toMatchObject({ http_status: 409, response: blocked.response });
      const unknown = await send13({ contact: '999999999' });
      expect(unknown).toMatchObject({ send: false, http_status: 422, response: { error: 'unknown_contact' } });
    });

    test('1.2 regression: conversation_id without a delivered handoff is still 422 unknown_conversation', async () => {
      const c = await customer();
      const eventId = newEventId();
      const { rows: [answer] } = await client.query(applyConversationChatSql, [
        eventId, hash(eventId), 'chat.take', c.ref(c.latest), c.latest, SELLER_A, '0',
      ]);
      expect(answer).toMatchObject({ http_status: 422, response: { error: 'unknown_conversation' } });
      expect(await liveLeases(c)).toEqual([]);
    });
  });

  describe('S7: contact.opportunity_linked', () => {
    test('applied, then duplicate; the link is stored on the customer with its seller', async () => {
      const c = await customer();
      const applied = await link(c.contactId);
      expect(applied).toMatchObject({ http_status: 200, response: { event_id: applied.eventId, result: 'applied' } });
      expect(await contactOf(c.contactId)).toMatchObject({ crm_opportunity_id: OPPORTUNITY, crm_opportunity_seller_id: sellers.a });
      const dup = await link(c.contactId);
      expect(dup).toMatchObject({ http_status: 200, response: { event_id: dup.eventId, result: 'duplicate' } });
      const replay = await link(c.contactId, { eventId: applied.eventId });
      expect(replay).toMatchObject({ http_status: 200, replayed: true, response: applied.response });
      const changed = await link(c.contactId, { eventId: applied.eventId, bodyHash: hash('x') });
      expect(changed).toMatchObject({ http_status: 409, response: { error: 'event_conflict' } });
    });

    test('409 identity_conflict: the customer holds another open opportunity, or the opportunity is another customer\'s', async () => {
      const c = await customer();
      const other = await customer();
      await link(c.contactId);
      const second = await link(c.contactId, { opportunity: OTHER_OPPORTUNITY });
      expect(second).toMatchObject({ http_status: 409, response: { error: 'identity_conflict', event_id: second.eventId } });
      expect(await link(other.contactId)).toMatchObject({ http_status: 409, response: { error: 'identity_conflict' } });
      const withLead = await customer({ withLead: true, opportunity: OTHER_OPPORTUNITY });
      expect(await link(c.contactId, { opportunity: OTHER_OPPORTUNITY })).toMatchObject({ http_status: 409 });
      expect(await link(withLead.contactId, { opportunity: OTHER_OPPORTUNITY })).toMatchObject({ http_status: 200, response: { result: 'applied' } });
      expect(await contactOf(c.contactId)).toMatchObject({ crm_opportunity_id: OPPORTUNITY });
    });

    test('422 unknown contact (missing or another prefix) and invalid seller', async () => {
      const c = await customer();
      expect(await link('999999999')).toMatchObject({ http_status: 422, response: { error: 'unknown_contact' } });
      expect(await link(null, { contactRef: 'wa-prod-contact-1' })).toMatchObject({ http_status: 422, response: { error: 'unknown_contact' } });
      expect(await link(c.contactId, { seller: INACTIVE })).toMatchObject({ http_status: 422, response: { error: 'invalid_seller' } });
      expect(await link(c.contactId, { seller: '5e5f5d67-8e90-41a2-9dce-3f4a5b6c7d8e' }))
        .toMatchObject({ http_status: 422, response: { error: 'invalid_seller' } });
      expect(await link(c.contactId, { seller: ADMIN })).toMatchObject({ http_status: 200, response: { result: 'applied' } });
    });

    const handoff = async (c, estado = 'pending') => String((await client.query(
      `INSERT INTO handoffs (idempotency_key, conversation_id, phone_number, source_number_id, motivo, area, area_label,
                             prioridad, responsable, estado)
       VALUES ($1, $2, $3, $4, 'human_request', 'sales', 'Ventas', 'alta', 'Ventas', $5) RETURNING id`,
      [`u7-${crypto.randomUUID()}`, c.latest, c.phone, sourceNumberId, estado],
    )).rows[0].id);
    const selectHandoffs = async (c) => (await client.query(selectHandoffsSql, [
      'true', new Date(Date.now() - 3600000).toISOString(), '20', c.phone, '', '',
    ])).rows;

    test('a later handoff of the customer is routed to the linked opportunity instead of the rotation', async () => {
      const c = await customer();
      await link(c.contactId, { seller: SELLER_B });
      const id = await handoff(c);
      const [row] = await selectHandoffs(c);
      expect(row).toMatchObject({ handoff_id: id, crm_opportunity_id: OPPORTUNITY, crm_seller_id: null });
      expect((await client.query('SELECT crm_opportunity_id, crm_routing_seller_id FROM handoffs WHERE id = $1', [id])).rows[0])
        .toEqual({ crm_opportunity_id: OPPORTUNITY, crm_routing_seller_id: null });
    });

    test('without a link the 1.2d routing is unchanged (rotation names a seller)', async () => {
      const c = await customer();
      const id = await handoff(c);
      const [row] = await selectHandoffs(c);
      expect(row).toMatchObject({ handoff_id: id, crm_opportunity_id: null });
      expect(row.crm_seller_id).toMatch(/^[0-9a-f-]{36}$/);
    });

    test('the link ends when a handoff that carried it is resolved; a new link is then accepted', async () => {
      const c = await customer();
      await link(c.contactId);
      const id = await handoff(c);
      await selectHandoffs(c);
      await client.query(`UPDATE handoffs SET estado = 'resolved', resolved_at = NOW() WHERE id = $1`, [id]);
      const relinked = await link(c.contactId, { opportunity: OTHER_OPPORTUNITY });
      expect(relinked).toMatchObject({ http_status: 200, response: { result: 'applied' } });
      expect(await contactOf(c.contactId)).toMatchObject({ crm_opportunity_id: OTHER_OPPORTUNITY });
    });

    test('the linked seller is the holder of a lease without an owner seller, and may act', async () => {
      const c = await customer();
      await link(c.contactId, { seller: SELLER_B });
      await client.query(
        `INSERT INTO lead_chat_ownerships (conversation_id, clickup_task_id, acquired_at, sla_mode)
         VALUES ($1, 'cu-task', NOW(), 'standard')`, [c.latest],
      );
      const other = await chat13({ contact: c.contactId }, { seller: SELLER_A, version: 1 });
      expect(other).toMatchObject({ http_status: 409, response: { error: 'ownership_conflict', holder_crm_seller_id: SELLER_B } });
      expect(await chat13({ contact: c.contactId }, { seller: SELLER_B, version: 1 }))
        .toMatchObject({ http_status: 200, response: { result: 'applied' } });
    });

    test('a later lead.qualified of the customer carries the linked crm_opportunity_id (1.3 only)', async () => {
      const c = await customer({ withLead: true });
      await link(c.contactId);
      const since = new Date(Date.now() - 3600000).toISOString();
      const [row13] = (await client.query(selectLeadsSql, [since, '20', '1.3', c.phone])).rows;
      expect(row13).toMatchObject({ lead_id: c.leadId, crm_linked_opportunity_id: OPPORTUNITY });
      const [row12] = (await client.query(selectLeadsSql, [since, '20', '1.2', c.phone])).rows;
      expect(row12.crm_linked_opportunity_id).toBeNull();

      const config = { enabled: true, errors: [], protocol_revision: '1.3', id_prefix: PREFIX };
      const built = buildLeadQualifiedEvent({ ...row13, contact_upserted_prefixes: PREFIX }, config);
      const body = JSON.parse(built.body);
      expect(body.data.crm_opportunity_id).toBe(OPPORTUNITY);
      expect(validateCrmEvent(body)).toEqual([]);
      const built12 = buildLeadQualifiedEvent(row12, { ...config, protocol_revision: '1.2' });
      expect(JSON.parse(built12.body).data).not.toHaveProperty('crm_opportunity_id');
      expect(validateCrmEvent({ ...body, protocol_revision: '1.2' })).toContain('data.crm_opportunity_id: unknown key');
    });

    test('a lead that already carries another opportunity does not take the link', async () => {
      const c = await customer({ withLead: true, opportunity: OTHER_OPPORTUNITY });
      await client.query('UPDATE crm_contacts SET crm_opportunity_id = $2, crm_opportunity_seller_id = $3, crm_opportunity_linked_at = NOW() WHERE id = $1',
        [c.contactId, OPPORTUNITY, sellers.a]);
      await client.query('UPDATE leads SET crm_checked_source_hash = NULL WHERE id = $1', [c.leadId]);
      const [row] = (await client.query(selectLeadsSql, [new Date(Date.now() - 3600000).toISOString(), '20', '1.3', c.phone])).rows;
      expect(row.crm_linked_opportunity_id).toBeNull();
    });
  });

  describe('two-client race (committed rows)', () => {
    test('take by contact_id vs take by conversation_id: one applies, the other is 409, the counter moves once', async () => {
      await client.query('ROLLBACK');
      const setup = new pg.Client(connection);
      const one = new pg.Client(connection);
      const two = new pg.Client(connection);
      await Promise.all([setup.connect(), one.connect(), two.connect()]);
      const cleanup = [];
      try {
        await setup.query('UPDATE sellers SET crm_user_id = NULL WHERE crm_user_id = ANY($1::uuid[])', [[SELLER_A, SELLER_B]]);
        const raceSellers = [];
        cleanup.push(async () => { await setup.query('DELETE FROM sellers WHERE id = ANY($1::bigint[])', [raceSellers]); });
        const mk = async (uuid) => String((await setup.query(
          `INSERT INTO sellers (name, is_active, sort_order, crm_user_id)
           VALUES ('race', TRUE, 100000 + (random() * 900000)::int, $1) RETURNING id`, [uuid],
        )).rows[0].id);
        raceSellers.push(await mk(SELLER_A), await mk(SELLER_B));
        const { rows: [{ id: source }] } = await setup.query(
          `INSERT INTO whatsapp_numbers (display_name, phone_number, phone_number_id, instance_name)
           VALUES ('Race', '56220000000', 'crm-u7-race-' || gen_random_uuid(), 'inst-race') RETURNING id`,
        );
        cleanup.unshift(async () => {
          await setup.query('DELETE FROM crm_inbound_events WHERE conversation_id IN (SELECT id FROM conversations WHERE source_number_id = $1)', [source]);
          await setup.query('DELETE FROM crm_inbound_events WHERE event_id LIKE $1', ['%race-u7-%']);
          await setup.query('DELETE FROM audit_logs WHERE actor_id = $1 AND metadata->>\'crm_event_id\' LIKE $2', ['crm-inbound-events', '%race-u7-%']);
          await setup.query('DELETE FROM lead_chat_ownerships WHERE conversation_id IN (SELECT id FROM conversations WHERE source_number_id = $1)', [source]);
          await setup.query('DELETE FROM crm_ownership_changes WHERE conversation_id IN (SELECT id FROM conversations WHERE source_number_id = $1)', [source]);
          await setup.query('DELETE FROM crm_conversation_ownership WHERE conversation_id IN (SELECT id FROM conversations WHERE source_number_id = $1)', [source]);
          await setup.query('DELETE FROM messages WHERE conversation_id IN (SELECT id FROM conversations WHERE source_number_id = $1)', [source]);
          await setup.query('DELETE FROM conversations WHERE source_number_id = $1', [source]);
          await setup.query('DELETE FROM whatsapp_numbers WHERE id = $1', [source]);
        });
        const c = await customer({ conversations: 2, db: setup, source });
        for (let round = 0; round < 5; round += 1) {
          const before = await counterOf(c.contactId, setup);
          const [first, second] = await Promise.all([
            (async () => { await one.query('BEGIN'); const r = await chat13({ contact: c.contactId }, { db: one, eventId: `race-u7-${crypto.randomUUID()}`, version: before }); await one.query('COMMIT'); return r; })(),
            (async () => { await two.query('BEGIN'); const r = await chat13({ conversation: c.conversations[0] }, { db: two, eventId: `race-u7-${crypto.randomUUID()}`, seller: SELLER_B, version: before }); await two.query('COMMIT'); return r; })(),
          ]);
          const statuses = [first.http_status, second.http_status].sort();
          const winner = first.http_status === 200 ? first : second;
          const loser = first.http_status === 200 ? second : first;
          expect(statuses).toEqual([200, 409]);
          expect(winner.response).toMatchObject({ result: 'applied', ownership_version: before + 1 });
          expect(loser.response).toMatchObject({ error: 'ownership_conflict', ownership_version: before + 1 });
          expect(await counterOf(c.contactId, setup)).toBe(before + 1);
          expect(await liveLeases({ ...c, leadId: null }, setup)).toHaveLength(1);
          await setup.query(
            `UPDATE lead_chat_ownerships SET released_at = NOW(), release_reason = 'manual', released_via = 'crm', restoration_state = 'not_required'
             WHERE conversation_id = ANY($1::bigint[]) AND released_at IS NULL`, [c.conversations],
          );
        }
      } finally {
        for (const step of cleanup) await step();
        await Promise.all([setup.end(), one.end(), two.end()]);
        await client.query('BEGIN');
      }
    });
  });
});
