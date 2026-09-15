import fs from 'node:fs';
import { describe, expect, test } from 'vitest';

const fixturePath = 'tests/fixtures/workflow-nodes/ops-lead-chat-lease-scheduler/dispatch-lead-chat-reacquisition.js';
const source = fs.readFileSync(fixturePath, 'utf8');

const runPerItemAsyncCodeNode = (json, env = {}, helpers = {}) =>
  new Function('$json', '$env', 'helpers', source)(json, env, helpers);

const TOKEN = 'clickup-token-abc';
const TASK_URL = 'https://api.clickup.com/api/v2/task/task-42';

const claimedRow = (overrides = {}) => ({
  operation_id: 91,
  operation_claim_token: 'c321d74b-42cd-491c-a0c0-e36a43fecc4c',
  ownership_id: 42,
  clickup_task_id: 'task-42',
  target_status: 'in progress',
  ownership_active: true,
  should_dispatch_reacquisition: true,
  reacquisition_blocker: null,
  clickup_task_url: TASK_URL,
  ...overrides,
});

const taskAt = (status) => ({ id: 'task-42', status: { status } });

const clickupStub = (...responses) => {
  const calls = [];
  const httpRequest = async (options) => {
    calls.push(options);
    const planned = responses[calls.length - 1];
    if (planned === undefined) throw new Error(`unplanned ClickUp call #${calls.length}`);
    if (planned instanceof Error) throw planned;
    return planned;
  };
  return { calls, helpers: { httpRequest } };
};

const dispatch = (row, env, stub) =>
  runPerItemAsyncCodeNode(row, env, stub.helpers).then((output) => output.json);

describe('Dispatch Lead Chat Reacquisition — late human reply projection', () => {
  test('writes the acquisition status after a GET proves ClickUp is elsewhere', async () => {
    const stub = clickupStub(
      { statusCode: 200, body: taskAt('to do') },
      { statusCode: 200, body: taskAt('in progress') },
    );

    const output = await dispatch(claimedRow(), { CLICKUP_API_TOKEN: TOKEN }, stub);

    expect(stub.calls.map((call) => call.method)).toEqual(['GET', 'PUT']);
    expect(stub.calls[1].body).toEqual({ status: 'in progress' });
    expect(output.reacquisition_result).toBe('succeeded');
    expect(output.observed_clickup_status).toBe('in progress');
  });

  test('does not write when ClickUp already has the target status', async () => {
    const stub = clickupStub({ statusCode: 200, body: taskAt('In Progress') });

    const output = await dispatch(claimedRow(), { CLICKUP_API_TOKEN: TOKEN }, stub);

    expect(stub.calls).toHaveLength(1);
    expect(stub.calls[0].method).toBe('GET');
    expect(output.reacquisition_result).toBe('succeeded');
  });

  test('never calls ClickUp after PostgreSQL says ownership is no longer active', async () => {
    const stub = clickupStub();

    const output = await dispatch(claimedRow({
      ownership_active: false,
      should_dispatch_reacquisition: false,
      reacquisition_blocker: 'ownership_not_active',
    }), { CLICKUP_API_TOKEN: TOKEN }, stub);

    expect(stub.calls).toHaveLength(0);
    expect(output.reacquisition_result).toBe('skipped_ownership_changed');
  });

  test('returns a retry for a rate-limited PUT', async () => {
    const stub = clickupStub(
      { statusCode: 200, body: taskAt('to do') },
      { statusCode: 429, body: { err: 'rate limited' } },
    );

    const output = await dispatch(claimedRow(), { CLICKUP_API_TOKEN: TOKEN }, stub);

    expect(output.reacquisition_result).toBe('retry');
    expect(output.reacquisition_error).toBe('clickup_reacquire_write_retryable_http_429');
  });

  test('reconciles an ambiguous PUT with one GET and no second write', async () => {
    const stub = clickupStub(
      { statusCode: 200, body: taskAt('to do') },
      { statusCode: 500, body: {} },
      { statusCode: 200, body: taskAt('in progress') },
    );

    const output = await dispatch(claimedRow(), { CLICKUP_API_TOKEN: TOKEN }, stub);

    expect(stub.calls.map((call) => call.method)).toEqual(['GET', 'PUT', 'GET']);
    expect(stub.calls.filter((call) => call.method === 'PUT')).toHaveLength(1);
    expect(output.reacquisition_result).toBe('succeeded');
  });

  test('keeps an unconfirmed ambiguous PUT visible as unknown', async () => {
    const stub = clickupStub(
      { statusCode: 200, body: taskAt('to do') },
      { statusCode: 500, body: {} },
      { statusCode: 200, body: taskAt('to do') },
    );

    const output = await dispatch(claimedRow(), { CLICKUP_API_TOKEN: TOKEN }, stub);

    expect(output.reacquisition_result).toBe('unknown');
    expect(output.reacquisition_error).toContain('unconfirmed');
  });

  test('fails visibly without making HTTP calls when the token is missing', async () => {
    const stub = clickupStub();

    const output = await dispatch(claimedRow(), {}, stub);

    expect(stub.calls).toHaveLength(0);
    expect(output.reacquisition_result).toBe('failed');
    expect(output.reacquisition_error).toBe('CLICKUP_API_TOKEN_missing');
  });
});
