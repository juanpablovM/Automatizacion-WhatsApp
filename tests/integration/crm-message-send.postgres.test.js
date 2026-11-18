// =============================================================================
// CRM -> bot message.send (migration 041): the exactly-once send intent
// (crm_outbound_messages), the implicit take through crm_inbound_apply_chat_event,
// the ownership checks, the retry states and the message row that becomes the
// usual message.new with sender seller.
//
// The claim and completion SQL are the exact node queries of crm-inbound-events.
// The Evolution call between them is simulated by choosing the outcome passed to
// the completion. The own-message SQL of wa-inbound-entry (08) runs UNCHANGED to
// prove the fromMe echo of a CRM send is not stored twice.
// Every test runs inside a transaction that is rolled back.
// =============================================================================
import crypto from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import pg from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'vitest';

const require = createRequire(import.meta.url);
const { buildMessageNewEvent } = require('../fixtures/workflow-nodes/crm-events-dispatcher/crm-events-runtime.js');
const { verifyCrmInboundRequest } = require('../fixtures/workflow-nodes/crm-inbound-events/crm-inbound-runtime.js');
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
const claimSendSql = read('db/queries/n8n/crm-inbound-events/02_claim_crm_message_send.sql');
const completeSendSql = read('db/queries/n8n/crm-inbound-events/03_complete_crm_message_send.sql');
const applyChatSql = read('db/queries/n8n/crm-inbound-events/01_apply_crm_chat_event.sql');
const ownMessageSql = read('db/queries/n8n/lead-chat-ownership/08_persist_own_message_from_evolution.sql');
const acquireSql = read('db/queries/n8n/lead-chat-ownership/01_acquire_ownership_from_clickup.sql');
const loadStateSql = read('db/queries/n8n/lead-chat-ownership/05_load_ownership_state.sql');
const selectMessagesSql = read('db/queries/n8n/crm-events-dispatcher/05_select_message_candidates.sql');
const selectOwnershipSql = read('db/queries/n8n/crm-events-dispatcher/07_select_ownership_candidates.sql');

const PREFIX = 'msgs';
const SINCE = '2000-01-01T00:00:00.000Z';
const SELLER_A = '6f1c2a34-5b6d-4e7f-8a9b-0c1d2e3f4a5b';
const SELLER_B = '7a2d3b45-6c7e-4f80-9bac-1d2e3f4a5b6c';
const ADMIN = '7b726374-5516-429d-b993-fe18d7d421d6';
const OPPORTUNITY = '66666666-7777-4888-9999-aaaaaaaaaaaa';
const INBOUND_SECRET = 'crm-inbound-integration-secret';

describeIntegration('CRM message.send (migration 041)', () => {
  const client = new pg.Client(connection);
  let leadStatusId;
  let conversationStatusId;
  let sellerA;
  let sellerB;
  let admin;
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
    await client.query('UPDATE sellers SET crm_user_id = NULL WHERE crm_user_id IN ($1, $2, $3)', [SELLER_A, SELLER_B, ADMIN]);
    await client.query('UPDATE leads SET crm_opportunity_id = NULL WHERE crm_opportunity_id = $1', [OPPORTUNITY]);
    const seller = async (name, uuid) => (await client.query(
      `INSERT INTO sellers (name, is_active, sort_order, crm_user_id)
       VALUES ($1, TRUE, 90000 + (random() * 9000)::int, $2) RETURNING id`, [name, uuid],
    )).rows[0].id;
    sellerA = await seller('Seller A', SELLER_A);
    sellerB = await seller('Seller B', SELLER_B);
    admin = await seller('CRM admin', ADMIN);
    ({ rows: [{ id: sourceNumberId }] } = await client.query(
      `INSERT INTO whatsapp_numbers (display_name, phone_number, phone_number_id, instance_name)
       VALUES ('Ventas', '56223456789', 'crm-send-' || gen_random_uuid(), 'inst-' || gen_random_uuid()) RETURNING id`,
    ));
  });
  afterEach(async () => { await client.query('ROLLBACK'); });

  const insertLead = async ({ seller = sellerA, customerMessage = true } = {}) => {
    sequence += 1;
    const phone = `5694${String(1000000 + sequence).slice(-7)}`;
    const taskId = `send-task-${sequence}-${crypto.randomUUID()}`;
    const { rows: [lead] } = await client.query(
      `INSERT INTO leads (whatsapp_name, phone_number, lead_status_id, assigned_seller_id, source_number_id,
                          clickup_task_id, crm_opportunity_id, channel)
       VALUES ('Ana', $1, $2, $3, $4, $5, $6, 'whatsapp') RETURNING id`,
      [phone, leadStatusId, seller, sourceNumberId, taskId, OPPORTUNITY],
    );
    const { rows: [{ id: conversationId }] } = await client.query(
      `INSERT INTO conversations (lead_id, phone_number, conversation_status_id, source_number_id)
       VALUES ($1, $2, $3, $4) RETURNING id`,
      [lead.id, phone, conversationStatusId, sourceNumberId],
    );
    if (customerMessage) {
      await client.query(
        `INSERT INTO messages (conversation_id, lead_id, direction, sender_type, message_type, text_body, raw_payload)
         VALUES ($1, $2, 'incoming', 'customer', 'text', 'hola', '{}'::jsonb)`,
        [conversationId, lead.id],
      );
    }
    return { leadId: String(lead.id), conversationId: String(conversationId), taskId, phone };
  };

  const announce = async ({ leadId, conversationId }) => client.query(
    `INSERT INTO crm_events (event_id, event_type, conversation_id, lead_id, revision, body, status, delivered_at)
     VALUES ($1, 'lead.qualified', $2, $3, 1, '{}', 'delivered', NOW())`,
    [`wa-${PREFIX}-lead-${leadId}-r1`, `wa-${PREFIX}-conversation-${conversationId}`, leadId],
  );

  const claim = async ({
    eventId = `crm-evt-${crypto.randomUUID()}`, seller = SELLER_A, opportunity = OPPORTUNITY,
    clientMessageId = crypto.randomUUID(), version = 0, text = 'Hola, le escribo de Hormiglass',
    hash,
  } = {}) => {
    const bodyHash = hash ?? crypto.createHash('sha256').update(`${eventId}|${clientMessageId}|${text}`).digest('hex');
    const { rows } = await client.query(claimSendSql, [
      eventId, bodyHash, opportunity, seller, clientMessageId, String(version), text,
    ]);
    expect(rows).toHaveLength(1);
    return { ...rows[0], eventId, hash: bodyHash, clientMessageId, text };
  };

  const complete = async (claimed, {
    outcome = 'sent', providerId = `BAE5${crypto.randomUUID().replace(/-/g, '').slice(0, 16).toUpperCase()}`,
    status = outcome === 'sent' ? '201' : '400', error = outcome === 'sent' ? '' : 'provider error',
  } = {}) => {
    const { rows } = await client.query(completeSendSql, [
      String(claimed.outbound_id), String(claimed.attempt), outcome,
      outcome === 'sent' ? providerId : '', status, error, PREFIX,
    ]);
    expect(rows).toHaveLength(1);
    return { ...rows[0], providerId };
  };

  const applyChat = async ({ eventId = `crm-evt-${crypto.randomUUID()}`, type = 'chat.take', seller = SELLER_A, version = 0, hash } = {}) => {
    const { rows: [row] } = await client.query(applyChatSql, [
      eventId, hash ?? crypto.createHash('sha256').update(eventId).digest('hex'), type, OPPORTUNITY, seller, String(version),
    ]);
    return row;
  };

  const outboundOf = async (eventId) => (await client.query(
    'SELECT * FROM crm_outbound_messages WHERE event_id = $1', [eventId],
  )).rows[0];
  const ownershipsOf = async (leadId) => (await client.query(
    'SELECT * FROM lead_chat_ownerships WHERE lead_id = $1 ORDER BY id', [leadId],
  )).rows;
  const versionOf = async (conversationId) => Number((await client.query(
    'SELECT ownership_version FROM crm_conversation_ownership WHERE conversation_id = $1', [conversationId],
  )).rows[0]?.ownership_version ?? 0);
  const outgoingOf = async (conversationId) => (await client.query(
    `SELECT * FROM messages WHERE conversation_id = $1 AND direction = 'outgoing' ORDER BY id`, [conversationId],
  )).rows;
  const botSuppressed = async (leadId) => (await client.query(loadStateSql, [leadId])).rows[0].bot_suppressed;

  describe('implicit take when the bot holds the chat', () => {
    test('the send takes the chat for the sender exactly like an applied chat.take, then sends', async () => {
      const lead = await insertLead();
      await announce(lead);
      const claimed = await claim({ version: 0 });
      expect(claimed).toMatchObject({ send: true, attempt: 1, phone_number: lead.phone, text_body: claimed.text });
      expect(claimed.instance_name).toMatch(/^inst-/);
      expect(claimed.http_status).toBeNull();

      const [row] = await ownershipsOf(lead.leadId);
      expect(row).toMatchObject({
        acquired_via: 'crm', owner_seller_id: String(sellerA), clickup_task_id: null, sla_mode: 'standard',
        released_at: null,
      });
      expect(row.pending_message_id).not.toBeNull();
      const dueInMinutes = (new Date(row.response_due_at) - new Date(row.acquired_at)) / 60000;
      expect(dueInMinutes).toBeCloseTo(120, 0);
      expect(await botSuppressed(lead.leadId)).toBe(true);
      expect(await versionOf(lead.conversationId)).toBe(1);
      const [taken] = (await client.query(selectOwnershipSql, ['1.2', SINCE, PREFIX, '500'])).rows
        .filter((c) => String(c.conversation_id) === lead.conversationId);
      expect(taken).toMatchObject({ change_kind: 'taken', source: 'crm', crm_user_id: SELLER_A });
      expect(await outboundOf(claimed.eventId)).toMatchObject({ status: 'sending', attempt_count: 1, ownership_version: '1' });
    });

    test('a successful send stores one outgoing seller message and answers sent with the current version', async () => {
      const lead = await insertLead();
      await announce(lead);
      const claimed = await claim();
      const done = await complete(claimed);
      const messages = await outgoingOf(lead.conversationId);
      expect(messages).toHaveLength(1);
      const [message] = messages;
      expect(message).toMatchObject({
        sender_type: 'human', direction: 'outgoing', message_type: 'text', delivery_status: 'sent',
        external_message_id: done.providerId, text_body: claimed.text, lead_id: lead.leadId,
      });
      expect(done).toMatchObject({
        http_status: 200,
        response: { event_id: claimed.eventId, result: 'sent', message_id: `wa-${PREFIX}-message-${message.id}`, ownership_version: 1 },
      });
      expect(Object.keys(done.response).sort()).toEqual(['event_id', 'message_id', 'ownership_version', 'result']);
      expect(await outboundOf(claimed.eventId)).toMatchObject({
        status: 'sent', message_id: message.id, provider_message_id: done.providerId,
      });

      // The seller replied: the 2-hour window is satisfied, the chat stays held.
      const [row] = await ownershipsOf(lead.leadId);
      expect(row).toMatchObject({ pending_message_id: null, response_due_at: null, last_human_message_id: message.id, released_at: null });
      expect(await botSuppressed(lead.leadId)).toBe(true);
    });

    test('the message becomes the usual message.new with sender seller and the sender\'s crm_seller_id', async () => {
      const lead = await insertLead();
      await announce(lead);
      const claimed = await claim({ seller: ADMIN });
      const done = await complete(claimed);
      const [candidate] = (await client.query(selectMessagesSql, ['1.2', SINCE, PREFIX, '500'])).rows
        .filter((c) => String(c.conversation_id) === lead.conversationId && c.direction === 'outgoing');
      // An admin sends with their own id, not the lead's assigned seller.
      expect(candidate).toMatchObject({ sender_type: 'human', crm_user_id: ADMIN });
      const built = buildMessageNewEvent(candidate, { protocol_revision: '1.2', id_prefix: PREFIX });
      expect(built.blocked_reason).toBeNull();
      const body = JSON.parse(built.body);
      expect(body.data).toMatchObject({ message_id: done.response.message_id, sender: 'seller', crm_seller_id: ADMIN, direction: 'outbound' });
      expect(validateCrmEvent(built.body)).toEqual([]);
    });

    test('a phone reply of the assigned seller still maps to the assigned seller', async () => {
      const lead = await insertLead();
      await announce(lead);
      await client.query(
        `INSERT INTO messages (conversation_id, lead_id, direction, sender_type, message_type, text_body, delivery_status, raw_payload)
         VALUES ($1, $2, 'outgoing', 'human', 'text', 'desde el celular', 'sent', '{}'::jsonb)`,
        [lead.conversationId, lead.leadId],
      );
      const [candidate] = (await client.query(selectMessagesSql, ['1.2', SINCE, PREFIX, '500'])).rows
        .filter((c) => String(c.conversation_id) === lead.conversationId && c.direction === 'outgoing');
      expect(candidate.crm_user_id).toBe(SELLER_A);
    });

    test('a stale ownership_version never blocks the send', async () => {
      const lead = await insertLead();
      await applyChat({ version: 0 });
      await applyChat({ type: 'chat.release', version: 1 });
      expect(await versionOf(lead.conversationId)).toBe(2);
      const claimed = await claim({ version: 0 });
      expect(claimed.send).toBe(true);
      const done = await complete(claimed);
      expect(done.response.ownership_version).toBe(3);
    });
  });

  describe('ownership checks', () => {
    test('the seller who already holds the chat sends without a new version', async () => {
      const lead = await insertLead();
      await applyChat({ version: 0 });
      const claimed = await claim({ version: 1 });
      expect(claimed.send).toBe(true);
      expect(await versionOf(lead.conversationId)).toBe(1);
      expect(await ownershipsOf(lead.leadId)).toHaveLength(1);
      const done = await complete(claimed);
      expect(done.response).toMatchObject({ result: 'sent', ownership_version: 1 });
    });

    test('the assigned seller sends on a chat ClickUp holds', async () => {
      const lead = await insertLead();
      await client.query(acquireSql, [
        lead.taskId, 'nueva', `hist-${crypto.randomUUID()}`, new Date().toISOString(), 'in progress', 'cotización enviada',
      ]);
      const claimed = await claim({ version: 1 });
      expect(claimed.send).toBe(true);
      expect(await versionOf(lead.conversationId)).toBe(1);
    });

    test('another seller holding the chat is a 409 naming the holder; nothing is claimed', async () => {
      const lead = await insertLead();
      await applyChat({ seller: SELLER_B, version: 0 });
      const claimed = await claim({ seller: SELLER_A, version: 1 });
      expect(claimed).toMatchObject({
        send: false, http_status: 409,
        response: { error: 'ownership_conflict', holder_crm_seller_id: SELLER_B, ownership_version: 1 },
      });
      expect(await outboundOf(claimed.eventId)).toBeUndefined();
      expect(await outgoingOf(lead.conversationId)).toHaveLength(0);
      const again = await claim({ eventId: claimed.eventId, hash: claimed.hash, clientMessageId: claimed.clientMessageId, seller: SELLER_A });
      expect(again).toMatchObject({ send: false, http_status: 409, replayed: true });
    });

    test('an unknown opportunity is 422 invalid_opportunity', async () => {
      await insertLead();
      const claimed = await claim({ opportunity: '00000000-0000-4000-8000-000000000001' });
      expect(claimed).toMatchObject({ send: false, http_status: 422, response: { error: 'invalid_opportunity', event_id: claimed.eventId } });
    });

    test('an unmapped or inactive seller is 422 invalid_seller', async () => {
      await insertLead();
      const unknown = await claim({ seller: '00000000-0000-4000-8000-000000000002' });
      expect(unknown).toMatchObject({ send: false, http_status: 422, response: { error: 'invalid_seller' } });
      await client.query('UPDATE sellers SET is_active = FALSE WHERE id = $1', [sellerA]);
      const inactive = await claim();
      expect(inactive).toMatchObject({ send: false, http_status: 422, response: { error: 'invalid_seller' } });
    });
  });

  describe('idempotency and retries', () => {
    test('a retry of a sent event returns the stored 200 and sends nothing again', async () => {
      const lead = await insertLead();
      const claimed = await claim();
      const done = await complete(claimed);
      const retry = await claim({ eventId: claimed.eventId, hash: claimed.hash, clientMessageId: claimed.clientMessageId });
      expect(retry).toMatchObject({ send: false, http_status: 200, response: done.response, replayed: true });
      expect(await outgoingOf(lead.conversationId)).toHaveLength(1);
    });

    test('a definite failure answers 503; the retry with the same bytes sends again', async () => {
      const lead = await insertLead();
      const claimed = await claim();
      const failed = await complete(claimed, { outcome: 'failed' });
      expect(failed).toMatchObject({ http_status: 503, response: { error: 'receiver_unavailable' } });
      expect(await outboundOf(claimed.eventId)).toMatchObject({ status: 'failed', last_error: 'provider error', message_id: null });
      expect(await outgoingOf(lead.conversationId)).toHaveLength(0);

      const retry = await claim({ eventId: claimed.eventId, hash: claimed.hash, clientMessageId: claimed.clientMessageId });
      expect(retry).toMatchObject({ send: true, attempt: 2 });
      const done = await complete(retry);
      expect(done).toMatchObject({ http_status: 200, response: { result: 'sent' } });
      expect(await outgoingOf(lead.conversationId)).toHaveLength(1);
      // The implicit take happened once.
      expect(await versionOf(lead.conversationId)).toBe(1);
    });

    test('an in-flight send answers 503 to a retry and is never resent', async () => {
      await insertLead();
      const claimed = await claim();
      const retry = await claim({ eventId: claimed.eventId, hash: claimed.hash, clientMessageId: claimed.clientMessageId });
      expect(retry).toMatchObject({ send: false, http_status: 503, response: { error: 'receiver_unavailable' } });
      expect(await outboundOf(claimed.eventId)).toMatchObject({ status: 'sending', attempt_count: 1 });
    });

    test('an unknown provider outcome answers 503 and stays for an operator', async () => {
      await insertLead();
      const claimed = await claim();
      const unknown = await complete(claimed, { outcome: 'unknown', status: '502', error: 'bad gateway' });
      expect(unknown).toMatchObject({ http_status: 503 });
      expect(await outboundOf(claimed.eventId)).toMatchObject({ status: 'unknown', last_error: 'bad gateway' });
      const retry = await claim({ eventId: claimed.eventId, hash: claimed.hash, clientMessageId: claimed.clientMessageId });
      expect(retry).toMatchObject({ send: false, http_status: 503 });
    });

    test('a stale completion (wrong attempt) changes nothing', async () => {
      await insertLead();
      const claimed = await claim();
      const stale = await complete({ ...claimed, attempt: 9 });
      expect(stale).toMatchObject({ http_status: 503 });
      expect(await outboundOf(claimed.eventId)).toMatchObject({ status: 'sending' });
    });

    test('the same event_id with different bytes is 409 event_conflict', async () => {
      await insertLead();
      const claimed = await claim();
      const conflict = await claim({ eventId: claimed.eventId, clientMessageId: claimed.clientMessageId, text: 'otro texto' });
      expect(conflict).toMatchObject({ send: false, http_status: 409, response: { error: 'event_conflict', event_id: claimed.eventId } });
      await complete(claimed);
      const afterSent = await claim({ eventId: claimed.eventId, clientMessageId: claimed.clientMessageId, text: 'otro texto' });
      expect(afterSent).toMatchObject({ http_status: 409, response: { error: 'event_conflict' } });
    });

    test('the same client_message_id under another event_id is 409 event_conflict', async () => {
      const lead = await insertLead();
      const claimed = await claim();
      await complete(claimed);
      const duplicate = await claim({ clientMessageId: claimed.clientMessageId });
      expect(duplicate).toMatchObject({ send: false, http_status: 409, response: { error: 'event_conflict', event_id: duplicate.eventId } });
      expect(await outgoingOf(lead.conversationId)).toHaveLength(1);
    });

    test('a chat.take reusing a message.send event_id is 409 event_conflict', async () => {
      await insertLead();
      const claimed = await claim();
      const take = await applyChat({ eventId: claimed.eventId });
      expect(take).toMatchObject({ http_status: 409, response: { error: 'event_conflict' } });
    });
  });

  describe('the fromMe echo of a CRM send (08_persist_own_message_from_evolution.sql unchanged)', () => {
    const echo = async (lead, externalId, text) => {
      const token = crypto.randomUUID();
      const { rows: [event] } = await client.query(
        `INSERT INTO inbound_events (instance_name, external_message_id, event_fingerprint, dedupe_key, source_number_id,
                                     phone_number, should_process, processing_status, processing_token, normalized_payload)
         VALUES ('inst', $1, $2, $2, $3, $4, TRUE, 'processing', $5, jsonb_build_object('is_from_me', TRUE, 'text_body', $6::text))
         RETURNING id`,
        [externalId, `fp-${crypto.randomUUID()}`, sourceNumberId, lead.phone, token, text],
      );
      const { rows: [row] } = await client.query(ownMessageSql, [
        String(event.id), token, String(sourceNumberId), lead.phone, externalId,
        String(Math.floor(Date.now() / 1000)), 'text', text, '{}', 'inst',
      ]);
      return row;
    };

    test('an echo after completion is the seller\'s reply, not a second message', async () => {
      const lead = await insertLead();
      const claimed = await claim();
      const done = await complete(claimed);
      const classified = await echo(lead, done.providerId, claimed.text);
      expect(classified).toMatchObject({ own_message_kind: 'human_reply', lead_id: lead.leadId });
      expect(await outgoingOf(lead.conversationId)).toHaveLength(1);
    });

    test('an echo that wins the race is adopted by the completion, not duplicated', async () => {
      const lead = await insertLead();
      const claimed = await claim();
      const providerId = 'BAE5ECHOFIRST0001';
      const classified = await echo(lead, providerId, claimed.text);
      expect(classified.own_message_kind).toBe('human_reply');
      const done = await complete(claimed, { providerId });
      const messages = await outgoingOf(lead.conversationId);
      expect(messages).toHaveLength(1);
      expect(done.response.message_id).toBe(`wa-${PREFIX}-message-${messages[0].id}`);
      expect(await outboundOf(claimed.eventId)).toMatchObject({ status: 'sent', message_id: messages[0].id });
    });
  });

  test('a signed message.send flows from verification to the claim', async () => {
    const lead = await insertLead();
    const clientMessageId = crypto.randomUUID();
    const raw = Buffer.from(JSON.stringify({
      schema_version: 1, protocol_revision: '1.2', event_id: 'crm-evt-send-signed', type: 'message.send',
      occurred_at: '2026-11-18T15:00:00Z',
      data: { crm_opportunity_id: OPPORTUNITY, crm_seller_id: SELLER_A, client_message_id: clientMessageId, ownership_version: 0, text: ' Hola ' },
    }));
    const timestamp = String(Math.floor(Date.now() / 1000));
    const signature = `v1=${crypto.createHmac('sha256', INBOUND_SECRET).update(Buffer.concat([Buffer.from(`${timestamp}.`), raw])).digest('hex')}`;
    const verified = verifyCrmInboundRequest({
      rawBody: raw,
      headers: { 'x-crm-timestamp': timestamp, 'x-crm-signature': signature },
      env: { CRM_INBOUND_ENABLED: 'true', CRM_INBOUND_HMAC_SECRET: INBOUND_SECRET, CRM_INBOUND_MESSAGE_SEND_ENABLED: 'true', CRM_EVENTS_ID_PREFIX: PREFIX },
      now: Date.now(),
      crypto,
    });
    expect(verified.action).toBe('send');
    const { rows: [row] } = await client.query(claimSendSql, [
      verified.event_id, verified.body_sha256, verified.crm_opportunity_id, verified.crm_seller_id,
      verified.client_message_id, verified.ownership_version, verified.text,
    ]);
    expect(row).toMatchObject({ send: true, phone_number: lead.phone, text_body: 'Hola' });
  });
});

// Runs last and outside the rolled-back transactions: 041 and its rollback are
// single transactions of their own (BEGIN ... COMMIT). Ends with 041 applied.
describeIntegration('migration 041 and its rollback', () => {
  const client = new pg.Client(connection);
  const migrationSql = read('infra/postgres/migrations/041_crm_message_send.sql');
  const rollbackSql = read('infra/postgres/rollback/041_crm_message_send.down.sql');
  const objects = async () => (await client.query(
    `SELECT to_regclass('public.crm_outbound_messages') IS NOT NULL AS table_exists,
            to_regprocedure('crm_inbound_claim_message_send(text,text,uuid,uuid,uuid,bigint,text)') IS NOT NULL AS claim_exists,
            to_regprocedure('crm_inbound_complete_message_send(bigint,integer,text,text,integer,text,text)') IS NOT NULL AS complete_exists`,
  )).rows[0];

  beforeAll(async () => { await client.connect(); });
  afterAll(async () => {
    await client.query(migrationSql);
    await client.end();
  });

  test('the rollback removes every 041 object and the migration restores them, twice in a row', async () => {
    await client.query(rollbackSql);
    expect(await objects()).toEqual({ table_exists: false, claim_exists: false, complete_exists: false });
    expect((await client.query('SELECT to_regprocedure($1) IS NOT NULL AS ok', [
      'crm_inbound_apply_chat_event(text,text,text,uuid,uuid,bigint)',
    ])).rows[0].ok).toBe(true);
    await client.query(migrationSql);
    await client.query(migrationSql);
    expect(await objects()).toEqual({ table_exists: true, claim_exists: true, complete_exists: true });
  });
});
