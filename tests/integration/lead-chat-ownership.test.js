import fs from 'node:fs';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';

const enabled = process.env.TEST_PG_INTEGRATION === '1';
const describeIntegration = enabled ? describe : describe.skip;
const connection = {
  host: process.env.TEST_PGHOST || '127.0.0.1',
  port: Number(process.env.TEST_PGPORT || 55433),
  database: process.env.TEST_PGDATABASE || 'testdb',
  user: process.env.TEST_PGUSER || 'test',
  password: process.env.TEST_PGPASSWORD || 'test',
};

const queryDirectory = 'db/queries/n8n/lead-chat-ownership';
const readQuery = (fileName) => fs.readFileSync(`${queryDirectory}/${fileName}`, 'utf8');

const TWO_HOURS_MS = 2 * 60 * 60 * 1000;

describeIntegration('lead chat ownership: human takeover arbitrated by PostgreSQL', () => {
  const client = new pg.Client(connection);

  const acquireSql = readQuery('01_acquire_ownership_from_clickup.sql');
  const releaseSql = readQuery('02_release_ownership_from_clickup.sql');
  const customerMessageSql = readQuery('03_register_customer_message.sql');
  const humanReplySql = readQuery('04_register_human_reply.sql');
  const loadStateSql = readQuery('05_load_ownership_state.sql');
  const claimExpiredSql = readQuery('06_claim_expired_ownerships.sql');
  const completeRestorationSql = readQuery('07_complete_restoration.sql');
  const persistOwnMessageSql = readQuery('08_persist_own_message_from_evolution.sql');
  const claimReacquisitionsSql = readQuery('09_claim_clickup_reacquisitions.sql');
  const completeReacquisitionSql = readQuery('10_complete_clickup_reacquisition.sql');

  // Every row this suite writes is tracked so afterAll can remove it in
  // FK-safe order. A test database that only survives its first run hides
  // regressions behind a unique-violation on the second one.
  const createdLeadIds = [];
  const createdConversationIds = [];
  const createdMessageIds = [];
  const createdInboundEventIds = [];
  let sourceNumberId;
  let draftStatusId;
  let activeStatusId;
  let sequence = 0;

  const acquire = (clickupTaskId, previousStatus, historyId, historyEventAt) =>
    client.query(acquireSql, [clickupTaskId, previousStatus, historyId, historyEventAt]);

  const release = (clickupTaskId, newStatus, historyId, historyEventAt) =>
    client.query(releaseSql, [clickupTaskId, newStatus, historyId, historyEventAt]);

  const registerCustomerMessage = (leadId, messageId, createdAt, windowHours = 2) =>
    client.query(customerMessageSql, [leadId, messageId, createdAt, windowHours]);

  const registerHumanReply = (
    leadId, messageId, repliedAt,
    inboundEventId = null, processingToken = null, acquisitionStatus = 'in progress',
  ) => client.query(humanReplySql, [
    leadId, messageId, repliedAt, inboundEventId, processingToken, acquisitionStatus,
  ]);

  const loadState = (leadId) => client.query(loadStateSql, [leadId]);

  const claimExpired = (batchSize = 25, staleProcessingSeconds = 900) =>
    client.query(claimExpiredSql, [batchSize, staleProcessingSeconds]);

  const completeRestoration = (ownershipId, claimToken, result, errorText, observedStatus) =>
    client.query(completeRestorationSql, [
      ownershipId, claimToken, result, errorText, observedStatus,
    ]);

  const claimReacquisitions = (
    batchSize = 20, staleSeconds = 300, retrySeconds = 60, maxAttempts = 5,
  ) => client.query(claimReacquisitionsSql, [
    batchSize, staleSeconds, retrySeconds, maxAttempts,
  ]);

  const completeReacquisition = (
    operationId, claimToken, outcome, errorText = null,
    observedStatus = null, responseJson = '{}', maxAttempts = 5,
  ) => client.query(completeReacquisitionSql, [
    operationId, claimToken, outcome, errorText,
    observedStatus, responseJson, maxAttempts,
  ]);

  const seedOwnInboundEvent = async ({ phoneNumber, externalMessageId }) => {
    const token = `own-token-${++sequence}`;
    const { rows } = await client.query(`
      INSERT INTO inbound_events (
        instance_name, external_message_id, event_fingerprint, dedupe_key,
        source_number_id, phone_number, queue_key, event_type, normalized_event,
        should_process, processing_status, processing_started_at,
        processing_token, processing_phase, attempt_count, raw_payload,
        normalized_payload
      ) VALUES (
        'lead-chat-ownership-test', $1, md5($1), 'id:' || $1,
        $2::bigint, $3, $2::bigint::text || ':' || $3, 'messages.upsert', 'MESSAGES_UPSERT',
        TRUE, 'processing', NOW(), $4, 'orchestrating', 1,
        '{}'::jsonb, jsonb_build_object('is_from_me', TRUE)
      )
      RETURNING id, received_at
    `, [externalMessageId, sourceNumberId, phoneNumber, token]);
    createdInboundEventIds.push(rows[0].id);
    return { id: rows[0].id, token, receivedAt: rows[0].received_at };
  };

  const persistOwnMessage = (event, lead, externalMessageId, text = 'Respuesta vendedor') =>
    client.query(persistOwnMessageSql, [
      event.id, event.token, sourceNumberId, lead.phoneNumber,
      externalMessageId, event.receivedAt, 'text', text, '{}',
      'lead-chat-ownership-test',
    ]);

  // Each case gets its own lead, task and conversation so ordering between
  // tests never decides the outcome.
  const seedLead = async () => {
    sequence += 1;
    const suffix = String(sequence).padStart(3, '0');
    const phoneNumber = `1556000${suffix}`;
    const clickupTaskId = `lco-task-${suffix}`;

    const lead = await client.query(`
      INSERT INTO leads (
        source_number_id, phone_number, lead_status_id, clickup_task_id, channel
      ) VALUES ($1, $2, $3, $4, 'whatsapp')
      RETURNING id
    `, [sourceNumberId, phoneNumber, draftStatusId, clickupTaskId]);
    const leadId = lead.rows[0].id;
    createdLeadIds.push(leadId);

    const conversation = await client.query(`
      INSERT INTO conversations (
        lead_id, source_number_id, phone_number, conversation_status_id,
        started_at, last_message_at
      ) VALUES ($1, $2, $3, $4, NOW(), NOW())
      RETURNING id
    `, [leadId, sourceNumberId, phoneNumber, activeStatusId]);
    const conversationId = conversation.rows[0].id;
    createdConversationIds.push(conversationId);

    return { leadId, conversationId, clickupTaskId, phoneNumber };
  };

  const seedMessage = async (conversationId, leadId, senderType, createdAt) => {
    const direction = senderType === 'customer' ? 'incoming' : 'outgoing';
    const { rows } = await client.query(`
      INSERT INTO messages (
        conversation_id, lead_id, direction, message_type, sender_type,
        text_body, created_at
      ) VALUES ($1, $2, $3, 'text', $4, $5, $6)
      RETURNING id
    `, [
      conversationId, leadId, direction, senderType,
      `${senderType} message`, createdAt,
    ]);
    createdMessageIds.push(rows[0].id);
    return rows[0].id;
  };

  const ownershipRow = async (leadId) => {
    const { rows } = await client.query(`
      SELECT * FROM lead_chat_ownerships
      WHERE lead_id = $1 AND deleted_at IS NULL
      ORDER BY id DESC
      LIMIT 1
    `, [leadId]);
    return rows[0];
  };

  const ownershipCount = async (leadId) => {
    const { rows } = await client.query(
      'SELECT COUNT(*)::int AS total FROM lead_chat_ownerships WHERE lead_id = $1',
      [leadId],
    );
    return rows[0].total;
  };

  const restoreOperations = async (ownershipId) => {
    const { rows } = await client.query(`
      SELECT operation_key, status, attempt_count
      FROM external_operations
      WHERE operation_type = 'clickup_status_restore'
        AND entity_type = 'lead_chat_ownership'
        AND entity_id = $1
      ORDER BY id
    `, [ownershipId]);
    return rows;
  };

  // Wall-clock time is never waited on: the deadline is dragged into the past
  // directly, which is the only way a two-hour SLA is testable at all.
  const expireDeadline = (ownershipId) => client.query(`
    UPDATE lead_chat_ownerships
    SET response_due_at = NOW() - INTERVAL '1 minute',
        pending_message_at = NOW() - INTERVAL '2 hours 1 minute'
    WHERE id = $1
  `, [ownershipId]);

  // Drags the claim stamp into the past so the stale-reclaim branch of $2 is
  // reachable without waiting fifteen real minutes for it.
  const abandonRestoration = (ownershipId, age = '31 minutes') => client.query(`
    UPDATE lead_chat_ownerships
    SET restoration_claimed_at = NOW() - $2::interval
    WHERE id = $1
  `, [ownershipId, age]);

  // An owned chat with a live deadline: the state every SLA case starts from.
  const seedOwnedChatWithDeadline = async ({ previousStatus = 'to do' } = {}) => {
    const lead = await seedLead();
    const acquiredAt = new Date();
    const acquired = await acquire(
      lead.clickupTaskId, previousStatus, `hist-${lead.clickupTaskId}-1`, acquiredAt.toISOString(),
    );
    expect(acquired.rows[0].outcome).toBe('acquired');

    const messageAt = new Date();
    const messageId = await seedMessage(
      lead.conversationId, lead.leadId, 'customer', messageAt.toISOString(),
    );
    const registered = await registerCustomerMessage(
      lead.leadId, messageId, messageAt.toISOString(),
    );
    expect(registered.rows[0].outcome).toBe('deadline_started');

    return {
      ...lead,
      ownershipId: acquired.rows[0].ownership_id,
      customerMessageId: messageId,
      customerMessageAt: messageAt,
    };
  };

  beforeAll(async () => {
    await client.connect();

    const number = await client.query(`
      INSERT INTO whatsapp_numbers (display_name, phone_number, phone_number_id, is_active)
      VALUES ('lead-chat-ownership-test', '15560000000', 'pn-lead-chat-ownership', TRUE)
      RETURNING id
    `);
    sourceNumberId = number.rows[0].id;

    const leadStatus = await client.query(
      "SELECT id FROM lead_statuses WHERE code = 'draft'",
    );
    draftStatusId = leadStatus.rows[0].id;

    const conversationStatus = await client.query(
      "SELECT id FROM conversation_statuses WHERE code = 'active'",
    );
    activeStatusId = conversationStatus.rows[0].id;
  });

  afterAll(async () => {
    // FK-safe order: projections and evidence first, then the rows they point
    // at, then the shared WhatsApp number whose phone_number is unique.
    const ownerships = await client.query(
      'SELECT id FROM lead_chat_ownerships WHERE lead_id = ANY($1::bigint[])',
      [createdLeadIds],
    );
    const ownershipIds = ownerships.rows.map((row) => row.id);

    await client.query(`
      DELETE FROM audit_logs
      WHERE entity_type = 'lead_chat_ownership' AND entity_id = ANY($1::bigint[])
    `, [ownershipIds]);
    await client.query(`
      DELETE FROM audit_logs
      WHERE actor_id = 'wa-inbound-entry'
        AND metadata->>'inbound_event_id' = ANY($1::text[])
    `, [createdInboundEventIds.map(String)]);
    await client.query(`
      DELETE FROM external_operations
      WHERE entity_type = 'lead_chat_ownership' AND entity_id = ANY($1::bigint[])
    `, [ownershipIds]);
    await client.query(
      'DELETE FROM lead_chat_ownerships WHERE id = ANY($1::bigint[])',
      [ownershipIds],
    );
    await client.query(
      'DELETE FROM messages WHERE id = ANY($1::bigint[])',
      [createdMessageIds],
    );
    await client.query(
      'DELETE FROM inbound_events WHERE id = ANY($1::bigint[])',
      [createdInboundEventIds],
    );
    await client.query(
      'DELETE FROM conversations WHERE id = ANY($1::bigint[])',
      [createdConversationIds],
    );
    await client.query(
      'DELETE FROM leads WHERE id = ANY($1::bigint[])',
      [createdLeadIds],
    );
    await client.query('DELETE FROM whatsapp_numbers WHERE id = $1', [sourceNumberId]);

    await client.end();
  });

  test('acquisition from an in progress transition captures the exact previous status', async () => {
    const lead = await seedLead();
    const eventAt = new Date().toISOString();

    const { rows } = await acquire(lead.clickupTaskId, 'to do', 'hist-acquire-1', eventAt);

    expect(rows).toHaveLength(1);
    expect(rows[0].outcome).toBe('acquired');
    expect(rows[0].lead_id).toBe(lead.leadId);
    // The restoration has exactly one source of truth for where the task came
    // from, and guessing it later is not an option.
    expect(rows[0].previous_clickup_status).toBe('to do');

    const ownership = await ownershipRow(lead.leadId);
    expect(ownership.released_at).toBeNull();
    expect(ownership.restoration_state).toBe('not_required');
    expect(ownership.last_clickup_history_id).toBe('hist-acquire-1');
  });

  test('a duplicate ClickUp history id is already_applied and does not re-acquire', async () => {
    const lead = await seedLead();
    const eventAt = new Date().toISOString();
    const first = await acquire(lead.clickupTaskId, 'to do', 'hist-duplicate', eventAt);
    const firstOwnership = await ownershipRow(lead.leadId);

    const { rows } = await acquire(lead.clickupTaskId, 'to do', 'hist-duplicate', eventAt);

    expect(rows[0].outcome).toBe('already_applied');
    expect(rows[0].ownership_id).toBe(first.rows[0].ownership_id);
    expect(await ownershipCount(lead.leadId)).toBe(1);

    const secondOwnership = await ownershipRow(lead.leadId);
    // A webhook retry must not restart the lease clock.
    expect(secondOwnership.acquired_at).toEqual(firstOwnership.acquired_at);
  });

  test('an out-of-order ClickUp event is stale_event and does not mutate the projection', async () => {
    const lead = await seedLead();
    const acquiredAt = new Date();
    const releasedAt = new Date(acquiredAt.getTime() + 60_000);
    const beforeEverything = new Date(acquiredAt.getTime() - 60 * 60_000);

    await acquire(lead.clickupTaskId, 'to do', 'hist-stale-1', acquiredAt.toISOString());
    const released = await release(
      lead.clickupTaskId, 'complete', 'hist-stale-2', releasedAt.toISOString(),
    );
    expect(released.rows[0].outcome).toBe('released');
    const afterRelease = await ownershipRow(lead.leadId);

    // A delayed 'in progress' webhook must never reacquire a chat that a newer
    // 'complete' already handed back to the bot.
    const { rows } = await acquire(
      lead.clickupTaskId, 'to do', 'hist-stale-3', beforeEverything.toISOString(),
    );

    expect(rows[0].outcome).toBe('stale_event');
    expect(await ownershipCount(lead.leadId)).toBe(1);
    const afterStale = await ownershipRow(lead.leadId);
    expect(afterStale.released_at).toEqual(afterRelease.released_at);
    expect(afterStale.last_clickup_history_id).toBe('hist-stale-2');
  });

  test('an unknown ClickUp task is unknown_task', async () => {
    const { rows } = await acquire(
      'lco-task-does-not-exist', 'to do', 'hist-unknown', new Date().toISOString(),
    );

    expect(rows).toHaveLength(1);
    expect(rows[0].outcome).toBe('unknown_task');
    expect(rows[0].ownership_id).toBeNull();
  });

  test('an active ownership suppresses the bot', async () => {
    const lead = await seedLead();
    await acquire(lead.clickupTaskId, 'to do', 'hist-suppress', new Date().toISOString());

    const { rows } = await loadState(lead.leadId);

    expect(rows).toHaveLength(1);
    expect(rows[0].outcome).toBe('suppressed');
    expect(rows[0].bot_suppressed).toBe(true);
    expect(rows[0].released_at).toBeNull();
  });

  test('a fromMe event matching a bot external id is completed as an echo without duplication', async () => {
    const lead = await seedLead();
    const externalMessageId = `bot-echo-${sequence}`;
    const botMessageId = await seedMessage(
      lead.conversationId, lead.leadId, 'bot', new Date().toISOString(),
    );
    await client.query(
      'UPDATE messages SET external_message_id = $2 WHERE id = $1',
      [botMessageId, externalMessageId],
    );
    const event = await seedOwnInboundEvent({
      phoneNumber: lead.phoneNumber, externalMessageId,
    });

    const { rows } = await persistOwnMessage(event, lead, externalMessageId, 'bot message');

    expect(rows[0].own_message_kind).toBe('bot_echo');
    expect(rows[0].message_id).toBe(botMessageId);
    const count = await client.query(
      'SELECT COUNT(*)::int total FROM messages WHERE external_message_id = $1',
      [externalMessageId],
    );
    expect(count.rows[0].total).toBe(1);
    const inbox = await client.query(
      'SELECT processing_status, processing_phase FROM inbound_events WHERE id = $1',
      [event.id],
    );
    expect(inbox.rows[0]).toEqual({ processing_status: 'processed', processing_phase: 'completed' });
  });

  test('an unmatched fromMe event persists a human reply and satisfies the live SLA', async () => {
    const owned = await seedOwnedChatWithDeadline();
    const externalMessageId = `human-reply-${sequence}`;
    const event = await seedOwnInboundEvent({
      phoneNumber: owned.phoneNumber, externalMessageId,
    });

    const persisted = await persistOwnMessage(event, owned, externalMessageId);
    expect(persisted.rows[0].own_message_kind).toBe('human_reply');
    createdMessageIds.push(persisted.rows[0].message_id);

    const registered = await registerHumanReply(
      persisted.rows[0].lead_id,
      persisted.rows[0].message_id,
      persisted.rows[0].replied_at,
      event.id,
      event.token,
    );
    expect(registered.rows[0].outcome).toBe('reply_registered');
    expect(registered.rows[0].bot_suppressed).toBe(true);

    const saved = await client.query(`
      SELECT direction, sender_type, external_message_id
      FROM messages WHERE id = $1
    `, [persisted.rows[0].message_id]);
    expect(saved.rows[0]).toEqual({
      direction: 'outgoing', sender_type: 'human', external_message_id: externalMessageId,
    });
    const ownership = await ownershipRow(owned.leadId);
    expect(ownership.response_due_at).toBeNull();
    expect(ownership.pending_message_id).toBeNull();
    expect(ownership.last_human_message_id).toBe(persisted.rows[0].message_id);
    const inbox = await client.query(
      'SELECT processing_status, processing_phase FROM inbound_events WHERE id = $1',
      [event.id],
    );
    expect(inbox.rows[0]).toEqual({ processing_status: 'processed', processing_phase: 'completed' });
  });

  test('an unmatched fromMe event is requeued while a matching bot send has no provider id', async () => {
    const lead = await seedLead();
    const pendingBotId = await seedMessage(
      lead.conversationId, lead.leadId, 'bot', new Date().toISOString(),
    );
    await client.query(`
      UPDATE messages
      SET dispatch_phase = 'sending', delivery_status = 'sending', updated_at = NOW()
      WHERE id = $1
    `, [pendingBotId]);
    const externalMessageId = `ambiguous-own-${sequence}`;
    const event = await seedOwnInboundEvent({
      phoneNumber: lead.phoneNumber, externalMessageId,
    });

    const { rows } = await persistOwnMessage(event, lead, externalMessageId, 'bot message');

    expect(rows[0].own_message_kind).toBe('bot_echo_pending');
    const humanCount = await client.query(`
      SELECT COUNT(*)::int total
      FROM messages
      WHERE external_message_id = $1 AND sender_type = 'human'
    `, [externalMessageId]);
    expect(humanCount.rows[0].total).toBe(0);
    const inbox = await client.query(
      'SELECT processing_status, failure_reason FROM inbound_events WHERE id = $1',
      [event.id],
    );
    expect(inbox.rows[0]).toEqual({
      processing_status: 'received',
      failure_reason: 'own_message_bot_echo_pending',
    });
  });

  test('a newer customer message replaces the deadline and starts a fresh 2-hour window', async () => {
    const owned = await seedOwnedChatWithDeadline();
    const firstDue = await ownershipRow(owned.leadId);
    expect(firstDue.response_due_at.getTime())
      .toBe(owned.customerMessageAt.getTime() + TWO_HOURS_MS);

    const secondMessageAt = new Date(owned.customerMessageAt.getTime() + 30 * 60_000);
    const secondMessageId = await seedMessage(
      owned.conversationId, owned.leadId, 'customer', secondMessageAt.toISOString(),
    );

    const { rows } = await registerCustomerMessage(
      owned.leadId, secondMessageId, secondMessageAt.toISOString(),
    );

    expect(rows[0].outcome).toBe('deadline_replaced');
    expect(rows[0].bot_suppressed).toBe(true);
    // The SLA is measured against the latest thing the customer asked, so the
    // window restarts in full instead of inheriting the first one's remainder.
    expect(rows[0].response_due_at.getTime())
      .toBe(secondMessageAt.getTime() + TWO_HOURS_MS);

    const ownership = await ownershipRow(owned.leadId);
    expect(ownership.pending_message_id).toBe(secondMessageId);
  });

  test('a manual reply clears the deadline but leaves ownership active', async () => {
    const owned = await seedOwnedChatWithDeadline();
    const repliedAt = new Date();
    const replyId = await seedMessage(
      owned.conversationId, owned.leadId, 'human', repliedAt.toISOString(),
    );

    const { rows } = await registerHumanReply(owned.leadId, replyId, repliedAt.toISOString());

    expect(rows[0].outcome).toBe('reply_registered');
    expect(rows[0].response_due_at).toBeNull();
    expect(rows[0].last_human_message_id).toBe(replyId);

    const ownership = await ownershipRow(owned.leadId);
    expect(ownership.pending_message_id).toBeNull();
    expect(ownership.pending_message_at).toBeNull();
    expect(ownership.released_at).toBeNull();

    // Answering does not hand the chat back to the bot: the seller keeps it
    // until ClickUp moves the task or a new customer message opens a window.
    const state = await loadState(owned.leadId);
    expect(state.rows[0].outcome).toBe('suppressed');
    expect(state.rows[0].bot_suppressed).toBe(true);
  });

  test('an already-expired deadline is not revived by a new customer message', async () => {
    const owned = await seedOwnedChatWithDeadline();
    await expireDeadline(owned.ownershipId);
    const expired = await ownershipRow(owned.leadId);

    const laterAt = new Date();
    const laterMessageId = await seedMessage(
      owned.conversationId, owned.leadId, 'customer', laterAt.toISOString(),
    );
    const { rows } = await registerCustomerMessage(
      owned.leadId, laterMessageId, laterAt.toISOString(),
    );

    expect(rows[0].outcome).toBe('expired');
    expect(rows[0].bot_suppressed).toBe(false);
    // An insistent customer must not be able to keep the bot silent forever by
    // reopening a lease that already died.
    expect(rows[0].response_due_at).toEqual(expired.response_due_at);

    const ownership = await ownershipRow(owned.leadId);
    expect(ownership.response_due_at).toEqual(expired.response_due_at);
    expect(ownership.pending_message_id).toBe(owned.customerMessageId);
  });

  test('a late human reply reacquires ownership and queues the ClickUp projection', async () => {
    const owned = await seedOwnedChatWithDeadline();
    await expireDeadline(owned.ownershipId);

    const repliedAt = new Date();
    const replyId = await seedMessage(
      owned.conversationId, owned.leadId, 'human', repliedAt.toISOString(),
    );
    const { rows } = await registerHumanReply(owned.leadId, replyId, repliedAt.toISOString());

    expect(rows[0].outcome).toBe('late_reply_reacquired');
    expect(rows[0].bot_suppressed).toBe(true);
    expect(rows[0].clickup_reacquire_required).toBe(true);
    expect(rows[0].clickup_reacquire_operation_key).toBe(
      `clickup-status-reacquire:message:${replyId}`,
    );

    const ownership = await ownershipRow(owned.leadId);
    expect(ownership.response_due_at).toBeNull();
    expect(ownership.pending_message_id).toBeNull();
    expect(ownership.last_human_message_id).toBe(replyId);
    expect(ownership.last_human_reply_at).not.toBeNull();

    const { rows: operations } = await client.query(`
      SELECT status, request_payload
      FROM external_operations
      WHERE operation_key = $1
    `, [rows[0].clickup_reacquire_operation_key]);
    expect(operations).toHaveLength(1);
    expect(operations[0].status).toBe('pending');
    expect(operations[0].request_payload.target_status).toBe('in progress');
  });

  test('a late reply after the expiry sweep creates a new ownership and supersedes restoration', async () => {
    const owned = await seedOwnedChatWithDeadline();
    await expireDeadline(owned.ownershipId);
    const swept = await claimExpired();
    expect(swept.rows.some((row) => row.ownership_id === owned.ownershipId)).toBe(true);

    const repliedAt = new Date();
    const replyId = await seedMessage(
      owned.conversationId, owned.leadId, 'human', repliedAt.toISOString(),
    );
    const { rows } = await registerHumanReply(
      owned.leadId, replyId, repliedAt.toISOString(),
    );

    expect(rows[0].outcome).toBe('late_reply_reacquired');
    expect(rows[0].ownership_id).not.toBe(owned.ownershipId);
    expect(rows[0].bot_suppressed).toBe(true);
    expect(await ownershipCount(owned.leadId)).toBe(2);

    const oldOwnership = await client.query(
      'SELECT restoration_state, restoration_claim_token FROM lead_chat_ownerships WHERE id = $1',
      [owned.ownershipId],
    );
    expect(oldOwnership.rows[0].restoration_state).toBe('skipped_status_changed');
    expect(oldOwnership.rows[0].restoration_claim_token).toBeNull();

    const oldOperation = await client.query(`
      SELECT status, last_error FROM external_operations
      WHERE operation_type = 'clickup_status_restore'
        AND entity_type = 'lead_chat_ownership'
        AND entity_id = $1
    `, [owned.ownershipId]);
    expect(oldOperation.rows[0]).toEqual({
      status: 'failed', last_error: 'superseded_by_late_human_reply',
    });
  });

  test('the expiry claim is one-time for the same ownership', async () => {
    const owned = await seedOwnedChatWithDeadline();
    await expireDeadline(owned.ownershipId);

    const first = await claimExpired();
    const claimed = first.rows.filter((row) => row.ownership_id === owned.ownershipId);
    expect(claimed).toHaveLength(1);

    const second = await claimExpired();
    expect(second.rows.filter((row) => row.ownership_id === owned.ownershipId)).toHaveLength(0);
  });

  test('a restoration abandoned in processing past the stale window is re-claimed with a fresh token', async () => {
    const owned = await seedOwnedChatWithDeadline();
    await expireDeadline(owned.ownershipId);

    const firstSweep = await claimExpired();
    const first = firstSweep.rows.find((row) => row.ownership_id === owned.ownershipId);
    // The claim leaves the row in 'processing', not 'pending': only a state
    // that declares "a worker holds this" can be rescued when that worker dies.
    expect(first.restoration_state).toBe('processing');

    // The worker dies here. Nothing ever calls 07, and every sweep predicate
    // excludes released rows, so without the stale branch this restoration is
    // lost in silence forever.
    await abandonRestoration(owned.ownershipId);

    const secondSweep = await claimExpired(25, 900);
    const second = secondSweep.rows.find((row) => row.ownership_id === owned.ownershipId);

    expect(second).toBeDefined();
    expect(second.restoration_state).toBe('processing');
    expect(second.restoration_claim_token).not.toBe(first.restoration_claim_token);
    // Same acquisition, same operation row: the rescue reuses the stable key
    // instead of seeding one external_operations row per attempt.
    expect(second.operation_key).toBe(first.operation_key);

    const ownership = await ownershipRow(owned.leadId);
    expect(ownership.restoration_attempt_count).toBe(2);
    // The rescue must not restamp the instant the AI was actually freed.
    expect(ownership.release_reason).toBe('sla_expired');

    const operations = await restoreOperations(owned.ownershipId);
    expect(operations).toHaveLength(1);
    expect(operations[0].attempt_count).toBe(2);
  });

  test('the dead worker completing with its old token is claim_mismatch after a re-claim', async () => {
    const owned = await seedOwnedChatWithDeadline();
    await expireDeadline(owned.ownershipId);

    const firstSweep = await claimExpired();
    const first = firstSweep.rows.find((row) => row.ownership_id === owned.ownershipId);
    await abandonRestoration(owned.ownershipId);
    const secondSweep = await claimExpired();
    const second = secondSweep.rows.find((row) => row.ownership_id === owned.ownershipId);
    expect(second.restoration_claim_token).not.toBe(first.restoration_claim_token);

    // The dead worker revives and reports the ClickUp call it made ages ago.
    const late = await completeRestoration(
      owned.ownershipId, first.restoration_claim_token, 'succeeded', null, 'to do',
    );

    expect(late.rows).toHaveLength(1);
    expect(late.rows[0].outcome).toBe('claim_mismatch');

    const afterLate = await ownershipRow(owned.leadId);
    expect(afterLate.restoration_state).toBe('processing');
    expect(afterLate.restoration_completed_at).toBeNull();
    // The live claim keeps its authorization: the rescue worker can still close.
    expect(afterLate.restoration_claim_token).toBe(second.restoration_claim_token);

    const closed = await completeRestoration(
      owned.ownershipId, second.restoration_claim_token, 'succeeded', null, 'to do',
    );
    expect(closed.rows[0].outcome).toBe('completed');
    expect(closed.rows[0].restoration_state).toBe('succeeded');
  });

  test('expiry frees the bot even while the ClickUp restoration is still pending', async () => {
    const owned = await seedOwnedChatWithDeadline({ previousStatus: 'to do' });
    await expireDeadline(owned.ownershipId);

    const { rows } = await claimExpired();
    const claimed = rows.find((row) => row.ownership_id === owned.ownershipId);

    expect(claimed).toBeDefined();
    expect(claimed.restoration_state).toBe('processing');
    expect(claimed.previous_clickup_status).toBe('to do');
    // Stable per acquisition: a later takeover of the same chat must not
    // inherit this restoration's external_operations row.
    expect(claimed.operation_key).toMatch(
      new RegExp(`^clickup-status-restore:ownership:${owned.ownershipId}:\\d{4}-\\d{2}-\\d{2}T[\\d:.]+Z$`),
    );

    const ownership = await ownershipRow(owned.leadId);
    expect(ownership.released_at).not.toBeNull();
    expect(ownership.release_reason).toBe('sla_expired');

    // A ClickUp outage must never keep the AI muted: the internal release has
    // already happened while the projection is still queued.
    const state = await loadState(owned.leadId);
    expect(state.rows[0].outcome).toBe('free');
    expect(state.rows[0].bot_suppressed).toBe(false);

    const operations = await restoreOperations(owned.ownershipId);
    expect(operations).toHaveLength(1);
    expect(operations[0].status).toBe('processing');
  });

  test('a missing previous status releases internally but is marked skipped_no_previous_status', async () => {
    const owned = await seedOwnedChatWithDeadline({ previousStatus: '' });
    const beforeClaim = await ownershipRow(owned.leadId);
    expect(beforeClaim.previous_clickup_status).toBeNull();

    await expireDeadline(owned.ownershipId);
    const { rows } = await claimExpired();
    const claimed = rows.find((row) => row.ownership_id === owned.ownershipId);

    expect(claimed.restoration_state).toBe('skipped_no_previous_status');

    const ownership = await ownershipRow(owned.leadId);
    expect(ownership.released_at).not.toBeNull();
    expect(ownership.release_reason).toBe('sla_expired');
    // Failing visibly beats moving the task to an invented status.
    expect(ownership.restoration_error).toContain('previous_clickup_status_missing');
    expect(await restoreOperations(owned.ownershipId)).toHaveLength(0);
  });

  test('completing the restoration with a wrong claim token is claim_mismatch', async () => {
    const owned = await seedOwnedChatWithDeadline();
    await expireDeadline(owned.ownershipId);
    await claimExpired();
    const claimedOwnership = await ownershipRow(owned.leadId);

    const { rows } = await completeRestoration(
      owned.ownershipId, 'not-the-issued-token', 'succeeded', null, 'to do',
    );

    expect(rows).toHaveLength(1);
    expect(rows[0].outcome).toBe('claim_mismatch');

    const ownership = await ownershipRow(owned.leadId);
    expect(ownership.restoration_state).toBe('processing');
    expect(ownership.restoration_completed_at).toBeNull();
    // The live claim keeps its token, so the legitimate worker can still close.
    expect(ownership.restoration_claim_token).toBe(claimedOwnership.restoration_claim_token);
  });

  test('a late human reply is durably claimed and completed as a ClickUp reacquisition', async () => {
    const owned = await seedOwnedChatWithDeadline();
    await expireDeadline(owned.ownershipId);

    const repliedAt = new Date();
    const replyId = await seedMessage(
      owned.conversationId, owned.leadId, 'human', repliedAt.toISOString(),
    );
    const registered = await registerHumanReply(
      owned.leadId, replyId, repliedAt.toISOString(), null, null,
      'atendiendo,en curso',
    );
    expect(registered.rows[0].outcome).toBe('late_reply_reacquired');

    const claimedBatch = await claimReacquisitions();
    const claimed = claimedBatch.rows.find(
      (row) => row.ownership_id === registered.rows[0].ownership_id,
    );
    expect(claimed).toMatchObject({
      // Matching accepts a configured list, but ClickUp PUT receives exactly
      // one concrete status label: the first configured acquisition status.
      target_status: 'atendiendo',
      ownership_active: true,
      should_dispatch_reacquisition: true,
      attempt_count: 1,
    });
    expect(claimed.operation_claim_token).toBeTruthy();

    const completed = await completeReacquisition(
      claimed.operation_id,
      claimed.operation_claim_token,
      'succeeded',
      null,
      'atendiendo',
      JSON.stringify({ status: { status: 'atendiendo' } }),
    );
    expect(completed.rows[0]).toMatchObject({
      operation_status: 'succeeded', outcome: 'completed',
    });

    const repeated = await claimReacquisitions();
    expect(repeated.rows.some((row) => row.operation_id === claimed.operation_id)).toBe(false);
  });

  test('a reacquisition claim is skipped without ClickUp when ownership was released', async () => {
    const owned = await seedOwnedChatWithDeadline();
    await expireDeadline(owned.ownershipId);
    const repliedAt = new Date();
    const replyId = await seedMessage(
      owned.conversationId, owned.leadId, 'human', repliedAt.toISOString(),
    );
    const registered = await registerHumanReply(
      owned.leadId, replyId, repliedAt.toISOString(),
    );
    const reacquiredOwnershipId = registered.rows[0].ownership_id;

    await client.query(`
      UPDATE lead_chat_ownerships
      SET released_at = NOW(), release_reason = 'manual'
      WHERE id = $1
    `, [reacquiredOwnershipId]);

    const claimedBatch = await claimReacquisitions();
    const claimed = claimedBatch.rows.find((row) => row.ownership_id === reacquiredOwnershipId);
    expect(claimed).toMatchObject({
      ownership_active: false,
      should_dispatch_reacquisition: false,
      reacquisition_blocker: 'ownership_not_active',
    });

    const completed = await completeReacquisition(
      claimed.operation_id,
      claimed.operation_claim_token,
      'skipped_ownership_changed',
      'ownership_not_active',
    );
    expect(completed.rows[0].operation_status).toBe('succeeded');
  });

  test('a retryable reacquisition gets a new token and rejects the stale worker', async () => {
    const owned = await seedOwnedChatWithDeadline();
    await expireDeadline(owned.ownershipId);
    const repliedAt = new Date();
    const replyId = await seedMessage(
      owned.conversationId, owned.leadId, 'human', repliedAt.toISOString(),
    );
    const registered = await registerHumanReply(
      owned.leadId, replyId, repliedAt.toISOString(),
    );

    const firstBatch = await claimReacquisitions();
    const first = firstBatch.rows.find(
      (row) => row.ownership_id === registered.rows[0].ownership_id,
    );
    const retry = await completeReacquisition(
      first.operation_id,
      first.operation_claim_token,
      'retry',
      'clickup_reacquire_write_retryable_http_429',
    );
    expect(retry.rows[0].operation_status).toBe('pending');

    await client.query(`
      UPDATE external_operations
      SET locked_at = NOW() - INTERVAL '2 minutes'
      WHERE id = $1
    `, [first.operation_id]);
    const secondBatch = await claimReacquisitions(20, 300, 60, 5);
    const second = secondBatch.rows.find((row) => row.operation_id === first.operation_id);
    expect(second.attempt_count).toBe(2);
    expect(second.operation_claim_token).not.toBe(first.operation_claim_token);

    const staleCompletion = await completeReacquisition(
      first.operation_id,
      first.operation_claim_token,
      'succeeded',
      null,
      'in progress',
    );
    expect(staleCompletion.rows[0].outcome).toBe('claim_mismatch');

    const liveCompletion = await completeReacquisition(
      second.operation_id,
      second.operation_claim_token,
      'succeeded',
      null,
      'in progress',
    );
    expect(liveCompletion.rows[0]).toMatchObject({
      operation_status: 'succeeded', outcome: 'completed',
    });
  });
});
