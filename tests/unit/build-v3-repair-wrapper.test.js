import fs from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import { describe, expect, test } from 'vitest';

const require = createRequire(import.meta.url);
const fixturePath = 'tests/fixtures/workflow-nodes/wa-conversation-orchestrator/build-v3-repair.js';
const runCodeNode = (source, items) => new Function('items', 'require', source)(items, require);
const runCodeNodeWithoutStructuredClone = (source, items) => {
  const context = vm.createContext({ items, require });
  expect(vm.runInContext('typeof structuredClone', context)).toBe('undefined');
  return new vm.Script(`(function () { ${source}\n})()`).runInContext(context);
};

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

  test('preserves JSON state without structuredClone and isolates later mutations', () => {
    const source = fs.readFileSync(fixturePath, 'utf8');
    const qualificationContext = {
      nullable: null,
      nested: { values: [{ name: 'original' }] },
    };
    const input = {
      turn_policy: {
        version: 'ai_prd_turn_policy/v3',
        policy_digest: 'b'.repeat(64),
        turn: { id: 'turn-vm-repair' },
      },
      v3_validation: {
        version: 'conversation_validation_result/v3',
        valid: false,
        errors: [{ code: 'proposal_shape_invalid', path: '$' }],
      },
      qualification_context: qualificationContext,
    };

    const output = runCodeNodeWithoutStructuredClone(source, [{ json: input }]);
    qualificationContext.nested.values[0].name = 'mutated-input';
    qualificationContext.nested.values.push({ name: 'new-input-item' });

    expect(output[0].json.v3_recovery.preserved_state).toEqual({
      nullable: null,
      nested: { values: [{ name: 'original' }] },
    });
    output[0].json.v3_recovery.preserved_state.nested.values[0].name = 'mutated-output';
    expect(qualificationContext.nested.values[0].name).toBe('mutated-input');
  });
});
