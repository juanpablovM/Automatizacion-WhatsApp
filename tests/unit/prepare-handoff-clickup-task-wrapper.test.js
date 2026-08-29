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
      CLICKUP_HANDOFF_LIST_ID: '999',
      HANDOFF_CLICKUP_ASSIGNEES_JSON: JSON.stringify({ sales: [111, 222] }),
    });

    expect(output.json.should_dispatch_clickup).toBe(true);
    expect(output.json.clickup_config_error).toBeNull();
    expect(output.json.clickup_payload.assignees).toEqual([111, 222]);
    expect(output.json.clickup_payload.priority).toBe(2);
    expect(output.json.clickup_url).toContain('/list/999/task');
  });

  test('blocks dispatch and reports every missing config error at once', () => {
    const source = fs.readFileSync(fixturePath, 'utf8');
    const output = runPerItemCodeNode(source, {
      area: 'finance',
      handoff_id: 8,
      operation_key: 'handoff:8',
    }, {});

    expect(output.json.should_dispatch_clickup).toBe(false);
    expect(output.json.clickup_payload).toBeNull();
    expect(output.json.clickup_config_error).toContain('CLICKUP_API_TOKEN_missing');
    expect(output.json.clickup_config_error).toContain('CLICKUP_HANDOFF_LIST_ID_missing');
    expect(output.json.clickup_config_error).toContain('HANDOFF_CLICKUP_ASSIGNEES_JSON_missing');
  });
});

// Which areas can be delivered is a configuration question, not a name hard
// coded in the dispatcher. An area earns delivery by having at least one real
// ClickUp assignee; everything else defers, exactly as before.
describe('Prepare Handoff ClickUp Task — configuration decides the deliverable areas', () => {
  const source = () => fs.readFileSync(fixturePath, 'utf8');
  const baseEnv = {
    CLICKUP_API_TOKEN: 'token-123',
    CLICKUP_HANDOFF_LIST_ID: '999',
  };
  const handoff = (area) => ({
    area,
    area_label: area ? area.toUpperCase() : '',
    handoff_id: 15,
    operation_key: `handoff-clickup:15`,
    motivo: 'b2b',
    phone_number: '56900000003',
    conversation_id: 150,
    prioridad: 'alta',
  });

  test('a non-sales area with a configured assignee is dispatchable', () => {
    const output = runPerItemCodeNode(source(), handoff('b2b'), {
      ...baseEnv,
      HANDOFF_CLICKUP_ASSIGNEES_JSON: JSON.stringify({ sales: [111], b2b: [333] }),
    });

    expect(output.json.should_dispatch_clickup).toBe(true);
    expect(output.json.clickup_config_error).toBeNull();
    expect(output.json.clickup_payload.assignees).toEqual([333]);
    expect(output.json.clickup_payload.name).toContain('HANDOFF #15');
    expect(output.json.clickup_url).toContain('/list/999/task');
  });

  test('an area declared with no assignee still defers: declaring is not configuring', () => {
    const output = runPerItemCodeNode(source(), handoff('b2b'), {
      ...baseEnv,
      HANDOFF_CLICKUP_ASSIGNEES_JSON: JSON.stringify({ sales: [111], b2b: [] }),
    });

    expect(output.json.should_dispatch_clickup).toBe(false);
    expect(output.json.clickup_payload).toBeNull();
    expect(output.json.clickup_config_error).toContain('HANDOFF_CLICKUP_ASSIGNEES_JSON_missing_area:b2b');
  });

  test('an area absent from the mapping defers', () => {
    const output = runPerItemCodeNode(source(), handoff('support'), {
      ...baseEnv,
      HANDOFF_CLICKUP_ASSIGNEES_JSON: JSON.stringify({ sales: [111] }),
    });

    expect(output.json.should_dispatch_clickup).toBe(false);
    expect(output.json.clickup_config_error).toContain('HANDOFF_CLICKUP_ASSIGNEES_JSON_missing_area:support');
  });

  test('a handoff with no area at all is never dispatched', () => {
    const output = runPerItemCodeNode(source(), handoff(''), {
      ...baseEnv,
      HANDOFF_CLICKUP_ASSIGNEES_JSON: JSON.stringify({ sales: [111], b2b: [333] }),
    });

    expect(output.json.should_dispatch_clickup).toBe(false);
    expect(output.json.clickup_config_error).toContain('HANDOFF_CLICKUP_AREA_unsupported:missing');
  });

  test('sales keeps working exactly as before', () => {
    const output = runPerItemCodeNode(source(), handoff('sales'), {
      ...baseEnv,
      HANDOFF_CLICKUP_ASSIGNEES_JSON: JSON.stringify({ sales: [111], b2b: [333] }),
    });

    expect(output.json.should_dispatch_clickup).toBe(true);
    expect(output.json.clickup_payload.assignees).toEqual([111]);
  });
});
