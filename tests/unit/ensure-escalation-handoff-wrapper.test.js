import fs from 'node:fs';
import { describe, expect, test } from 'vitest';

const fixturePath = 'tests/fixtures/workflow-nodes/wa-inbound-downstream-dispatcher/ensure-escalation-handoff.js';

const runCodeNode = (source, items, env = {}) => new Function('items', '$env', source)(items, env);

describe('Ensure Escalation Handoff — real n8n Code node wrapper', () => {
  test('the embedded wrapper (not the exported functions) returns a handoff scope for a real escalation', () => {
    const source = fs.readFileSync(fixturePath, 'utf8');
    const output = runCodeNode(source, [
      {
        json: {
          conversation_id: 100,
          phone_number: '56900000001',
          should_escalate: true,
          escalation_reason: 'frustration_detected',
          intent: 'complaint',
          text_body: 'Esto es un desastre, quiero hablar con una persona',
        },
      },
    ]);

    expect(output).toHaveLength(1);
    expect(output[0].json.handoff_write).toBe(true);
    expect(output[0].json.handoff_scope.conversation_id).toBe(100);
    expect(output[0].json.handoff_scope.motivo).toBe('complaint');
  });

  test('the embedded wrapper skips the handoff write when nothing escalates', () => {
    const source = fs.readFileSync(fixturePath, 'utf8');
    const output = runCodeNode(source, [
      {
        json: {
          conversation_id: 100,
          phone_number: '56900000001',
          should_escalate: false,
          escalation_area: 'none',
        },
      },
    ]);

    expect(output).toHaveLength(1);
    expect(output[0].json.handoff_write).toBe(false);
    expect(output[0].json.handoff_scope.motivo).toBeNull();
  });
});
