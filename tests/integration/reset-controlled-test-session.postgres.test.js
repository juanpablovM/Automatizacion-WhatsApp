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

describeIntegration('controlled test session reset in PostgreSQL', () => {
  const client = new pg.Client(connection);
  const resetSql = fs.readFileSync(
    'db/queries/ops/reset-controlled-test-session.sql',
    'utf8',
  );
  const statusIdByCode = new Map();

  const sqlForPhone = (phoneNumber) => {
    if (!/^\d+$/.test(phoneNumber)) throw new Error('test phone must contain only digits');
    return resetSql.replaceAll(":'phone_number'", `'${phoneNumber}'`);
  };

  const insertConversationWithStatus = async (phoneNumber, statusCode) => {
    const statusId = statusIdByCode.get(statusCode);
    if (!statusId) throw new Error(`unknown conversation status ${statusCode}`);
    const result = await client.query(`
      INSERT INTO conversations (phone_number, conversation_status_id)
      VALUES ($1, $2)
      RETURNING id
    `, [phoneNumber, statusId]);
    return result.rows[0].id;
  };

  const insertConversation = (phoneNumber) => insertConversationWithStatus(phoneNumber, 'waiting_user');

  const insertFollowUp = async ({
    phoneNumber, conversationId, estado, stepDia, idempotencyKey,
  }) => {
    const result = await client.query(`
      INSERT INTO follow_ups (
        idempotency_key, cycle_key, conversation_id, phone_number, motivo,
        step_dia, scheduled_at, estado
      ) VALUES ($1, $1, $2, $3, 'lead_sin_respuesta', $4, NOW(), $5)
      RETURNING id
    `, [idempotencyKey, conversationId, phoneNumber, stepDia, estado]);
    return result.rows[0].id;
  };

  // An escalated conversation only reaches a terminal status once its handoff
  // was notified: enforce_handoff_before_conversation_terminal refuses
  // otherwise. The reset never touches handoffs, so the fixture has to look
  // like the real escalation it replays.
  const insertHandoff = async ({
    phoneNumber, conversationId, idempotencyKey, estado,
  }) => {
    const result = await client.query(`
      INSERT INTO handoffs (
        idempotency_key, conversation_id, phone_number, motivo, area, area_label,
        prioridad, responsable, estado, notified_at
      ) VALUES (
        $1, $2, $3, 'escalacion', 'soporte', 'Soporte', 'alta', 'equipo', $4,
        CASE WHEN $4 = 'pending' THEN NULL ELSE NOW() END
      )
      RETURNING id
    `, [idempotencyKey, conversationId, phoneNumber, estado]);
    return result.rows[0].id;
  };

  const readConversationStatus = async (conversationId) => {
    const result = await client.query(`
      SELECT status.code
      FROM conversations AS conversation
      JOIN conversation_statuses AS status ON status.id = conversation.conversation_status_id
      WHERE conversation.id = $1
    `, [conversationId]);
    return result.rows[0].code;
  };

  const readFollowUp = async (followUpId) => {
    const result = await client.query(`
      SELECT estado, result, claim_token, claimed_at, next_retry_at, metadata
      FROM follow_ups
      WHERE id = $1
    `, [followUpId]);
    return result.rows[0];
  };

  beforeAll(async () => {
    await client.connect();
    const statuses = await client.query('SELECT id, code FROM conversation_statuses');
    for (const row of statuses.rows) statusIdByCode.set(row.code, row.id);
  });

  afterAll(async () => {
    await client.end();
  });

  test('rolls back when the controlled number has a queued inbound event', async () => {
    const phoneNumber = '56900000021';
    const conversationId = await insertConversation(phoneNumber);
    await client.query(`
      INSERT INTO inbound_events (
        instance_name, event_fingerprint, dedupe_key, phone_number, processing_status
      ) VALUES ('reset-contract', 'reset-queued-fingerprint', 'reset-queued-dedupe', $1, 'received')
    `, [phoneNumber]);

    await expect(client.query(sqlForPhone(phoneNumber))).rejects.toThrow(
      /queued\/processing inbound event/,
    );
    await client.query('ROLLBACK');

    const result = await client.query(`
      SELECT status.code
      FROM conversations AS conversation
      JOIN conversation_statuses AS status ON status.id = conversation.conversation_status_id
      WHERE conversation.id = $1
    `, [conversationId]);
    expect(result.rows[0].code).toBe('waiting_user');
  });

  test('archives only the selected session and writes its audit record', async () => {
    const selectedPhone = '56900000022';
    const otherPhone = '56900000023';
    const selectedConversationId = await insertConversation(selectedPhone);
    const otherConversationId = await insertConversation(otherPhone);

    await client.query(sqlForPhone(selectedPhone));

    const statuses = await client.query(`
      SELECT conversation.id, status.code
      FROM conversations AS conversation
      JOIN conversation_statuses AS status ON status.id = conversation.conversation_status_id
      WHERE conversation.id = ANY($1::bigint[])
      ORDER BY conversation.id
    `, [[selectedConversationId, otherConversationId]]);
    expect(statuses.rows).toEqual([
      { id: selectedConversationId, code: 'closed' },
      { id: otherConversationId, code: 'waiting_user' },
    ]);

    const audit = await client.query(`
      SELECT COUNT(*)::integer AS count
      FROM audit_logs
      WHERE event_name = 'controlled_test_session_archived'
        AND entity_type = 'conversation'
        AND entity_id = $1
        AND actor_id = 'reset-controlled-test-session'
    `, [selectedConversationId]);
    expect(audit.rows[0].count).toBe(1);
  });

  test('closes conversations already handed to sales or escalated', async () => {
    const phoneNumber = '56900000024';
    const handedConversationId = await insertConversationWithStatus(phoneNumber, 'handed_to_sales');
    const escalatedConversationId = await insertConversationWithStatus(phoneNumber, 'escalation_required');
    const handoffId = await insertHandoff({
      phoneNumber,
      conversationId: escalatedConversationId,
      idempotencyKey: 'reset-escalated-handoff',
      estado: 'notified',
    });

    await client.query(sqlForPhone(phoneNumber));

    const statuses = await client.query(`
      SELECT conversation.id, status.code
      FROM conversations AS conversation
      JOIN conversation_statuses AS status ON status.id = conversation.conversation_status_id
      WHERE conversation.id = ANY($1::bigint[])
      ORDER BY conversation.id
    `, [[handedConversationId, escalatedConversationId]]);
    expect(statuses.rows).toEqual([
      { id: handedConversationId, code: 'closed' },
      { id: escalatedConversationId, code: 'closed' },
    ]);

    const audit = await client.query(`
      SELECT entity_id, before_payload, after_payload
      FROM audit_logs
      WHERE event_name = 'controlled_test_session_archived'
        AND entity_type = 'conversation'
        AND entity_id = ANY($1::bigint[])
        AND actor_id = 'reset-controlled-test-session'
      ORDER BY entity_id
    `, [[handedConversationId, escalatedConversationId]]);
    expect(audit.rows).toEqual([
      {
        entity_id: handedConversationId,
        before_payload: { conversation_status_code: 'handed_to_sales' },
        after_payload: { conversation_status_code: 'closed' },
      },
      {
        entity_id: escalatedConversationId,
        before_payload: { conversation_status_code: 'escalation_required' },
        after_payload: { conversation_status_code: 'closed' },
      },
    ]);

    const handoff = await client.query('SELECT estado FROM handoffs WHERE id = $1', [handoffId]);
    expect(handoff.rows[0].estado).toBe('notified');
  });

  test('refuses before any write when a handoff is still pending', async () => {
    const phoneNumber = '56900000029';
    const conversationId = await insertConversation(phoneNumber);
    await insertHandoff({
      phoneNumber,
      conversationId,
      idempotencyKey: 'reset-pending-handoff',
      estado: 'pending',
    });
    const followUpId = await insertFollowUp({
      phoneNumber,
      conversationId,
      estado: 'pending',
      stepDia: 1,
      idempotencyKey: 'reset-pending-handoff-follow-up',
    });

    await expect(client.query(sqlForPhone(phoneNumber))).rejects.toThrow(
      /conversation\(s\) whose handoff is not notified yet/,
    );
    await client.query('ROLLBACK');

    expect(await readConversationStatus(conversationId)).toBe('waiting_user');
    // The follow-up proves the refusal ran before every mutation, not just
    // before the conversation update.
    expect((await readFollowUp(followUpId)).estado).toBe('pending');
  });

  test('refuses an escalated conversation whose handoff was never notified', async () => {
    const phoneNumber = '56900000030';
    const conversationId = await insertConversationWithStatus(phoneNumber, 'escalation_required');

    await expect(client.query(sqlForPhone(phoneNumber))).rejects.toThrow(
      /conversation\(s\) whose handoff is not notified yet/,
    );
    await client.query('ROLLBACK');

    expect(await readConversationStatus(conversationId)).toBe('escalation_required');
  });

  test('cancels a scheduled follow-up and writes its audit record', async () => {
    const phoneNumber = '56900000025';
    const conversationId = await insertConversation(phoneNumber);
    const followUpId = await insertFollowUp({
      phoneNumber,
      conversationId,
      estado: 'pending',
      stepDia: 1,
      idempotencyKey: 'reset-cancel-pending',
    });

    await client.query(sqlForPhone(phoneNumber));

    const followUp = await readFollowUp(followUpId);
    expect(followUp.estado).toBe('cancelled');
    expect(followUp.result).toBeNull();
    expect(followUp.claim_token).toBeNull();
    expect(followUp.claimed_at).toBeNull();
    expect(followUp.next_retry_at).toBeNull();
    expect(followUp.metadata).toEqual({
      cancel_reason: 'controlled_test_session_reset',
      cancelled_by: 'reset-controlled-test-session',
    });

    const audit = await client.query(`
      SELECT entity_type, actor_type, actor_id, result, before_payload, after_payload, metadata
      FROM audit_logs
      WHERE event_name = 'controlled_test_follow_up_cancelled'
        AND entity_id = $1
    `, [followUpId]);
    expect(audit.rows).toEqual([{
      entity_type: 'follow_up',
      actor_type: 'system',
      actor_id: 'reset-controlled-test-session',
      result: 'cancelled',
      before_payload: { estado: 'pending' },
      after_payload: { estado: 'cancelled' },
      metadata: {
        conversation_id: Number(conversationId),
        motivo: 'lead_sin_respuesta',
        step_dia: 1,
        reason: 'controlled_test_session_reset',
      },
    }]);
  });

  test('refuses and changes nothing when a follow-up is already in flight', async () => {
    const phoneNumber = '56900000026';
    const conversationId = await insertConversation(phoneNumber);
    const inFlightId = await insertFollowUp({
      phoneNumber,
      conversationId,
      estado: 'sending',
      stepDia: 3,
      idempotencyKey: 'reset-in-flight-sending',
    });
    const pendingId = await insertFollowUp({
      phoneNumber,
      conversationId,
      estado: 'pending',
      stepDia: 7,
      idempotencyKey: 'reset-in-flight-pending',
    });

    await expect(client.query(sqlForPhone(phoneNumber))).rejects.toThrow(
      /follow-up\(s\) in flight/,
    );
    await client.query('ROLLBACK');

    const conversation = await client.query(`
      SELECT status.code
      FROM conversations AS conversation
      JOIN conversation_statuses AS status ON status.id = conversation.conversation_status_id
      WHERE conversation.id = $1
    `, [conversationId]);
    expect(conversation.rows[0].code).toBe('waiting_user');
    expect((await readFollowUp(inFlightId)).estado).toBe('sending');
    expect((await readFollowUp(pendingId)).estado).toBe('pending');
  });

  test('leaves another number conversation and follow-up untouched', async () => {
    const selectedPhone = '56900000027';
    const otherPhone = '56900000028';
    const selectedConversationId = await insertConversation(selectedPhone);
    const otherConversationId = await insertConversation(otherPhone);
    const selectedFollowUpId = await insertFollowUp({
      phoneNumber: selectedPhone,
      conversationId: selectedConversationId,
      estado: 'pending',
      stepDia: 0,
      idempotencyKey: 'reset-scope-selected',
    });
    const otherFollowUpId = await insertFollowUp({
      phoneNumber: otherPhone,
      conversationId: otherConversationId,
      estado: 'pending',
      stepDia: 0,
      idempotencyKey: 'reset-scope-other',
    });

    await client.query(sqlForPhone(selectedPhone));

    const statuses = await client.query(`
      SELECT conversation.id, status.code
      FROM conversations AS conversation
      JOIN conversation_statuses AS status ON status.id = conversation.conversation_status_id
      WHERE conversation.id = ANY($1::bigint[])
      ORDER BY conversation.id
    `, [[selectedConversationId, otherConversationId]]);
    expect(statuses.rows).toEqual([
      { id: selectedConversationId, code: 'closed' },
      { id: otherConversationId, code: 'waiting_user' },
    ]);

    expect((await readFollowUp(selectedFollowUpId)).estado).toBe('cancelled');
    const otherFollowUp = await readFollowUp(otherFollowUpId);
    expect(otherFollowUp.estado).toBe('pending');
    expect(otherFollowUp.metadata).toEqual({});

    const otherAudit = await client.query(`
      SELECT COUNT(*)::integer AS count
      FROM audit_logs
      WHERE actor_id = 'reset-controlled-test-session'
        AND entity_type = 'follow_up'
        AND entity_id = $1
    `, [otherFollowUpId]);
    expect(otherAudit.rows[0].count).toBe(0);
  });
});
