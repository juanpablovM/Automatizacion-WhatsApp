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

const CONTACT = 'test-contact-eligibility';

describeIntegration('follow-up eligibility against persisted conversation state', () => {
  const client = new pg.Client(connection);
  const scheduleSql = fs.readFileSync(
    'db/queries/n8n/follow-up-pipeline/01_schedule_follow_up.sql',
    'utf8',
  );
  const optOutSql = fs.readFileSync(
    'db/queries/n8n/follow-up-pipeline/06_apply_opt_out.sql',
    'utf8',
  );

  let sourceNumberId;
  const statusIds = {};

  const createConversation = async (statusCode, step = 'city') => {
    const result = await client.query(
      `INSERT INTO conversations (source_number_id, phone_number, conversation_status_id, current_step)
       VALUES ($1, $2, $3, $4) RETURNING id`,
      [sourceNumberId, CONTACT, statusIds[statusCode], step],
    );
    return result.rows[0].id;
  };

  const schedule = async (conversationId, motivo, cycleKey) => {
    const result = await client.query(scheduleSql, [
      conversationId,
      '',
      CONTACT,
      sourceNumberId,
      motivo,
      0,
      new Date('2026-09-15T12:00:00.000Z').toISOString(),
      cycleKey,
    ]);
    return result.rows[0].result;
  };

  beforeAll(async () => {
    await client.connect();

    const source = await client.query(
      `INSERT INTO whatsapp_numbers (display_name, phone_number, phone_number_id)
       VALUES ('Eligibility Test', $1, 'test-source-eligibility') RETURNING id`,
      [CONTACT],
    );
    sourceNumberId = source.rows[0].id;

    const statuses = await client.query(
      `SELECT id, code FROM conversation_statuses
       WHERE code IN ('waiting_user', 'handed_to_sales', 'closed')`,
    );
    for (const row of statuses.rows) statusIds[row.code] = row.id;
  });

  afterAll(async () => {
    await client.query(
      'DELETE FROM follow_ups WHERE source_number_id = $1',
      [sourceNumberId],
    );
    await client.query(
      `DELETE FROM follow_up_preferences WHERE conversation_id IN
       (SELECT id FROM conversations WHERE source_number_id = $1)`,
      [sourceNumberId],
    );
    await client.query('DELETE FROM conversations WHERE source_number_id = $1', [sourceNumberId]);
    await client.query('DELETE FROM whatsapp_numbers WHERE id = $1', [sourceNumberId]);
    await client.end();
  });

  test('schedules a no-reply follow-up only while the customer still owes a reply', async () => {
    const waiting = await createConversation('waiting_user');
    await expect(schedule(waiting, 'lead_sin_respuesta', 'cycle-waiting')).resolves.toBe('scheduled');
  });

  test('refuses a no-reply follow-up on a conversation that is already closed', async () => {
    const closed = await createConversation('closed');
    await expect(schedule(closed, 'lead_sin_respuesta', 'cycle-closed')).resolves.toBe(
      'ineligible_blocked',
    );
  });

  test('refuses a no-reply follow-up on a conversation already handed to a seller', async () => {
    const handed = await createConversation('handed_to_sales');
    await expect(schedule(handed, 'lead_sin_respuesta', 'cycle-handed-wrong')).resolves.toBe(
      'ineligible_blocked',
    );
  });

  test('schedules a quote follow-up only once the lead reached a seller', async () => {
    const handed = await createConversation('handed_to_sales');
    await expect(schedule(handed, 'cotizacion_lead', 'cycle-handed-right')).resolves.toBe(
      'scheduled',
    );

    const waiting = await createConversation('waiting_user');
    await expect(schedule(waiting, 'cotizacion_lead', 'cycle-waiting-wrong')).resolves.toBe(
      'ineligible_blocked',
    );
  });

  test('stops claiming a pending follow-up once its conversation stops being eligible', async () => {
    const conversationId = await createConversation('waiting_user');
    expect(await schedule(conversationId, 'lead_sin_respuesta', 'cycle-claim')).toBe('scheduled');

    await client.query(
      "UPDATE follow_ups SET scheduled_at = NOW() - INTERVAL '1 hour' WHERE conversation_id = $1",
      [conversationId],
    );

    const claimable = await client.query(
      "SELECT id FROM claim_due_follow_ups(50, '00:00', '23:59', NOW(), 900) WHERE conversation_id = $1",
      [conversationId],
    );
    expect(claimable.rowCount).toBe(1);

    await client.query(
      'UPDATE follow_ups SET estado = $2, claim_token = NULL, claimed_at = NULL WHERE conversation_id = $1',
      [conversationId, 'pending'],
    );
    await client.query(
      'UPDATE conversations SET conversation_status_id = $2 WHERE id = $1',
      [conversationId, statusIds.closed],
    );

    const afterClose = await client.query(
      "SELECT id FROM claim_due_follow_ups(50, '00:00', '23:59', NOW(), 900) WHERE conversation_id = $1",
      [conversationId],
    );
    expect(afterClose.rowCount).toBe(0);
  });

  test('carries an opt-out to the next conversation the same contact opens', async () => {
    const first = await createConversation('waiting_user');
    await client.query(optOutSql, [first, 'no me escriban mas', '']);

    const second = await createConversation('waiting_user');
    await expect(schedule(second, 'lead_sin_respuesta', 'cycle-after-optout')).resolves.toBe(
      'opted_out_blocked',
    );
  });
});
