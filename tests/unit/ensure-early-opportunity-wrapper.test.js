import fs from 'node:fs';
import { describe, expect, test } from 'vitest';

const fixturePath = 'tests/fixtures/workflow-nodes/wa-inbound-downstream-dispatcher/ensure-early-opportunity.js';

const runCodeNode = (source, items, env = {}) => new Function('items', '$env', source)(items, env);

// This fixture has no exported functions at all — it is entirely a top-level
// n8n Code node body. It had zero test coverage before this file.
describe('Ensure Early Opportunity — real n8n Code node wrapper', () => {
  test('writes a new opportunity for a plain conversational turn', () => {
    const source = fs.readFileSync(fixturePath, 'utf8');
    const output = runCodeNode(source, [
      {
        json: {
          conversation_id: 55,
          phone_number: '56900000002',
          intent: 'provide_info',
          service: 'Baldosas',
        },
      },
    ]);

    expect(output).toHaveLength(1);
    expect(output[0].json.opportunity_write).toBe(true);
    expect(output[0].json.opportunity_status).toBe('new');
    expect(output[0].json.opportunity_scope.conversation_id).toBe(55);
  });

  test('skips the write for operational intents (complaint, warranty, etc.)', () => {
    const source = fs.readFileSync(fixturePath, 'utf8');
    const output = runCodeNode(source, [
      {
        json: {
          conversation_id: 55,
          phone_number: '56900000002',
          intent: 'complaint',
        },
      },
    ]);

    expect(output).toHaveLength(1);
    expect(output[0].json.opportunity_write).toBe(false);
    expect(output[0].json.opportunity_skipped).toBe(true);
  });

  test('marks the opportunity qualified once the lead is confirmed with no commercial gate pending', () => {
    const source = fs.readFileSync(fixturePath, 'utf8');
    const output = runCodeNode(source, [
      {
        json: {
          conversation_id: 55,
          phone_number: '56900000002',
          intent: 'provide_info',
          should_create_lead: true,
          confirmation_status: 'confirmed',
          commercial_missing_fields: [],
        },
      },
    ]);

    expect(output[0].json.opportunity_status).toBe('qualified');
  });
});
