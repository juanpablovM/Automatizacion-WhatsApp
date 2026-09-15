import fs from 'node:fs';
import { createRequire } from 'node:module';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';

const enabled = process.env.TEST_PG_INTEGRATION === '1';
const describeIntegration = enabled ? describe : describe.skip;
const require = createRequire(import.meta.url);
const { resolveCancellationAction } = require(
  '../fixtures/workflow-nodes/wa-inbound-downstream-dispatcher/ensure-follow-up-cancellation.js',
);

const connection = {
  host: process.env.TEST_PGHOST || '127.0.0.1',
  port: Number(process.env.TEST_PGPORT || 55433),
  database: process.env.TEST_PGDATABASE || 'testdb',
  user: process.env.TEST_PGUSER || 'test',
  password: process.env.TEST_PGPASSWORD || 'test',
};

describeIntegration('follow-up policy replay in PostgreSQL', () => {
  const clients = [new pg.Client(connection), new pg.Client(connection)];
  const policySql = fs.readFileSync(
    'db/queries/n8n/follow-up-pipeline/05_cancel_pending_follow_ups.sql',
    'utf8',
  );
  let conversationId;
  let sourceNumberId;
  let inboundEventId;

  beforeAll(async () => {
    await Promise.all(clients.map((client) => client.connect()));

    const source = await clients[0].query(`
      INSERT INTO whatsapp_numbers (display_name, phone_number, phone_number_id)
      VALUES ('Integration Test', 'test-contact-followup', 'test-source-followup')
      RETURNING id
    `);
    sourceNumberId = source.rows[0].id;

    const status = await clients[0].query(
      "SELECT id FROM conversation_statuses WHERE code = 'waiting_user'",
    );
    const conversation = await clients[0].query(`
      INSERT INTO conversations (
        source_number_id, phone_number, conversation_status_id, current_step
      ) VALUES ($1, 'test-contact-followup', $2, 'city')
      RETURNING id
    `, [sourceNumberId, status.rows[0].id]);
    conversationId = conversation.rows[0].id;

    const inbound = await clients[0].query(`
      INSERT INTO inbound_events (
        instance_name, event_fingerprint, dedupe_key, source_number_id,
        phone_number, processing_status, created_at
      ) VALUES (
        'integration-test', 'fingerprint-followup', 'dedupe-followup', $1,
        'test-contact-followup', 'processed', '2026-08-20T10:30:00.000Z'
      ) RETURNING id
    `, [sourceNumberId]);
    inboundEventId = inbound.rows[0].id;

    await clients[0].query(`
      INSERT INTO follow_ups (
        idempotency_key, cycle_key, conversation_id, phone_number,
        source_number_id, motivo, step_dia, scheduled_at
      ) VALUES (
        'legacy-pending', 'legacy-cycle', $1, 'test-contact-followup',
        $2, 'lead_sin_respuesta', 1, '2026-08-20T09:00:00.000Z'
      )
    `, [conversationId, sourceNumberId]);
  });

  afterAll(async () => {
    await Promise.all(clients.map((client) => client.end()));
  });

  test('concurrent replay produces one cancellation, schedule and audit', async () => {
    const policy = resolveCancellationAction({
      target_conversation_id: conversationId,
      inbound_event_id: inboundEventId,
      text_body: 'Synthetic inbound reply',
      response_text: 'How many units do you need?',
      conversation_status_code: 'waiting_user',
      follow_up_first_delay_hours: 24,
    });
    const cycleKey = policy.follow_up_cycle_key;
    const policyKey = policy.follow_up_idempotency_key;
    const values = [
      policy.follow_up_target_conversation_id,
      policy.follow_up_cancel_action,
      policy.follow_up_cancel_reason,
      policy.follow_up_source_text,
      policy.follow_up_source_message_id,
      policy.follow_up_should_schedule,
      'test-contact-followup',
      sourceNumberId,
      cycleKey,
      policy.follow_up_motivo,
      policy.follow_up_scheduled_at,
      policyKey,
      inboundEventId,
      policy.follow_up_first_delay_hours,
      policy.follow_up_window_start,
      policy.follow_up_window_end,
    ];

    const [first, second] = await Promise.all(
      clients.map((client) => client.query(policySql, values)),
    );
    const outcomes = [first.rows[0], second.rows[0]];

    expect(outcomes.reduce((sum, row) => sum + Number(row.cancelled_count), 0)).toBe(1);
    expect(outcomes.reduce((sum, row) => sum + Number(row.scheduled_count), 0)).toBe(1);
    expect(outcomes.filter((row) => row.replayed).length).toBe(1);

    const persisted = await clients[0].query(`
      SELECT
        (SELECT COUNT(*)::int FROM audit_logs
          WHERE event_name = 'follow_up_inbound_policy'
            AND after_payload->>'idempotency_key' = $1) AS audit_count,
        (SELECT COUNT(*)::int FROM follow_ups
          WHERE conversation_id = $2 AND cycle_key = $3) AS scheduled_count,
        (SELECT estado FROM follow_ups
          WHERE conversation_id = $2 AND cycle_key = 'legacy-cycle') AS old_state,
        (SELECT scheduled_at FROM follow_ups
          WHERE conversation_id = $2 AND cycle_key = $3) AS scheduled_at
    `, [policyKey, conversationId, cycleKey]);

    expect(persisted.rows[0]).toMatchObject({
      audit_count: 1,
      scheduled_count: 1,
      old_state: 'cancelled',
    });
    expect(persisted.rows[0].scheduled_at.toISOString()).toBe('2026-08-21T10:30:00.000Z');
  });
  const applyPolicy = async (text, createdAt, extra = {}) => {
    const identity = `${text}:${createdAt}:${JSON.stringify(extra)}`;
    const inbound = await clients[0].query(`
      INSERT INTO inbound_events (
        instance_name, event_fingerprint, dedupe_key, source_number_id,
        phone_number, processing_status, created_at
      ) VALUES ('integration-test', $1, $1, $2, 'test-contact-followup', 'processed', $3)
      RETURNING id
    `, [identity, sourceNumberId, createdAt]);
    const policy = resolveCancellationAction({
      conversation_id: conversationId, inbound_event_id: inbound.rows[0].id,
      pending_question_key: 'previous_context_choice', current_step: 'previous_context',
      text_body: text, response_text: 'We can resume tomorrow.',
      conversation_status_code: 'waiting_user', ...extra,
    });
    const result = await clients[0].query(policySql, [
      policy.follow_up_target_conversation_id, policy.follow_up_cancel_action,
      policy.follow_up_cancel_reason, policy.follow_up_source_text,
      policy.follow_up_source_message_id, policy.follow_up_should_schedule,
      'test-contact-followup', sourceNumberId, policy.follow_up_cycle_key,
      policy.follow_up_motivo, policy.follow_up_scheduled_at, policy.follow_up_idempotency_key,
      inbound.rows[0].id, policy.follow_up_first_delay_hours,
      policy.follow_up_window_start, policy.follow_up_window_end,
    ]);
    return { policy, result: result.rows[0] };
  };

  test.each([
    { label: 'inside-window', inbound: '2026-09-13T14:00:00Z', expected: '2026-09-14T14:00:00.000Z' },
    { label: 'evening-outside-window', inbound: '2026-09-13T00:30:00Z', expected: '2026-09-13T12:00:00.000Z' },
    { label: 'end-exclusive', inbound: '2026-09-13T23:00:00Z', expected: '2026-09-14T12:00:00.000Z' },
    { label: 'DST-preserves-local-clock', inbound: '2026-09-05T15:00:00Z', expected: '2026-09-06T14:00:00.000Z' },
    { label: 'custom-window', inbound: '2026-09-14T00:30:00Z', expected: '2026-09-14T13:00:00.000Z', extra: { follow_up_window_start: '10:00', follow_up_window_end: '18:00' } },
  ])('tomorrow uses Chile calendar and configured window: $label', async ({ inbound, expected, extra = {} }) => {
    const { policy, result } = await applyPolicy('Háblame mañana', inbound, extra);
    expect(Number(result.scheduled_count)).toBe(1);
    const scheduled = await clients[0].query('SELECT scheduled_at FROM follow_ups WHERE conversation_id=$1 AND cycle_key=$2', [conversationId, policy.follow_up_cycle_key]);
    expect(scheduled.rows[0].scheduled_at.toISOString()).toBe(expected);
  });

  test('courtesy preserves an already scheduled requested reminder', async () => {
    const first = await applyPolicy('Mañana', '2026-09-15T14:00:00Z');
    const before = await clients[0].query('SELECT id, scheduled_at, estado FROM follow_ups WHERE conversation_id=$1 AND cycle_key=$2', [conversationId, first.policy.follow_up_cycle_key]);
    const courtesy = await applyPolicy('Gracias', '2026-09-15T14:01:00Z');
    expect(Number(courtesy.result.cancelled_count)).toBe(0);
    expect(Number(courtesy.result.scheduled_count)).toBe(0);
    const after = await clients[0].query('SELECT id, scheduled_at, estado FROM follow_ups WHERE id=$1', [before.rows[0].id]);
    expect(after.rows[0]).toEqual(before.rows[0]);
  });

  test('opt-out wins over tomorrow and prevents new reminders', async () => {
    const { result } = await applyPolicy('No me escribas más, háblame mañana', '2026-09-16T14:00:00Z');
    expect(result.opted_out_persisted).toBe(true);
    expect(Number(result.scheduled_count)).toBe(0);
  });

});
