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
  let waitingStatusId;

  const sqlForPhone = (phoneNumber) => {
    if (!/^\d+$/.test(phoneNumber)) throw new Error('test phone must contain only digits');
    return resetSql.replaceAll(":'phone_number'", `'${phoneNumber}'`);
  };

  const insertConversation = async (phoneNumber) => {
    const result = await client.query(`
      INSERT INTO conversations (phone_number, conversation_status_id)
      VALUES ($1, $2)
      RETURNING id
    `, [phoneNumber, waitingStatusId]);
    return result.rows[0].id;
  };

  beforeAll(async () => {
    await client.connect();
    const status = await client.query(
      "SELECT id FROM conversation_statuses WHERE code = 'waiting_user'",
    );
    waitingStatusId = status.rows[0].id;
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
});
