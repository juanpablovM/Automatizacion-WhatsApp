import fs from 'node:fs';
import { describe, expect, test } from 'vitest';

const fixturePath = 'tests/fixtures/workflow-nodes/ops-followup-scheduler/normalize-follow-up-delivery.js';

// This wrapper reads n8n's `$('Prepare Follow-Up Message')` node-reference
// global to correlate origin items by index — an n8n runtime primitive that
// cannot be reproduced by importing the exported function directly.
const runCodeNode = (source, items, env = {}, dollar = () => ({ all: () => [] })) =>
  new Function('items', '$env', '$', source)(items, env, dollar);

describe('Normalize Follow-Up Delivery — real n8n Code node wrapper', () => {
  test('correlates each outbound result with its origin item by position', () => {
    const source = fs.readFileSync(fixturePath, 'utf8');
    const dollar = (nodeName) => {
      expect(nodeName).toBe('Prepare Follow-Up Message');
      return { all: () => [{ json: { id: 1, lead_name: 'Juan' } }, { json: { id: 2, lead_name: 'Ana' } }] };
    };

    const output = runCodeNode(
      source,
      [
        { json: { delivery_status: 'sent', message_id: 'wamid-1' } },
        { json: { delivery_status: 'failed', error: { message: 'insufficient permissions' } } },
      ],
      {},
      dollar,
    );

    expect(output).toHaveLength(2);
    expect(output[0].json.id).toBe(1);
    expect(output[0].json.follow_up_outcome).toBe('sent');
    expect(output[0].json.follow_up_error).toBeNull();
    expect(output[1].json.id).toBe(2);
    expect(output[1].json.follow_up_outcome).toBe('failed');
    expect(output[1].json.follow_up_error).toBe('insufficient permissions');
  });

  test('falls back to an empty origin when the node reference is unavailable, without throwing', () => {
    const source = fs.readFileSync(fixturePath, 'utf8');
    const dollar = () => {
      throw new Error('node reference not available in this execution context');
    };

    const output = runCodeNode(source, [{ json: { delivery_status: 'sent' } }], {}, dollar);

    expect(output).toHaveLength(1);
    expect(output[0].json.follow_up_outcome).toBe('sent');
  });
});
