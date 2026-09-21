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

const authorizeSql = fs.readFileSync(
  'db/queries/n8n/wa-outbound-messages/05_authorize_outbound_send.sql',
  'utf8',
);
const loadConversationSql = fs.readFileSync(
  'db/queries/n8n/wa-conversation-orchestrator/01_load_active_context.sql',
  'utf8',
);
const persistConversationSql = fs.readFileSync(
  'db/queries/n8n/wa-conversation-orchestrator/07_persist_conversation_state.sql',
  'utf8',
);

describeIntegration('outbound human authority revalidation', () => {
  const client = new pg.Client(connection);
  const suffix = `${process.pid}${Date.now()}`.slice(-10);
  const phoneNumber = `56${suffix}`;
  let sourceNumberId;
  let leadId;
  let conversationId;
  let ownershipId;
  let inboundEventId;

  const seedClaimedMessage = async (token, textBody = 'test response') => {
    const { rows } = await client.query(`
      INSERT INTO messages (
        conversation_id, lead_id, direction, sender_type, message_type,
        delivery_status, text_body, raw_payload, idempotency_key,
        dispatch_phase, dispatch_token, claimed_at
      ) VALUES (
        $1, $2, 'outgoing', 'bot', 'text', 'queued', $6::text,
        jsonb_build_object('number', $3::text, 'text', $6::text),
        $4, 'claimed', $5, NOW()
      )
      RETURNING id
    `, [conversationId, leadId, phoneNumber, `authority:${token}`, token, textBody]);
    return rows[0].id;
  };

  beforeAll(async () => {
    await client.connect();
    sourceNumberId = (await client.query(`
      INSERT INTO whatsapp_numbers (display_name, phone_number, phone_number_id, is_active)
      VALUES ($1, $2, $3, TRUE)
      RETURNING id
    `, [`authority-${suffix}`, phoneNumber, `pn-${suffix}`])).rows[0].id;
    const leadStatusId = (await client.query(
      "SELECT id FROM lead_statuses WHERE code = 'draft'",
    )).rows[0].id;
    const conversationStatusId = (await client.query(
      "SELECT id FROM conversation_statuses WHERE code = 'active'",
    )).rows[0].id;
    leadId = (await client.query(`
      INSERT INTO leads (
        source_number_id, phone_number, lead_status_id, clickup_task_id, channel
      ) VALUES ($1, $2, $3, $4, 'whatsapp')
      RETURNING id
    `, [sourceNumberId, phoneNumber, leadStatusId, `authority-task-${suffix}`])).rows[0].id;
    conversationId = (await client.query(`
      INSERT INTO conversations (
        lead_id, source_number_id, phone_number, conversation_status_id,
        started_at, last_message_at
      ) VALUES (NULL, $1, $2, $3, NOW(), NOW())
      RETURNING id
    `, [sourceNumberId, phoneNumber, conversationStatusId])).rows[0].id;
    ownershipId = (await client.query(`
      INSERT INTO lead_chat_ownerships (lead_id, clickup_task_id, previous_clickup_status)
      VALUES ($1, $2, 'to do')
      RETURNING id
    `, [leadId, `authority-task-${suffix}`])).rows[0].id;
    inboundEventId = (await client.query(`
      INSERT INTO inbound_events (
        instance_name, event_fingerprint, dedupe_key, source_number_id,
        phone_number, processing_status, processing_token
      ) VALUES ($1, $2, $3, $4, $5, 'processing', $6)
      RETURNING id
    `, [
      'authority-test', `authority-fingerprint-${suffix}`, `authority-dedupe-${suffix}`,
      sourceNumberId, phoneNumber, `authority-inbound-${suffix}`,
    ])).rows[0].id;
  });

  // An own-message event still waiting in the contact queue. The queue admits a
  // single in-flight event per contact, so anything that arrives while the
  // customer message is being handled sits here until that pipeline finishes.
  const seedQueuedOwnMessage = async (tag, { externalMessageId, textBody, status = 'received' }) => {
    const { rows } = await client.query(`
      INSERT INTO inbound_events (
        instance_name, event_fingerprint, dedupe_key, source_number_id,
        phone_number, queue_key, external_message_id, should_process,
        processing_status, normalized_payload
      ) VALUES (
        'authority-test', $1, $2, $3, $4, $5, $6, TRUE, $7,
        jsonb_build_object('is_from_me', true, 'text_body', $8::text)
      )
      RETURNING id
    `, [
      `queued-fingerprint-${tag}-${suffix}`,
      `queued-dedupe-${tag}-${suffix}`,
      sourceNumberId,
      phoneNumber,
      `${sourceNumberId}:${phoneNumber}`,
      externalMessageId,
      status,
      textBody,
    ]);
    return rows[0].id;
  };

  afterAll(async () => {
    await client.query('DELETE FROM messages WHERE conversation_id = $1', [conversationId]);
    await client.query('DELETE FROM inbound_events WHERE source_number_id = $1', [sourceNumberId]);
    await client.query('DELETE FROM lead_chat_ownerships WHERE id = $1', [ownershipId]);
    await client.query('DELETE FROM conversations WHERE id = $1', [conversationId]);
    await client.query('DELETE FROM leads WHERE id = $1', [leadId]);
    await client.query('DELETE FROM whatsapp_numbers WHERE id = $1', [sourceNumberId]);
    await client.end();
  });

  test('persists the customer message and atomically starts the two-hour human deadline', async () => {
    const values = [
      conversationId, phoneNumber, sourceNumberId, 'confirm', null,
      `authority-incoming-${suffix}`, null, 'text', 'Hello', '{}',
      null, null, null, null, null, null, null,
      'waiting_user', 'conversation_state_evaluated', 'human_control_suppressed',
      '{}', '{}', '{}', false, false, true,
      null, null, null, null, 'human_control_active', null, null, null, null, null,
      0, '[]', '{}', '{}', null, null, false, '[]',
      null, null, null, '{}', null, null, null, '[]', '{}', 'final_confirmation',
      inboundEventId, `authority-inbound-${suffix}`,
      JSON.stringify({ response_text: '', bot_suppressed: true }), leadId,
    ];
    expect(values).toHaveLength(58);
    const { rows } = await client.query(persistConversationSql, values);

    expect(rows).toHaveLength(1);
    expect(rows[0].ownership_id).toBe(ownershipId);
    expect(rows[0].human_response_due_at).not.toBeNull();

    const message = await client.query(
      'SELECT sender_type, lead_id FROM messages WHERE id = $1',
      [rows[0].message_id],
    );
    expect(message.rows[0].sender_type).toBe('customer');
    expect(message.rows[0].lead_id).toBe(leadId);

    const conversation = await client.query(
      'SELECT lead_id FROM conversations WHERE id = $1',
      [conversationId],
    );
    expect(conversation.rows[0].lead_id).toBe(leadId);

    const ownership = await client.query(
      'SELECT pending_message_id, response_due_at FROM lead_chat_ownerships WHERE id = $1',
      [ownershipId],
    );
    expect(ownership.rows[0].pending_message_id).toBe(rows[0].message_id);
    const remainingMs = ownership.rows[0].response_due_at.getTime() - Date.now();
    expect(remainingMs).toBeGreaterThan(2 * 60 * 60 * 1000 - 10_000);
    expect(remainingMs).toBeLessThanOrEqual(2 * 60 * 60 * 1000);
  });

  test('the conversation load exposes active PostgreSQL ownership to the orchestrator', async () => {
    const values = [
      phoneNumber, sourceNumberId, 'Authority Customer', null,
      `authority-incoming-${suffix}`, null, 'text', 'Hello', '{}',
      null, null, null, null, null, null, null,
      'authority-test', inboundEventId, `authority-inbound-${suffix}`,
    ];
    const { rows } = await client.query(loadConversationSql, values);

    expect(rows).toHaveLength(1);
    expect(rows[0].ownership_id).toBe(ownershipId);
    expect(rows[0].ownership_lead_id).toBe(leadId);
    expect(rows[0].bot_suppressed).toBe(true);
    expect(rows[0].human_arbitration_required).toBe(false);
  });

  test('cancels a claimed bot message when human control became active', async () => {
    const token = `blocked-${suffix}`;
    const messageId = await seedClaimedMessage(token);
    const { rows } = await client.query(authorizeSql, [messageId, token, 'question']);

    expect(rows).toHaveLength(1);
    expect(rows[0].should_send).toBe(false);
    expect(rows[0].human_control_cancelled).toBe(true);
    expect(rows[0].dispatch_phase).toBe('cancelled');
  });

  test('authorizes the bot after the human ownership is released', async () => {
    await client.query(`
      UPDATE lead_chat_ownerships
      SET released_at = NOW(), release_reason = 'sla_expired'
      WHERE id = $1
    `, [ownershipId]);
    const token = `allowed-${suffix}`;
    const messageId = await seedClaimedMessage(token);
    const { rows } = await client.query(authorizeSql, [messageId, token, 'question']);

    expect(rows).toHaveLength(1);
    expect(rows[0].should_send).toBe(true);
    expect(rows[0].human_control_cancelled).toBe(false);
    expect(rows[0].dispatch_phase).toBe('sending');
  });

  test('cancels the bot while an unprocessed human reply waits in the contact queue', async () => {
    const queuedId = await seedQueuedOwnMessage('human', {
      externalMessageId: `unknown-${suffix}`,
      textBody: 'yo sigo desde aca',
    });
    const token = `queued-human-${suffix}`;
    const messageId = await seedClaimedMessage(token);

    const { rows } = await client.query(authorizeSql, [messageId, token, 'question']);
    expect(rows).toHaveLength(1);
    expect(rows[0].should_send).toBe(false);
    expect(rows[0].human_control_cancelled).toBe(true);
    expect(rows[0].dispatch_phase).toBe('cancelled');

    const { rows: stored } = await client.query(
      'SELECT reconciliation_reason FROM messages WHERE id = $1',
      [messageId],
    );
    expect(stored[0].reconciliation_reason).toBe('human_reply_pending');

    await client.query('DELETE FROM inbound_events WHERE id = $1', [queuedId]);
  });

  test('authorizes the bot when the queued own message is a confirmed bot echo', async () => {
    const echoId = `echo-${suffix}`;
    await client.query(`
      INSERT INTO messages (
        conversation_id, lead_id, direction, sender_type, message_type,
        delivery_status, text_body, external_message_id
      ) VALUES ($1, $2, 'outgoing', 'bot', 'text', 'sent', 'ya enviado', $3)
    `, [conversationId, leadId, echoId]);
    const queuedId = await seedQueuedOwnMessage('echo', {
      externalMessageId: echoId,
      textBody: 'ya enviado',
    });
    const token = `queued-echo-${suffix}`;
    const messageId = await seedClaimedMessage(token);

    const { rows } = await client.query(authorizeSql, [messageId, token, 'question']);
    expect(rows).toHaveLength(1);
    expect(rows[0].should_send).toBe(true);
    expect(rows[0].dispatch_phase).toBe('sending');

    await client.query('DELETE FROM inbound_events WHERE id = $1', [queuedId]);
  });

  test('authorizes the bot when the queued own message echoes another in-flight send', async () => {
    const inFlightToken = `in-flight-${suffix}`;
    const inFlightId = await seedClaimedMessage(inFlightToken);
    const queuedId = await seedQueuedOwnMessage('pending-echo', {
      externalMessageId: `pending-${suffix}`,
      textBody: 'test response',
    });
    const token = `queued-pending-${suffix}`;
    const messageId = await seedClaimedMessage(token);

    const { rows } = await client.query(authorizeSql, [messageId, token, 'question']);
    expect(rows).toHaveLength(1);
    expect(rows[0].should_send).toBe(true);
    expect(rows[0].dispatch_phase).toBe('sending');

    await client.query('DELETE FROM inbound_events WHERE id = $1', [queuedId]);
    await client.query('DELETE FROM messages WHERE id = $1', [inFlightId]);
  });

  test('does not treat the message under authorization as its own pending echo', async () => {
    // The candidate has not left yet, so no echo of it can exist. Matching it
    // would let a genuine human reply through and produce the double answer.
    // Text unique to this candidate, so the only possible pending-echo match
    // is the candidate itself.
    const onlyText = `solo-este-candidato-${suffix}`;
    const queuedId = await seedQueuedOwnMessage('self-echo', {
      externalMessageId: `self-${suffix}`,
      textBody: onlyText,
    });
    const token = `queued-self-${suffix}`;
    const messageId = await seedClaimedMessage(token, onlyText);

    const { rows } = await client.query(authorizeSql, [messageId, token, 'question']);
    expect(rows).toHaveLength(1);
    expect(rows[0].should_send).toBe(false);
    expect(rows[0].human_control_cancelled).toBe(true);

    await client.query('DELETE FROM inbound_events WHERE id = $1', [queuedId]);
  });

  test('authorizes the bot once the human event has already been processed', async () => {
    const queuedId = await seedQueuedOwnMessage('done', {
      externalMessageId: `done-${suffix}`,
      textBody: 'respuesta ya registrada',
      status: 'processed',
    });
    const token = `queued-done-${suffix}`;
    const messageId = await seedClaimedMessage(token);

    const { rows } = await client.query(authorizeSql, [messageId, token, 'question']);
    expect(rows).toHaveLength(1);
    expect(rows[0].should_send).toBe(true);
    expect(rows[0].dispatch_phase).toBe('sending');

    await client.query('DELETE FROM inbound_events WHERE id = $1', [queuedId]);
  });
});
