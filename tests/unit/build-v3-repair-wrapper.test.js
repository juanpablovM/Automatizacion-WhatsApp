import fs from 'node:fs';
import { createRequire } from 'node:module';
import { describe, expect, test } from 'vitest';

const require = createRequire(import.meta.url);
const fixturePath = 'tests/fixtures/workflow-nodes/wa-conversation-orchestrator/build-v3-repair.js';
const runCodeNode = (source, items) => new Function('items', 'require', source)(items, require);

describe('Build V3 Repair — real n8n Code node wrapper', () => {
  test('repairs from turn_policy alone and preserves both policy aliases', () => {
    const source = fs.readFileSync(fixturePath, 'utf8');
    const turnPolicy = {
      version: 'ai_prd_turn_policy/v3',
      policy_digest: 'a'.repeat(64),
      turn: { id: 'turn-repair-wrapper' },
    };
    const validation = {
      version: 'conversation_validation_result/v3',
      valid: false,
      errors: [{ code: 'proposal_shape_invalid', path: '$' }],
    };

    const output = runCodeNode(source, [{
      json: {
        turn_policy: turnPolicy,
        v3_validation: validation,
        v3_repair_attempt: 0,
      },
    }]);

    expect(output).toHaveLength(1);
    expect(output[0].json.v3_recovery.action).toBe('repair');
    expect(output[0].json.ai_repair_request.policy).toEqual(turnPolicy);
    expect(output[0].json.turn_policy).toEqual(turnPolicy);
    expect(output[0].json.v3_policy).toEqual(turnPolicy);
    expect(output[0].json.v3_repair_attempt).toBe(1);
  });
});
