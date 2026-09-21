import fs from 'node:fs';
import { describe, expect, test } from 'vitest';

const fixturePath = 'tests/fixtures/workflow-nodes/ops-lead-chat-lease-scheduler/dispatch-lead-chat-restoration.js';
const source = fs.readFileSync(fixturePath, 'utf8');

// $json per-item mode, async: the node reads $env and calls helpers.httpRequest,
// both n8n runtime globals, exactly as the handoff dispatcher does.
const runPerItemAsyncCodeNode = (json, env = {}, helpers = {}) =>
  new Function('$json', '$env', 'helpers', source)(json, env, helpers);

const TOKEN = 'clickup-token-abc';
const TASK_URL = 'https://api.clickup.com/api/v2/task/lco-task-042';

// One row as 06_claim_expired_ownerships.sql returns it, after the prepare node
// has normalized it. The lease is ALREADY released at this point.
const claimedRow = (overrides = {}) => ({
  ownership_id: 42,
  lead_id: 7,
  clickup_task_id: 'lco-task-042',
  // Deliberately mixed case: ClickUp status names are user-editable labels and
  // the captured evidence is the only record of how this one was spelled.
  previous_clickup_status: 'To Do',
  restoration_state: 'processing',
  restoration_claim_token: 'token-live',
  operation_key: 'clickup-status-restore:ownership:42:2026-09-09T10:00:00.000000Z',
  should_dispatch_restoration: true,
  should_complete: true,
  clickup_task_url: TASK_URL,
  completion_ownership_id: 42,
  restoration_config_error: null,
  restoration_result: null,
  restoration_error: null,
  observed_clickup_status: null,
  ...overrides,
});

const taskAt = (status) => ({ id: 'lco-task-042', status: { status } });

// Answers the calls in order and records every one of them, so a test can
// assert what was sent as well as what came back. An unplanned call is a
// failure, which is how "no HTTP call at all" is proven rather than assumed.
const clickupStub = (...responses) => {
  const calls = [];
  const httpRequest = async (options) => {
    calls.push({
      method: options.method,
      url: options.url,
      body: options.body,
      headers: options.headers,
    });
    const planned = responses[calls.length - 1];
    if (planned === undefined) {
      throw new Error(`unplanned ClickUp call #${calls.length}: ${options.method} ${options.url}`);
    }
    if (planned instanceof Error) throw planned;
    return planned;
  };
  return { calls, helpers: { httpRequest } };
};

const dispatch = (row, env, stub) =>
  runPerItemAsyncCodeNode(row, env, stub.helpers).then((output) => output.json);

const withToken = { CLICKUP_API_TOKEN: TOKEN };

describe('Dispatch Lead Chat Restoration — ClickUp projection of an expired lease', () => {
  test('restores a task still in the acquisition status with the exact captured previous status', async () => {
    const stub = clickupStub(
      { statusCode: 200, body: taskAt('in progress') },
      { statusCode: 200, body: taskAt('To Do') },
    );

    const output = await dispatch(claimedRow(), withToken, stub);

    expect(stub.calls).toHaveLength(2);
    expect(stub.calls[0].method).toBe('GET');
    expect(stub.calls[0].url).toBe(TASK_URL);
    expect(stub.calls[0].headers.Authorization).toBe(TOKEN);
    expect(stub.calls[1].method).toBe('PUT');
    expect(stub.calls[1].url).toBe(TASK_URL);
    // Verbatim casing: normalizing it would invent a status ClickUp may not have.
    expect(stub.calls[1].body).toEqual({ status: 'To Do' });

    expect(output.restoration_outcome).toBe('succeeded');
    expect(output.restoration_result).toBe('succeeded');
    expect(output.should_complete).toBe(true);
    expect(output.completion_ownership_id).toBe(42);
  });

  test('honours CLICKUP_STATUS_ACKNOWLEDGED when deciding what the acquisition status is', async () => {
    const stub = clickupStub(
      { statusCode: 200, body: taskAt('atendiendo') },
      { statusCode: 200, body: taskAt('To Do') },
    );

    const output = await dispatch(claimedRow(), {
      ...withToken,
      CLICKUP_STATUS_ACKNOWLEDGED: 'atendiendo, en gestion',
    }, stub);

    expect(stub.calls[1].method).toBe('PUT');
    expect(output.restoration_outcome).toBe('succeeded');
  });

  test('reports succeeded and issues no write when the task already sits at the previous status', async () => {
    const stub = clickupStub({ statusCode: 200, body: taskAt('to do') });

    const output = await dispatch(claimedRow(), withToken, stub);

    // A reconciled task needs no write, and a write here would be pure risk.
    expect(stub.calls).toHaveLength(1);
    expect(stub.calls[0].method).toBe('GET');
    expect(output.restoration_outcome).toBe('succeeded');
    expect(output.restoration_result).toBe('succeeded');
    expect(output.observed_clickup_status).toBe('to do');
  });

  test('reports skipped_status_changed and never overwrites a status a human moved', async () => {
    const stub = clickupStub({ statusCode: 200, body: taskAt('complete') });

    const output = await dispatch(claimedRow(), withToken, stub);

    expect(stub.calls).toHaveLength(1);
    expect(stub.calls.filter((call) => call.method === 'PUT')).toHaveLength(0);
    expect(output.restoration_outcome).toBe('skipped_status_changed');
    expect(output.restoration_result).toBe('skipped_status_changed');
    expect(output.observed_clickup_status).toBe('complete');
    expect(output.restoration_error).toBe('clickup_status_changed:complete');
  });

  test('defers without any HTTP call when CLICKUP_API_TOKEN is missing', async () => {
    const stub = clickupStub();

    const output = await dispatch(claimedRow(), {}, stub);

    expect(stub.calls).toHaveLength(0);
    expect(output.restoration_outcome).toBe('deferred');
    expect(output.restoration_error).toBe('CLICKUP_API_TOKEN_missing');
  });

  test('defers without any HTTP call on a __PENDIENTE__ placeholder token', async () => {
    const stub = clickupStub();

    const output = await dispatch(
      claimedRow(), { CLICKUP_API_TOKEN: '__PENDIENTE__CLICKUP_API_TOKEN__' }, stub,
    );

    expect(stub.calls).toHaveLength(0);
    expect(output.restoration_outcome).toBe('deferred');
    expect(output.restoration_error).toBe('CLICKUP_API_TOKEN_missing');
  });

  test('never calls ClickUp for a claim already terminal as skipped_no_previous_status', async () => {
    const stub = clickupStub();

    const output = await dispatch(claimedRow({
      restoration_state: 'skipped_no_previous_status',
      previous_clickup_status: null,
      should_dispatch_restoration: false,
      restoration_config_error: 'skipped_no_previous_status',
    }), withToken, stub);

    expect(stub.calls).toHaveLength(0);
    expect(output.restoration_result).toBeNull();
    // The claim already wrote the visible evidence; closing it here would
    // overwrite it with a guess.
    expect(output.should_complete).toBe(false);
    expect(output.completion_ownership_id).toBeNull();
  });

  test('classifies a 429 on the restore write as a retry-safe failure', async () => {
    const stub = clickupStub(
      { statusCode: 200, body: taskAt('in progress') },
      { statusCode: 429, body: { err: 'rate limited' } },
    );

    const output = await dispatch(claimedRow(), withToken, stub);

    expect(output.restoration_outcome).toBe('failed');
    expect(output.restoration_retry_safe).toBe(true);
    expect(output.restoration_status_code).toBe(429);
    expect(output.restoration_result).toBe('failed');
  });

  test('classifies a 500 on the restore write as unknown and not retry-safe', async () => {
    const stub = clickupStub(
      { statusCode: 200, body: taskAt('in progress') },
      { statusCode: 500, body: {} },
      // The reconciliation read cannot prove the write landed either way.
      { statusCode: 200, body: taskAt('in progress') },
    );

    const output = await dispatch(claimedRow(), withToken, stub);

    expect(output.restoration_outcome).toBe('unknown');
    expect(output.restoration_retry_safe).toBe(false);
    expect(output.restoration_status_code).toBe(500);
    // Nothing proven, so nothing is closed: 06's stale branch re-reads later.
    expect(output.should_complete).toBe(false);
    expect(output.completion_ownership_id).toBeNull();
  });

  test('reconciles an ambiguous write with a follow-up GET instead of a second PUT', async () => {
    const stub = clickupStub(
      { statusCode: 200, body: taskAt('in progress') },
      // A 2xx that proves nothing: the write may or may not have applied.
      { statusCode: 200, body: {} },
      { statusCode: 200, body: taskAt('To Do') },
    );

    const output = await dispatch(claimedRow(), withToken, stub);

    expect(stub.calls.map((call) => call.method)).toEqual(['GET', 'PUT', 'GET']);
    // A blind re-PUT could overwrite a status a human set in between.
    expect(stub.calls.filter((call) => call.method === 'PUT')).toHaveLength(1);
    expect(stub.calls[2].url).toBe(TASK_URL);
    expect(output.restoration_outcome).toBe('succeeded');
    expect(output.observed_clickup_status).toBe('To Do');
  });

  test('a ClickUp outage leaves the already-released lease untouched', async () => {
    const stub = clickupStub(new Error('ECONNREFUSED api.clickup.com'));

    const output = await dispatch(claimedRow(), withToken, stub);

    expect(output.restoration_outcome).toBe('unknown');
    expect(output.restoration_error).toContain('ECONNREFUSED');

    // The AI was freed by the claim transaction. This node projects onto
    // ClickUp only, so it must emit nothing that could re-suppress the bot:
    // no lease field, and no completion that could reopen the ownership.
    for (const leaseField of [
      'released_at', 'release_reason', 'response_due_at', 'pending_message_id',
      'pending_message_at', 'bot_suppressed', 'suppressed',
    ]) {
      expect(Object.prototype.hasOwnProperty.call(output, leaseField)).toBe(false);
    }
    expect(output.should_complete).toBe(false);
    expect(output.completion_ownership_id).toBeNull();
    expect(output.restoration_result).toBeNull();
    // The token it was issued is carried through untouched, never invalidated
    // by a failed projection.
    expect(output.restoration_claim_token).toBe('token-live');
  });
});
