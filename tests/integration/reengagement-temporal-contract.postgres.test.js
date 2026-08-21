import fs from 'node:fs';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';

const enabled = process.env.TEST_PG_INTEGRATION === '1';
const describeIntegration = enabled ? describe : describe.skip;
const connection = {
  host: process.env.TEST_PGHOST || '127.0.0.1',
  port: Number(process.env.TEST_PGPORT || 5433),
  database: process.env.TEST_PGDATABASE || 'testdb',
  user: process.env.TEST_PGUSER || 'test',
  password: process.env.TEST_PGPASSWORD || 'test',
};

describeIntegration('re-engagement temporal contract in PostgreSQL', () => {
  const client = new pg.Client(connection);
  const loadStateSql = fs.readFileSync(
    'db/queries/n8n/wa-conversation-orchestrator/01_load_active_context.sql',
    'utf8',
  );
  let sourceNumberId;
  let previousInboundId;
  let currentInboundId;

  beforeAll(async () => {
    await client.connect();
    const source = await client.query(`
      INSERT INTO whatsapp_numbers (display_name, phone_number, phone_number_id)
      VALUES ('Temporal Test', 'test-contact-temporal', 'test-source-temporal')
      RETURNING id
    `);
    sourceNumberId = source.rows[0].id;

    const status = await client.query(
      "SELECT id FROM conversation_statuses WHERE code = 'waiting_user'",
    );
    await client.query(`
      INSERT INTO conversations (
        source_number_id, phone_number, conversation_status_id, current_step
      ) VALUES ($1, 'test-contact-temporal', $2, 'city')
    `, [sourceNumberId, status.rows[0].id]);

    const previous = await client.query(`
      INSERT INTO inbound_events (
        instance_name, event_fingerprint, dedupe_key, source_number_id,
        phone_number, processing_status, created_at
      ) VALUES (
        'integration-test', 'fingerprint-temporal-previous', 'dedupe-temporal-previous',
        $1, 'test-contact-temporal', 'processed', NOW() - INTERVAL '1 hour'
      ) RETURNING id
    `, [sourceNumberId]);
    previousInboundId = previous.rows[0].id;

    const current = await client.query(`
      INSERT INTO inbound_events (
        instance_name, event_fingerprint, dedupe_key, source_number_id,
        phone_number, processing_status, processing_token, created_at
      ) VALUES (
        'integration-test', 'fingerprint-temporal-current', 'dedupe-temporal-current',
        $1, 'test-contact-temporal', 'processing', 'temporal-claim', NOW()
      ) RETURNING id
    `, [sourceNumberId]);
    currentInboundId = current.rows[0].id;
  });

  afterAll(async () => {
    await client.end();
  });

  const loadAtAge = async (interval) => {
    await client.query(
      `UPDATE inbound_events SET created_at = NOW() - $1::interval WHERE id = $2`,
      [interval, previousInboundId],
    );
    const values = [
      'test-contact-temporal', sourceNumberId, 'Temporal Test', null,
      'message-temporal-current', null, 'text', 'Hola', '{}',
      null, null, null, null, null, null, null,
      'integration-test', currentInboundId, 'temporal-claim',
    ];
    const result = await client.query(loadStateSql, values);
    expect(result.rows).toHaveLength(1);
    return result.rows[0];
  };

  test('continues before the 48-hour boundary', async () => {
    const row = await loadAtAge('47 hours 59 minutes');
    expect(row.has_existing_conversation).toBe(true);
    expect(row.has_active_conversation).toBe(true);
    expect(row.is_recent_conversation).toBe(true);
    expect(row.is_reengagement).toBe(false);
  });

  test('enters re-engagement after 48 hours and through 30 days', async () => {
    const after48h = await loadAtAge('48 hours 1 minute');
    expect(after48h.has_active_conversation).toBe(false);
    expect(after48h.is_stale_context).toBe(true);
    expect(after48h.is_reengagement).toBe(true);

    const before30d = await loadAtAge('29 days 23 hours 59 minutes');
    expect(before30d.is_reengagement).toBe(true);
  });

  test('starts a new request after 30 days', async () => {
    const row = await loadAtAge('30 days 1 minute');
    expect(row.has_existing_conversation).toBe(true);
    expect(row.is_stale_context).toBe(true);
    expect(row.is_reengagement).toBe(false);
  });
});
