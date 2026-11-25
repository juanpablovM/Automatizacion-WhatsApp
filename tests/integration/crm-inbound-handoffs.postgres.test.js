// =============================================================================
// CRM -> bot 1.2d (migration 046): chat.take / chat.release / message.send by
// conversation_id for a conversation the bot handed off to the CRM without an
// opportunity, and handoff.acknowledged / handoff.resolved.
//
// The SQL is the exact node queries of crm-inbound-events (04, 05, 06, and
// 03 for completion). A delivered handoff.created row (written in production
// by the crm-events dispatcher) is seeded directly.
// Every test runs inside a transaction that is rolled back.
// Feature document: odd/tasks/crm-1-2d-contingency-handoffs.md (S5, S6).
// =============================================================================
import crypto from 'node:crypto';
import fs from 'node:fs';
import pg from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'vitest';

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
const claimSendSql = read('db/queries/n8n/crm-inbound-events/02_claim_crm_message_send.sql');
const completeSendSql = read('db/queries/n8n/crm-inbound-events/03_complete_crm_message_send.sql');
const applyConversationChatSql = read('db/queries/n8n/crm-inbound-events/04_apply_crm_conversation_chat_event.sql');
const claimConversationSendSql = read('db/queries/n8n/crm-inbound-events/05_claim_crm_conversation_message_send.sql');
const applyHandoffSql = read('db/queries/n8n/crm-inbound-events/06_apply_crm_handoff_event.sql');
const loadStateSql = read('db/queries/n8n/lead-chat-ownership/05_load_ownership_state.sql');

const PREFIX = 'hand';
const SELLER_A = '6f1c2a34-5b6d-4e7f-8a9b-0c1d2e3f4a5b';
const SELLER_B = '7a2d3b45-6c7e-4f80-9bac-1d2e3f4a5b6c';
const OPPORTUNITY = '66666666-7777-4888-9999-aaaaaaaaaaaa';
const hash = (value) => crypto.createHash('sha256').update(value).digest('hex');
const newEventId = () => `crm-evt-${crypto.randomUUID()}`;

describeIntegration('CRM 1.2d inbound (migration 046)', () => {
  const client = new pg.Client(connection);
  let leadStatusId;
  let statusIds;
  let sellerA;
  let sellerB;
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
    statusIds = Object.fromEntries((await client.query(
      `SELECT code, id FROM conversation_statuses WHERE code IN ('escalation_required', 'closed', 'active')`,
    )).rows.map((r) => [r.code, r.id]));
    await client.query('UPDATE sellers SET crm_user_id = NULL WHERE crm_user_id IN ($1, $2)', [SELLER_A, SELLER_B]);
    await client.query('UPDATE leads SET crm_opportunity_id = NULL WHERE crm_opportunity_id = $1', [OPPORTUNITY]);
    const seller = async (name, uuid) => (await client.query(
      `INSERT INTO sellers (name, is_active, sort_order, crm_user_id)
       VALUES ($1, TRUE, 90000 + (random() * 9000)::int, $2) RETURNING id`, [name, uuid],
    )).rows[0].id;
    sellerA = await seller('Seller A', SELLER_A);
    sellerB = await seller('Seller B', SELLER_B);
    ({ rows: [{ id: sourceNumberId }] } = await client.query(
      `INSERT INTO whatsapp_numbers (display_name, phone_number, phone_number_id, instance_name)
       VALUES ('Ventas', '56223456789', 'crm-hand-' || gen_random_uuid(), 'inst-' || gen_random_uuid()) RETURNING id`,
    ));
  });
  afterEach(async () => { await client.query('ROLLBACK'); });

  // A conversation in escalation_required with one customer message, its lead
  // (no opportunity unless asked) and a handoff routed to routedSeller.
  const handedOff = async ({
    routedSeller = sellerA, opportunity = null, withLead = true, delivered = true,
    routeByOpportunity = false, estado = 'notified',
  } = {}) => {
    sequence += 1;
    const phone = `5695${String(1000000 + sequence).slice(-7)}`;
    let leadId = null;
    if (withLead) {
      ({ rows: [{ id: leadId }] } = await client.query(
        `INSERT INTO leads (whatsapp_name, phone_number, lead_status_id, source_number_id, crm_opportunity_id, channel)
         VALUES ('Ana', $1, $2, $3, $4, 'whatsapp') RETURNING id`,
        [phone, leadStatusId, sourceNumberId, opportunity],
      ));
    }
    const { rows: [{ id: conversationId }] } = await client.query(
      `INSERT INTO conversations (lead_id, phone_number, conversation_status_id, source_number_id)
       VALUES ($1, $2, $3, $4) RETURNING id`,
      [leadId, phone, statusIds.escalation_required, sourceNumberId],
    );
    await client.query(
      `INSERT INTO messages (conversation_id, lead_id, direction, sender_type, message_type, text_body, raw_payload)
       VALUES ($1, $2, 'incoming', 'customer', 'text', 'quiero hablar con una persona', '{}'::jsonb)`,
      [conversationId, leadId],
    );
    const handoffId = await addHandoff({
      conversationId, phone, routedSeller, delivered, routeByOpportunity, estado,
    });
    return {
      leadId: leadId === null ? null : String(leadId),
      conversationId: String(conversationId),
      ref: `wa-${PREFIX}-conversation-${conversationId}`,
      handoffId: String(handoffId),
      phone,
    };
  };

  const addHandoff = async ({
    conversationId, phone, routedSeller = sellerA, delivered = true, routeByOpportunity = false, estado = 'notified',
  }) => {
    const { rows: [{ id }] } = await client.query(
      `INSERT INTO handoffs (idempotency_key, conversation_id, phone_number, motivo, area, area_label, prioridad,
                             responsable, estado, notified_at, crm_opportunity_id, crm_routing_seller_id)
       VALUES ($1, $2, $3, 'human_request', 'sales', 'Ventas', 'alta', 'Ventas', $4,
               CASE WHEN $4 <> 'pending' THEN NOW() END, $5, $6) RETURNING id`,
      [`hand-${crypto.randomUUID()}`, conversationId, phone, estado,
        routeByOpportunity ? OPPORTUNITY : null, routeByOpportunity ? null : routedSeller],
    );
    await client.query(
      `INSERT INTO crm_events (event_id, event_type, conversation_id, handoff_id, revision, body, status, delivered_at)
       VALUES ($1, 'handoff.created', $2, $3, 1, '{}', $4, CASE WHEN $4 = 'delivered' THEN NOW() END)`,
      [`wa-${PREFIX}-handoff-${id}-r1`, `wa-${PREFIX}-conversation-${conversationId}`, id,
        delivered ? 'delivered' : 'pending'],
    );
    return id;
  };

  const chatByConversation = async (conv, {
    eventId = newEventId(), type = 'chat.take', seller = SELLER_A, version = 0, bodyHash,
    ref = conv.ref, conversationId = conv.conversationId,
  } = {}) => {
    const { rows } = await client.query(applyConversationChatSql, [
      eventId, bodyHash ?? hash(eventId), type, ref, conversationId, seller, String(version),
    ]);
    expect(rows).toHaveLength(1);
    return { ...rows[0], eventId };
  };

  const sendByConversation = async (conv, {
    eventId = newEventId(), seller = SELLER_A, version = 0, clientMessageId = crypto.randomUUID(),
    text = 'Hola, le escribo de Hormiglass', ref = conv.ref,
  } = {}) => {
    const { rows } = await client.query(claimConversationSendSql, [
      eventId, hash(`${eventId}|${clientMessageId}`), ref, conv.conversationId, seller, clientMessageId,
      String(version), text,
    ]);
    expect(rows).toHaveLength(1);
    return { ...rows[0], eventId, text };
  };

  const complete = async (claimed, providerId = `BAE5${crypto.randomUUID().slice(0, 8).toUpperCase()}`) => (
    await client.query(completeSendSql, [
      String(claimed.outbound_id), String(claimed.attempt), 'sent', providerId, '201', '', PREFIX,
    ])
  ).rows[0];

  const closure = async (handoffId, { eventId = newEventId(), type = 'handoff.resolved', seller = SELLER_A, bodyHash } = {}) => {
    const { rows } = await client.query(applyHandoffSql, [eventId, bodyHash ?? hash(eventId), type, handoffId, seller]);
    expect(rows).toHaveLength(1);
    return { ...rows[0], eventId };
  };

  const ownershipsOf = async (leadId) => (await client.query(
    'SELECT * FROM lead_chat_ownerships WHERE lead_id = $1 ORDER BY id', [leadId],
  )).rows;
  const versionOf = async (conversationId) => Number((await client.query(
    'SELECT ownership_version FROM crm_conversation_ownership WHERE conversation_id = $1', [conversationId],
  )).rows[0]?.ownership_version ?? 0);
  const inboxOf = async (eventId) => (await client.query(
    'SELECT * FROM crm_inbound_events WHERE event_id = $1', [eventId],
  )).rows[0];
  const handoffOf = async (id) => (await client.query('SELECT * FROM handoffs WHERE id = $1', [id])).rows[0];
  const conversationStatusOf = async (id) => (await client.query(
    `SELECT s.code, c.closed_at FROM conversations c JOIN conversation_statuses s ON s.id = c.conversation_status_id
     WHERE c.id = $1`, [id],
  )).rows[0];
  const auditOf = async (handoffId) => (await client.query(
    `SELECT * FROM audit_logs WHERE entity_type = 'handoff' AND entity_id = $1 AND actor_id = 'crm-inbound-events'
     ORDER BY id`, [handoffId],
  )).rows;
  const botSuppressed = async (leadId) => (await client.query(loadStateSql, [leadId])).rows[0].bot_suppressed;

  describe('conversation_id identity: resolution (S5)', () => {
    test('chat.take takes a handed-off conversation exactly like the opportunity path', async () => {
      const conv = await handedOff();
      const taken = await chatByConversation(conv);
      expect(taken).toMatchObject({
        http_status: 200, replayed: false,
        response: { event_id: taken.eventId, result: 'applied', ownership_version: 1 },
      });
      const [row] = await ownershipsOf(conv.leadId);
      expect(row).toMatchObject({
        acquired_via: 'crm', owner_seller_id: String(sellerA), clickup_task_id: null, sla_mode: 'standard', released_at: null,
      });
      expect(row.pending_message_id).not.toBeNull();
      expect((new Date(row.response_due_at) - new Date(row.acquired_at)) / 60000).toBeCloseTo(120, 0);
      expect(await botSuppressed(conv.leadId)).toBe(true);
      expect(await versionOf(conv.conversationId)).toBe(1);
      const change = (await client.query(
        'SELECT * FROM crm_ownership_changes WHERE conversation_id = $1', [conv.conversationId],
      )).rows;
      expect(change).toMatchObject([{ change_kind: 'taken', source: 'crm', seller_id: String(sellerA) }]);
      expect(await inboxOf(taken.eventId)).toMatchObject({
        event_type: 'chat.take', http_status: 200, lead_id: conv.leadId, conversation_id: conv.conversationId,
      });
    });

    test('chat.release by the holder releases with released_via crm', async () => {
      const conv = await handedOff();
      await chatByConversation(conv);
      const released = await chatByConversation(conv, { type: 'chat.release', version: 1 });
      expect(released).toMatchObject({ http_status: 200, response: { result: 'applied', ownership_version: 2 } });
      const [row] = await ownershipsOf(conv.leadId);
      expect(row).toMatchObject({ release_reason: 'manual', released_via: 'crm', restoration_state: 'not_required' });
      expect(row.released_at).not.toBeNull();
      expect(await botSuppressed(conv.leadId)).toBe(false);
    });

    test('a stale version is ignored and another seller is an ownership conflict', async () => {
      const conv = await handedOff();
      await chatByConversation(conv);
      expect(await chatByConversation(conv, { seller: SELLER_B, version: 1 })).toMatchObject({
        http_status: 409, response: { error: 'ownership_conflict', holder_crm_seller_id: SELLER_A, ownership_version: 1 },
      });
      expect(await chatByConversation(conv, { type: 'chat.release', version: 0 })).toMatchObject({
        http_status: 200, response: { result: 'ignored_stale', ownership_version: 1 },
      });
    });

    test('a live lease without an owner seller is held by the routed seller', async () => {
      const conv = await handedOff({ routedSeller: sellerB });
      await client.query(
        `INSERT INTO lead_chat_ownerships (lead_id, clickup_task_id, acquired_at, sla_mode)
         VALUES ($1, 'task-x', NOW(), 'standard')`, [conv.leadId],
      );
      const version = await versionOf(conv.conversationId);
      expect(await chatByConversation(conv, { version })).toMatchObject({
        http_status: 409, response: { error: 'ownership_conflict', holder_crm_seller_id: SELLER_B },
      });
      expect(await chatByConversation(conv, { seller: SELLER_B, version })).toMatchObject({
        http_status: 200, response: { result: 'applied' },
      });
    });

    test('an unmapped seller is 422 invalid_seller', async () => {
      const conv = await handedOff();
      expect(await chatByConversation(conv, { seller: crypto.randomUUID() })).toMatchObject({
        http_status: 422, response: { error: 'invalid_seller' },
      });
    });

    test.each([
      ['no handoff.created delivered for it', { delivered: false }],
      ['its handoff was routed by opportunity', { routeByOpportunity: true }],
      ['its lead has an opportunity', { opportunity: OPPORTUNITY }],
    ])('422 unknown_conversation when %s, nothing changes', async (_name, options) => {
      const conv = await handedOff(options);
      const answer = await chatByConversation(conv);
      expect(answer).toMatchObject({ http_status: 422, response: { error: 'unknown_conversation', event_id: answer.eventId } });
      expect(await versionOf(conv.conversationId)).toBe(0);
      if (conv.leadId) expect(await ownershipsOf(conv.leadId)).toEqual([]);
      expect(await inboxOf(answer.eventId)).toMatchObject({ http_status: 422 });
    });

    test('422 unknown_conversation for another prefix, a conversation that does not exist, or a mismatched id', async () => {
      const conv = await handedOff();
      for (const options of [
        { ref: `wa-other-conversation-${conv.conversationId}`, conversationId: '' },
        { ref: 'wa-hand-conversation-999999999', conversationId: '999999999' },
        { ref: conv.ref, conversationId: String(Number(conv.conversationId) + 1000000) },
      ]) {
        const answer = await chatByConversation(conv, options);
        expect(answer).toMatchObject({ http_status: 422, response: { error: 'unknown_conversation' } });
        expect((await inboxOf(answer.eventId)).conversation_id).toBeNull();
      }
    });

    test('same event_id and bytes replay; other bytes are 409 event_conflict', async () => {
      const conv = await handedOff();
      const first = await chatByConversation(conv);
      expect(await chatByConversation(conv, { eventId: first.eventId })).toMatchObject({
        http_status: 200, replayed: true, response: first.response,
      });
      expect(await chatByConversation(conv, { eventId: first.eventId, bodyHash: hash('other') })).toMatchObject({
        http_status: 409, response: { error: 'event_conflict' },
      });
      expect(await ownershipsOf(conv.leadId)).toHaveLength(1);
    });
  });

  describe('message.send by conversation_id (S5)', () => {
    test('implicit take, claim with crm_conversation_ref, then the usual completion', async () => {
      const conv = await handedOff();
      const claimed = await sendByConversation(conv);
      expect(claimed).toMatchObject({ send: true, attempt: 1, phone_number: conv.phone, http_status: null });
      const outbound = (await client.query('SELECT * FROM crm_outbound_messages WHERE event_id = $1', [claimed.eventId])).rows[0];
      expect(outbound).toMatchObject({
        crm_opportunity_id: null, crm_conversation_ref: conv.ref, status: 'sending',
        lead_id: conv.leadId, conversation_id: conv.conversationId, ownership_version: '1',
      });
      expect(await ownershipsOf(conv.leadId)).toMatchObject([{ acquired_via: 'crm', owner_seller_id: String(sellerA) }]);
      const done = await complete(claimed);
      expect(done).toMatchObject({ http_status: 200, response: { event_id: claimed.eventId, result: 'sent', ownership_version: 1 } });
      expect(done.response.message_id).toMatch(new RegExp(`^wa-${PREFIX}-message-\\d+$`));
      const [message] = (await client.query(
        `SELECT * FROM messages WHERE conversation_id = $1 AND direction = 'outgoing'`, [conv.conversationId],
      )).rows;
      expect(message).toMatchObject({ sender_type: 'human', text_body: claimed.text, lead_id: conv.leadId });
      expect(await inboxOf(claimed.eventId)).toMatchObject({ http_status: 200, response: done.response });
    });

    test('another seller holding the chat is 409; a retry of the same bytes while sending is 503', async () => {
      const conv = await handedOff();
      const claimed = await sendByConversation(conv);
      expect(await sendByConversation(conv, { seller: SELLER_B })).toMatchObject({
        send: false, http_status: 409, response: { error: 'ownership_conflict', holder_crm_seller_id: SELLER_A },
      });
      const { rows: [retry] } = await client.query(claimConversationSendSql, [
        claimed.eventId, (await inboxOf(claimed.eventId)).body_sha256, conv.ref, conv.conversationId, SELLER_A,
        (await client.query('SELECT client_message_id FROM crm_outbound_messages WHERE event_id = $1', [claimed.eventId])).rows[0].client_message_id,
        '1', claimed.text,
      ]);
      expect(retry).toMatchObject({ send: false, http_status: 503, response: { error: 'receiver_unavailable' } });
    });

    test('unknown conversation is 422 and nothing is claimed', async () => {
      const conv = await handedOff({ delivered: false });
      const answer = await sendByConversation(conv);
      expect(answer).toMatchObject({ send: false, http_status: 422, response: { error: 'unknown_conversation' } });
      expect((await client.query('SELECT 1 FROM crm_outbound_messages WHERE event_id = $1', [answer.eventId])).rows).toEqual([]);
    });

    // Migration 047 (S8): no lead is no longer unknown; the chat is held by a
    // conversation-keyed ownership (crm-conversation-chat-ownership test).
    test('a handed-off conversation without a lead is taken and sent by conversation_id', async () => {
      const conv = await handedOff({ withLead: false });
      expect(await chatByConversation(conv)).toMatchObject({ http_status: 200, response: { result: 'applied', ownership_version: 1 } });
      expect(await sendByConversation(conv, { version: 1 })).toMatchObject({ send: true, http_status: null });
      const rows = (await client.query(
        'SELECT lead_id, conversation_id FROM lead_chat_ownerships WHERE conversation_id = $1', [conv.conversationId],
      )).rows;
      expect(rows).toEqual([{ lead_id: null, conversation_id: conv.conversationId }]);
      expect((await client.query('SELECT 1 FROM leads WHERE phone_number = $1', [conv.phone])).rows).toEqual([]);
    });

    test('a send intent carries exactly one identity', async () => {
      const conv = await handedOff();
      await expect(client.query(
        `INSERT INTO crm_outbound_messages (event_id, client_message_id, body_sha256, crm_opportunity_id, crm_conversation_ref,
           crm_seller_id, conversation_id, phone_number, text_body, ownership_version)
         VALUES ('x', gen_random_uuid(), repeat('a', 64), $1, $2, $3, $4, '569', 'hola', 0)`,
        [OPPORTUNITY, conv.ref, SELLER_A, conv.conversationId],
      )).rejects.toThrow(/chk_crm_outbound_messages_identity/);
    });
  });

  describe('opportunity identity is unchanged (S5)', () => {
    const opportunityLead = async () => {
      sequence += 1;
      const phone = `5696${String(1000000 + sequence).slice(-7)}`;
      const { rows: [{ id: leadId }] } = await client.query(
        `INSERT INTO leads (whatsapp_name, phone_number, lead_status_id, assigned_seller_id, source_number_id,
                            clickup_task_id, crm_opportunity_id, channel)
         VALUES ('Ana', $1, $2, $3, $4, $5, $6, 'whatsapp') RETURNING id`,
        [phone, leadStatusId, sellerA, sourceNumberId, `task-${crypto.randomUUID()}`, OPPORTUNITY],
      );
      const { rows: [{ id: conversationId }] } = await client.query(
        `INSERT INTO conversations (lead_id, phone_number, conversation_status_id, source_number_id)
         VALUES ($1, $2, $3, $4) RETURNING id`, [leadId, phone, statusIds.active, sourceNumberId],
      );
      await client.query(
        `INSERT INTO messages (conversation_id, lead_id, direction, sender_type, message_type, text_body, raw_payload)
         VALUES ($1, $2, 'incoming', 'customer', 'text', 'hola', '{}'::jsonb)`, [conversationId, leadId],
      );
      return { leadId: String(leadId), conversationId: String(conversationId) };
    };

    test('chat.take / chat.release and message.send by crm_opportunity_id still apply', async () => {
      const lead = await opportunityLead();
      const take = newEventId();
      expect((await client.query(applyChatSql, [take, hash(take), 'chat.take', OPPORTUNITY, SELLER_A, '0'])).rows[0])
        .toMatchObject({ http_status: 200, response: { result: 'applied', ownership_version: 1 } });
      const release = newEventId();
      expect((await client.query(applyChatSql, [release, hash(release), 'chat.release', OPPORTUNITY, SELLER_A, '1'])).rows[0])
        .toMatchObject({ http_status: 200, response: { result: 'applied', ownership_version: 2 } });
      const send = newEventId();
      const { rows: [claimed] } = await client.query(claimSendSql, [
        send, hash(send), OPPORTUNITY, SELLER_A, crypto.randomUUID(), '2', 'hola',
      ]);
      expect(claimed).toMatchObject({ send: true, attempt: 1 });
      expect((await client.query('SELECT crm_opportunity_id, crm_conversation_ref FROM crm_outbound_messages WHERE event_id = $1', [send])).rows[0])
        .toEqual({ crm_opportunity_id: OPPORTUNITY, crm_conversation_ref: null });
      expect(await versionOf(lead.conversationId)).toBe(3);
    });
  });

  describe('handoff.acknowledged / handoff.resolved (S6)', () => {
    test('acknowledged from notified: applied, acknowledged_at, audit row', async () => {
      const conv = await handedOff();
      const answer = await closure(conv.handoffId, { type: 'handoff.acknowledged' });
      expect(answer).toMatchObject({ http_status: 200, replayed: false, response: { event_id: answer.eventId, result: 'applied' } });
      expect(Object.keys(answer.response).sort()).toEqual(['event_id', 'result']);
      const handoff = await handoffOf(conv.handoffId);
      expect(handoff.estado).toBe('acknowledged');
      expect(handoff.acknowledged_at).not.toBeNull();
      expect(handoff.resolved_at).toBeNull();
      expect((await conversationStatusOf(conv.conversationId)).code).toBe('escalation_required');
      expect(await auditOf(conv.handoffId)).toMatchObject([{
        event_name: 'handoff_transition', result: 'advanced', actor_type: 'system',
        before_payload: { estado: 'notified' }, after_payload: { estado: 'acknowledged' },
        metadata: { requested: 'acknowledged', crm_event_id: answer.eventId, crm_seller_id: SELLER_A },
      }]);
      expect(await inboxOf(answer.eventId)).toMatchObject({
        event_type: 'handoff.acknowledged', http_status: 200, conversation_id: conv.conversationId,
      });
    });

    test('resolved from notified closes the conversation and every other open handoff of it', async () => {
      const conv = await handedOff();
      const reEscalation = await addHandoff({ conversationId: conv.conversationId, phone: conv.phone });
      const answer = await closure(conv.handoffId);
      expect(answer).toMatchObject({ http_status: 200, response: { result: 'applied' } });
      for (const id of [conv.handoffId, String(reEscalation)]) {
        const handoff = await handoffOf(id);
        expect(handoff.estado).toBe('resolved');
        expect(handoff.resolved_at).not.toBeNull();
      }
      const status = await conversationStatusOf(conv.conversationId);
      expect(status.code).toBe('closed');
      expect(status.closed_at).not.toBeNull();
      expect(await auditOf(conv.handoffId)).toMatchObject([{
        result: 'advanced', after_payload: { estado: 'resolved' },
        metadata: { conversation_closed: true, resolved_handoff_ids: [Number(reEscalation)] },
      }]);
    });

    test('resolved from acknowledged; a conversation no longer escalation_required stays as it is', async () => {
      const conv = await handedOff({ estado: 'acknowledged' });
      await client.query('UPDATE conversations SET conversation_status_id = $1 WHERE id = $2', [statusIds.active, conv.conversationId]);
      expect(await closure(conv.handoffId)).toMatchObject({ http_status: 200, response: { result: 'applied' } });
      expect((await handoffOf(conv.handoffId)).estado).toBe('resolved');
      expect((await conversationStatusOf(conv.conversationId)).code).toBe('active');
    });

    test('a pending handoff whose handoff.created was delivered counts as notified', async () => {
      const conv = await handedOff({ estado: 'pending' });
      expect(await closure(conv.handoffId, { type: 'handoff.acknowledged' })).toMatchObject({ http_status: 200, response: { result: 'applied' } });
      expect((await handoffOf(conv.handoffId)).estado).toBe('acknowledged');
    });

    test('repeating the state already reached is duplicate and writes nothing', async () => {
      const conv = await handedOff();
      await closure(conv.handoffId);
      const before = await handoffOf(conv.handoffId);
      const again = await closure(conv.handoffId);
      expect(again).toMatchObject({ http_status: 200, replayed: false, response: { event_id: again.eventId, result: 'duplicate' } });
      expect((await handoffOf(conv.handoffId)).resolved_at).toEqual(before.resolved_at);
      expect(await auditOf(conv.handoffId)).toHaveLength(1);

      const ack = await handedOff();
      await closure(ack.handoffId, { type: 'handoff.acknowledged' });
      expect(await closure(ack.handoffId, { type: 'handoff.acknowledged' })).toMatchObject({ response: { result: 'duplicate' } });
    });

    test('acknowledged after resolved is 409 invalid_transition, audited, nothing changes', async () => {
      const conv = await handedOff();
      await closure(conv.handoffId);
      const answer = await closure(conv.handoffId, { type: 'handoff.acknowledged' });
      expect(answer).toMatchObject({ http_status: 409, response: { error: 'invalid_transition', event_id: answer.eventId } });
      const handoff = await handoffOf(conv.handoffId);
      expect(handoff.estado).toBe('resolved');
      expect(handoff.acknowledged_at).toBeNull();
      expect((await auditOf(conv.handoffId)).map((a) => a.result)).toEqual(['advanced', 'invalid_transition']);
      expect(await inboxOf(answer.eventId)).toMatchObject({ http_status: 409 });
    });

    test.each([
      ['not ours or unparsable', async () => ''],
      ['a handoff that does not exist', async () => '999999999'],
      ['a handoff with no delivered handoff.created', async () => (await handedOff({ delivered: false })).handoffId],
    ])('422 unknown_handoff for %s', async (_name, id) => {
      const answer = await closure(await id());
      expect(answer).toMatchObject({ http_status: 422, response: { error: 'unknown_handoff', event_id: answer.eventId } });
      expect(await inboxOf(answer.eventId)).toMatchObject({ http_status: 422, conversation_id: null });
    });

    test('same event_id and bytes replay the stored answer; other bytes are 409 event_conflict', async () => {
      const conv = await handedOff();
      const first = await closure(conv.handoffId);
      expect(await closure(conv.handoffId, { eventId: first.eventId })).toMatchObject({
        http_status: 200, replayed: true, response: { event_id: first.eventId, result: 'applied' },
      });
      expect(await closure(conv.handoffId, { eventId: first.eventId, bodyHash: hash('other') })).toMatchObject({
        http_status: 409, response: { error: 'event_conflict', event_id: first.eventId },
      });
      expect(await auditOf(conv.handoffId)).toHaveLength(1);
    });

    test('an event_id already used by a chat event is shared: replay or conflict, never a second decision', async () => {
      const conv = await handedOff();
      const take = await chatByConversation(conv);
      expect(await closure(conv.handoffId, { eventId: take.eventId, bodyHash: hash('other') })).toMatchObject({
        http_status: 409, response: { error: 'event_conflict' },
      });
      expect((await handoffOf(conv.handoffId)).estado).toBe('notified');
    });
  });
});
