// =============================================================================
// handoff.resolved gives the chat back to the bot (migration 052, spec S12 of
// odd/tasks/crm-1-2d-contingency-handoffs.md).
//
// Live case 2026-11-26 (L30): the CRM admin took the chat implicitly with
// message.send by conversation_id 663 -> lease 52 (lead 488, conversation 663,
// acquired_via crm, response_due_at NULL after the reply). handoff.resolved 570
// applied and closed conversation 663, but lease 52 stayed live: the bot stayed
// silent for the customer indefinitely and the CRM got no ownership.released.
// Now an applied transition to resolved releases the customer's live
// CRM-acquired lease (the one the bot reads for silence: the contact's latest
// lead, the conversation key without a lead) exactly as chat.release does.
// ClickUp leases are not touched; duplicate and acknowledged change nothing.
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
const completeSendSql = read('db/queries/n8n/crm-inbound-events/03_complete_crm_message_send.sql');
const applyConversationChatSql = read('db/queries/n8n/crm-inbound-events/04_apply_crm_conversation_chat_event.sql');
const claimConversationSendSql = read('db/queries/n8n/crm-inbound-events/05_claim_crm_conversation_message_send.sql');
const applyHandoffSql = read('db/queries/n8n/crm-inbound-events/06_apply_crm_handoff_event.sql');
const loadConversationSql = read('db/queries/n8n/wa-conversation-orchestrator/01_load_active_context.sql');
const acquireSql = read('db/queries/n8n/lead-chat-ownership/01_acquire_ownership_from_clickup.sql');
const selectOwnershipSql = read('db/queries/n8n/crm-events-dispatcher/07_select_ownership_candidates.sql');

const PREFIX = 'relres';
const SINCE = '2000-01-01T00:00:00.000Z';
const SELLER_A = '7c8d9e0f-1a2b-4c3d-8e4f-5a6b7c8d9e0f';
const SELLER_B = '8d9e0f1a-2b3c-4d4e-9f5a-6b7c8d9e0f1a';
const OPP = '4b0913ef-aaaa-4bbb-8ccc-dddddddddd03';
const INSTANCE = 'crm-release-on-resolve-test';
const hash = (value) => crypto.createHash('sha256').update(value).digest('hex');
const newEventId = () => `crm-evt-${crypto.randomUUID()}`;

describeIntegration('handoff.resolved releases the CRM chat lease (migration 052)', () => {
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
    await client.query('UPDATE leads SET crm_opportunity_id = NULL WHERE crm_opportunity_id = $1', [OPP]);
    const seller = async (name, uuid) => (await client.query(
      `INSERT INTO sellers (name, is_active, sort_order, crm_user_id)
       VALUES ($1, TRUE, 90000 + (random() * 9000)::int, $2::uuid) RETURNING id`, [name, uuid],
    )).rows[0].id;
    sellerA = String(await seller('Seller A', SELLER_A));
    sellerB = String(await seller('Seller B', SELLER_B));
    ({ rows: [{ id: sourceNumberId }] } = await client.query(
      `INSERT INTO whatsapp_numbers (display_name, phone_number, phone_number_id, instance_name)
       VALUES ('Ventas', '56223456783', 'crm-relres-' || gen_random_uuid(), $1 || '-' || gen_random_uuid()) RETURNING id`,
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

  // A lead qualified in its own closed conversation, announced to the CRM.
  const qualifiedLead = async ({ phone, seller = sellerA, opportunity = OPP, ago = '1 day' }) => {
    const conversationId = await conversation({ phone, status: 'closed', ago });
    const { rows: [{ id }] } = await client.query(
      `INSERT INTO leads (whatsapp_name, phone_number, lead_status_id, assigned_seller_id, source_number_id,
                          clickup_task_id, crm_opportunity_id, channel, source_conversation_id, created_at)
       VALUES ('Ana', $1, $2, $3, $4, $5, $6, 'whatsapp', $7, NOW() - $8::interval) RETURNING id, clickup_task_id`,
      [phone, leadStatusId, seller, sourceNumberId, `relres-task-${crypto.randomUUID()}`, opportunity, conversationId, ago],
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

  const handoff = async ({ conversationId, phone, opportunity = null, routedSeller = null, estado = 'notified' }) => {
    const { rows: [{ id }] } = await client.query(
      `INSERT INTO handoffs (idempotency_key, conversation_id, phone_number, motivo, area, area_label, prioridad,
                             responsable, estado, notified_at, crm_opportunity_id, crm_routing_seller_id)
       VALUES ($1, $2, $3, 'human_request', 'sales', 'Ventas', 'alta', 'Ventas', $4, NOW(), $5, $6) RETURNING id`,
      [`relres-${crypto.randomUUID()}`, conversationId, phone, estado, opportunity, routedSeller],
    );
    await client.query(
      `INSERT INTO crm_events (event_id, event_type, conversation_id, handoff_id, revision, body, status, delivered_at)
       VALUES ($1, 'handoff.created', $2, $3, 1, '{}', 'delivered', NOW())`,
      [`wa-${PREFIX}-handoff-${id}-r1`, `wa-${PREFIX}-conversation-${conversationId}`, id],
    );
    return String(id);
  };

  // The live case: the latest lead (with an opportunity) qualified in its own
  // closed conversation; the customer writes again in a continuation
  // conversation that inherits the lead and is handed off to the CRM.
  const liveCase = async ({ leadSeller = sellerA } = {}) => {
    const phone = nextPhone('5696');
    const lead = await qualifiedLead({ phone, seller: leadSeller });
    const conversationId = await conversation({ phone, leadId: lead.leadId });
    const messageId = await customerMessage(conversationId, lead.leadId);
    const handoffId = await handoff({ conversationId, phone, opportunity: OPP });
    return { phone, lead, conversationId, messageId, handoffId, ref: `wa-${PREFIX}-conversation-${conversationId}` };
  };

  // A customer without any lead, handed off by seller.
  const noLeadCase = async () => {
    const phone = nextPhone('5694');
    const conversationId = await conversation({ phone });
    const messageId = await customerMessage(conversationId, null);
    const handoffId = await handoff({ conversationId, phone, routedSeller: sellerA });
    return { phone, lead: null, conversationId, messageId, handoffId, ref: `wa-${PREFIX}-conversation-${conversationId}` };
  };

  const byConversation = async (c, { eventId = newEventId(), type = 'chat.take', seller = SELLER_A, version = 0 } = {}) => {
    const { rows } = await client.query(applyConversationChatSql, [
      eventId, hash(eventId), type, c.ref, c.conversationId, seller, String(version),
    ]);
    expect(rows).toHaveLength(1);
    return { ...rows[0], eventId };
  };
  const sendAndComplete = async (c, { seller = SELLER_A, version = 0 } = {}) => {
    const eventId = newEventId();
    const clientMessageId = crypto.randomUUID();
    const { rows: [claimed] } = await client.query(claimConversationSendSql, [
      eventId, hash(`${eventId}|${clientMessageId}`), c.ref, c.conversationId, seller, clientMessageId, String(version), 'Hola',
    ]);
    expect(claimed).toMatchObject({ send: true });
    const { rows: [done] } = await client.query(completeSendSql, [
      String(claimed.outbound_id), String(claimed.attempt), 'sent', `BAE5${crypto.randomUUID().slice(0, 8).toUpperCase()}`,
      '201', '', PREFIX,
    ]);
    expect(done).toMatchObject({ http_status: 200, response: { result: 'sent' } });
  };
  const handoffEvent = async (handoffId, { type = 'handoff.resolved', eventId = newEventId(), seller = SELLER_A } = {}) => {
    const { rows } = await client.query(applyHandoffSql, [eventId, hash(eventId), type, String(handoffId), seller]);
    expect(rows).toHaveLength(1);
    return { ...rows[0], eventId };
  };

  const leasesOf = async (c) => (await client.query(
    `SELECT o.* FROM lead_chat_ownerships o
     LEFT JOIN leads l ON l.id = o.lead_id
     LEFT JOIN conversations cv ON cv.id = o.conversation_id
     WHERE l.phone_number = $1 OR cv.phone_number = $1 ORDER BY o.id`, [c.phone],
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
  const handoffRow = async (id) => (await client.query('SELECT * FROM handoffs WHERE id = $1', [id])).rows[0];
  const conversationStatus = async (id) => (await client.query(
    `SELECT s.code FROM conversations c JOIN conversation_statuses s ON s.id = c.conversation_status_id WHERE c.id = $1`, [id],
  )).rows[0].code;
  const transitionAudits = async (handoffId) => (await client.query(
    `SELECT * FROM audit_logs WHERE event_name = 'handoff_transition' AND entity_type = 'handoff' AND entity_id = $1 ORDER BY id`,
    [handoffId],
  )).rows;
  const releaseAudits = async (ownershipId) => (await client.query(
    `SELECT * FROM audit_logs WHERE event_name = 'lead_chat_ownership_release' AND entity_id = $1 ORDER BY id`, [ownershipId],
  )).rows;
  const ownershipCandidates = async (conversationId) => (await client.query(selectOwnershipSql, ['1.2', SINCE, PREFIX, '500']))
    .rows.filter((row) => String(row.conversation_id) === String(conversationId));

  const loadState = async (c) => {
    sequence += 1;
    const token = `relres-token-${sequence}-${crypto.randomUUID()}`;
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
    `, [INSTANCE, sourceNumberId, `relres-${token}`, c.phone, token]);
    const { rows } = await client.query(loadConversationSql, [
      c.phone, String(sourceNumberId), 'Ana', null, `in-${token}`, null, 'text', 'hola?', '{}',
      null, null, null, null, null, null, null, INSTANCE, String(event.id), token,
    ]);
    expect(rows).toHaveLength(1);
    await client.query(`UPDATE inbound_events SET processing_status = 'processed', processing_token = NULL WHERE id = $1`, [event.id]);
    return rows[0];
  };

  // Every observable effect of a resolved that released `lease`.
  const expectReleasedByResolve = async (c, lease, resolved) => {
    expect(resolved).toEqual({
      http_status: 200, replayed: false, response: { event_id: resolved.eventId, result: 'applied' }, eventId: resolved.eventId,
    });
    const [after] = (await leasesOf(c)).filter((o) => o.id === lease.id);
    expect(after).toMatchObject({
      release_reason: 'manual', released_via: 'crm', restoration_state: 'not_required', acquired_via: 'crm',
      owner_seller_id: lease.owner_seller_id, lead_id: lease.lead_id, conversation_id: lease.conversation_id,
    });
    expect(after.released_at).not.toBeNull();
    expect((await leasesOf(c)).filter((o) => o.released_at === null)).toEqual([]);
    expect(await sellerOwned(c)).toBe(false);
    expect((await loadState(c)).bot_suppressed).toBe(false);

    const changes = await changesOf(c.conversationId);
    expect(changes.at(-1)).toMatchObject({
      change_kind: 'released', source: 'crm', reason: 'seller_released', raw_reason: 'manual', ownership_id: lease.id,
      lead_id: lease.lead_id,
    });
    expect(await versionOf(c.conversationId)).toBe(Number(changes.at(-1).ownership_version));
    const candidates = await ownershipCandidates(c.conversationId);
    expect(candidates.at(-1)).toMatchObject({
      change_id: changes.at(-1).id, change_kind: 'released', source: 'crm', reason: 'seller_released', crm_user_id: null,
    });

    expect(await handoffRow(c.handoffId)).toMatchObject({ estado: 'resolved' });
    expect(await conversationStatus(c.conversationId)).toBe('closed');
    const [audit] = await transitionAudits(c.handoffId);
    expect(audit).toMatchObject({
      result: 'advanced',
      metadata: {
        requested: 'resolved', crm_event_id: resolved.eventId, crm_seller_id: SELLER_A, conversation_closed: true,
        resolved_handoff_ids: [], released_ownership_id: Number(lease.id),
      },
    });
    const [leaseAudit] = await releaseAudits(lease.id);
    expect(leaseAudit).toMatchObject({
      entity_type: 'lead_chat_ownership', actor_type: 'system', actor_id: 'crm-inbound-events', result: 'released',
      after_payload: { release_reason: 'manual', released_via: 'crm' },
      metadata: {
        crm_event_id: resolved.eventId, crm_seller_id: SELLER_A, handoff_id: Number(c.handoffId),
        conversation_id: Number(c.conversationId), lead_id: lease.lead_id === null ? null : Number(lease.lead_id),
      },
    });
  };

  test('live case: the lease taken by message.send by conversation_id is released by handoff.resolved', async () => {
    const c = await liveCase();
    await sendAndComplete(c);
    const [lease] = await leasesOf(c);
    expect(lease).toMatchObject({
      lead_id: c.lead.leadId, conversation_id: c.conversationId, acquired_via: 'crm', owner_seller_id: sellerA,
      released_at: null, response_due_at: null,
    });
    expect(await sellerOwned(c)).toBe(true);
    expect((await loadState(c)).bot_suppressed).toBe(true);

    const resolved = await handoffEvent(c.handoffId);
    await expectReleasedByResolve(c, lease, resolved);
    expect((await changesOf(c.conversationId)).map((x) => [x.ownership_version, x.change_kind, x.source, x.reason]))
      .toEqual([['1', 'taken', 'crm', null], ['2', 'released', 'crm', 'seller_released']]);
  });

  test('a customer without a lead: the conversation-keyed CRM lease is released the same way', async () => {
    const c = await noLeadCase();
    expect(await byConversation(c)).toMatchObject({ http_status: 200, response: { result: 'applied', ownership_version: 1 } });
    const [lease] = await leasesOf(c);
    expect(lease).toMatchObject({ lead_id: null, conversation_id: c.conversationId, acquired_via: 'crm', released_at: null });
    expect(await sellerOwned(c)).toBe(true);

    const resolved = await handoffEvent(c.handoffId);
    await expectReleasedByResolve(c, lease, resolved);
    expect((await changesOf(c.conversationId)).map((x) => [x.ownership_version, x.change_kind, x.source, x.reason]))
      .toEqual([['1', 'taken', 'crm', null], ['2', 'released', 'crm', 'seller_released']]);
  });

  test('a ClickUp lease is not released by handoff.resolved', async () => {
    const c = await liveCase({ leadSeller: sellerB });
    await client.query(acquireSql, [
      c.lead.taskId, 'nueva', `hist-${crypto.randomUUID()}`, new Date().toISOString(), 'in progress', 'cotización enviada',
    ]);
    const [lease] = await leasesOf(c);
    expect(lease).toMatchObject({ lead_id: c.lead.leadId, released_at: null });
    expect(lease.acquired_via).not.toBe('crm');
    const changesBefore = await changesOf(c.conversationId);
    const leadChangesBefore = await changesOf(c.lead.conversationId);

    const resolved = await handoffEvent(c.handoffId);
    expect(resolved).toMatchObject({ http_status: 200, response: { event_id: resolved.eventId, result: 'applied' } });
    expect(await leasesOf(c)).toEqual([lease]);
    expect(await sellerOwned(c)).toBe(true);
    expect(await changesOf(c.conversationId)).toEqual(changesBefore);
    expect(await changesOf(c.lead.conversationId)).toEqual(leadChangesBefore);
    expect(await releaseAudits(lease.id)).toEqual([]);
    const [audit] = await transitionAudits(c.handoffId);
    expect(audit.metadata).toMatchObject({ conversation_closed: true, released_ownership_id: null });
    expect(await conversationStatus(c.conversationId)).toBe('closed');
  });

  test('a duplicate handoff.resolved and handoff.acknowledged release nothing', async () => {
    const c = await liveCase();
    // acknowledged on a held chat: applied, the lease stays live.
    await sendAndComplete(c);
    const [lease] = await leasesOf(c);
    const acknowledged = await handoffEvent(c.handoffId, { type: 'handoff.acknowledged' });
    expect(acknowledged).toMatchObject({ http_status: 200, response: { result: 'applied' } });
    expect(await leasesOf(c)).toEqual([lease]);
    expect(await sellerOwned(c)).toBe(true);
    expect((await transitionAudits(c.handoffId))[0].metadata).not.toHaveProperty('released_ownership_id');

    await handoffEvent(c.handoffId);
    expect(await sellerOwned(c)).toBe(false);

    // The CRM takes the chat again after closure (the CRM stops that, not us);
    // a repeated resolved (duplicate) and a late acknowledged leave it alone.
    expect(await byConversation(c, { version: await versionOf(c.conversationId) }))
      .toMatchObject({ http_status: 200, response: { result: 'applied' } });
    const leasesBefore = await leasesOf(c);
    const changesBefore = await changesOf(c.conversationId);
    const auditsBefore = await transitionAudits(c.handoffId);

    const duplicate = await handoffEvent(c.handoffId);
    expect(duplicate).toEqual({
      http_status: 200, replayed: false, response: { event_id: duplicate.eventId, result: 'duplicate' }, eventId: duplicate.eventId,
    });
    const late = await handoffEvent(c.handoffId, { type: 'handoff.acknowledged' });
    expect(late).toMatchObject({ http_status: 409, response: { error: 'invalid_transition' } });

    expect(await leasesOf(c)).toEqual(leasesBefore);
    expect(await sellerOwned(c)).toBe(true);
    expect(await changesOf(c.conversationId)).toEqual(changesBefore);
    const auditsAfter = await transitionAudits(c.handoffId);
    expect(auditsAfter.slice(0, auditsBefore.length)).toEqual(auditsBefore);
    expect(auditsAfter).toHaveLength(auditsBefore.length + 1);
    expect(auditsAfter.at(-1)).toMatchObject({ result: 'invalid_transition' });
    expect(auditsAfter.at(-1).metadata).not.toHaveProperty('released_ownership_id');
  });

  test('without a live lease handoff.resolved is applied and nothing else changes', async () => {
    const c = await liveCase();
    const resolved = await handoffEvent(c.handoffId);
    expect(resolved).toEqual({
      http_status: 200, replayed: false, response: { event_id: resolved.eventId, result: 'applied' }, eventId: resolved.eventId,
    });
    expect(await leasesOf(c)).toEqual([]);
    expect(await changesOf(c.conversationId)).toEqual([]);
    expect(await versionOf(c.conversationId)).toBe(0);
    expect(await sellerOwned(c)).toBe(false);
    expect(await handoffRow(c.handoffId)).toMatchObject({ estado: 'resolved' });
    expect(await conversationStatus(c.conversationId)).toBe('closed');
    const [audit] = await transitionAudits(c.handoffId);
    expect(audit.metadata).toMatchObject({ conversation_closed: true, resolved_handoff_ids: [], released_ownership_id: null });
  });
});
