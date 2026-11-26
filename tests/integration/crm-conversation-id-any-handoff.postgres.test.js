// =============================================================================
// chat.take / chat.release / message.send by conversation_id on any handed-off
// conversation (migration 050, spec S10 of
// odd/tasks/crm-1-2d-contingency-handoffs.md).
//
// Live case 2026-11-26 (L18-L22): handoff 568 on conversation 645 was routed by
// the opportunity of an older lead (474, conversation 567). The customer later
// qualified as lead 488 in conversation 582 (with its own opportunity); 645
// continues 582 and inherits lead 488. Until 050, conversation_id 645 answered
// 422 unknown_conversation, so the CRM could not reply. Now any conversation
// with a delivered handoff.created is accepted; the events act on the
// customer's current chat lease (the contact's latest lead, the same lease the
// opportunity path of 049 uses), the conversation key only when the customer
// has no lead.
//
// Every query is the exact node query; every test runs in a rolled-back
// transaction.
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
const completeSendSql = read('db/queries/n8n/crm-inbound-events/03_complete_crm_message_send.sql');
const applyConversationChatSql = read('db/queries/n8n/crm-inbound-events/04_apply_crm_conversation_chat_event.sql');
const claimConversationSendSql = read('db/queries/n8n/crm-inbound-events/05_claim_crm_conversation_message_send.sql');
const loadConversationSql = read('db/queries/n8n/wa-conversation-orchestrator/01_load_active_context.sql');
const authorizeSql = read('db/queries/n8n/wa-outbound-messages/05_authorize_outbound_send.sql');
const acquireSql = read('db/queries/n8n/lead-chat-ownership/01_acquire_ownership_from_clickup.sql');

const PREFIX = 'anyho';
const SELLER_A = '5a6b7c8d-9e0f-4a1b-8c2d-3e4f5a6b7c8d';
const SELLER_B = '6b7c8d9e-0f1a-4b2c-9d3e-4f5a6b7c8d9e';
const OPP_OLD = '6e190fad-aaaa-4bbb-8ccc-dddddddddd01';
const OPP_NEW = '3a9802de-aaaa-4bbb-8ccc-dddddddddd02';
const INSTANCE = 'crm-any-handoff-test';
const hash = (value) => crypto.createHash('sha256').update(value).digest('hex');
const newEventId = () => `crm-evt-${crypto.randomUUID()}`;

describeIntegration('conversation_id accepted on any handed-off conversation (migration 050)', () => {
  const client = new pg.Client(connection);
  let statusIds;
  let leadStatusId;
  let sellerA;
  let sellerB;
  let sourceNumberId;
  let sequence = 0;

  beforeAll(async () => { await client.connect(); });
  afterAll(async () => { await client.end(); });

  beforeEach(async () => {
    await client.query('BEGIN');
    statusIds = Object.fromEntries((await client.query(
      `SELECT code, id FROM conversation_statuses WHERE code IN ('active', 'closed', 'escalation_required')`,
    )).rows.map((r) => [r.code, r.id]));
    ({ rows: [{ id: leadStatusId }] } = await client.query(
      `INSERT INTO lead_statuses (code, label, sort_order) VALUES ('assigned', 'Assigned', 2)
       ON CONFLICT (code) DO UPDATE SET code = EXCLUDED.code RETURNING id`,
    ));
    await client.query('UPDATE sellers SET crm_user_id = NULL WHERE crm_user_id IN ($1, $2)', [SELLER_A, SELLER_B]);
    await client.query('UPDATE leads SET crm_opportunity_id = NULL WHERE crm_opportunity_id IN ($1, $2)', [OPP_OLD, OPP_NEW]);
    const seller = async (name, uuid) => (await client.query(
      `INSERT INTO sellers (name, is_active, sort_order, crm_user_id)
       VALUES ($1, TRUE, 90000 + (random() * 9000)::int, $2::uuid) RETURNING id`, [name, uuid],
    )).rows[0].id;
    sellerA = await seller('Seller A', SELLER_A);
    sellerB = await seller('Seller B', SELLER_B);
    ({ rows: [{ id: sourceNumberId }] } = await client.query(
      `INSERT INTO whatsapp_numbers (display_name, phone_number, phone_number_id, instance_name)
       VALUES ('Ventas', '56223456782', 'crm-anyho-' || gen_random_uuid(), $1 || '-' || gen_random_uuid()) RETURNING id`,
      [INSTANCE],
    ));
  });
  afterEach(async () => { await client.query('ROLLBACK'); });

  const nextPhone = (head) => {
    sequence += 1;
    return `${head}${String(1000000 + sequence).slice(-7)}`;
  };

  const customerMessage = async (conversationId, leadId, ago = '0 minutes') => String((await client.query(
    `INSERT INTO messages (conversation_id, lead_id, direction, sender_type, message_type, text_body, raw_payload, created_at)
     VALUES ($1, $2, 'incoming', 'customer', 'text', 'hola', '{}'::jsonb, NOW() - $3::interval) RETURNING id`,
    [conversationId, leadId, ago],
  )).rows[0].id);

  const conversation = async ({ phone, leadId = null, status = 'escalation_required', ago = '0 minutes' }) => String((await client.query(
    `INSERT INTO conversations (lead_id, phone_number, conversation_status_id, source_number_id, started_at, last_message_at)
     VALUES ($1, $2, $3, $4, NOW() - $5::interval, NOW() - $5::interval) RETURNING id`,
    [leadId, phone, statusIds[status], sourceNumberId, ago],
  )).rows[0].id);

  // A lead qualified in its own conversation, announced to the CRM.
  const qualifiedLead = async ({ phone, opportunity = null, seller = sellerA, previous = null, status = 'closed', ago = '2 days' }) => {
    const conversationId = await conversation({ phone, status, ago });
    const { rows: [{ id }] } = await client.query(
      `INSERT INTO leads (whatsapp_name, phone_number, lead_status_id, assigned_seller_id, source_number_id,
                          clickup_task_id, crm_opportunity_id, channel, source_conversation_id, previous_lead_id, created_at)
       VALUES ('Ana', $1, $2, $3, $4, $5, $6, 'whatsapp', $7, $8, NOW() - $9::interval) RETURNING id`,
      [phone, leadStatusId, seller, sourceNumberId, `anyho-task-${crypto.randomUUID()}`, opportunity,
        conversationId, previous, ago],
    );
    const leadId = String(id);
    await client.query('UPDATE conversations SET lead_id = $1 WHERE id = $2', [leadId, conversationId]);
    await customerMessage(conversationId, leadId, ago);
    await client.query(
      `INSERT INTO crm_events (event_id, event_type, conversation_id, lead_id, revision, body, status, delivered_at)
       VALUES ($1, 'lead.qualified', $2, $3, 1, '{}', 'delivered', NOW())`,
      [`wa-${PREFIX}-lead-${leadId}-r1`, `wa-${PREFIX}-conversation-${conversationId}`, leadId],
    );
    const taskId = (await client.query('SELECT clickup_task_id FROM leads WHERE id = $1', [leadId])).rows[0].clickup_task_id;
    return { leadId, conversationId, taskId };
  };

  // A handoff of the conversation with its handoff.created row (delivered
  // unless asked), routed by opportunity or by seller.
  const handoff = async ({ conversationId, phone, opportunity = null, routedSeller = null, delivered = true }) => {
    const { rows: [{ id }] } = await client.query(
      `INSERT INTO handoffs (idempotency_key, conversation_id, phone_number, motivo, area, area_label, prioridad,
                             responsable, estado, notified_at, crm_opportunity_id, crm_routing_seller_id)
       VALUES ($1, $2, $3, 'human_request', 'sales', 'Ventas', 'alta', 'Ventas', 'notified', NOW(), $4, $5) RETURNING id`,
      [`anyho-${crypto.randomUUID()}`, conversationId, phone, opportunity, routedSeller],
    );
    await client.query(
      `INSERT INTO crm_events (event_id, event_type, conversation_id, handoff_id, revision, body, status, delivered_at)
       VALUES ($1, 'handoff.created', $2, $3, 1, '{}', $4, CASE WHEN $4 = 'delivered' THEN NOW() END)`,
      [`wa-${PREFIX}-handoff-${id}-r1`, `wa-${PREFIX}-conversation-${conversationId}`, id,
        delivered ? 'delivered' : 'pending'],
    );
    return String(id);
  };

  // The live case: old lead with OPP_OLD (closed), latest lead (with OPP_NEW
  // unless asked) qualified in its own closed conversation, and a continuation
  // conversation that inherited the latest lead, handed off by OPP_OLD.
  const liveCase = async ({ latestOpportunity = OPP_NEW, latestSeller = sellerA } = {}) => {
    const phone = nextPhone('5697');
    const old = await qualifiedLead({ phone, opportunity: OPP_OLD, ago: '3 days' });
    const latest = await qualifiedLead({
      phone, opportunity: latestOpportunity, seller: latestSeller, previous: old.leadId, ago: '1 day',
    });
    const conversationId = await conversation({ phone, leadId: latest.leadId });
    const messageId = await customerMessage(conversationId, latest.leadId);
    const handoffId = await handoff({ conversationId, phone, opportunity: OPP_OLD });
    return {
      phone, old, latest, conversationId, messageId, handoffId, ref: `wa-${PREFIX}-conversation-${conversationId}`,
    };
  };

  const byConversation = async (c, {
    eventId = newEventId(), type = 'chat.take', seller = SELLER_A, version = 0, ref = c.ref, conversationId = c.conversationId,
  } = {}) => {
    const { rows } = await client.query(applyConversationChatSql, [
      eventId, hash(eventId), type, ref, conversationId, seller, String(version),
    ]);
    expect(rows).toHaveLength(1);
    return { ...rows[0], eventId };
  };
  const byOpportunity = async ({ opportunity = OPP_OLD, eventId = newEventId(), type = 'chat.take', seller = SELLER_A, version = 0 } = {}) => {
    const { rows } = await client.query(applyChatSql, [eventId, hash(eventId), type, opportunity, seller, String(version)]);
    expect(rows).toHaveLength(1);
    return { ...rows[0], eventId };
  };
  const sendByConversation = async (c, {
    eventId = newEventId(), seller = SELLER_A, version = 0, ref = c.ref, conversationId = c.conversationId,
    text = 'Hola, le escribo de Hormiglass',
  } = {}) => {
    const clientMessageId = crypto.randomUUID();
    const { rows } = await client.query(claimConversationSendSql, [
      eventId, hash(`${eventId}|${clientMessageId}`), ref, conversationId, seller, clientMessageId, String(version), text,
    ]);
    expect(rows).toHaveLength(1);
    return { ...rows[0], eventId, text };
  };
  const complete = async (claimed) => (await client.query(completeSendSql, [
    String(claimed.outbound_id), String(claimed.attempt), 'sent', `BAE5${crypto.randomUUID().slice(0, 8).toUpperCase()}`,
    '201', '', PREFIX,
  ])).rows[0];

  const ownershipsOfLead = async (leadId) => (await client.query(
    'SELECT * FROM lead_chat_ownerships WHERE lead_id = $1 ORDER BY id', [leadId],
  )).rows;
  const liveLeasesOf = async (phone) => (await client.query(
    `SELECT o.* FROM lead_chat_ownerships o
     LEFT JOIN leads l ON l.id = o.lead_id
     LEFT JOIN conversations c ON c.id = o.conversation_id
     WHERE o.released_at IS NULL AND o.deleted_at IS NULL AND (l.phone_number = $1 OR c.phone_number = $1)`, [phone],
  )).rows;
  const changesOf = async (conversationId) => (await client.query(
    'SELECT * FROM crm_ownership_changes WHERE conversation_id = $1 ORDER BY ownership_version', [conversationId],
  )).rows;
  const versionOf = async (conversationId) => Number((await client.query(
    'SELECT ownership_version FROM crm_conversation_ownership WHERE conversation_id = $1', [conversationId],
  )).rows[0]?.ownership_version ?? 0);
  const sellerOwned = async (c) => (await client.query(
    'SELECT inbound_contact_seller_owned($1, $2) AS owned', [sourceNumberId, c.phone],
  )).rows[0].owned;
  const inboxOf = async (eventId) => (await client.query(
    'SELECT * FROM crm_inbound_events WHERE event_id = $1', [eventId],
  )).rows[0];

  const loadState = async (c) => {
    sequence += 1;
    const token = `anyho-token-${sequence}-${crypto.randomUUID()}`;
    const { rows: [event] } = await client.query(`
      INSERT INTO inbound_events (
        instance_name, external_message_id, event_fingerprint, dedupe_key, source_number_id, phone_number,
        queue_key, event_type, normalized_event, should_process, processing_status, processing_started_at,
        processing_token, processing_phase, attempt_count, raw_payload, normalized_payload
      ) VALUES (
        $1, NULL, md5($3), 'id:' || $3, $2::bigint, $4, $2::bigint::text || ':' || $4, 'messages.upsert',
        'MESSAGES_UPSERT', TRUE, 'processing', NOW(), $5, 'orchestrating', 1, '{}'::jsonb,
        jsonb_build_object('is_from_me', FALSE)
      ) RETURNING id
    `, [INSTANCE, sourceNumberId, `anyho-${token}`, c.phone, token]);
    const { rows } = await client.query(loadConversationSql, [
      c.phone, String(sourceNumberId), 'Ana', null, `in-${token}`, null, 'text', 'hola?', '{}',
      null, null, null, null, null, null, null, INSTANCE, String(event.id), token,
    ]);
    expect(rows).toHaveLength(1);
    await client.query(`UPDATE inbound_events SET processing_status = 'processed', processing_token = NULL WHERE id = $1`, [event.id]);
    return rows[0];
  };

  const authorizeBotReply = async (c, leadId = c.latest?.leadId ?? null) => {
    const token = `dispatch-${crypto.randomUUID()}`;
    const { rows: [{ id }] } = await client.query(`
      INSERT INTO messages (conversation_id, lead_id, direction, sender_type, message_type, delivery_status,
                            text_body, raw_payload, idempotency_key, dispatch_phase, dispatch_token, claimed_at)
      VALUES ($1, $2, 'outgoing', 'bot', 'text', 'queued', 'respuesta bot',
              jsonb_build_object('number', $3::text, 'text', 'respuesta bot'), $4, 'claimed', $4, NOW())
      RETURNING id
    `, [c.conversationId, leadId, c.phone, token]);
    const { rows } = await client.query(authorizeSql, [String(id), token, 'question']);
    expect(rows).toHaveLength(1);
    return rows[0];
  };

  describe('the live case: handoff routed by an older opportunity on a continuation conversation', () => {
    test('chat.take by conversation_id holds the latest lead and silences the bot', async () => {
      const c = await liveCase();
      expect(await sellerOwned(c)).toBe(false);

      const taken = await byConversation(c);
      expect(taken).toMatchObject({
        http_status: 200, replayed: false, response: { event_id: taken.eventId, result: 'applied', ownership_version: 1 },
      });
      expect(await ownershipsOfLead(c.old.leadId)).toEqual([]);
      const [lease] = await ownershipsOfLead(c.latest.leadId);
      expect(lease).toMatchObject({
        lead_id: c.latest.leadId, conversation_id: c.conversationId, acquired_via: 'crm',
        owner_seller_id: String(sellerA), clickup_task_id: null, released_at: null, sla_mode: 'standard',
        pending_message_id: c.messageId,
      });
      expect((new Date(lease.response_due_at) - new Date(lease.acquired_at)) / 60000).toBeCloseTo(120, 0);

      expect(await sellerOwned(c)).toBe(true);
      expect(await loadState(c)).toMatchObject({
        bot_suppressed: true, ownership_id: lease.id, ownership_lead_id: c.latest.leadId,
      });
      expect(await authorizeBotReply(c)).toMatchObject({
        should_send: false, human_control_cancelled: true, dispatch_phase: 'cancelled',
      });

      expect(await changesOf(c.conversationId)).toMatchObject([
        { ownership_version: '1', change_kind: 'taken', source: 'crm', seller_id: String(sellerA), lead_id: c.latest.leadId },
      ]);
      expect(await changesOf(c.latest.conversationId)).toEqual([]);
      expect(await changesOf(c.old.conversationId)).toEqual([]);
      expect(await inboxOf(taken.eventId)).toMatchObject({
        event_type: 'chat.take', http_status: 200, lead_id: c.latest.leadId, conversation_id: c.conversationId,
      });

      // Same seller again: idempotent; another seller: conflict.
      expect(await byConversation(c, { version: 1 })).toMatchObject({
        http_status: 200, response: { result: 'applied', ownership_version: 1 },
      });
      expect(await byConversation(c, { seller: SELLER_B, version: 1 })).toMatchObject({
        http_status: 409, response: { error: 'ownership_conflict', holder_crm_seller_id: SELLER_A, ownership_version: 1 },
      });
      expect(await liveLeasesOf(c.phone)).toHaveLength(1);
    });

    test('chat.release by conversation_id frees the bot', async () => {
      const c = await liveCase();
      await byConversation(c);
      const released = await byConversation(c, { type: 'chat.release', version: 1 });
      expect(released).toMatchObject({ http_status: 200, response: { result: 'applied', ownership_version: 2 } });
      const [lease] = await ownershipsOfLead(c.latest.leadId);
      expect(lease).toMatchObject({ release_reason: 'manual', released_via: 'crm', restoration_state: 'not_required' });
      expect(lease.released_at).not.toBeNull();
      expect((await changesOf(c.conversationId)).map((x) => [x.ownership_version, x.change_kind, x.source, x.reason]))
        .toEqual([['1', 'taken', 'crm', null], ['2', 'released', 'crm', 'seller_released']]);
      expect(await liveLeasesOf(c.phone)).toEqual([]);
      expect(await sellerOwned(c)).toBe(false);
      expect((await loadState(c)).bot_suppressed).toBe(false);
      expect(await authorizeBotReply(c)).toMatchObject({ should_send: true, dispatch_phase: 'sending' });
    });

    test('message.send by conversation_id: implicit take, send, completion clears the pending reply', async () => {
      const c = await liveCase();
      const claimed = await sendByConversation(c);
      expect(claimed).toMatchObject({ send: true, attempt: 1, phone_number: c.phone, http_status: null });
      const outbound = (await client.query('SELECT * FROM crm_outbound_messages WHERE id = $1', [claimed.outbound_id])).rows[0];
      expect(outbound).toMatchObject({
        crm_opportunity_id: null, crm_conversation_ref: c.ref, lead_id: c.latest.leadId,
        conversation_id: c.conversationId, seller_id: String(sellerA), status: 'sending', ownership_version: '1',
      });
      const [held] = await ownershipsOfLead(c.latest.leadId);
      expect(held).toMatchObject({ pending_message_id: c.messageId, conversation_id: c.conversationId, acquired_via: 'crm' });

      const done = await complete(claimed);
      expect(done).toMatchObject({ http_status: 200, response: { event_id: claimed.eventId, result: 'sent', ownership_version: 1 } });
      const [after] = await ownershipsOfLead(c.latest.leadId);
      expect(after).toMatchObject({ released_at: null, pending_message_id: null, pending_message_at: null, response_due_at: null });
      const message = (await client.query('SELECT * FROM messages WHERE id = $1', [after.last_human_message_id])).rows[0];
      expect(message).toMatchObject({
        direction: 'outgoing', sender_type: 'human', conversation_id: c.conversationId, delivery_status: 'sent',
        text_body: claimed.text, lead_id: c.latest.leadId,
      });
      expect(await inboxOf(claimed.eventId)).toMatchObject({ http_status: 200, response: done.response });
      expect(await sellerOwned(c)).toBe(true);
      expect((await loadState(c)).bot_suppressed).toBe(true);
      expect(await authorizeBotReply(c)).toMatchObject({ should_send: false, dispatch_phase: 'cancelled' });
    });

    test('a ClickUp lease on the latest lead is held by its assigned seller', async () => {
      const c = await liveCase({ latestSeller: sellerB });
      await client.query(acquireSql, [
        c.latest.taskId, 'nueva', `hist-${crypto.randomUUID()}`, new Date().toISOString(), 'in progress', 'cotización enviada',
      ]);
      const version = await versionOf(c.conversationId);
      expect(await byConversation(c, { version })).toMatchObject({
        http_status: 409, response: { error: 'ownership_conflict', holder_crm_seller_id: SELLER_B },
      });
      expect(await sendByConversation(c, { version })).toMatchObject({
        send: false, http_status: 409, response: { error: 'ownership_conflict', holder_crm_seller_id: SELLER_B },
      });
      expect(await byConversation(c, { seller: SELLER_B, version })).toMatchObject({
        http_status: 200, response: { result: 'applied' },
      });
      expect(await liveLeasesOf(c.phone)).toHaveLength(1);
    });
  });

  describe('one live lease across the opportunity and conversation_id keys', () => {
    test('take by opportunity first: conversation_id by another seller is 409, by the same seller idempotent', async () => {
      const c = await liveCase();
      expect(await byOpportunity()).toMatchObject({ http_status: 200, response: { result: 'applied', ownership_version: 1 } });
      const [lease] = await ownershipsOfLead(c.latest.leadId);
      expect(lease).toMatchObject({ conversation_id: c.old.conversationId, owner_seller_id: String(sellerA) });
      expect(await versionOf(c.conversationId)).toBe(0);

      expect(await byConversation(c, { seller: SELLER_B })).toMatchObject({
        http_status: 409, response: { error: 'ownership_conflict', holder_crm_seller_id: SELLER_A, ownership_version: 0 },
      });
      expect(await byConversation(c)).toMatchObject({
        http_status: 200, response: { result: 'applied', ownership_version: 0 },
      });
      expect(await sendByConversation(c, { seller: SELLER_B })).toMatchObject({
        send: false, http_status: 409, response: { error: 'ownership_conflict', holder_crm_seller_id: SELLER_A },
      });
      expect(await liveLeasesOf(c.phone)).toEqual([expect.objectContaining({ id: lease.id })]);

      // Release by conversation_id of the lease taken by opportunity: the
      // change is tracked under the lease's conversation (the opportunity's).
      expect(await byConversation(c, { type: 'chat.release' })).toMatchObject({
        http_status: 200, response: { result: 'applied', ownership_version: 0 },
      });
      expect((await changesOf(c.old.conversationId)).map((x) => [x.ownership_version, x.change_kind]))
        .toEqual([['1', 'taken'], ['2', 'released']]);
      expect(await changesOf(c.conversationId)).toEqual([]);
      expect(await liveLeasesOf(c.phone)).toEqual([]);
      expect(await sellerOwned(c)).toBe(false);
    });

    test('take by conversation_id first: either opportunity by another seller is 409, by the same seller idempotent', async () => {
      const c = await liveCase();
      expect(await byConversation(c)).toMatchObject({ http_status: 200, response: { result: 'applied', ownership_version: 1 } });
      const [lease] = await ownershipsOfLead(c.latest.leadId);
      for (const opportunity of [OPP_OLD, OPP_NEW]) {
        expect(await byOpportunity({ opportunity, seller: SELLER_B })).toMatchObject({
          http_status: 409, response: { error: 'ownership_conflict', holder_crm_seller_id: SELLER_A },
        });
        expect(await byOpportunity({ opportunity })).toMatchObject({ http_status: 200, response: { result: 'applied' } });
      }
      expect(await liveLeasesOf(c.phone)).toEqual([expect.objectContaining({ id: lease.id, conversation_id: c.conversationId })]);
      expect(await changesOf(c.conversationId)).toMatchObject([{ ownership_version: '1', change_kind: 'taken' }]);

      // Release by the opportunity: tracked under the lease's conversation.
      expect(await byOpportunity({ type: 'chat.release' })).toMatchObject({ http_status: 200, response: { result: 'applied' } });
      expect((await changesOf(c.conversationId)).map((x) => [x.ownership_version, x.change_kind]))
        .toEqual([['1', 'taken'], ['2', 'released']]);
      expect(await liveLeasesOf(c.phone)).toEqual([]);
    });
  });

  describe('other handed-off conversations with an opportunity', () => {
    test('handoff routed by opportunity, the customer has only that lead: accepted, lease on the lead', async () => {
      const phone = nextPhone('5696');
      const only = await qualifiedLead({ phone, opportunity: OPP_OLD, status: 'escalation_required', ago: '0 minutes' });
      await handoff({ conversationId: only.conversationId, phone, opportunity: OPP_OLD });
      const c = { phone, conversationId: only.conversationId, ref: `wa-${PREFIX}-conversation-${only.conversationId}`, latest: only };

      const taken = await byConversation(c);
      expect(taken).toMatchObject({ http_status: 200, response: { result: 'applied', ownership_version: 1 } });
      const [lease] = await ownershipsOfLead(only.leadId);
      expect(lease).toMatchObject({ conversation_id: null, acquired_via: 'crm', owner_seller_id: String(sellerA), released_at: null });
      expect(await changesOf(only.conversationId)).toMatchObject([{ ownership_version: '1', change_kind: 'taken', lead_id: only.leadId }]);
      expect(await sellerOwned(c)).toBe(true);
      expect(await authorizeBotReply(c)).toMatchObject({ should_send: false, dispatch_phase: 'cancelled' });

      // The opportunity path sees the same lease and version.
      expect(await byOpportunity({ seller: SELLER_B, version: 1 })).toMatchObject({
        http_status: 409, response: { error: 'ownership_conflict', holder_crm_seller_id: SELLER_A, ownership_version: 1 },
      });
      expect(await byOpportunity({ type: 'chat.release', version: 1 })).toMatchObject({
        http_status: 200, response: { result: 'applied', ownership_version: 2 },
      });
      expect(await sellerOwned(c)).toBe(false);
    });

    test('handoff routed by seller while the lead has an opportunity: accepted', async () => {
      const phone = nextPhone('5695');
      const only = await qualifiedLead({ phone, opportunity: OPP_OLD, status: 'escalation_required', ago: '0 minutes' });
      await handoff({ conversationId: only.conversationId, phone, routedSeller: sellerB });
      const c = { phone, conversationId: only.conversationId, ref: `wa-${PREFIX}-conversation-${only.conversationId}` };
      expect(await byConversation(c, { seller: SELLER_B })).toMatchObject({ http_status: 200, response: { result: 'applied' } });
      expect(await ownershipsOfLead(only.leadId)).toMatchObject([{ owner_seller_id: String(sellerB), released_at: null }]);
    });
  });

  describe('still 422 unknown_conversation', () => {
    test('never handed off, handoff not delivered, foreign prefix, unparsable or unknown id: nothing changes', async () => {
      const c = await liveCase();
      const phone = nextPhone('5694');
      const lead = await qualifiedLead({ phone, opportunity: null, status: 'active', ago: '0 minutes' });
      const notHanded = { phone, conversationId: lead.conversationId, ref: `wa-${PREFIX}-conversation-${lead.conversationId}` };
      const phone2 = nextPhone('5693');
      const pendingConversation = await conversation({ phone: phone2 });
      await handoff({ conversationId: pendingConversation, phone: phone2, routedSeller: sellerA, delivered: false });
      const pending = { phone: phone2, conversationId: pendingConversation, ref: `wa-${PREFIX}-conversation-${pendingConversation}` };

      const cases = [
        [notHanded, {}],
        [pending, {}],
        [c, { ref: `wa-other-conversation-${c.conversationId}`, conversationId: '' }],
        [c, { ref: 'wa-anyho-conversation-abc', conversationId: '' }],
        [c, { ref: 'wa-anyho-conversation-999999999', conversationId: '999999999' }],
        [c, { conversationId: String(Number(c.conversationId) + 1000000) }],
      ];
      for (const [target, options] of cases) {
        const taken = await byConversation(target, options);
        expect(taken).toMatchObject({ http_status: 422, response: { error: 'unknown_conversation', event_id: taken.eventId } });
        expect(await inboxOf(taken.eventId)).toMatchObject({ http_status: 422, lead_id: null });
        const sent = await sendByConversation(target, options);
        expect(sent).toMatchObject({ send: false, http_status: 422, response: { error: 'unknown_conversation' } });
        expect((await client.query('SELECT 1 FROM crm_outbound_messages WHERE event_id = $1', [sent.eventId])).rows).toEqual([]);
      }
      for (const target of [c, notHanded, pending]) {
        expect(await liveLeasesOf(target.phone)).toEqual([]);
        expect(await versionOf(target.conversationId)).toBe(0);
      }
    });
  });

  describe('regressions', () => {
    test('no lead (047/S8): conversation-keyed lease, no lead created', async () => {
      const phone = nextPhone('5692');
      const conversationId = await conversation({ phone });
      await customerMessage(conversationId, null);
      await handoff({ conversationId, phone, routedSeller: sellerA });
      const c = { phone, conversationId, ref: `wa-${PREFIX}-conversation-${conversationId}` };
      expect(await byConversation(c)).toMatchObject({ http_status: 200, response: { result: 'applied', ownership_version: 1 } });
      expect((await client.query(
        'SELECT lead_id, conversation_id, owner_seller_id FROM lead_chat_ownerships WHERE conversation_id = $1', [conversationId],
      )).rows).toEqual([{ lead_id: null, conversation_id: conversationId, owner_seller_id: String(sellerA) }]);
      expect(await sellerOwned(c)).toBe(true);
      expect(await byConversation(c, { seller: SELLER_B, version: 1 })).toMatchObject({
        http_status: 409, response: { error: 'ownership_conflict', holder_crm_seller_id: SELLER_A },
      });
      expect((await client.query('SELECT 1 FROM leads WHERE phone_number = $1', [phone])).rows).toEqual([]);
    });

    test('routed seller (048) may act when inactive; another inactive seller may not', async () => {
      const phone = nextPhone('5691');
      const conversationId = await conversation({ phone });
      await customerMessage(conversationId, null);
      await handoff({ conversationId, phone, routedSeller: sellerB });
      await client.query('UPDATE sellers SET is_active = FALSE WHERE id IN ($1, $2)', [sellerA, sellerB]);
      const c = { phone, conversationId, ref: `wa-${PREFIX}-conversation-${conversationId}` };
      expect(await byConversation(c)).toMatchObject({ http_status: 422, response: { error: 'invalid_seller' } });
      expect(await byConversation(c, { seller: SELLER_B })).toMatchObject({ http_status: 200, response: { result: 'applied' } });
    });
  });

  // Independent verification of T8 (B1): a ClickUp lease (no owner seller) on
  // a lead with an opportunity must name the same holder whichever key the CRM
  // uses: the lead's assigned seller, never the handoff's routed seller.
  test('ClickUp lease on a lead with an opportunity: same holder by opportunity and by conversation_id', async () => {
    const phone = nextPhone('5695');
    const only = await qualifiedLead({ phone, opportunity: OPP_NEW, seller: sellerB, status: 'escalation_required', ago: '0 minutes' });
    await handoff({ conversationId: only.conversationId, phone, routedSeller: sellerA });
    const c = { phone, conversationId: only.conversationId, ref: `wa-${PREFIX}-conversation-${only.conversationId}`, latest: only };
    await client.query(acquireSql, [only.taskId, 'nueva', `hist-${crypto.randomUUID()}`, new Date().toISOString(), 'in progress', 'cotización enviada']);
    const version = await versionOf(c.conversationId);
    expect(await byOpportunity({ opportunity: OPP_NEW, version })).toMatchObject({ http_status: 409, response: { holder_crm_seller_id: SELLER_B } });
    expect(await byConversation(c, { version })).toMatchObject({ http_status: 409, response: { holder_crm_seller_id: SELLER_B } });
    expect(await sendByConversation(c, { version })).toMatchObject({ send: false, http_status: 409 });
    expect(await byConversation(c, { seller: SELLER_B, version })).toMatchObject({ http_status: 200, response: { result: 'applied' } });
  });
});
