import fs from 'node:fs';
import { describe, expect, test } from 'vitest';

const fixturePath = 'tests/fixtures/workflow-nodes/ops-lead-chat-lease-scheduler/prepare-lead-chat-restoration.js';
const source = fs.readFileSync(fixturePath, 'utf8');

// $json per-item mode, synchronous: this node never touches the network.
const run = (json) => new Function('$json', source)(json).json;

const claimedRow = (overrides = {}) => ({
  ownership_id: 42,
  lead_id: 7,
  clickup_task_id: 'lco-task-042',
  previous_clickup_status: 'To Do',
  restoration_state: 'processing',
  restoration_claim_token: 'token-live',
  operation_key: 'clickup-status-restore:ownership:42:2026-09-09T10:00:00.000000Z',
  ...overrides,
});

describe('Prepare Lead Chat Restoration — which claims may reach ClickUp', () => {
  test('a claimed restoration is dispatchable and keeps the captured status verbatim', () => {
    const output = run(claimedRow({ previous_clickup_status: '  To Do  ' }));

    expect(output.should_dispatch_restoration).toBe(true);
    expect(output.should_complete).toBe(true);
    expect(output.completion_ownership_id).toBe(42);
    // Surrounding whitespace is noise; casing is evidence.
    expect(output.previous_clickup_status).toBe('To Do');
    expect(output.clickup_task_url).toBe('https://api.clickup.com/api/v2/task/lco-task-042');
    expect(output.restoration_config_error).toBeNull();
  });

  test('a skipped_no_previous_status claim is never dispatched and never completed', () => {
    const output = run(claimedRow({
      restoration_state: 'skipped_no_previous_status',
      previous_clickup_status: null,
    }));

    expect(output.should_dispatch_restoration).toBe(false);
    // 06 already wrote the terminal state and a readable restoration_error.
    // Closing it through 07 would overwrite that evidence with a guess, so the
    // completion node gets a NULL ownership id and writes nothing.
    expect(output.should_complete).toBe(false);
    expect(output.completion_ownership_id).toBeNull();
    expect(output.restoration_config_error).toBe('skipped_no_previous_status');
    expect(output.clickup_task_url).toBeNull();
  });

  test('a claim missing its token or task id is blocked with a named reason', () => {
    expect(run(claimedRow({ restoration_claim_token: '' })).restoration_config_error)
      .toBe('restoration_claim_token_missing');
    expect(run(claimedRow({ clickup_task_id: '' })).restoration_config_error)
      .toBe('clickup_task_id_missing');
    expect(run(claimedRow({ clickup_task_id: '' })).should_dispatch_restoration).toBe(false);
  });

  test('a task id needing escaping is encoded into the ClickUp URL', () => {
    expect(run(claimedRow({ clickup_task_id: 'task/42 b' })).clickup_task_url)
      .toBe('https://api.clickup.com/api/v2/task/task%2F42%20b');
  });
});
