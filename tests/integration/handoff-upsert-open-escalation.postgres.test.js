import fs from 'node:fs';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';

// Task 3c.25: after a handoff the conversation is escalation_required, and the
// next customer message gets the deterministic "Tu solicitud ya está derivada"
// reply with escalation_reason=escalation_already_required (conversation 391,
// 2026-09-30: handoffs 530 and 531). That reminder refers to the escalation
// that is already open, so it reuses that handoff instead of opening a second
// one. Every other motive keeps its own handoff, as before.
const enabled = process.env.TEST_PG_INTEGRATION === '1';
const describeIntegration = enabled ? describe : describe.skip;
const connection = {
  host: process.env.TEST_PGHOST || '127.0.0.1',
  port: Number(process.env.TEST_PGPORT || 55433),
  database: process.env.TEST_PGDATABASE || 'testdb',
  user: process.env.TEST_PGUSER || 'test',
  password: process.env.TEST_PGPASSWORD || 'test',
};
const upsertSql = fs.readFileSync('db/queries/n8n/handoff-routing/01_upsert_handoff.sql', 'utf8');

describeIntegration('legacy handoff upsert: one open escalation per conversation', () => {
  const client = new pg.Client(connection);
  let sourceNumberId;
  let escalationStatusId;
  let sequence = 0;

  const seedConversation = async () => {
    sequence += 1;
    const { rows } = await client.query(`
      INSERT INTO conversations (source_number_id, phone_number, conversation_status_id, current_step)
      VALUES ($1, $2, $3, 'escalation') RETURNING id, phone_number
    `, [sourceNumberId, `1555866${String(sequence).padStart(4, '0')}`, escalationStatusId]);
    return rows[0];
  };
  const seedHandoff = async (conversation, { key, estado = 'notified', createdAt = null } = {}) => {
    const { rows } = await client.query(`
      INSERT INTO handoffs (
        idempotency_key, conversation_id, phone_number, source_number_id, motivo, area, area_label,
        prioridad, responsable, estado, trigger, created_at
      ) VALUES ($1, $2, $3, $4, 'v3_authorized_handoff', 'sales', 'Ventas', 'alta', 'Equipo Ventas',
        $5, 'v3_effect', COALESCE($6::timestamptz, NOW()))
      RETURNING id
    `, [key, conversation.id, conversation.phone_number, sourceNumberId, estado, createdAt]);
    return rows[0].id;
  };
  const upsert = (conversation, { motivo = 'sales', trigger = 'escalation_already_required' } = {}) => client.query(upsertSql, [
    true, conversation.id, conversation.phone_number, String(sourceNumberId), '',
    motivo, 'sales', 'Ventas', 'alta', 'Ejecutiva comercial',
    `${conversation.id}:${motivo}:${trigger}`, trigger, trigger, 'sales', '',
  ]);
  const openCount = async (conversation) => (await client.query(
    'SELECT COUNT(*)::int AS count FROM handoffs WHERE conversation_id = $1 AND deleted_at IS NULL',
    [conversation.id],
  )).rows[0].count;

  beforeAll(async () => {
    await client.connect();
    // Everything runs inside one transaction that is rolled back at the end.
    await client.query('BEGIN');
    const source = await client.query(`
      INSERT INTO whatsapp_numbers (display_name, phone_number, phone_number_id, instance_name, is_active)
      VALUES ('handoff open reuse', '15550008666', 'pn-handoff-open-reuse', 'handoff-open-reuse', TRUE)
      RETURNING id
    `);
    sourceNumberId = source.rows[0].id;
    escalationStatusId = (await client.query(
      "SELECT id FROM conversation_statuses WHERE code = 'escalation_required'",
    )).rows[0].id;
  });

  afterAll(async () => {
    if (enabled) {
      await client.query('ROLLBACK');
      await client.end();
    }
  });

  test('escalation_already_required reuses the open handoff', async () => {
    const conversation = await seedConversation();
    const openId = await seedHandoff(conversation, { key: `v3-open-${conversation.id}` });
    const first = await upsert(conversation);
    expect(first.rows[0]).toEqual({ handoff_id: openId, handoff_estado: 'notified', outcome: 'reused_open' });
    const again = await upsert(conversation);
    expect(again.rows[0].handoff_id).toBe(openId);
    expect(await openCount(conversation)).toBe(1);
  });

  test('escalation_already_required opens its own handoff when none is open', async () => {
    const conversation = await seedConversation();
    await seedHandoff(conversation, { key: `v3-resolved-${conversation.id}`, estado: 'resolved' });
    const first = await upsert(conversation);
    expect(first.rows[0].outcome).toBe('created');
    expect(await openCount(conversation)).toBe(2);
    const replay = await upsert(conversation);
    expect(replay.rows[0].handoff_id).toBe(first.rows[0].handoff_id);
  });

  test('a different motive keeps its own handoff even while one is open', async () => {
    const conversation = await seedConversation();
    const openId = await seedHandoff(conversation, { key: `v3-open-other-${conversation.id}` });
    const complaint = await upsert(conversation, { motivo: 'complaint', trigger: 'complaint' });
    expect(complaint.rows[0].outcome).toBe('created');
    expect(complaint.rows[0].handoff_id).not.toBe(openId);
    expect(await openCount(conversation)).toBe(2);
  });
});
