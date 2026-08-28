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

describeIntegration('closing handoffs whose area has no ClickUp delivery path', () => {
  const client = new pg.Client(connection);
  const backfillSql = fs.readFileSync('db/queries/ops/close-undeliverable-area-handoffs.sql', 'utf8');

  let sourceNumberId;
  let conversationId;
  let sequence = 0;

  // The backfill is a whole transaction script; running it inside the test's
  // own transaction would nest BEGIN/COMMIT, so it runs standalone.
  const runBackfill = () => client.query(backfillSql);

  const insertHandoff = async ({
    area = 'b2b',
    estado = 'pending',
    lastNotificationError = 'HANDOFF_CLICKUP_AREA_unsupported:b2b',
    operationStatus = 'pending',
    attemptCount = 0,
    notifiedAt = null,
    withOperation = true,
  }) => {
    sequence += 1;
    const key = `undeliverable-${sequence}`;
    const { rows } = await client.query(`
      INSERT INTO handoffs (
        idempotency_key, conversation_id, phone_number, source_number_id,
        motivo, area, area_label, prioridad, responsable, estado,
        last_notification_error, notification_attempt_count, max_attempts,
        notified_at, next_notification_at
      ) VALUES ($1, $2, '15550009999', $3, $4, $4, upper($4), 'alta',
                'Área de prueba', $5, $6, 0, 3, $7, NOW())
      RETURNING id
    `, [key, conversationId, sourceNumberId, area, estado, lastNotificationError, notifiedAt]);
    const handoffId = rows[0].id;

    if (withOperation) {
      await client.query(`
        INSERT INTO external_operations (
          operation_key, operation_type, entity_type, entity_id,
          status, attempt_count, retry_safe
        ) VALUES ($1, 'handoff_clickup_notification', 'handoff', $2, $3, $4, FALSE)
      `, [`handoff-clickup:${handoffId}`, handoffId, operationStatus, attemptCount]);
    }

    return handoffId;
  };

  const readHandoff = async (id) => {
    const { rows } = await client.query(`
      SELECT estado, last_notification_error, deleted_at IS NOT NULL AS retired
      FROM handoffs WHERE id = $1
    `, [id]);
    return rows[0];
  };

  const readOperation = async (handoffId) => {
    const { rows } = await client.query(`
      SELECT status, retry_safe, reconciliation_required, completed_at IS NOT NULL AS completed
      FROM external_operations WHERE entity_type = 'handoff' AND entity_id = $1
    `, [handoffId]);
    return rows[0];
  };

  const auditCount = async (id) => {
    const { rows } = await client.query(`
      SELECT COUNT(*)::int AS total FROM audit_logs
      WHERE entity_type = 'handoff' AND entity_id = $1
        AND event_name = 'handoff_closed_undeliverable_area'
    `, [id]);
    return rows[0].total;
  };

  beforeAll(async () => {
    await client.connect();

    const number = await client.query(`
      INSERT INTO whatsapp_numbers (display_name, phone_number, phone_number_id, is_active)
      VALUES ('undeliverable-area-test', '15550000011', 'pn-undeliverable-test', TRUE)
      RETURNING id
    `);
    sourceNumberId = number.rows[0].id;

    const conversation = await client.query(`
      INSERT INTO conversations (
        source_number_id, phone_number, conversation_status_id, started_at, last_message_at
      ) VALUES ($1, '15550009999',
        (SELECT id FROM conversation_statuses WHERE code = 'escalation_required'), NOW(), NOW())
      RETURNING id
    `, [sourceNumberId]);
    conversationId = conversation.rows[0].id;
  });

  afterAll(async () => {
    await client.end();
  });

  test('retires a handoff the dispatcher can never deliver and audits the change', async () => {
    const id = await insertHandoff({});

    await runBackfill();

    // estado stays 'pending' on purpose: the schema only admits pending,
    // notified, acknowledged and resolved, and none of them is true here.
    // Nobody was notified and nobody resolved it. The soft delete is what
    // takes the row out of the claim query.
    expect(await readHandoff(id)).toEqual({
      estado: 'pending',
      last_notification_error: 'closed_undeliverable_area_no_replay',
      retired: true,
    });
    expect(await readOperation(id)).toEqual({
      status: 'failed',
      retry_safe: false,
      reconciliation_required: false,
      completed: true,
    });
    expect(await auditCount(id)).toBe(1);
  });

  test('leaves a sales handoff untouched: that area does have a delivery path', async () => {
    const id = await insertHandoff({
      area: 'sales',
      lastNotificationError: null,
    });

    await runBackfill();

    expect((await readHandoff(id)).retired).toBe(false);
    expect((await readOperation(id)).status).toBe('pending');
    expect(await auditCount(id)).toBe(0);
  });

  test('leaves an unsupported-area handoff the dispatcher never rejected', async () => {
    // No unsupported-area marker means the dispatcher has not spoken yet.
    // Closing it here would hide a row the pipeline still owns.
    const id = await insertHandoff({
      area: 'finance',
      lastNotificationError: null,
    });

    await runBackfill();

    expect((await readHandoff(id)).retired).toBe(false);
    expect(await auditCount(id)).toBe(0);
  });

  test('leaves an already notified handoff untouched', async () => {
    const id = await insertHandoff({
      estado: 'notified',
      notifiedAt: new Date(),
      operationStatus: 'succeeded',
    });

    await runBackfill();

    expect((await readHandoff(id)).retired).toBe(false);
    expect(await auditCount(id)).toBe(0);
  });

  test('is idempotent: a second run changes nothing and audits nothing new', async () => {
    const id = await insertHandoff({});

    await runBackfill();
    const afterFirst = await readHandoff(id);
    await runBackfill();

    expect(await readHandoff(id)).toEqual(afterFirst);
    expect(await auditCount(id)).toBe(1);
  });
});
