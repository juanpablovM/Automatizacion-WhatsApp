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
      catalog_resolution: { status: 'matched', grounding_ref: 'product:cierros' },
    };
    const rejectedProposal = { primary_request: { goal_id: 'service_scope' } };

    const output = runCodeNode(source, [{
      json: {
        turn_policy: turnPolicy,
        v3_validation: validation,
        v3_repair_attempt: 0,
        ai_proposal: rejectedProposal,
      },
    }]);

    expect(output).toHaveLength(1);
    expect(output[0].json.v3_recovery.action).toBe('repair');
    expect(output[0].json.ai_repair_request.policy).toEqual(turnPolicy);
    expect(output[0].json.ai_repair_request.rejected_proposal).toEqual(rejectedProposal);
    expect(output[0].json.ai_repair_request.catalog_resolution).toEqual(validation.catalog_resolution);
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

// `Normalize AI Result` already separates a provider that never answered from a
// model that answered badly, and `planV3Recovery` already has an `outage` branch
// for the first case. Nothing ever wrote `v3_provider_outcome`, so that branch
// was unreachable: every outage arrived as `repair_exhausted`, and the turn first
// spent a repair call on a provider that had just refused two.
describe('Build V3 Repair — a provider that never answered', () => {
  const source = () => fs.readFileSync(fixturePath, 'utf8');
  const policy = {
    version: 'ai_prd_turn_policy/v3',
    policy_digest: 'e'.repeat(64),
    turn: { id: 'turn-outage' },
  };
  const validation = {
    version: 'conversation_validation_result/v3',
    valid: false,
    errors: [{ code: 'proposal_version_invalid', path: 'version' }],
  };
  const turn = (overrides = {}) => ({
    v3_policy: policy,
    v3_validation: validation,
    v3_repair_attempt: 0,
    ai_proposal: null,
    ...overrides,
  });
  const handoffOf = (output) => output.v3_recovery.decision.effect_commands
    .find((effect) => effect.type === 'internal_handoff');

  test('goes to contingency on the first provider error, spending no repair call', () => {
    const output = runCodeNode(source(), [{
      json: turn({ ai_fallback_reason: 'provider_error', ai_status_code: 503, ai_retry_exhausted: true }),
    }])[0].json;

    expect(output.v3_recovery.action).toBe('contingency');
    expect(output.ai_repair_request).toBeNull();
  });

  test('files the outage under its own reason instead of an exhausted repair', () => {
    const output = runCodeNode(source(), [{
      json: turn({ ai_fallback_reason: 'provider_error' }),
    }])[0].json;

    expect(handoffOf(output).payload.recovery_reason).toBe('provider_outage');
    expect(output.v3_provider_outcome).toBe('outage');
  });

  test('treats a rate limit the same way, because a refused request is no answer', () => {
    const output = runCodeNode(source(), [{
      json: turn({ ai_fallback_reason: 'rate_limited', ai_status_code: 429 }),
    }])[0].json;

    expect(output.v3_recovery.action).toBe('contingency');
    expect(handoffOf(output).payload.recovery_reason).toBe('provider_outage');
  });

  test('still repairs when the provider answered and the model was the problem', () => {
    for (const reason of ['invalid_json', 'intent_mismatch', 'low_confidence']) {
      const output = runCodeNode(source(), [{ json: turn({ ai_fallback_reason: reason }) }])[0].json;

      expect(output.v3_recovery.action).toBe('repair');
      expect(output.v3_provider_outcome).toBe('accepted');
    }
  });

  test('does not let a request we failed to build hide behind the provider', () => {
    const output = runCodeNode(source(), [{
      json: turn({ ai_fallback_reason: 'missing_ai_request' }),
    }])[0].json;

    expect(output.v3_recovery.action).toBe('repair');
  });

  test('reads the provider signal through the merge suffix', () => {
    const output = runCodeNode(source(), [{
      json: { v3_policy_1: policy, v3_validation: validation, ai_fallback_reason_2: 'provider_error' },
    }])[0].json;

    expect(handoffOf(output).payload.recovery_reason).toBe('provider_outage');
  });

  test('an exhausted repair with a healthy provider keeps its own reason', () => {
    const output = runCodeNode(source(), [{
      json: turn({ v3_repair_attempt: 1, ai_fallback_reason: 'invalid_json' }),
    }])[0].json;

    expect(output.v3_recovery.action).toBe('contingency');
    expect(handoffOf(output).payload.recovery_reason).toBe('repair_exhausted');
  });
});

// n8n prunes executions after about two days, so once a turn falls back to the
// system contingency the only durable trace of why is what the database keeps.
// The node therefore emits a small diagnostic next to the decision: machine
// codes and scalars only, never the rejected proposal or the customer's words.
describe('Build V3 Repair — durable contingency diagnostic', () => {
  const source = () => fs.readFileSync(fixturePath, 'utf8');
  const policy = {
    version: 'ai_prd_turn_policy/v3',
    policy_digest: 'f'.repeat(64),
    turn: { id: 'turn-diagnostic' },
  };
  const validationWith = (errors) => ({
    version: 'conversation_validation_result/v3',
    valid: false,
    errors,
  });
  const run = (json) => runCodeNode(source(), [{ json }])[0].json;

  test('keeps the distinct validation codes of an exhausted repair', () => {
    const output = run({
      v3_policy: policy,
      v3_repair_attempt: 1,
      ai_fallback_reason: 'invalid_json',
      ai_status_code: 200,
      v3_validation: validationWith([
        { code: 'policy_digest_mismatch', path: 'policy_digest' },
        { code: 'reply_claim_ungrounded', path: 'reply.text' },
        { code: 'policy_digest_mismatch', path: 'policy_digest' },
      ]),
    });

    expect(output.v3_recovery.action).toBe('contingency');
    expect(output.v3_contingency_diagnostic).toEqual({
      validation_error_codes: ['policy_digest_mismatch', 'reply_claim_ungrounded'],
      ai_fallback_reason: 'invalid_json',
      ai_status_code: 200,
      repair_attempt: 1,
    });
  });

  test('records the provider signal of an outage without validation noise', () => {
    // A provider that never answered leaves only the validation of an absent
    // proposal behind; those codes describe the gap, not the cause.
    const output = run({
      v3_policy: policy,
      v3_repair_attempt: 0,
      ai_fallback_reason: 'provider_error',
      ai_status_code: 503,
      v3_validation: validationWith([{ code: 'proposal_version_invalid', path: 'version' }]),
    });

    expect(output.v3_contingency_diagnostic).toEqual({
      validation_error_codes: [],
      ai_fallback_reason: 'provider_error',
      ai_status_code: 503,
      repair_attempt: 0,
    });
  });

  test('reads the provider signal through the merge suffix', () => {
    const output = run({
      v3_policy_1: policy,
      v3_repair_attempt_1: 1,
      ai_fallback_reason_2: 'rate_limited',
      ai_status_code_2: 429,
      v3_validation: validationWith([{ code: 'proposal_shape_invalid', path: '$' }]),
    });

    expect(output.v3_contingency_diagnostic).toMatchObject({
      ai_fallback_reason: 'rate_limited',
      ai_status_code: 429,
    });
  });

  test('emits no diagnostic while the turn can still be repaired', () => {
    const output = run({
      v3_policy: policy,
      v3_repair_attempt: 0,
      v3_validation: validationWith([{ code: 'proposal_shape_invalid', path: '$' }]),
    });

    expect(output.v3_recovery.action).toBe('repair');
    expect(output.v3_contingency_diagnostic).toBeNull();
  });

  test('never carries customer text, the raw proposal or free-form errors', () => {
    const customerText = 'Hola, soy Ana, mi dirección es Av. Siempre Viva 742';
    const manyCodes = Array.from({ length: 30 }, (_, index) => ({ code: `code_${index}`, path: '$' }));
    const output = run({
      v3_policy: policy,
      v3_repair_attempt: 1,
      message_text: customerText,
      ai_proposal: { reply: { text: customerText } },
      ai_raw_response: `{"reply":"${customerText}"}`,
      ai_fallback_reason: `provider said: ${customerText}`,
      ai_status_code: 'five hundred',
      v3_validation: validationWith([
        { code: customerText, path: 'reply.text', message: customerText },
        { code: 'reply_claim_ungrounded', path: 'reply.text', message: customerText },
        { code: { nested: customerText }, path: '$' },
        { code: 'x'.repeat(65), path: '$' },
        ...manyCodes,
      ]),
    });
    const diagnostic = output.v3_contingency_diagnostic;
    const serialized = JSON.stringify(diagnostic);

    expect(Object.keys(diagnostic).sort()).toEqual([
      'ai_fallback_reason', 'ai_status_code', 'repair_attempt', 'validation_error_codes',
    ]);
    expect(serialized).not.toContain('Ana');
    expect(serialized).not.toContain('Siempre Viva');
    expect(serialized).not.toContain('reply.text');
    expect(diagnostic.validation_error_codes[0]).toBe('reply_claim_ungrounded');
    expect(diagnostic.validation_error_codes).toHaveLength(20);
    expect(diagnostic.ai_fallback_reason).toBeNull();
    expect(diagnostic.ai_status_code).toBeNull();
  });
});

describe('Prepare V3 Contingency Decision — diagnostic binding', () => {
  test('passes the node diagnostic to the query as its fifth parameter', () => {
    const workflow = JSON.parse(fs.readFileSync('n8n/workflows/wa-conversation-orchestrator.json', 'utf8'));
    const node = workflow.nodes.find((entry) => entry.name === 'Prepare V3 Contingency Decision');
    const sql = fs.readFileSync('db/queries/n8n/wa-conversation-orchestrator/15_prepare_v3_contingency.sql', 'utf8');

    expect(node.parameters.additionalFields.queryParams)
      .toBe('inbound_event_id,processing_token,v3_policy,v3_recovery_decision,v3_contingency_diagnostic');
    expect(sql).toContain('$5::JSONB');
    // The prepare node reads the item `Build V3 Repair` emits, unmerged.
    expect(workflow.connections['V3 Recovery Is Contingency?'].main[0]
      .some((edge) => edge.node === 'Prepare V3 Contingency Decision')).toBe(true);
    expect(workflow.connections['Build V3 Repair'].main[0]
      .some((edge) => edge.node === 'V3 Recovery Is Contingency?')).toBe(true);
  });
});
