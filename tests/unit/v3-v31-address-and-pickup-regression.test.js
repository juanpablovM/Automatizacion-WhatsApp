import { createRequire } from 'node:module';
import { describe, expect, test } from 'vitest';

const require = createRequire(import.meta.url);
const { buildV3PolicyInput } = require('../fixtures/workflow-nodes/shared/v3-policy-builder.js');
const {
  compileV3TurnPolicy, validateV3AiProposal, authorizeV3ConversationDecision,
} = require('../fixtures/workflow-nodes/shared/v3-contract-runtime.js');

// -----------------------------------------------------------------------------
// design.md D11 (2a.30) — explicit v3.1 regression coverage for the address
// retry hard bound and the pickup factory address rule, mirroring
// tests/unit/v3-address-hardbound.test.js and the pickup case in
// tests/unit/v3-commercial-policy.test.js, but against the item-aware v3.1
// contract (single item `li_0`). These are the exact two guardrails design.md
// calls out as regression risk if composition ever regresses.
// -----------------------------------------------------------------------------

const context = {
  product: 'Bloques', commune: 'Rancagua', quantity: '120 unidades',
  service_scope: 'material', fulfillment: 'delivery', access_restrictions: 'Sin restricciones',
};
const policyFor = (text = 'Rancagua', overrides = {}) => compileV3TurnPolicy(buildV3PolicyInput({
  inbound_event_id: 991, conversation_id: 22, external_message_id: 'address-repeat-3-v31',
  text_body: text, pending_question_key: 'address', qualification_context: context,
  previous_commercial_pending_question_key: 'address', previous_commercial_question_retry: 2, ...overrides,
}, { version: 'v3.1' }));
const proposalFor = (policy, overrides = {}) => ({
  version: 'ai_conversation_proposal/v3.1', policy_digest: policy.policy_digest,
  reply_text: '¿Cuál es la calle y número aproximado?', primary_request: { goal_id: 'address', item_ref: null },
  catalog_resolutions: [], observations: [], state_mutations: [], effect_requests: [], ...overrides,
});

describe('v3.1 address retry hard bound (design.md D11, 2a.30)', () => {
  test('third repeated request without commercial progress cannot ask address again', () => {
    const policy = policyFor();
    const validation = validateV3AiProposal(policy, proposalFor(policy));
    expect(validation.version).toBe('conversation_validation_result/v3.1');
    expect(validation.valid).toBe(false);
    expect(validation.errors.map(({ code }) => code)).toEqual(expect.arrayContaining([
      'address_retry_exhausted', 'address_retry_handoff_required',
    ]));
    expect(validation.authorized_effect_requests).toEqual([]);
  });

  test('new exact address evidence resets the bound and allows natural progress', () => {
    const policy = policyFor('Calle Uno 120');
    const validation = validateV3AiProposal(policy, proposalFor(policy, {
      reply_text: 'Gracias, registré los datos. ¿Confirmas la solicitud?',
      primary_request: { goal_id: 'final_confirmation', item_ref: null },
      observations: [{
        id: 'obs-address', concept: 'address', raw_value: 'Calle Uno 120', normalized_value: 'Calle Uno 120',
        evidence_quote: 'Calle Uno 120', evidence_occurrence: 1, grounding_ref: null,
        resolves_goal_ids: ['address'], item_ref: null,
      }],
      state_mutations: [{ operation: 'set', field: 'address', item_ref: null, observation_id: 'obs-address', replaces_fact_id: null }],
    }));
    expect(validation.valid).toBe(true);
    expect(validation.authorized_mutations[0]).toMatchObject({ field: 'address', item_ref: null, projected_value: 'Calle Uno 120' });
  });

  test('existing permitted handoff needs no quote address and carries the domain reason', () => {
    const policy = policyFor();
    const proposal = proposalFor(policy, {
      reply_text: 'Registré el caso para revisión por una persona del equipo.',
      primary_request: null, effect_requests: [{ type: 'handoff', reason_observation_ids: [] }],
    });
    const validation = validateV3AiProposal(policy, proposal);
    expect(validation.valid).toBe(true);
    const decision = authorizeV3ConversationDecision(policy, proposal, validation);
    expect(decision.version).toBe('validated_conversation_decision/v3.1');
    expect(decision.effect_commands[0]).toMatchObject({
      type: 'handoff', required_before_reply: true, payload: { reason_observation_ids: [] },
    });
  });
});

describe('v3.1 pickup factory address rule (design.md D11, 2a.30)', () => {
  const pickupContext = { product: 'Bloques', quantity: '120 unidades', service_scope: 'material', fulfillment: 'pickup' };
  const pickupPolicyFor = (overrides = {}) => compileV3TurnPolicy(buildV3PolicyInput({
    inbound_event_id: 992, conversation_id: 23, external_message_id: 'pickup-v31',
    text_body: 'Quiero retirar en fábrica', pending_question_key: null, qualification_context: pickupContext, ...overrides,
  }, { version: 'v3.1' }));

  test('final confirmation without the exact address is rejected', () => {
    const policy = pickupPolicyFor();
    const validation = validateV3AiProposal(policy, {
      version: 'ai_conversation_proposal/v3.1', policy_digest: policy.policy_digest,
      reply_text: 'Confirmá los datos para retirar en fábrica.',
      primary_request: { goal_id: 'final_confirmation', item_ref: null },
      catalog_resolutions: [], observations: [], state_mutations: [], effect_requests: [],
    });
    expect(validation.valid).toBe(false);
    expect(validation.errors).toContainEqual(expect.objectContaining({ code: 'pickup_factory_address_required' }));
  });

  test('final confirmation stating the single factory address is accepted', () => {
    const policy = pickupPolicyFor();
    const validation = validateV3AiProposal(policy, {
      version: 'ai_conversation_proposal/v3.1', policy_digest: policy.policy_digest,
      reply_text: 'Confirmá los datos para retirar en Portezuelo 1502, San Bernardo.',
      primary_request: { goal_id: 'final_confirmation', item_ref: null },
      catalog_resolutions: [], observations: [], state_mutations: [], effect_requests: [],
    });
    expect(validation.valid).toBe(true);
  });
});
