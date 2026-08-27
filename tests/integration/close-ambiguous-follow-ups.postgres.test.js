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

describeIntegration('closing follow-ups left ambiguous by the provider', () => {
  const client = new pg.Client(connection);
  const backfillSql = fs.readFileSync('db/queries/ops/close-ambiguous-follow-ups.sql', 'utf8');

  let sourceNumberId;
  let conversationId;
  let sequence = 0;

  // The backfill is a whole transaction script; running it inside the test's
  // own transaction would nest BEGIN/COMMIT, so it runs standalone.
  const runBackfill = () => client.query(backfillSql);

  const insertFollowUp = async ({ estado, lastSendError, nextRetryAt = null, attempts = 1 }) => {
    sequence += 1;
    const { rows } = await client.query(`
      INSERT INTO follow_ups (
        idempotency_key, conversation_id, phone_number, source_number_id,
        motivo, step_dia, scheduled_at, estado, last_send_error,
        send_attempt_count, max_send_attempts, next_retry_at, cycle_key
      ) VALUES ($1, $2, '15550009999', $3, 'lead_sin_respuesta', 1, NOW(), $4, $5, $6, 3, $7, $1)
      RETURNING id
    `, [
      `ambiguous-${sequence}`,
      conversationId,
      sourceNumberId,
      estado,
      lastSendError,
      attempts,
      nextRetryAt,
    ]);
    return rows[0].id;
  };

  const readFollowUp = async (id) => {
    const { rows } = await client.query(
      'SELECT estado, last_send_error FROM follow_ups WHERE id = $1',
      [id],
    );
    return rows[0];
  };

  const auditCount = async (id) => {
    const { rows } = await client.query(`
      SELECT COUNT(*)::int AS total FROM audit_logs
      WHERE entity_type = 'follow_up' AND entity_id = $1
        AND event_name = 'follow_up_closed_ambiguous'
    `, [id]);
    return rows[0].total;
  };

  beforeAll(async () => {
    await client.connect();

    const number = await client.query(`
      INSERT INTO whatsapp_numbers (display_name, phone_number, phone_number_id, is_active)
      VALUES ('ambiguous-test', '15550000009', 'pn-ambiguous-test', TRUE)
      RETURNING id
    `);
    sourceNumberId = number.rows[0].id;

    const conversation = await client.query(`
      INSERT INTO conversations (
        source_number_id, phone_number, conversation_status_id, started_at, last_message_at
      ) VALUES ($1, '15550009999',
        (SELECT id FROM conversation_statuses WHERE code = 'waiting_user'), NOW(), NOW())
      RETURNING id
    `, [sourceNumberId]);
    conversationId = conversation.rows[0].id;
  });

  afterAll(async () => {
    await client.end();
  });

  test('declares an ambiguous follow-up terminal and audits the change', async () => {
    const id = await insertFollowUp({ estado: 'error', lastSendError: 'outbound_unknown' });

    await runBackfill();

    expect(await readFollowUp(id)).toEqual({
      estado: 'cancelled',
      last_send_error: 'closed_no_replay_ambiguous_outbound',
    });
    expect(await auditCount(id)).toBe(1);
  });

  test('leaves a genuine exhausted failure untouched', async () => {
    const id = await insertFollowUp({
      estado: 'error',
      lastSendError: 'outbound_failed',
      attempts: 3,
    });

    await runBackfill();

    expect(await readFollowUp(id)).toEqual({
      estado: 'error',
      last_send_error: 'outbound_failed',
    });
    expect(await auditCount(id)).toBe(0);
  });

  test('leaves an ambiguous follow-up that still has a retry scheduled', async () => {
    const id = await insertFollowUp({
      estado: 'error',
      lastSendError: 'outbound_unknown',
      nextRetryAt: new Date(Date.now() + 3600_000),
    });

    await runBackfill();

    // A scheduled retry means the pipeline still owns this row.
    expect((await readFollowUp(id)).estado).toBe('error');
    expect(await auditCount(id)).toBe(0);
  });

  test('is idempotent: a second run changes nothing and audits nothing new', async () => {
    const id = await insertFollowUp({ estado: 'error', lastSendError: 'outbound_unknown' });

    await runBackfill();
    const afterFirst = await readFollowUp(id);
    await runBackfill();

    expect(await readFollowUp(id)).toEqual(afterFirst);
    expect(await auditCount(id)).toBe(1);
  });

  test('does not disturb follow-ups cancelled because the client responded', async () => {
    const { rows } = await client.query(`
      INSERT INTO follow_ups (
        idempotency_key, conversation_id, phone_number, source_number_id,
        motivo, step_dia, scheduled_at, estado, result, cycle_key
      ) VALUES ('responded-guard', $1, '15550009999', $2,
        'lead_sin_respuesta', 1, NOW(), 'cancelled', 'responded', 'responded-guard')
      RETURNING id
    `, [conversationId, sourceNumberId]);
    const id = rows[0].id;

    await runBackfill();

    const { rows: after } = await client.query(
      'SELECT estado, result, last_send_error FROM follow_ups WHERE id = $1',
      [id],
    );
    expect(after[0]).toEqual({
      estado: 'cancelled',
      result: 'responded',
      last_send_error: null,
    });
  });
});
