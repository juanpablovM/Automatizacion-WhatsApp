import { createRequire } from 'node:module';
import { describe, expect, test } from 'vitest';

const require = createRequire(import.meta.url);
const {
  compileV3TurnPolicy,
  validateV3AiProposal,
} = require('../fixtures/workflow-nodes/shared/v3-contract-runtime.js');
const {
  buildV3RepairRequest,
} = require('../fixtures/workflow-nodes/shared/v3-saga-runtime.js');

const policyFor = (message = 'Hola') => compileV3TurnPolicy({
  turn: {
    id: 'turn-compatibility',
    conversation_id: 'conversation-compatibility',
    conversation_revision: 1,
    message: { id: 'message-compatibility', text: message },
  },
  history: { messages: [] },
  facts: [],
  goals: [],
  allowed_mutations: [],
  grounding: {},
  claim_rules: [],
  effect_permissions: [],
  effect_requirements: [],
});

describe('v3 runtime contract compatibility', () => {
  test('the saga accepts the validation object emitted by the canonical runtime', () => {
    const policy = policyFor();
    const validation = validateV3AiProposal(policy, null);

    expect(validation.version).toBe('conversation_validation_result/v3');
    expect(validation.valid).toBe(false);
    expect(validation.errors.length).toBeGreaterThan(0);

    const repair = buildV3RepairRequest({ policy, validation });

    expect(repair.schema).toBe('ai_conversation_repair_request/v3');
    expect(repair.policy_digest).toBe(policy.policy_digest);
    expect(repair.errors).toEqual(validation.errors);
  });
});
