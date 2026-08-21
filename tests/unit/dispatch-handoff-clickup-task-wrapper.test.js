import fs from 'node:fs';
import { describe, expect, test } from 'vitest';

const fixturePath = 'tests/fixtures/workflow-nodes/ops-handoff-notification-scheduler/dispatch-handoff-clickup-task.js';

// $json per-item mode, async, reads $env.CLICKUP_API_TOKEN directly and
// calls helpers.httpRequest — both n8n runtime globals.
const runPerItemAsyncCodeNode = (source, json, env = {}, helpers = {}) =>
  new Function('$json', '$env', 'helpers', source)(json, env, helpers);

describe('Dispatch Handoff ClickUp Task — real n8n Code node wrapper ($json contract)', () => {
  test('defers without ever calling the ClickUp API when dispatch was not authorized upstream', async () => {
    const source = fs.readFileSync(fixturePath, 'utf8');
    const httpRequest = () => {
      throw new Error('httpRequest must not be called when should_dispatch_clickup is false');
    };

    const output = await runPerItemAsyncCodeNode(source, {
      should_dispatch_clickup: false,
      clickup_config_error: 'CLICKUP_API_TOKEN_missing',
    }, {}, { httpRequest });

    expect(output.json.notification_outcome).toBe('deferred');
    expect(output.json.notification_error).toBe('CLICKUP_API_TOKEN_missing');
    expect(output.json.notification_retry_safe).toBe(false);
  });

  test('marks the task succeeded when ClickUp responds 200 with a task id', async () => {
    const source = fs.readFileSync(fixturePath, 'utf8');
    const httpRequest = async (options) => {
      expect(options.headers.Authorization).toBe('token-abc');
      return { statusCode: 200, body: { id: '999', url: 'https://app.clickup.com/t/999' } };
    };

    const output = await runPerItemAsyncCodeNode(source, {
      should_dispatch_clickup: true,
      clickup_url: 'https://api.clickup.com/api/v2/list/1/task',
      clickup_payload: { name: 'Handoff #1' },
    }, { CLICKUP_API_TOKEN: 'token-abc' }, { httpRequest });

    expect(output.json.notification_outcome).toBe('succeeded');
    expect(output.json.notification_external_id).toBe('999');
    expect(output.json.notification_status_code).toBe(200);
  });
});
