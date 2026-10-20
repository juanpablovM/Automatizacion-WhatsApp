import fs from 'node:fs';
import { createRequire } from 'node:module';
import { describe, expect, test } from 'vitest';

const require = createRequire(import.meta.url);
const {
  compileV3TurnPolicy,
  validateV3AiProposal,
  GROUNDED_CONCEPTS,
} = require('../fixtures/workflow-nodes/shared/v3-contract-runtime.js');

// -----------------------------------------------------------------------------
// Slice 3c (task 3c.4). Slices 2a and 2b independently derived their own idea
// of "which goal ids and which (operation, field) mutations v3.1 allows" —
// the policy builder, the validator and the response schema disagreed (that
// disagreement is exactly what rollout step 3's live A/B caught: the model's
// semantically correct output used literals the validator did not recognize,
// and the schema never even offered the validator's own literal). This file
// compiles ONE v3.1 policy, derives what the response schema (Build AI
// Request) permits, and PROBES the real validator with matching proposals —
// so the three can never drift silently again.
// -----------------------------------------------------------------------------

const buildAiRequestFixturePath = 'tests/fixtures/workflow-nodes/ai-lead-qualification-assistant/build-ai-request.js';
const runCodeNode = (source, items, env = {}) => new Function('items', '$env', source)(items, env);
const baseEnv = { AI_DIRECT_API_KEY: 'fake-key-123', AI_DIRECT_API_MODEL: 'test-model' };

const responseSchemaFor = (turnPolicy) => {
  const source = fs.readFileSync(buildAiRequestFixturePath, 'utf8');
  return runCodeNode(source, [{ json: { contract_version: 'v3', turn_policy: turnPolicy } }], baseEnv)[0].json.response_schema;
};

const MESSAGE_TEXT = 'value';
const GROUNDING_REF = 'product:x';

const compiledPolicy = () => compileV3TurnPolicy({
  version: 'v3.1',
  turn: {
    id: 'turn-consistency',
    conversation_id: 'conversation-consistency',
    conversation_revision: 1,
    message: { id: 'message-consistency', text: MESSAGE_TEXT },
  },
  history: { messages: [] },
  facts: [],
  goals: [
    { goal_id: 'commune', status: 'unresolved', importance: 'optional', blocks_effects: [] },
    { goal_id: 'line_items', status: 'unresolved', importance: 'required_for_effect', blocks_effects: ['create_lead'] },
  ],
  allowed_mutations: [
    { operation: 'set', concept: 'product', field: 'product' },
    { operation: 'replace', concept: 'product', field: 'product' },
    { operation: 'set', concept: 'quantity', field: 'quantity' },
    { operation: 'replace', concept: 'quantity', field: 'quantity' },
    { operation: 'set', concept: 'measurements', field: 'measurements' },
    { operation: 'replace', concept: 'measurements', field: 'measurements' },
    { operation: 'remove_item', concept: 'line_items', field: null },
    { operation: 'set', concept: 'commune', field: 'commune' },
  ],
  grounding: { catalog: [{ ref: GROUNDING_REF, concept: 'product', value: 'X' }] },
  claim_rules: [],
  effect_permissions: [],
  effect_requirements: [],
});

describe('v3.1 primary_request.goal_id — schema enum vs. validator acceptance (3c.4)', () => {
  const policy = compiledPolicy();
  const schema = responseSchemaFor(policy);
  const schemaGoalIds = new Set(schema.properties.primary_request.properties.goal_id.enum);

  const probeGoalId = (goalId) => {
    const proposal = {
      version: 'ai_conversation_proposal/v3.1',
      policy_digest: policy.policy_digest,
      reply_text: 'x',
      primary_request: { goal_id: goalId, item_ref: null },
      catalog_resolutions: [],
      observations: [],
      state_mutations: [],
      effect_requests: [],
    };
    const validation = validateV3AiProposal(policy, proposal);
    return !validation.errors.some((error) => error.code === 'primary_request_invalid');
  };

  // The candidate set is the union of everything the schema exposes plus
  // every literal the contract could plausibly use: the three item concepts
  // (design.md's literal for catalog_resolution_clarification_required and
  // item_target_required's repair instruction), the real policy goals,
  // final_confirmation, and one literal that must never be accepted by
  // either side.
  const candidates = [...new Set([
    ...schemaGoalIds,
    'commune', 'line_items', 'product', 'quantity', 'measurements',
    'final_confirmation', 'not_a_real_goal',
  ])];

  test.each(candidates)('goal_id %s: schema enum and validator acceptance agree', (goalId) => {
    expect(probeGoalId(goalId)).toBe(schemaGoalIds.has(goalId));
  });

  test('the three item concepts are actually offered by the schema (not just accidentally accepted)', () => {
    expect(schemaGoalIds.has('product')).toBe(true);
    expect(schemaGoalIds.has('quantity')).toBe(true);
    expect(schemaGoalIds.has('measurements')).toBe(true);
  });
});

describe('v3.1 state_mutations (operation, field) — schema variants vs. validator acceptance (3c.4)', () => {
  const policy = compiledPolicy();
  const schema = responseSchemaFor(policy);
  const mutationVariants = schema.properties.state_mutations.items.anyOf || [];

  const schemaFieldsFor = (operation) => new Set(
    mutationVariants
      .filter((variant) => variant.properties?.operation?.enum?.[0] === operation)
      .map((variant) => variant.properties?.field?.enum?.[0])
      .filter((field) => field !== undefined),
  );
  const schemaSetFields = schemaFieldsFor('set');

  const BLOCKING_CODES = new Set([
    'mutation_mapping_forbidden', 'mutation_shape_invalid',
    'observation_shape_invalid', 'grounding_invalid', 'evidence_quote_not_found',
  ]);

  // item_ref: null lets the mutation resolve to the flat primary item without
  // needing a catalog_resolutions identity entry — isolating exactly the
  // (operation, field) authorization question this test cares about.
  const probeSetMutation = (field) => {
    const grounded = GROUNDED_CONCEPTS.has(field);
    const observation = {
      id: 'probe-obs',
      concept: field,
      raw_value: MESSAGE_TEXT,
      normalized_value: grounded ? 'X' : MESSAGE_TEXT,
      evidence_quote: MESSAGE_TEXT,
      evidence_occurrence: 1,
      grounding_ref: grounded ? GROUNDING_REF : null,
      resolves_goal_ids: [],
      item_ref: null,
    };
    const mutation = { operation: 'set', field, item_ref: null, observation_id: 'probe-obs', replaces_fact_id: null };
    const proposal = {
      version: 'ai_conversation_proposal/v3.1',
      policy_digest: policy.policy_digest,
      reply_text: 'x',
      primary_request: null,
      catalog_resolutions: [],
      observations: [observation],
      state_mutations: [mutation],
      effect_requests: [],
    };
    const validation = validateV3AiProposal(policy, proposal);
    return !validation.errors.some((error) => BLOCKING_CODES.has(error.code));
  };

  // product/quantity/measurements are authorized item fields; commune is an
  // authorized quote-level field; name/service are valid observation
  // concepts but never authorized to mutate in this policy — a negative
  // control proving the probe actually distinguishes allowed from forbidden.
  const candidateFields = ['product', 'quantity', 'measurements', 'commune', 'name', 'service'];

  test.each(candidateFields)('set %s: schema variant and validator acceptance agree', (field) => {
    expect(probeSetMutation(field)).toBe(schemaSetFields.has(field));
  });

  test('the three item fields are actually offered by the schema as set variants', () => {
    expect(schemaSetFields.has('product')).toBe(true);
    expect(schemaSetFields.has('quantity')).toBe(true);
    expect(schemaSetFields.has('measurements')).toBe(true);
  });
});
