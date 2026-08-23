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

describeIntegration('handoff closure driven by a ClickUp task update', () => {
  const client = new pg.Client(connection);
  const closureSql = fs.readFileSync(
    'db/queries/n8n/handoff-routing/05_close_handoff_from_clickup.sql',
    'utf8',
  );

  let sourceNumberId;
  let escalationStatusId;
  let sequence = 0;

  const close = (clickupTaskId, estado) => client.query(closureSql, [clickupTaskId, estado]);

  // Each case gets its own conversation/handoff/task so ordering between tests
  // never decides the outcome.
  const seedNotifiedHandoff = async () => {
    sequence += 1;
    const suffix = String(sequence).padStart(3, '0');
    const phoneNumber = `1555000${suffix}`;
    const clickupTaskId = `clickup-task-${suffix}`;

    const conversation = await client.query(`
      INSERT INTO conversations (
        source_number_id, phone_number, conversation_status_id, current_step,
        started_at, last_message_at
      ) VALUES ($1, $2, $3, 'escalation', NOW(), NOW())
      RETURNING id
    `, [sourceNumberId, phoneNumber, escalationStatusId]);
    const conversationId = conversation.rows[0].id;

    const handoff = await client.query(`
      INSERT INTO handoffs (
        idempotency_key, conversation_id, phone_number, source_number_id,
        motivo, area, area_label, prioridad, responsable, estado, notified_at
      ) VALUES ($1, $2, $3, $4, 'test', 'sales', 'Ventas', 'alta', 'equipo-ventas', 'notified', NOW())
      RETURNING id
    `, [`closure-${suffix}`, conversationId, phoneNumber, sourceNumberId]);
    const handoffId = handoff.rows[0].id;

    await client.query(`
      INSERT INTO external_operations (
        operation_key, operation_type, entity_type, entity_id, status,
        external_id, external_url
      ) VALUES ($1, 'handoff_clickup_notification', 'handoff', $2, 'succeeded', $3, $4)
    `, [
      `handoff-clickup:${handoffId}`,
      handoffId,
      clickupTaskId,
      `https://app.clickup.com/t/${clickupTaskId}`,
    ]);

    return { conversationId, handoffId, clickupTaskId };
  };

  const handoffState = async (handoffId) => {
    const { rows } = await client.query(
      'SELECT estado, acknowledged_at, resolved_at FROM handoffs WHERE id = $1',
      [handoffId],
    );
    return rows[0];
  };

  const conversationStatus = async (conversationId) => {
    const { rows } = await client.query(`
      SELECT status.code
      FROM conversations conversation
      JOIN conversation_statuses status ON status.id = conversation.conversation_status_id
      WHERE conversation.id = $1
    `, [conversationId]);
    return rows[0].code;
  };

  const auditResults = async (handoffId) => {
    const { rows } = await client.query(`
      SELECT result FROM audit_logs
      WHERE entity_type = 'handoff' AND entity_id = $1
      ORDER BY id
    `, [handoffId]);
    return rows.map((row) => row.result);
  };

  beforeAll(async () => {
    await client.connect();

    const number = await client.query(`
      INSERT INTO whatsapp_numbers (display_name, phone_number, phone_number_id, is_active)
      VALUES ('closure-test', '15550000000', 'pn-closure-test', TRUE)
      RETURNING id
    `);
    sourceNumberId = number.rows[0].id;

    const status = await client.query(
      "SELECT id FROM conversation_statuses WHERE code = 'escalation_required'",
    );
    escalationStatusId = status.rows[0].id;
  });

  afterAll(async () => {
    await client.end();
  });

  test('reports unknown_task for a ClickUp task that maps to no handoff', async () => {
    const { rows } = await close('clickup-task-does-not-exist', 'resolved');

    expect(rows).toHaveLength(1);
    expect(rows[0].outcome).toBe('unknown_task');
    expect(rows[0].handoff_id).toBeNull();
    expect(rows[0].conversation_closed).toBe(false);
  });

  test('advances notified to acknowledged without closing the conversation', async () => {
    const { conversationId, handoffId, clickupTaskId } = await seedNotifiedHandoff();

    const { rows } = await close(clickupTaskId, 'acknowledged');

    expect(rows[0].outcome).toBe('advanced');
    expect(rows[0].handoff_estado).toBe('acknowledged');
    expect(rows[0].conversation_closed).toBe(false);

    const state = await handoffState(handoffId);
    expect(state.estado).toBe('acknowledged');
    expect(state.acknowledged_at).not.toBeNull();
    expect(state.resolved_at).toBeNull();

    // Acknowledgement is not closure: the case is still open for the area.
    expect(await conversationStatus(conversationId)).toBe('escalation_required');
  });

  test('is idempotent when the same state arrives twice', async () => {
    const { handoffId, clickupTaskId } = await seedNotifiedHandoff();

    await close(clickupTaskId, 'acknowledged');
    const first = await handoffState(handoffId);

    const { rows } = await close(clickupTaskId, 'acknowledged');

    expect(rows[0].outcome).toBe('already_applied');
    const second = await handoffState(handoffId);
    expect(second.acknowledged_at).toEqual(first.acknowledged_at);
    // A webhook retry must not pile up audit noise.
    expect(await auditResults(handoffId)).toEqual(['advanced']);
  });

  test('resolves and closes the escalated conversation', async () => {
    const { conversationId, handoffId, clickupTaskId } = await seedNotifiedHandoff();

    const { rows } = await close(clickupTaskId, 'resolved');

    expect(rows[0].outcome).toBe('advanced');
    expect(rows[0].handoff_estado).toBe('resolved');
    expect(rows[0].conversation_closed).toBe(true);

    const state = await handoffState(handoffId);
    expect(state.resolved_at).not.toBeNull();
    expect(await conversationStatus(conversationId)).toBe('closed');
  });

  test('rejects a backwards transition and leaves the handoff untouched', async () => {
    const { handoffId, clickupTaskId } = await seedNotifiedHandoff();
    await close(clickupTaskId, 'resolved');
    const resolvedState = await handoffState(handoffId);

    const { rows } = await close(clickupTaskId, 'acknowledged');

    expect(rows[0].outcome).toBe('invalid_transition');
    const afterState = await handoffState(handoffId);
    expect(afterState.estado).toBe('resolved');
    expect(afterState.resolved_at).toEqual(resolvedState.resolved_at);
    expect(await auditResults(handoffId)).toEqual(['advanced', 'invalid_transition']);
  });

  test('serializes concurrent transitions instead of interleaving them', async () => {
    const { handoffId, clickupTaskId } = await seedNotifiedHandoff();

    // Two ClickUp events for the same task can land at once: an operator moves
    // the task to a resolved column while an automation acknowledges it. Both
    // read 'notified'. Without row-level locking both classify as valid and the
    // later writer wins, leaving the handoff 'acknowledged' with resolved_at
    // already set — a state no legal transition can produce.
    const other = new pg.Client(connection);
    await other.connect();

    try {
      await client.query('BEGIN');
      const first = await client.query(closureSql, [clickupTaskId, 'resolved']);
      expect(first.rows[0].outcome).toBe('advanced');

      await other.query('BEGIN');
      const contender = other.query(closureSql, [clickupTaskId, 'acknowledged']);

      // Give the second transaction time to reach the row before we commit.
      await new Promise((resolve) => { setTimeout(resolve, 300); });
      await client.query('COMMIT');

      const second = await contender;
      await other.query('COMMIT');

      expect(second.rows[0].outcome).toBe('invalid_transition');
    } finally {
      await other.end();
    }

    const state = await handoffState(handoffId);
    expect(state.estado).toBe('resolved');
    expect(state.resolved_at).not.toBeNull();
    // The contradiction this test exists to prevent.
    expect(state.acknowledged_at).toBeNull();
  });

  test('ignores a ClickUp task whose notification never succeeded', async () => {
    const { clickupTaskId } = await seedNotifiedHandoff();
    await client.query(
      "UPDATE external_operations SET status = 'failed' WHERE external_id = $1",
      [clickupTaskId],
    );

    const { rows } = await close(clickupTaskId, 'resolved');

    expect(rows[0].outcome).toBe('unknown_task');
  });
});
