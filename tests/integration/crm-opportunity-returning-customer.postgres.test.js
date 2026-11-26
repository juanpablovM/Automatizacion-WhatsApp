// =============================================================================
// CRM chat events keyed by crm_opportunity_id on a returning customer
// (migration 049, spec S9 of odd/tasks/crm-1-2d-contingency-handoffs.md).
//
// Live case 2026-11-25: the opportunity's lead (older, conversation closed) is
// not the contact's latest lead (the customer re-qualified into a newer lead
// without an opportunity, in another conversation). The bot's silence reads
// the ownership of the contact's latest lead, so chat.take / chat.release /
// message.send by opportunity act on that lead's lease, tracked under the
// conversation the CRM knows for the opportunity. When the opportunity's lead
// is the latest lead nothing changes.
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
const claimSendSql = read('db/queries/n8n/crm-inbound-events/02_claim_crm_message_send.sql');
const completeSendSql = read('db/queries/n8n/crm-inbound-events/03_complete_crm_message_send.sql');
const loadConversationSql = read('db/queries/n8n/wa-conversation-orchestrator/01_load_active_context.sql');
const authorizeSql = read('db/queries/n8n/wa-outbound-messages/05_authorize_outbound_send.sql');
const acquireSql = read('db/queries/n8n/lead-chat-ownership/01_acquire_ownership_from_clickup.sql');

const PREFIX = 'opprc';
const SELLER_A = '3d5e6f70-8192-4a3b-9c4d-5e6f708192a3';
const SELLER_B = '4e6f7081-92a3-4b4c-8d5e-6f708192a3b4';
const OPPORTUNITY = '6e190fad-1111-4222-8333-444455556666';
const INSTANCE = 'crm-opportunity-returning-test';
const hash = (value) => crypto.createHash('sha256').update(value).digest('hex');
const newEventId = () => `crm-evt-${crypto.randomUUID()}`;

describeIntegration('CRM opportunity chat events on a returning customer (migration 049)', () => {
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
      `SELECT code, id FROM conversation_statuses WHERE code IN ('active', 'closed')`,
    )).rows.map((r) => [r.code, r.id]));
    ({ rows: [{ id: leadStatusId }] } = await client.query(
      `INSERT INTO lead_statuses (code, label, sort_order) VALUES ('assigned', 'Assigned', 2)
       ON CONFLICT (code) DO UPDATE SET code = EXCLUDED.code RETURNING id`,
    ));
    await client.query('UPDATE sellers SET crm_user_id = NULL WHERE crm_user_id IN ($1, $2)', [SELLER_A, SELLER_B]);
    await client.query('UPDATE leads SET crm_opportunity_id = NULL WHERE crm_opportunity_id = $1', [OPPORTUNITY]);
    const seller = async (name, uuid) => (await client.query(
      `INSERT INTO sellers (name, is_active, sort_order, crm_user_id)
       VALUES ($1, TRUE, 90000 + (random() * 9000)::int, $2::uuid) RETURNING id`, [name, uuid],
    )).rows[0].id;
    sellerA = await seller('Seller A', SELLER_A);
    sellerB = await seller('Seller B', SELLER_B);
    ({ rows: [{ id: sourceNumberId }] } = await client.query(
      `INSERT INTO whatsapp_numbers (display_name, phone_number, phone_number_id, instance_name)
       VALUES ('Ventas', '56223456781', 'crm-opprc-' || gen_random_uuid(), $1 || '-' || gen_random_uuid()) RETURNING id`,
      [INSTANCE],
    ));
  });
  afterEach(async () => { await client.query('ROLLBACK'); });

  // A lead with its own conversation and one customer message.
  const leadWithConversation = async ({ phone, opportunity = null, seller = sellerA, previous = null, status = 'active', startedAgo = '0 minutes' }) => {
    const taskId = `opprc-task-${crypto.randomUUID()}`;
    const { rows: [{ id: conversationId }] } = await client.query(
      `INSERT INTO conversations (lead_id, phone_number, conversation_status_id, source_number_id, started_at, last_message_at)
       VALUES (NULL, $1, $2, $3, NOW() - $4::interval, NOW() - $4::interval) RETURNING id`,
      [phone, statusIds[status], sourceNumberId, startedAgo],
    );
    const { rows: [{ id: leadId }] } = await client.query(
      `INSERT INTO leads (whatsapp_name, phone_number, lead_status_id, assigned_seller_id, source_number_id,
                          clickup_task_id, crm_opportunity_id, channel, source_conversation_id, previous_lead_id)
       VALUES ('Ana', $1, $2, $3, $4, $5, $6, 'whatsapp', $7, $8) RETURNING id`,
      [phone, leadStatusId, seller, sourceNumberId, taskId, opportunity, conversationId, previous],
    );
    await client.query('UPDATE conversations SET lead_id = $1 WHERE id = $2', [leadId, conversationId]);
    const { rows: [{ id: messageId }] } = await client.query(
      `INSERT INTO messages (conversation_id, lead_id, direction, sender_type, message_type, text_body, raw_payload, created_at)
       VALUES ($1, $2, 'incoming', 'customer', 'text', 'hola', '{}'::jsonb, NOW() - $3::interval) RETURNING id`,
      [conversationId, leadId, startedAgo],
    );
    return { leadId: String(leadId), conversationId: String(conversationId), taskId, messageId: String(messageId) };
  };

  const announce = ({ leadId, conversationId }) => client.query(
    `INSERT INTO crm_events (event_id, event_type, conversation_id, lead_id, revision, body, status, delivered_at)
     VALUES ($1, 'lead.qualified', $2, $3, 1, '{}', 'delivered', NOW())`,
    [`wa-${PREFIX}-lead-${leadId}-r1`, `wa-${PREFIX}-conversation-${conversationId}`, leadId],
  );

  // The live case: the opportunity's lead (closed conversation, two days ago)
  // and a newer lead of the same phone and source without an opportunity.
  const returningCustomer = async ({ newerSeller = sellerA } = {}) => {
    sequence += 1;
    const phone = `5699${String(1000000 + sequence).slice(-7)}`;
    const old = await leadWithConversation({ phone, opportunity: OPPORTUNITY, status: 'closed', startedAgo: '2 days' });
    await announce(old);
    const latest = await leadWithConversation({ phone, previous: old.leadId, seller: newerSeller });
    return { phone, old, latest };
  };

  const singleLead = async () => {
    sequence += 1;
    const phone = `5698${String(1000000 + sequence).slice(-7)}`;
    const old = await leadWithConversation({ phone, opportunity: OPPORTUNITY });
    await announce(old);
    return { phone, old, latest: old };
  };

  const chat = async ({ eventId = newEventId(), type = 'chat.take', seller = SELLER_A, version = 0 } = {}) => {
    const { rows } = await client.query(applyChatSql, [eventId, hash(eventId), type, OPPORTUNITY, seller, String(version)]);
    expect(rows).toHaveLength(1);
    return { ...rows[0], eventId };
  };
  const claim = async ({ eventId = newEventId(), seller = SELLER_A, text = 'Hola, le escribo de Hormiglass' } = {}) => {
    const clientMessageId = crypto.randomUUID();
    const { rows } = await client.query(claimSendSql, [
      eventId, hash(`${eventId}|${clientMessageId}`), OPPORTUNITY, seller, clientMessageId, '0', text,
    ]);
    expect(rows).toHaveLength(1);
    return { ...rows[0], eventId };
  };
  const complete = async (claimed) => (await client.query(completeSendSql, [
    String(claimed.outbound_id), String(claimed.attempt), 'sent', `BAE5${crypto.randomUUID().slice(0, 8).toUpperCase()}`,
    '201', '', PREFIX,
  ])).rows[0];

  const ownershipsOfLead = async (leadId) => (await client.query(
    'SELECT * FROM lead_chat_ownerships WHERE lead_id = $1 ORDER BY id', [leadId],
  )).rows;
  const changesOf = async (conversationId) => (await client.query(
    'SELECT * FROM crm_ownership_changes WHERE conversation_id = $1 ORDER BY ownership_version', [conversationId],
  )).rows;
  const sellerOwned = async (c) => (await client.query(
    'SELECT inbound_contact_seller_owned($1, $2) AS owned', [sourceNumberId, c.phone],
  )).rows[0].owned;
  const inboxOf = async (eventId) => (await client.query(
    'SELECT * FROM crm_inbound_events WHERE event_id = $1', [eventId],
  )).rows[0];

  const loadState = async (c) => {
    sequence += 1;
    const token = `opprc-token-${sequence}-${crypto.randomUUID()}`;
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
    `, [INSTANCE, sourceNumberId, `opprc-${token}`, c.phone, token]);
    const { rows } = await client.query(loadConversationSql, [
      c.phone, String(sourceNumberId), 'Ana', null, `in-${token}`, null, 'text', 'hola?', '{}',
      null, null, null, null, null, null, null, INSTANCE, String(event.id), token,
    ]);
    expect(rows).toHaveLength(1);
    await client.query(`UPDATE inbound_events SET processing_status = 'processed', processing_token = NULL WHERE id = $1`, [event.id]);
    return rows[0];
  };

  // A bot reply in the conversation the customer is writing in, then the
  // outbound authority (05).
  const authorizeBotReply = async (c) => {
    const token = `dispatch-${crypto.randomUUID()}`;
    const { rows: [{ id }] } = await client.query(`
      INSERT INTO messages (conversation_id, lead_id, direction, sender_type, message_type, delivery_status,
                            text_body, raw_payload, idempotency_key, dispatch_phase, dispatch_token, claimed_at)
      VALUES ($1, $2, 'outgoing', 'bot', 'text', 'queued', 'respuesta bot',
              jsonb_build_object('number', $3::text, 'text', 'respuesta bot'), $4, 'claimed', $4, NOW())
      RETURNING id
    `, [c.latest.conversationId, c.latest.leadId, c.phone, token]);
    const { rows } = await client.query(authorizeSql, [String(id), token, 'question']);
    expect(rows).toHaveLength(1);
    return rows[0];
  };

  test('chat.take by opportunity silences the bot where the returning customer writes', async () => {
    const c = await returningCustomer();
    expect(await sellerOwned(c)).toBe(false);

    const taken = await chat();
    expect(taken).toMatchObject({
      http_status: 200, replayed: false, response: { event_id: taken.eventId, result: 'applied', ownership_version: 1 },
    });

    expect(await ownershipsOfLead(c.old.leadId)).toEqual([]);
    const [lease] = await ownershipsOfLead(c.latest.leadId);
    expect(lease).toMatchObject({
      lead_id: c.latest.leadId, conversation_id: c.old.conversationId, acquired_via: 'crm',
      owner_seller_id: String(sellerA), clickup_task_id: null, released_at: null, sla_mode: 'standard',
      pending_message_id: c.latest.messageId,
    });
    expect((new Date(lease.response_due_at) - new Date(lease.acquired_at)) / 60000).toBeCloseTo(120, 0);

    expect(await sellerOwned(c)).toBe(true);
    expect(await loadState(c)).toMatchObject({
      bot_suppressed: true, ownership_id: lease.id, ownership_lead_id: c.latest.leadId,
    });
    expect(await authorizeBotReply(c)).toMatchObject({
      should_send: false, human_control_cancelled: true, dispatch_phase: 'cancelled',
    });

    expect(await changesOf(c.old.conversationId)).toMatchObject([
      { ownership_version: '1', change_kind: 'taken', source: 'crm', seller_id: String(sellerA), lead_id: c.latest.leadId },
    ]);
    expect(await changesOf(c.latest.conversationId)).toEqual([]);
    expect(await inboxOf(taken.eventId)).toMatchObject({
      http_status: 200, lead_id: c.latest.leadId, conversation_id: c.old.conversationId,
    });

    // Same seller again: idempotent.
    expect(await chat({ version: 1 })).toMatchObject({
      http_status: 200, response: { result: 'applied', ownership_version: 1 },
    });
    expect(await ownershipsOfLead(c.latest.leadId)).toHaveLength(1);
  });

  test('chat.release by opportunity frees the bot', async () => {
    const c = await returningCustomer();
    await chat();
    const released = await chat({ type: 'chat.release', version: 1 });
    expect(released).toMatchObject({ http_status: 200, response: { result: 'applied', ownership_version: 2 } });
    const [lease] = await ownershipsOfLead(c.latest.leadId);
    expect(lease).toMatchObject({ release_reason: 'manual', released_via: 'crm', restoration_state: 'not_required' });
    expect(lease.released_at).not.toBeNull();
    expect((await changesOf(c.old.conversationId)).map((x) => [x.ownership_version, x.change_kind, x.source, x.reason]))
      .toEqual([['1', 'taken', 'crm', null], ['2', 'released', 'crm', 'seller_released']]);
    expect(await sellerOwned(c)).toBe(false);
    expect((await loadState(c)).bot_suppressed).toBe(false);
    expect(await authorizeBotReply(c)).toMatchObject({ should_send: true, dispatch_phase: 'sending' });
  });

  test('message.send by opportunity takes the latest lead and clears its pending reply', async () => {
    const c = await returningCustomer();
    const claimed = await claim();
    expect(claimed).toMatchObject({ send: true, attempt: 1, phone_number: c.phone });
    const outbound = (await client.query('SELECT * FROM crm_outbound_messages WHERE id = $1', [claimed.outbound_id])).rows[0];
    expect(outbound).toMatchObject({ lead_id: c.latest.leadId, conversation_id: c.old.conversationId, ownership_version: '1' });

    const [held] = await ownershipsOfLead(c.latest.leadId);
    expect(held).toMatchObject({ pending_message_id: c.latest.messageId, conversation_id: c.old.conversationId });
    expect(await ownershipsOfLead(c.old.leadId)).toEqual([]);

    const done = await complete(claimed);
    expect(done).toMatchObject({ http_status: 200, response: { result: 'sent', ownership_version: 1 } });
    const [after] = await ownershipsOfLead(c.latest.leadId);
    expect(after).toMatchObject({
      released_at: null, pending_message_id: null, pending_message_at: null, response_due_at: null,
    });
    expect(after.last_human_message_id).not.toBeNull();
    const message = (await client.query('SELECT * FROM messages WHERE id = $1', [after.last_human_message_id])).rows[0];
    expect(message).toMatchObject({
      direction: 'outgoing', sender_type: 'human', conversation_id: c.old.conversationId, delivery_status: 'sent',
    });

    expect(await sellerOwned(c)).toBe(true);
    expect((await loadState(c)).bot_suppressed).toBe(true);
    expect(await authorizeBotReply(c)).toMatchObject({ should_send: false, dispatch_phase: 'cancelled' });
  });

  test('another seller live on the latest lead (ClickUp) is an ownership conflict', async () => {
    const c = await returningCustomer({ newerSeller: sellerB });
    await client.query(acquireSql, [
      c.latest.taskId, 'nueva', `hist-${crypto.randomUUID()}`, new Date().toISOString(), 'in progress', 'cotización enviada',
    ]);
    const [clickup] = await ownershipsOfLead(c.latest.leadId);
    expect(clickup.released_at).toBeNull();

    const taken = await chat();
    expect(taken).toMatchObject({
      http_status: 409, response: { error: 'ownership_conflict', holder_crm_seller_id: SELLER_B, ownership_version: 0 },
    });
    const claimed = await claim();
    expect(claimed).toMatchObject({
      http_status: 409, send: false, response: { error: 'ownership_conflict', holder_crm_seller_id: SELLER_B },
    });
    expect(await ownershipsOfLead(c.latest.leadId)).toHaveLength(1);
    expect(await ownershipsOfLead(c.old.leadId)).toEqual([]);

    // The ClickUp holder itself, from the CRM: idempotent take.
    expect(await chat({ seller: SELLER_B })).toMatchObject({ http_status: 200, response: { result: 'applied' } });
    expect(await ownershipsOfLead(c.latest.leadId)).toHaveLength(1);
  });

  test('a take after yet another newer lead moves to that lead without breaking the live-row index', async () => {
    const c = await returningCustomer();
    await chat();
    const newest = await leadWithConversation({ phone: c.phone, previous: c.latest.leadId });
    expect(await sellerOwned(c)).toBe(false);

    const again = await chat({ version: 1 });
    expect(again).toMatchObject({ http_status: 200, response: { result: 'applied', ownership_version: 1 } });
    const [lease] = await ownershipsOfLead(newest.leadId);
    // The opportunity's conversation already has the earlier live row.
    expect(lease).toMatchObject({ conversation_id: null, acquired_via: 'crm', released_at: null });
    expect(await changesOf(newest.conversationId)).toMatchObject([{ change_kind: 'taken', lead_id: newest.leadId }]);
    expect(await sellerOwned(c)).toBe(true);
  });

  test('regression: the opportunity lead is the latest lead, lease on it without conversation_id', async () => {
    const c = await singleLead();
    const taken = await chat();
    expect(taken).toMatchObject({ http_status: 200, response: { result: 'applied', ownership_version: 1 } });
    const [lease] = await ownershipsOfLead(c.old.leadId);
    expect(lease).toMatchObject({ conversation_id: null, acquired_via: 'crm', pending_message_id: c.old.messageId });
    expect(await changesOf(c.old.conversationId)).toMatchObject([
      { ownership_version: '1', change_kind: 'taken', lead_id: c.old.leadId },
    ]);
    expect(await inboxOf(taken.eventId)).toMatchObject({ lead_id: c.old.leadId, conversation_id: c.old.conversationId });
    expect(await sellerOwned(c)).toBe(true);

    const claimed = await claim();
    const outbound = (await client.query('SELECT * FROM crm_outbound_messages WHERE id = $1', [claimed.outbound_id])).rows[0];
    expect(outbound).toMatchObject({ lead_id: c.old.leadId, conversation_id: c.old.conversationId });
    await complete(claimed);
    expect((await ownershipsOfLead(c.old.leadId))[0]).toMatchObject({ pending_message_id: null, released_at: null });

    expect(await chat({ type: 'chat.release', version: 1 })).toMatchObject({
      http_status: 200, response: { result: 'applied', ownership_version: 2 },
    });
    expect(await sellerOwned(c)).toBe(false);
  });
});
