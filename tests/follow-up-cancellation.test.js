import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { test } from 'vitest';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const fixturePath = path.resolve(
  __dirname,
  'fixtures/workflow-nodes/wa-inbound-downstream-dispatcher/ensure-follow-up-cancellation.js',
);
const sqlPath = path.resolve(
  __dirname,
  '../db/queries/n8n/follow-up-pipeline/05_cancel_pending_follow_ups.sql',
);

const {
  buildIdempotencyKey,
  resolveCancellationAction,
} = require(fixturePath);

const persistedInbound = {
  inbound_event_id: 991,
  message_id: 551,
  inbound_created_at: '2026-08-20T10:30:00.000Z',
};

test('uses the preserved target conversation for cancellation', () => {
  const result = resolveCancellationAction({
    ...persistedInbound,
    conversation_id: 200,
    target_conversation_id: 100,
    text_body: 'No me escribas mas',
  });

  assert.equal(result.follow_up_target_conversation_id, 100);
  assert.equal(result.follow_up_cancel_action, 'opt_out');
  assert.equal(
    result.follow_up_idempotency_key,
    'follow-up-policy:100:event:991',
  );
});

test('derives a replay-stable schedule from the persisted inbound timestamp', () => {
  const input = {
    ...persistedInbound,
    conversation_id: 100,
    conversation_status_code: 'waiting_user',
    response_text: 'How many units do you need?',
    follow_up_first_delay_hours: 24,
  };

  const first = resolveCancellationAction(input);
  const replay = resolveCancellationAction(input);

  assert.equal(first.follow_up_should_schedule, true);
  assert.equal(first.follow_up_scheduled_at, '2026-08-21T10:30:00.000Z');
  assert.deepEqual(replay, first);
});

test('defers timestamp resolution to SQL when the persisted event identity is available', () => {
  const result = resolveCancellationAction({
    inbound_event_id: 991,
    conversation_id: 100,
    conversation_status_code: 'waiting_user',
    response_text: 'How many units do you need?',
  });

  assert.equal(result.follow_up_should_schedule, true);
  assert.equal(result.follow_up_scheduled_at, null);
  assert.equal(result.follow_up_schedule_skipped_reason, null);
});

test('builds one policy identity per target conversation and persisted inbound', () => {
  const identity = { type: 'event', id: 991 };

  assert.equal(
    buildIdempotencyKey(100, identity),
    buildIdempotencyKey(100, identity),
  );
  assert.notEqual(
    buildIdempotencyKey(100, identity),
    buildIdempotencyKey(101, identity),
  );
});

test('the n8n Code-node entrypoint evaluates every item without ambient row state', () => {
  const source = fs.readFileSync(fixturePath, 'utf8');
  const executeCodeNode = new Function('items', '$env', source);
  const output = executeCodeNode([
    {
      json: {
        ...persistedInbound,
        conversation_id: 100,
        conversation_status_code: 'waiting_user',
        response_text: 'How many units do you need?',
      },
    },
  ], { FOLLOW_UP_FIRST_DELAY_HOURS: '24' });

  assert.equal(output.length, 1);
  assert.equal(output[0].json.follow_up_target_conversation_id, 100);
  assert.equal(output[0].json.follow_up_scheduled_at, '2026-08-21T10:30:00.000Z');
});

test('SQL claims the persisted inbound event as the replay gate', () => {
  const sql = fs.readFileSync(sqlPath, 'utf8');

  assert.match(sql, /policy_claim AS MATERIALIZED/);
  assert.match(sql, /follow_up_policy_receipt/);
  assert.match(sql, /NOT EXISTS\(SELECT 1 FROM policy_claim\) THEN 'replayed'/);
  assert.match(sql, /ie\.created_at \+ make_interval\(hours => r\.first_delay_hours\)/);
  assert.doesNotMatch(sql, /NOW\(\) \+ INTERVAL '1 day'/);
});
