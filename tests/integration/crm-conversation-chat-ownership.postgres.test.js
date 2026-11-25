// =============================================================================
// CRM 1.2d (migration 047): a conversation handed off to the CRM whose customer
// has NO lead is taken, released and replied from the CRM by conversation_id,
// with the effects of a lead-owned chat: the bot stays silent while the seller
// holds it (orchestrator load and persist, outbound authority, inbound
// debounce), 2-hour window and lease expiry, release restores the bot, seller
// replies from the phone keep the lease, ownership changes reach the CRM. No
// lead and no CRM opportunity is created; a lead created later adopts the live
// ownership.
//
// Every query is the exact node query (db/queries/n8n/... or the workflow
// node). Every test runs inside a transaction that is rolled back.
// Feature document: odd/tasks/crm-1-2d-contingency-handoffs.md (S8, S5).
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
const applyConversationChatSql = read('db/queries/n8n/crm-inbound-events/04_apply_crm_conversation_chat_event.sql');
const claimConversationSendSql = read('db/queries/n8n/crm-inbound-events/05_claim_crm_conversation_message_send.sql');
const completeSendSql = read('db/queries/n8n/crm-inbound-events/03_complete_crm_message_send.sql');
const loadConversationSql = read('db/queries/n8n/wa-conversation-orchestrator/01_load_active_context.sql');
const persistConversationSql = read('db/queries/n8n/wa-conversation-orchestrator/07_persist_conversation_state.sql');
const authorizeSql = read('db/queries/n8n/wa-outbound-messages/05_authorize_outbound_send.sql');
const humanReplySql = read('db/queries/n8n/lead-chat-ownership/04_register_human_reply.sql');
const claimExpiredSql = read('db/queries/n8n/lead-chat-ownership/06_claim_expired_ownerships.sql');
const persistOwnMessageSql = read('db/queries/n8n/lead-chat-ownership/08_persist_own_message_from_evolution.sql');
const persistLeadSql = JSON.parse(read('n8n/workflows/crm-lead-creation-and-assignment.json'))
  .nodes.find((node) => node.name === 'Persist Lead And Rotation').parameters.query;
const registerHumanReplyParams = JSON.parse(read('n8n/workflows/wa-inbound-entry.json'))
  .nodes.find((node) => node.name === 'Register Human Reply').parameters.options.queryReplacement;

const PREFIX = 'conv';
const SELLER_A = '8b3e4c56-7d8f-4091-a1b2-2e3f4a5b6c7d';
const SELLER_B = '9c4f5d67-8e90-4112-b2c3-3f4a5b6c7d8e';
const hash = (value) => crypto.createHash('sha256').update(value).digest('hex');
const newEventId = () => `crm-evt-${crypto.randomUUID()}`;
const INSTANCE = 'crm-conversation-ownership-test';

describeIntegration('CRM 1.2d conversation-keyed chat ownership (migration 047)', () => {
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
      `SELECT code, id FROM conversation_statuses WHERE code IN ('escalation_required', 'active')`,
    )).rows.map((r) => [r.code, r.id]));
    ({ rows: [{ id: leadStatusId }] } = await client.query(
      `INSERT INTO lead_statuses (code, label, sort_order) VALUES ('assigned', 'Assigned', 2)
       ON CONFLICT (code) DO UPDATE SET code = EXCLUDED.code RETURNING id`,
    ));
    await client.query('UPDATE sellers SET crm_user_id = NULL WHERE crm_user_id IN ($1, $2)', [SELLER_A, SELLER_B]);
    const seller = async (name, uuid) => (await client.query(
      `INSERT INTO sellers (name, is_active, sort_order, crm_user_id, clickup_user_id)
       VALUES ($1, TRUE, 90000 + (random() * 9000)::int, $2::uuid, 'cu-' || $2::text) RETURNING id`, [name, uuid],
    )).rows[0].id;
    sellerA = await seller('Seller A', SELLER_A);
    sellerB = await seller('Seller B', SELLER_B);
    ({ rows: [{ id: sourceNumberId }] } = await client.query(
      `INSERT INTO whatsapp_numbers (display_name, phone_number, phone_number_id, instance_name)
       VALUES ('Ventas', '56223456780', 'crm-conv-' || gen_random_uuid(), $1 || '-' || gen_random_uuid()) RETURNING id`,
      [INSTANCE],
    ));
  });
  afterEach(async () => { await client.query('ROLLBACK'); });

  // A conversation in escalation_required, no lead, one customer message and a
  // handoff routed to Seller A whose handoff.created was delivered.
  const handedOffWithoutLead = async () => {
    sequence += 1;
    const phone = `5697${String(1000000 + sequence).slice(-7)}`;
    const { rows: [{ id: conversationId }] } = await client.query(
      `INSERT INTO conversations (lead_id, phone_number, conversation_status_id, source_number_id, started_at, last_message_at)
       VALUES (NULL, $1, $2, $3, NOW(), NOW()) RETURNING id`,
      [phone, statusIds.escalation_required, sourceNumberId],
    );
    await client.query(
      `INSERT INTO messages (conversation_id, lead_id, direction, sender_type, message_type, text_body, raw_payload)
       VALUES ($1, NULL, 'incoming', 'customer', 'text', 'quiero hablar con una persona', '{}'::jsonb)`,
      [conversationId],
    );
    const { rows: [{ id: handoffId }] } = await client.query(
      `INSERT INTO handoffs (idempotency_key, conversation_id, phone_number, motivo, area, area_label, prioridad,
                             responsable, estado, notified_at, crm_routing_seller_id)
       VALUES ($1, $2, $3, 'human_request', 'sales', 'Ventas', 'alta', 'Ventas', 'notified', NOW(), $4) RETURNING id`,
      [`conv-${crypto.randomUUID()}`, conversationId, phone, sellerA],
    );
    await client.query(
      `INSERT INTO crm_events (event_id, event_type, conversation_id, handoff_id, revision, body, status, delivered_at)
       VALUES ($1, 'handoff.created', $2, $3, 1, '{}', 'delivered', NOW())`,
      [`wa-${PREFIX}-handoff-${handoffId}-r1`, `wa-${PREFIX}-conversation-${conversationId}`, handoffId],
    );
    return { conversationId: String(conversationId), ref: `wa-${PREFIX}-conversation-${conversationId}`, phone };
  };

  const chat = async (conv, { eventId = newEventId(), type = 'chat.take', seller = SELLER_A, version = 0 } = {}) => {
    const { rows } = await client.query(applyConversationChatSql, [
      eventId, hash(eventId), type, conv.ref, conv.conversationId, seller, String(version),
    ]);
    expect(rows).toHaveLength(1);
    return { ...rows[0], eventId };
  };

  const send = async (conv, { eventId = newEventId(), seller = SELLER_A, text = 'Hola, le escribo de Hormiglass' } = {}) => {
    const clientMessageId = crypto.randomUUID();
    const { rows } = await client.query(claimConversationSendSql, [
      eventId, hash(`${eventId}|${clientMessageId}`), conv.ref, conv.conversationId, seller, clientMessageId, '0', text,
    ]);
    expect(rows).toHaveLength(1);
    return { ...rows[0], eventId, text };
  };

  const complete = async (claimed, providerId = `BAE5${crypto.randomUUID().slice(0, 8).toUpperCase()}`) => (
    await client.query(completeSendSql, [
      String(claimed.outbound_id), String(claimed.attempt), 'sent', providerId, '201', '', PREFIX,
    ])
  ).rows[0];

  const ownershipsOf = async (conversationId) => (await client.query(
    'SELECT * FROM lead_chat_ownerships WHERE conversation_id = $1 ORDER BY id', [conversationId],
  )).rows;
  const changesOf = async (conversationId) => (await client.query(
    'SELECT * FROM crm_ownership_changes WHERE conversation_id = $1 ORDER BY ownership_version', [conversationId],
  )).rows;
  const leadsOf = async (phone) => (await client.query(
    'SELECT * FROM leads WHERE phone_number = $1 AND source_number_id = $2', [phone, sourceNumberId],
  )).rows;
  const sellerOwned = async (conv) => (await client.query(
    'SELECT inbound_contact_seller_owned($1, $2) AS owned', [sourceNumberId, conv.phone],
  )).rows[0].owned;

  const claimedInbound = async (conv, { fromMe = false, externalMessageId = null } = {}) => {
    sequence += 1;
    const token = `conv-token-${sequence}-${crypto.randomUUID()}`;
    // One event in flight per contact queue: an earlier load's event is done.
    await client.query(
      `UPDATE inbound_events SET processing_status = 'processed', processing_token = NULL
       WHERE phone_number = $1 AND source_number_id = $2 AND processing_status = 'processing'`,
      [conv.phone, sourceNumberId],
    );
    const { rows: [row] } = await client.query(`
      INSERT INTO inbound_events (
        instance_name, external_message_id, event_fingerprint, dedupe_key, source_number_id, phone_number,
        queue_key, event_type, normalized_event, should_process, processing_status, processing_started_at,
        processing_token, processing_phase, attempt_count, raw_payload, normalized_payload
      ) VALUES (
        $1, $2, md5($4), 'id:' || $4, $3::bigint, $5, $3::bigint::text || ':' || $5, 'messages.upsert',
        'MESSAGES_UPSERT', TRUE, 'processing', NOW(), $6, 'orchestrating', 1, '{}'::jsonb,
        jsonb_build_object('is_from_me', $7::boolean)
      ) RETURNING id, received_at
    `, [INSTANCE, externalMessageId, sourceNumberId, `conv-${token}`, conv.phone, token, fromMe]);
    return { id: String(row.id), token, receivedAt: row.received_at };
  };

  // Load Conversation State, 19 parameters in node order.
  const loadState = async (conv) => {
    const event = await claimedInbound(conv);
    const { rows } = await client.query(loadConversationSql, [
      conv.phone, String(sourceNumberId), 'Ana', null, `in-${event.token}`, null, 'text', 'hola?', '{}',
      null, null, null, null, null, null, null, INSTANCE, event.id, event.token,
    ]);
    expect(rows).toHaveLength(1);
    return { row: rows[0], event };
  };

  // Persist Conversation State for a suppressed customer turn, 58 parameters.
  const persistSuppressedTurn = async (conv, event, ownershipLeadId = null) => {
    const values = [
      conv.conversationId, conv.phone, String(sourceNumberId), 'escalation', null,
      `in-${event.token}`, null, 'text', 'hola?', '{}',
      null, null, null, null, null, null, null,
      'escalation_required', 'conversation_state_evaluated', 'human_control_suppressed',
      '{}', '{}', '{}', false, false, true,
      null, null, null, null, 'human_control_active', null, null, null, null, null,
      0, '[]', '{}', '{}', null, null, false, '[]',
      null, null, null, '{}', null, null, null, '[]', '{}', null,
      event.id, event.token, JSON.stringify({ response_text: '', bot_suppressed: true }), ownershipLeadId,
    ];
    expect(values).toHaveLength(58);
    const { rows } = await client.query(persistConversationSql, values);
    expect(rows).toHaveLength(1);
    return rows[0];
  };

  // A bot reply claimed for dispatch, then the outbound authority (05).
  const authorizeBotReply = async (conv) => {
    const token = `dispatch-${crypto.randomUUID()}`;
    const { rows: [{ id }] } = await client.query(`
      INSERT INTO messages (conversation_id, lead_id, direction, sender_type, message_type, delivery_status,
                            text_body, raw_payload, idempotency_key, dispatch_phase, dispatch_token, claimed_at)
      VALUES ($1, NULL, 'outgoing', 'bot', 'text', 'queued', 'respuesta bot',
              jsonb_build_object('number', $2::text, 'text', 'respuesta bot'), $3, 'claimed', $3, NOW())
      RETURNING id
    `, [conv.conversationId, conv.phone, token]);
    const { rows } = await client.query(authorizeSql, [String(id), token, 'question']);
    expect(rows).toHaveLength(1);
    return rows[0];
  };

  // A fromMe message typed on the business phone: 08 then 04 with the node's
  // own parameter list (Register Human Reply), as wa-inbound-entry runs them.
  const sellerPhoneReply = async (conv, text = 'Hola, soy Ana de ventas') => {
    const externalMessageId = `3EB0${crypto.randomUUID().slice(0, 12).toUpperCase()}`;
    const event = await claimedInbound(conv, { fromMe: true, externalMessageId });
    const { rows: [own] } = await client.query(persistOwnMessageSql, [
      event.id, event.token, String(sourceNumberId), conv.phone, externalMessageId, event.receivedAt,
      'text', text, '{}', INSTANCE,
    ]);
    const $json = { ...own };
    const $env = { CLICKUP_STATUS_ACKNOWLEDGED: 'in progress' };
    // eslint-disable-next-line no-new-func
    const params = new Function('$json', '$env', `return ${registerHumanReplyParams.replace(/^=\{\{|\}\}$/g, '')};`)($json, $env);
    const { rows: [reply] } = await client.query(humanReplySql, params);
    return { own, reply };
  };

  // Live test 2026-11-25 (finding F2): test-phone handoffs are routed to the
  // configured test seller, who is inactive in `sellers` to stay out of the
  // rotation. The seller the bot routed a handoff to may always act on it;
  // any other inactive seller is still rejected.
  test('the seller the handoff was routed to may take and send even when inactive', async () => {
    const conv = await handedOffWithoutLead();
    await client.query('UPDATE sellers SET is_active = FALSE WHERE id = $1', [sellerA]);
    const taken = await chat(conv);
    expect(taken.http_status).toBe(200);
    expect(taken.response).toMatchObject({ result: 'applied' });
    const claimed = await send(conv);
    expect(claimed.http_status).not.toBe(422);
    expect(claimed.response?.error).not.toBe('invalid_seller');
  });

  test('an inactive seller the handoff was not routed to is still rejected', async () => {
    const conv = await handedOffWithoutLead();
    await client.query('UPDATE sellers SET is_active = FALSE WHERE id = $1', [sellerB]);
    const taken = await chat(conv, { seller: SELLER_B });
    expect(taken.http_status).toBe(422);
    expect(taken.response).toMatchObject({ error: 'invalid_seller' });
    const claimed = await send(conv, { seller: SELLER_B });
    expect(claimed.http_status).toBe(422);
    expect(claimed.response).toMatchObject({ error: 'invalid_seller' });
  });

  test('chat.take without a lead: conversation-keyed lease, 2-hour window, taken change, no lead', async () => {
    const conv = await handedOffWithoutLead();
    const taken = await chat(conv);
    expect(taken).toMatchObject({
      http_status: 200, replayed: false, response: { event_id: taken.eventId, result: 'applied', ownership_version: 1 },
    });
    const [row] = await ownershipsOf(conv.conversationId);
    expect(row).toMatchObject({
      lead_id: null, conversation_id: conv.conversationId, acquired_via: 'crm', owner_seller_id: String(sellerA),
      clickup_task_id: null, sla_mode: 'standard', released_at: null,
    });
    expect(row.pending_message_id).not.toBeNull();
    expect((new Date(row.response_due_at) - new Date(row.acquired_at)) / 60000).toBeCloseTo(120, 0);
    expect(await changesOf(conv.conversationId)).toMatchObject([
      { ownership_version: '1', change_kind: 'taken', source: 'crm', seller_id: String(sellerA), lead_id: null },
    ]);
    expect((await client.query('SELECT * FROM crm_inbound_events WHERE event_id = $1', [taken.eventId])).rows[0])
      .toMatchObject({ http_status: 200, lead_id: null, conversation_id: conv.conversationId });
    expect(await leadsOf(conv.phone)).toEqual([]);
  });

  test('the bot stays silent while the seller holds it: load, persist, outbound authority, debounce', async () => {
    const conv = await handedOffWithoutLead();
    expect(await sellerOwned(conv)).toBe(false);
    await chat(conv);
    const [ownership] = await ownershipsOf(conv.conversationId);

    const { row, event } = await loadState(conv);
    expect(row).toMatchObject({
      bot_suppressed: true, ownership_id: ownership.id, ownership_lead_id: null,
      ownership_conversation_id: conv.conversationId, human_arbitration_required: false,
    });
    expect(await sellerOwned(conv)).toBe(true);

    const persisted = await persistSuppressedTurn(conv, event);
    expect(persisted.ownership_id).toBe(ownership.id);
    const [after] = await ownershipsOf(conv.conversationId);
    expect(after.pending_message_id).toBe(persisted.message_id);
    expect((new Date(after.response_due_at) - Date.now()) / 60000).toBeCloseTo(120, 0);

    expect(await authorizeBotReply(conv)).toMatchObject({
      should_send: false, human_control_cancelled: true, dispatch_phase: 'cancelled',
    });
    expect(await leadsOf(conv.phone)).toEqual([]);
  });

  test('chat.release restores the bot and reaches the CRM as released by crm', async () => {
    const conv = await handedOffWithoutLead();
    await chat(conv);
    const released = await chat(conv, { type: 'chat.release', version: 1 });
    expect(released).toMatchObject({ http_status: 200, response: { result: 'applied', ownership_version: 2 } });
    const [row] = await ownershipsOf(conv.conversationId);
    expect(row).toMatchObject({ release_reason: 'manual', released_via: 'crm', restoration_state: 'not_required' });
    expect(row.released_at).not.toBeNull();
    expect((await changesOf(conv.conversationId)).map((c) => [c.change_kind, c.source, c.reason]))
      .toEqual([['taken', 'crm', null], ['released', 'crm', 'seller_released']]);
    expect((await loadState(conv)).row.bot_suppressed).toBe(false);
    expect(await sellerOwned(conv)).toBe(false);
    expect(await authorizeBotReply(conv)).toMatchObject({ should_send: true, dispatch_phase: 'sending' });
  });

  test('another seller is an ownership conflict; the routed seller holds a lease without owner', async () => {
    const conv = await handedOffWithoutLead();
    await chat(conv);
    expect(await chat(conv, { seller: SELLER_B, version: 1 })).toMatchObject({
      http_status: 409, response: { error: 'ownership_conflict', holder_crm_seller_id: SELLER_A, ownership_version: 1 },
    });
    expect(await ownershipsOf(conv.conversationId)).toHaveLength(1);
  });

  test('message.send without a lead: implicit take, send, completion keeps the lease and clears the window', async () => {
    const conv = await handedOffWithoutLead();
    const claimed = await send(conv);
    expect(claimed).toMatchObject({ send: true, attempt: 1, phone_number: conv.phone, http_status: null });
    const outbound = (await client.query('SELECT * FROM crm_outbound_messages WHERE event_id = $1', [claimed.eventId])).rows[0];
    expect(outbound).toMatchObject({
      crm_opportunity_id: null, crm_conversation_ref: conv.ref, lead_id: null,
      conversation_id: conv.conversationId, ownership_version: '1', status: 'sending',
    });
    expect(await ownershipsOf(conv.conversationId)).toMatchObject([{ acquired_via: 'crm', owner_seller_id: String(sellerA) }]);

    const done = await complete(claimed);
    expect(done).toMatchObject({ http_status: 200, response: { event_id: claimed.eventId, result: 'sent', ownership_version: 1 } });
    const [message] = (await client.query(
      `SELECT * FROM messages WHERE conversation_id = $1 AND direction = 'outgoing'`, [conv.conversationId],
    )).rows;
    expect(message).toMatchObject({ sender_type: 'human', text_body: claimed.text, lead_id: null });
    const [row] = await ownershipsOf(conv.conversationId);
    expect(row).toMatchObject({
      released_at: null, pending_message_id: null, response_due_at: null, last_human_message_id: message.id,
    });
    expect((await loadState(conv)).row.bot_suppressed).toBe(true);
    expect(await leadsOf(conv.phone)).toEqual([]);
  });

  test('lease expiry: the bot answers again, the sweeper releases sla_expired, a later take starts a new lease', async () => {
    const conv = await handedOffWithoutLead();
    await chat(conv);
    await client.query(
      `UPDATE lead_chat_ownerships SET response_due_at = NOW() - INTERVAL '1 minute' WHERE conversation_id = $1`,
      [conv.conversationId],
    );
    expect((await loadState(conv)).row).toMatchObject({ bot_suppressed: false, human_arbitration_required: true });
    expect(await sellerOwned(conv)).toBe(false);
    expect(await authorizeBotReply(conv)).toMatchObject({ should_send: true });

    const { rows: swept } = await client.query(claimExpiredSql, ['500', '900']);
    const [expired] = await ownershipsOf(conv.conversationId);
    expect(swept.map((r) => r.ownership_id)).toContain(expired.id);
    expect(expired).toMatchObject({ release_reason: 'sla_expired', lead_id: null });
    expect(expired.released_at).not.toBeNull();
    expect((await changesOf(conv.conversationId)).at(-1)).toMatchObject({
      change_kind: 'released', source: 'bot', reason: 'sla_expired', ownership_version: '2',
    });

    expect(await chat(conv, { seller: SELLER_B, version: 2 })).toMatchObject({
      http_status: 200, response: { result: 'applied', ownership_version: 3 },
    });
    const rows = await ownershipsOf(conv.conversationId);
    expect(rows).toHaveLength(2);
    expect(rows[1]).toMatchObject({ owner_seller_id: String(sellerB), released_at: null });
  });

  test('a take over a lease that expired before the sweeper releases it as sla_expired first', async () => {
    const conv = await handedOffWithoutLead();
    await chat(conv);
    await client.query(
      `UPDATE lead_chat_ownerships SET response_due_at = NOW() - INTERVAL '1 minute' WHERE conversation_id = $1`,
      [conv.conversationId],
    );
    expect(await chat(conv, { seller: SELLER_B, version: 1 })).toMatchObject({
      http_status: 200, response: { result: 'applied', ownership_version: 3 },
    });
    const rows = await ownershipsOf(conv.conversationId);
    expect(rows.map((r) => [r.release_reason, r.owner_seller_id])).toEqual([
      ['sla_expired', String(sellerA)], [null, String(sellerB)],
    ]);
  });

  test('a seller reply from the phone keeps the lease; a late one re-acquires it, no ClickUp operation', async () => {
    const conv = await handedOffWithoutLead();
    await chat(conv);
    const { own, reply } = await sellerPhoneReply(conv);
    expect(own).toMatchObject({ own_message_kind: 'human_reply', conversation_id: conv.conversationId, lead_id: null });
    const [held] = await ownershipsOf(conv.conversationId);
    expect(reply).toMatchObject({
      outcome: 'reply_registered', ownership_id: held.id, bot_suppressed: true, clickup_reacquire_required: false,
    });
    expect(held).toMatchObject({ released_at: null, pending_message_id: null, response_due_at: null });
    expect(held.last_human_message_id).toBe(own.message_id);
    expect((await client.query('SELECT processing_status FROM inbound_events WHERE id = $1', [own.inbound_event_id])).rows[0])
      .toEqual({ processing_status: 'processed' });

    await chat(conv, { type: 'chat.release', version: 1 });
    const late = await sellerPhoneReply(conv, 'sigo yo');
    expect(late.reply).toMatchObject({
      outcome: 'late_reply_reacquired', bot_suppressed: true, clickup_reacquire_required: false,
      clickup_reacquire_operation_key: null,
    });
    const rows = await ownershipsOf(conv.conversationId);
    expect(rows).toHaveLength(2);
    expect(rows[1]).toMatchObject({
      id: late.reply.ownership_id, released_at: null, acquired_via: 'crm', owner_seller_id: String(sellerA),
      clickup_task_id: null, lead_id: null,
    });
    expect((await client.query(
      `SELECT 1 FROM external_operations WHERE entity_type = 'lead_chat_ownership' AND entity_id = ANY($1::bigint[])`,
      [rows.map((r) => r.id)],
    )).rows).toEqual([]);
    expect((await changesOf(conv.conversationId)).map((c) => [c.change_kind, c.source]))
      .toEqual([['taken', 'crm'], ['released', 'crm'], ['taken', 'crm']]);
    expect((await loadState(conv)).row.bot_suppressed).toBe(true);
  });

  test('a lead created later adopts the live lease: one live owner, no ownership change, lead path from then on', async () => {
    const conv = await handedOffWithoutLead();
    await chat(conv);
    const [live] = await ownershipsOf(conv.conversationId);
    const { rows: [created] } = await client.query(persistLeadSql, [
      '', String(sourceNumberId), '', 'Ana', conv.phone, 'cierre', 'Santiago', 'cotizar', 'qualified_complete', 'true', 'false',
      `test-rotation-${crypto.randomUUID()}`, conv.conversationId, '{}', String(sellerA),
    ]);
    expect(created.lead_id).not.toBeNull();

    const moved = (await client.query('SELECT * FROM lead_chat_ownerships WHERE id = $1', [live.id])).rows[0];
    expect(moved).toMatchObject({ lead_id: String(created.lead_id), conversation_id: null, released_at: null });
    expect(await ownershipsOf(conv.conversationId)).toEqual([]);
    expect((await client.query(
      'SELECT count(*)::int AS n FROM lead_chat_ownerships WHERE (lead_id = $1 OR conversation_id = $2) AND released_at IS NULL',
      [created.lead_id, conv.conversationId],
    )).rows[0].n).toBe(1);
    expect(await changesOf(conv.conversationId)).toHaveLength(1);
    expect((await loadState(conv)).row).toMatchObject({
      bot_suppressed: true, ownership_id: live.id, ownership_lead_id: String(created.lead_id),
    });

    const released = await chat(conv, { type: 'chat.release', version: 1 });
    expect(released).toMatchObject({ http_status: 200, response: { result: 'applied', ownership_version: 2 } });
    expect((await client.query('SELECT lead_id FROM crm_inbound_events WHERE event_id = $1', [released.eventId])).rows[0])
      .toEqual({ lead_id: String(created.lead_id) });
  });

  test('a conversation ownership row carries exactly one key', async () => {
    const conv = await handedOffWithoutLead();
    const rejected = async (sql, params) => {
      await client.query('SAVEPOINT holder');
      try {
        await client.query(sql, params);
        return null;
      } catch (error) {
        return error.message;
      } finally {
        await client.query('ROLLBACK TO SAVEPOINT holder');
      }
    };
    expect(await rejected(
      `INSERT INTO lead_chat_ownerships (lead_id, conversation_id, acquired_via) VALUES (NULL, NULL, 'crm')`,
    )).toMatch(/chk_lead_chat_ownerships_holder/);
    await chat(conv);
    expect(await rejected(
      `INSERT INTO lead_chat_ownerships (conversation_id, acquired_via) VALUES ($1, 'crm')`, [conv.conversationId],
    )).toMatch(/uq_lead_chat_ownerships_active_conversation/);
  });

  // Re-engagement: the handed-off conversation inherited an older lead of the
  // contact (conversations.lead_id = L, L's own conversation is older). The
  // bot's silence reads L, so the CRM acts on L's lead-keyed lease.
  describe('a handed-off conversation that inherited an older lead of the contact', () => {
    const reengaged = async ({ liveLease }) => {
      const conv = await handedOffWithoutLead();
      const { rows: [{ id: olderConversationId }] } = await client.query(
        `INSERT INTO conversations (phone_number, conversation_status_id, source_number_id, started_at, last_message_at)
         VALUES ($1, $2, $3, NOW() - INTERVAL '3 days', NOW() - INTERVAL '3 days') RETURNING id`,
        [conv.phone, statusIds.active, sourceNumberId],
      );
      const { rows: [{ id: leadId }] } = await client.query(
        `INSERT INTO leads (whatsapp_name, phone_number, lead_status_id, source_number_id, source_conversation_id,
                            channel, created_at)
         VALUES ('Ana', $1, $2, $3, $4, 'whatsapp', NOW() - INTERVAL '3 days') RETURNING id`,
        [conv.phone, leadStatusId, sourceNumberId, olderConversationId],
      );
      await client.query('UPDATE conversations SET lead_id = $1 WHERE id IN ($2, $3)', [leadId, olderConversationId, conv.conversationId]);
      let ownershipId = null;
      if (liveLease) {
        ({ rows: [{ id: ownershipId }] } = await client.query(
          `INSERT INTO lead_chat_ownerships (lead_id, clickup_task_id, previous_clickup_status, sla_mode)
           VALUES ($1::bigint, 'task-reengaged-' || $1::text, 'to do', 'standard') RETURNING id`, [leadId],
        ));
      }
      return { ...conv, leadId: String(leadId), ownershipId };
    };

    test('a live ClickUp lease on the lead: another seller gets 409 and the bot stays silent', async () => {
      const conv = await reengaged({ liveLease: true });
      expect((await loadState(conv)).row.bot_suppressed).toBe(true);
      const answer = await chat(conv, { seller: SELLER_B });
      expect(answer).toMatchObject({
        http_status: 409, response: { error: 'ownership_conflict', holder_crm_seller_id: SELLER_A },
      });
      expect(await ownershipsOf(conv.conversationId)).toEqual([]);
      expect((await client.query(
        'SELECT id FROM lead_chat_ownerships WHERE lead_id = $1 AND released_at IS NULL', [conv.leadId],
      )).rows).toEqual([{ id: conv.ownershipId }]);
      expect((await loadState(conv)).row).toMatchObject({ bot_suppressed: true, ownership_lead_id: conv.leadId });
      expect(await sellerOwned(conv)).toBe(true);
    });

    test('no live lease: the take holds the lead-keyed lease, silences the bot and reaches the CRM', async () => {
      const conv = await reengaged({ liveLease: false });
      const taken = await chat(conv);
      expect(taken).toMatchObject({ http_status: 200, response: { result: 'applied', ownership_version: 1 } });
      const live = (await client.query(
        'SELECT * FROM lead_chat_ownerships WHERE lead_id = $1 AND released_at IS NULL', [conv.leadId],
      )).rows;
      expect(live).toMatchObject([{ acquired_via: 'crm', owner_seller_id: String(sellerA) }]);
      expect((await client.query(
        'SELECT 1 FROM lead_chat_ownerships WHERE conversation_id = $1 AND lead_id IS NULL', [conv.conversationId],
      )).rows).toEqual([]);
      expect((await loadState(conv)).row).toMatchObject({ bot_suppressed: true, ownership_lead_id: conv.leadId });
      expect(await sellerOwned(conv)).toBe(true);
      expect(await changesOf(conv.conversationId)).toMatchObject([{ change_kind: 'taken', source: 'crm', lead_id: conv.leadId }]);
      expect((await client.query('SELECT lead_id FROM crm_inbound_events WHERE event_id = $1', [taken.eventId])).rows[0])
        .toEqual({ lead_id: conv.leadId });

      expect(await chat(conv, { type: 'chat.release', version: 1 })).toMatchObject({
        http_status: 200, response: { result: 'applied', ownership_version: 2 },
      });
      expect((await loadState(conv)).row.bot_suppressed).toBe(false);
    });
  });

  describe('lead-keyed behavior is unchanged', () => {
    const leadOwnedConversation = async () => {
      sequence += 1;
      const phone = `5698${String(1000000 + sequence).slice(-7)}`;
      const { rows: [{ id: leadId }] } = await client.query(
        `INSERT INTO leads (whatsapp_name, phone_number, lead_status_id, source_number_id, assigned_seller_id, channel)
         VALUES ('Ana', $1, $2, $3, $4, 'whatsapp') RETURNING id`, [phone, leadStatusId, sourceNumberId, sellerB],
      );
      const { rows: [{ id: conversationId }] } = await client.query(
        `INSERT INTO conversations (lead_id, phone_number, conversation_status_id, source_number_id, started_at, last_message_at)
         VALUES ($1, $2, $3, $4, NOW(), NOW()) RETURNING id`, [leadId, phone, statusIds.active, sourceNumberId],
      );
      const { rows: [{ id: ownershipId }] } = await client.query(
        `INSERT INTO lead_chat_ownerships (lead_id, clickup_task_id, previous_clickup_status, response_due_at)
         VALUES ($1::bigint, 'task-' || $1::text, 'to do', NOW() + INTERVAL '2 hours') RETURNING id`, [leadId],
      );
      return { leadId: String(leadId), conversationId: String(conversationId), phone, ownershipId };
    };

    test('ClickUp-acquired lead lease: tracked under the lead conversation with the lead seller', async () => {
      const lead = await leadOwnedConversation();
      expect(await changesOf(lead.conversationId)).toMatchObject([
        { change_kind: 'taken', source: 'clickup', lead_id: lead.leadId, seller_id: String(sellerB) },
      ]);
      expect((await client.query('SELECT conversation_id FROM lead_chat_ownerships WHERE id = $1', [lead.ownershipId])).rows[0])
        .toEqual({ conversation_id: null });
    });

    test('orchestrator, persist, outbound authority and debounce read the lead lease', async () => {
      const lead = await leadOwnedConversation();
      const { row, event } = await loadState(lead);
      expect(row).toMatchObject({
        bot_suppressed: true, ownership_id: lead.ownershipId, ownership_lead_id: lead.leadId, ownership_conversation_id: null,
      });
      expect((await persistSuppressedTurn(lead, event, lead.leadId)).ownership_id).toBe(lead.ownershipId);
      expect(await authorizeBotReply(lead)).toMatchObject({ should_send: false, human_control_cancelled: true });
      expect(await sellerOwned(lead)).toBe(true);
    });

    test('a seller phone reply in a lead chat registers on the lead lease and ignores the conversation', async () => {
      const lead = await leadOwnedConversation();
      const { own, reply } = await sellerPhoneReply(lead);
      expect(own).toMatchObject({ lead_id: lead.leadId, conversation_id: lead.conversationId });
      expect(reply).toMatchObject({ outcome: 'reply_registered', ownership_id: lead.ownershipId });
    });
  });
});
