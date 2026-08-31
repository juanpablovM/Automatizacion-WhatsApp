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

// `Merge AI Assistance` combines with `addSuffix`, so by the time an item
// reaches this node every field from the policy side carries a `_1` suffix and
// every field from the AI side a `_2` one. Measured on the real canary the
// input holds 64 `_1` keys, 91 `_2` keys and 36 bare ones. Emitting that soup
// back into the repair cycle re-suffixes it (`contract_version_1_1`), and
// `Use V3 Contract?` — which reads `contract_version_1` — then routes the turn
// to legacy on the second pass. The node must emit the canonical, unsuffixed
// shape instead, so cycle two reproduces cycle one exactly.
describe('Build V3 Repair — canonical item across the merge', () => {
  const mergedInput = (overrides = {}) => ({
    // policy side, suffixed `_1` by the merge
    contract_version_1: 'v3',
    conversation_id_1: 'conv-77',
    qualification_context_1: { name: 'Ana' },
    expected_snapshot_digest_1: 'c'.repeat(64),
    v3_policy_1: {
      version: 'ai_prd_turn_policy/v3',
      policy_digest: 'd'.repeat(64),
      turn: { id: 'turn-merged' },
    },
    // AI side, suffixed `_2` by the merge
    contract_version_2: 'legacy',
    conversation_id_2: 'stale-conv',
    // bare fields contributed after the merge
    v3_validation: {
      version: 'conversation_validation_result/v3',
      valid: false,
      errors: [{ code: 'proposal_shape_invalid', path: '$' }],
    },
    ...overrides,
  });

  test('emits unsuffixed fields so the second cycle keeps routing to v3', () => {
    const source = fs.readFileSync(fixturePath, 'utf8');
    const output = runCodeNode(source, [{ json: mergedInput() }])[0].json;

    // The policy side becomes canonical: this is what `Use V3 Contract?` needs
    // to find as `contract_version_1` after the merge suffixes it once again.
    expect(output.contract_version).toBe('v3');
    expect(output.conversation_id).toBe('conv-77');
    expect(output.qualification_context).toEqual({ name: 'Ana' });

    // The AI side is dropped rather than carried forward and re-suffixed.
    expect(Object.keys(output).filter((key) => /_[12]$/.test(key))).toEqual([]);
    expect(output.v3_recovery.action).toBe('repair');
  });

  test('reads the repair attempt through the suffix so the loop terminates', () => {
    // Cycle two feeds `v3_repair_attempt` back through the merge as `_1`. If the
    // node misses it the attempt reads 0 and the turn repairs forever instead of
    // falling through to contingency.
    const source = fs.readFileSync(fixturePath, 'utf8');
    const output = runCodeNode(source, [{
      json: mergedInput({ v3_repair_attempt_1: 1 }),
    }])[0].json;

    expect(output.v3_recovery.action).toBe('contingency');
    expect(output.v3_recovery.decision.version).toBe('system_contingency_decision/v3');
  });

  test('prefers the policy side over a stale bare field of the same name', () => {
    const source = fs.readFileSync(fixturePath, 'utf8');
    const output = runCodeNode(source, [{
      json: mergedInput({ conversation_id: 'stale-bare' }),
    }])[0].json;

    expect(output.conversation_id).toBe('conv-77');
  });
});

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
