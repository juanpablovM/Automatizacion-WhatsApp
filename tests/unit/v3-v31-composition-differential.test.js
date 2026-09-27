import { createRequire } from 'node:module';
import { describe, expect, test } from 'vitest';

const require = createRequire(import.meta.url);
const { compileV3TurnPolicy, validateV3AiProposal } = require('../fixtures/workflow-nodes/shared/v3-contract-runtime.js');
const { buildV3PolicyInput } = require('../fixtures/workflow-nodes/shared/v3-policy-builder.js');
const { toV31Input, toV31Proposal } = require('../support/v3-v31-translate.js');

// -----------------------------------------------------------------------------
// design.md D11 — the v3.1 validator must COMPOSE the v3 validator: every
// quote-level v3 rule runs unchanged under v3.1. This harness takes the exact
// (policy input, proposal) pairs used by the existing v3 suites —
// tests/unit/v3-address-hardbound.test.js, tests/unit/v3-commercial-policy.test.js
// and tests/unit/v3-runtime-compatibility.test.js — with the same message
// text, facts, goals, grounding and observations, mechanically translates
// each pair into its single-item v3.1 equivalent (product/quantity/
// measurements move onto item `li_0`; every other concept stays quote-level,
// unchanged), and asserts that v3 and v3.1 return the exact same
// error-code set, except the two D5 carve-outs (`catalog_resolution_conflict`
// and the state-mutation branch of `catalog_resolution_action_forbidden`),
// which v3.1 intentionally replaces with withholding.
//
// How cases are enumerated: this table currently lists one case per rule
// that Slice 2a's first attempt dropped (see design.md D11's rejected
// alternative) plus a clean baseline. It is not a runtime scan of the v3
// suites — vitest cases are plain data, not introspectable at this level —
// so a brand-new v3 rule is NOT automatically added as a row here. What IS
// automatic is production composition: validateV3AiProposalV31 calls the
// same shared helper functions (addressRequiresStreetDetailsError,
// serviceScopeBothEvidenceError, fulfillmentEvidenceError,
// quantityObservationRequiredError, pickupFactoryAddressRequiredError,
// primaryRequestGoalInapplicableError, addressRetryBoundErrors) that
// validateV3AiProposalV3 calls, so editing one of those functions changes
// both versions identically. Add a row here whenever a new SHARED rule is
// introduced, to keep this regression net proportional to the composition
// surface.
// -----------------------------------------------------------------------------

const ALLOWLISTED_CARVE_OUT_CODES = new Set(['catalog_resolution_conflict', 'catalog_resolution_action_forbidden']);

const runV3 = (buildInput, buildProposal) => {
  const policy = compileV3TurnPolicy(buildInput());
  const proposal = { ...buildProposal(policy), policy_digest: policy.policy_digest };
  return validateV3AiProposal(policy, proposal);
};
const runV31 = (buildInput, buildProposal) => {
  const policy = compileV3TurnPolicy(toV31Input(buildInput()));
  const v3Proposal = buildProposal(compileV3TurnPolicy(buildInput()));
  const proposal = toV31Proposal(policy, v3Proposal);
  return validateV3AiProposal(policy, proposal);
};

const codesOf = (validation) => [...validation.errors.map((error) => error.code)].sort();
const withoutCarveOuts = (codes) => codes.filter((code) => !ALLOWLISTED_CARVE_OUT_CODES.has(code));

const noProductAssertion = () => ({ status: 'not_applicable', evidence_quote: null, evidence_occurrence: null, grounding_ref: null });

const rowFor = (context, overrides = {}) => ({
  inbound_event_id: 991, conversation_id: 22, external_message_id: 'differential-case',
  text_body: 'Rancagua', qualification_context: context, ...overrides,
});

// -----------------------------------------------------------------------------
// Cases (each mirrors an existing v3 test scenario verbatim in shape).
// -----------------------------------------------------------------------------
const CASES = [
  {
    name: 'address retry hard bound (mirrors v3-address-hardbound.test.js)',
    buildInput: () => buildV3PolicyInput(rowFor(
      { product: 'Bloques', commune: 'Rancagua', quantity: '120 unidades', service_scope: 'material', fulfillment: 'delivery', access_restrictions: 'Sin restricciones' },
      { text_body: 'Rancagua', pending_question_key: 'address', previous_commercial_pending_question_key: 'address', previous_commercial_question_retry: 2 },
    )),
    buildProposal: (policy) => ({
      version: 'ai_conversation_proposal/v3', policy_digest: policy.policy_digest,
      reply_text: '¿Cuál es la calle y número aproximado?', primary_request: { goal_id: 'address' },
      catalog_resolution: noProductAssertion(), observations: [], state_mutations: [], effect_requests: [],
    }),
  },
  {
    name: 'pickup factory address required (mirrors v3-commercial-policy.test.js)',
    buildInput: () => buildV3PolicyInput(rowFor(
      { product: 'Bloques', quantity: '120 unidades', service_scope: 'material', fulfillment: 'pickup' },
      { text_body: 'Quiero retirar en fábrica', pending_question_key: null },
    )),
    buildProposal: (policy) => ({
      version: 'ai_conversation_proposal/v3', policy_digest: policy.policy_digest,
      reply_text: 'Confirmá los datos para retirar en fábrica.', primary_request: { goal_id: 'final_confirmation' },
      catalog_resolution: noProductAssertion(), observations: [], state_mutations: [], effect_requests: [],
    }),
  },
  {
    name: 'address requires street details (mirrors v3-commercial-policy.test.js)',
    buildInput: () => buildV3PolicyInput(rowFor(
      { product: 'Bloques', commune: 'Rancagua', quantity: '120 unidades', service_scope: 'material', fulfillment: 'delivery' },
      { text_body: 'Rancagua', pending_question_key: 'address' },
    )),
    buildProposal: (policy) => ({
      version: 'ai_conversation_proposal/v3', policy_digest: policy.policy_digest,
      reply_text: '¿Cuál es la calle y el número aproximado?', primary_request: { goal_id: 'address' },
      catalog_resolution: noProductAssertion(),
      observations: [{
        id: 'obs-address', concept: 'address', raw_value: 'Rancagua', normalized_value: 'Rancagua',
        evidence_quote: 'Rancagua', evidence_occurrence: 1, grounding_ref: null, resolves_goal_ids: ['address'],
      }],
      state_mutations: [{ operation: 'set', field: 'address', observation_id: 'obs-address', replaces_fact_id: null }],
      effect_requests: [],
    }),
  },
  {
    name: 'service_scope_both_evidence_invalid (mirrors v3-runtime-compatibility.test.js)',
    buildInput: () => ({
      turn: { id: 't', conversation_id: 'c', conversation_revision: 1, message: { id: 'm', text: 'Necesito 100 bloques con instalación en Santiago' } },
      history: { messages: [] }, facts: [],
      goals: [{ goal_id: 'service_scope', status: 'unresolved' }],
      allowed_mutations: [{ operation: 'set', concept: 'service_scope', field: 'service_scope' }],
      grounding: { modality_synonyms: [
        { ref: 'service_scope:material', concept: 'service_scope', value: 'material' },
        { ref: 'service_scope:installation', concept: 'service_scope', value: 'installation' },
        { ref: 'service_scope:both', concept: 'service_scope', value: 'both' },
      ] },
      claim_rules: [], effect_permissions: [], effect_requirements: [],
    }),
    buildProposal: (policy) => ({
      version: 'ai_conversation_proposal/v3', policy_digest: policy.policy_digest,
      reply_text: 'Entendido.', primary_request: null, catalog_resolution: noProductAssertion(),
      observations: [{
        id: 'obs:scope', concept: 'service_scope', raw_value: 'instalación', normalized_value: 'both',
        evidence_quote: 'instalación', evidence_occurrence: 1, grounding_ref: 'service_scope:both', resolves_goal_ids: ['service_scope'],
      }],
      state_mutations: [{ operation: 'set', field: 'service_scope', observation_id: 'obs:scope', replaces_fact_id: null }],
      effect_requests: [],
    }),
  },
  {
    name: 'fulfillment_evidence_invalid (mirrors v3-runtime-compatibility.test.js)',
    buildInput: () => ({
      turn: { id: 't', conversation_id: 'c', conversation_revision: 1, message: { id: 'm', text: 'Ok, dale' } },
      history: { messages: [] }, facts: [],
      goals: [{ goal_id: 'fulfillment', status: 'unresolved' }, { goal_id: 'address', status: 'unresolved' }],
      allowed_mutations: [{ operation: 'set', concept: 'fulfillment', field: 'fulfillment' }],
      grounding: { modality_synonyms: [{ ref: 'fulfillment:delivery', concept: 'fulfillment', value: 'delivery' }] },
      claim_rules: [], effect_permissions: [], effect_requirements: [],
    }),
    buildProposal: (policy) => ({
      version: 'ai_conversation_proposal/v3', policy_digest: policy.policy_digest,
      reply_text: 'Perfecto. Indicame la dirección.', primary_request: { goal_id: 'address' }, catalog_resolution: noProductAssertion(),
      observations: [{
        id: 'obs:fulfillment', concept: 'fulfillment', raw_value: 'dale', normalized_value: 'delivery',
        evidence_quote: 'dale', evidence_occurrence: 1, grounding_ref: 'fulfillment:delivery', resolves_goal_ids: ['fulfillment'],
      }],
      state_mutations: [{ operation: 'set', field: 'fulfillment', observation_id: 'obs:fulfillment', replaces_fact_id: null }],
      effect_requests: [],
    }),
  },
  {
    name: 'quantity_observation_required (mirrors v3-runtime-compatibility.test.js)',
    buildInput: () => ({
      turn: { id: 't', conversation_id: 'c', conversation_revision: 1, message: { id: 'm', text: 'Santiago, 30 mtl de cierro' } },
      history: { messages: [] }, facts: [],
      goals: [{ goal_id: 'quantity', status: 'unresolved' }],
      allowed_mutations: [],
      grounding: { catalog: [{ ref: 'product:cierros-hormigon', concept: 'product', value: 'Cierros de Hormigón' }] },
      claim_rules: [], effect_permissions: [], effect_requirements: [],
    }),
    buildProposal: (policy) => ({
      version: 'ai_conversation_proposal/v3', policy_digest: policy.policy_digest,
      reply_text: 'Anoté los 30 metros lineales de cierro.', primary_request: null,
      catalog_resolution: { status: 'matched', evidence_quote: 'cierro', evidence_occurrence: 1, grounding_ref: 'product:cierros-hormigon' },
      observations: [], state_mutations: [], effect_requests: [],
    }),
  },
  {
    name: 'primary_request_goal_inapplicable (mirrors v3-runtime-compatibility.test.js)',
    buildInput: () => ({
      turn: { id: 't', conversation_id: 'c', conversation_revision: 1, message: { id: 'm', text: 'Necesito instalación' } },
      history: { messages: [] },
      facts: [{
        fact_id: 'fact:service_scope', field: 'service_scope', value: 'installation',
        mutability: 'customer_correctable', source: { message_id: 'previous', evidence_digest: 'a'.repeat(64) },
      }],
      goals: [{ goal_id: 'service_scope', status: 'resolved' }, { goal_id: 'fulfillment', status: 'unresolved' }],
      allowed_mutations: [], grounding: {}, claim_rules: [], effect_permissions: [], effect_requirements: [],
    }),
    buildProposal: (policy) => ({
      version: 'ai_conversation_proposal/v3', policy_digest: policy.policy_digest,
      reply_text: '¿Preferís retiro o despacho?', primary_request: { goal_id: 'fulfillment' }, catalog_resolution: noProductAssertion(),
      observations: [], state_mutations: [], effect_requests: [],
    }),
  },
  {
    name: 'clean baseline — no errors on either side',
    buildInput: () => ({
      turn: { id: 't', conversation_id: 'c', conversation_revision: 1, message: { id: 'm', text: 'Hola' } },
      history: { messages: [] }, facts: [], goals: [], allowed_mutations: [], grounding: {},
      claim_rules: [], effect_permissions: [], effect_requirements: [],
    }),
    buildProposal: (policy) => ({
      version: 'ai_conversation_proposal/v3', policy_digest: policy.policy_digest,
      reply_text: 'Hola, ¿en qué te puedo ayudar?', primary_request: null, catalog_resolution: noProductAssertion(),
      observations: [], state_mutations: [], effect_requests: [],
    }),
  },
];

describe('v3 -> v3.1 composition differential guarantee (design.md D11, 2a.28)', () => {
  test.each(CASES.map((testCase) => [testCase.name, testCase]))('%s', (_name, testCase) => {
    const v3Codes = codesOf(runV3(testCase.buildInput, testCase.buildProposal));
    const v31Codes = withoutCarveOuts(codesOf(runV31(testCase.buildInput, testCase.buildProposal)));
    expect(v31Codes).toEqual(withoutCarveOuts(v3Codes));
  });
});

describe('the two D5 carve-outs intentionally differ from v3 (allowlisted, not a regression)', () => {
  const ambiguousInput = () => ({
    turn: { id: 't', conversation_id: 'c', conversation_revision: 1, message: { id: 'm', text: 'pandereta' } },
    history: { messages: [] }, facts: [], goals: [{ goal_id: 'product', status: 'unresolved' }],
    allowed_mutations: [{ operation: 'set', concept: 'product', field: 'product' }],
    grounding: { catalog: [{ ref: 'product:cierros', concept: 'product', value: 'Cierros de Hormigón' }] },
    claim_rules: [], effect_permissions: [], effect_requirements: [],
  });

  test('catalog_resolution_conflict: v3 rejects, v3.1 withholds instead', () => {
    const v3Proposal = (policy) => ({
      version: 'ai_conversation_proposal/v3', policy_digest: policy.policy_digest,
      reply_text: 'Anoté pandereta.', primary_request: { goal_id: 'product' },
      catalog_resolution: { status: 'ambiguous', evidence_quote: 'pandereta', evidence_occurrence: 1, grounding_ref: null },
      observations: [{
        id: 'obs-product', concept: 'product', raw_value: 'pandereta', normalized_value: 'Cierros de Hormigón',
        evidence_quote: 'pandereta', evidence_occurrence: 1, grounding_ref: 'product:cierros', resolves_goal_ids: [],
      }],
      state_mutations: [], effect_requests: [],
    });
    const v3Validation = runV3(ambiguousInput, v3Proposal);
    expect(v3Validation.errors.map((error) => error.code)).toContain('catalog_resolution_conflict');

    const v31Validation = runV31(ambiguousInput, v3Proposal);
    expect(v31Validation.errors.map((error) => error.code)).not.toContain('catalog_resolution_conflict');
  });

  test('catalog_resolution_action_forbidden (state-mutation branch): v3 rejects, v3.1 withholds instead', () => {
    const v3Proposal = (policy) => ({
      version: 'ai_conversation_proposal/v3', policy_digest: policy.policy_digest,
      reply_text: 'Anoté pandereta.', primary_request: { goal_id: 'product' },
      catalog_resolution: { status: 'ambiguous', evidence_quote: 'pandereta', evidence_occurrence: 1, grounding_ref: null },
      observations: [{
        id: 'obs-product', concept: 'product', raw_value: 'pandereta', normalized_value: 'Cierros de Hormigón',
        evidence_quote: 'pandereta', evidence_occurrence: 1, grounding_ref: 'product:cierros', resolves_goal_ids: [],
      }],
      state_mutations: [{ operation: 'set', field: 'product', observation_id: 'obs-product', replaces_fact_id: null }],
      effect_requests: [],
    });
    const v3Validation = runV3(ambiguousInput, v3Proposal);
    expect(v3Validation.errors.map((error) => error.code)).toContain('catalog_resolution_action_forbidden');

    const v31Validation = runV31(ambiguousInput, v3Proposal);
    expect(v31Validation.errors.map((error) => error.code)).not.toContain('catalog_resolution_action_forbidden');
    expect(v31Validation.withheld_mutations).toContainEqual(expect.objectContaining({ field: 'product' }));
  });
});
