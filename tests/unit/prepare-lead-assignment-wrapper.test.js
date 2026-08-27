import fs from 'node:fs';
import { describe, expect, test } from 'vitest';

const fixturePath = 'tests/fixtures/workflow-nodes/crm-lead-creation-and-assignment/prepare-lead-assignment.js';

const runCodeNode = (source, items, env = {}) => new Function('items', '$env', source)(items, env);

// This fixture has no `if (typeof items !== 'undefined')` guard and no
// module.exports at all — importing/requiring it directly throws
// `ReferenceError: items is not defined`, which is exactly why it had zero
// test coverage before this file: it can only be exercised as a raw n8n
// Code node body.
describe('Prepare Lead Assignment — real n8n Code node wrapper', () => {
  test('builds a qualified lead when service/city/requirement are all present and no commercial field is missing', () => {
    const source = fs.readFileSync(fixturePath, 'utf8');
    const output = runCodeNode(source, [
      {
        json: {
          conversation_id: 100,
          phone_number: '56900000004',
          service: 'Baldosas',
          city: 'Santiago',
          requirement: 'Patio',
          commercial_missing_fields: [],
        },
      },
    ]);

    expect(output).toHaveLength(1);
    expect(output[0].json.is_qualified).toBe(true);
    expect(output[0].json.lead_status_code).toBe('qualified_complete');
    expect(output[0].json.rotation_key).toBe('whatsapp:default');
  });

  test('throws a BLOCKED payload instead of creating a lead when commercial fields are missing', () => {
    const source = fs.readFileSync(fixturePath, 'utf8');

    expect(() => runCodeNode(source, [
      {
        json: {
          conversation_id: 100,
          phone_number: '56900000004',
          service: 'Baldosas',
          city: 'Santiago',
          requirement: 'Patio',
          commercial_missing_fields: ['product'],
        },
      },
    ])).toThrow(/^BLOCKED\|/);
  });
});
