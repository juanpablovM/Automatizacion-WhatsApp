import fs from 'node:fs';
import { describe, expect, test } from 'vitest';

const fixturePath = 'tests/fixtures/workflow-nodes/ops-handoff-notification-scheduler/prepare-handoff-clickup-task.js';

// This node runs in n8n's "run once for each item" mode: it reads `$json`
// directly (not `items[0].json`) and returns a single `{ json }` object, not
// an array — a different n8n Code node contract than the other fixtures.
const runPerItemCodeNode = (source, json, env = {}) =>
  new Function('$json', '$env', source)(json, env);

describe('Prepare Handoff ClickUp Task — real n8n Code node wrapper ($json contract)', () => {
  test('builds a dispatchable ClickUp payload when config and area are valid', () => {
    const source = fs.readFileSync(fixturePath, 'utf8');
    const output = runPerItemCodeNode(source, {
      area: 'sales',
      area_label: 'Ventas',
      handoff_id: 7,
      operation_key: 'handoff:7',
      motivo: 'frustration',
      phone_number: '56900000003',
      conversation_id: 100,
      prioridad: 'alta',
    }, {
      CLICKUP_API_TOKEN: 'token-123',
      CLICKUP_LIST_ID: '999',
      HANDOFF_CLICKUP_ASSIGNEES_JSON: JSON.stringify({ sales: [111, 222] }),
    });

    expect(output.json.should_dispatch_clickup).toBe(true);
    expect(output.json.clickup_config_error).toBeNull();
    expect(output.json.clickup_payload.assignees).toEqual([111, 222]);
    expect(output.json.clickup_payload.priority).toBe(2);
    expect(output.json.clickup_url).toContain('/list/999/task');
  });

  test('blocks dispatch and reports every missing config error for an unsupported area', () => {
    const source = fs.readFileSync(fixturePath, 'utf8');
    const output = runPerItemCodeNode(source, {
      area: 'finance',
      handoff_id: 8,
      operation_key: 'handoff:8',
    }, {});

    expect(output.json.should_dispatch_clickup).toBe(false);
    expect(output.json.clickup_payload).toBeNull();
    expect(output.json.clickup_config_error).toContain('CLICKUP_API_TOKEN_missing');
    expect(output.json.clickup_config_error).toContain('HANDOFF_CLICKUP_AREA_unsupported:finance');
  });
});
