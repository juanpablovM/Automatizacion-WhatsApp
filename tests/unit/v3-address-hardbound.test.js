import { createRequire } from 'node:module';
import { describe, expect, test } from 'vitest';

const require = createRequire(import.meta.url);
const { buildV3PolicyInput } = require('../fixtures/workflow-nodes/shared/v3-policy-builder.js');
const { compileV3TurnPolicy, validateV3AiProposal, authorizeV3ConversationDecision } = require('../fixtures/workflow-nodes/shared/v3-contract-runtime.js');
const { planV3Recovery } = require('../fixtures/workflow-nodes/shared/v3-saga-runtime.js');
const context = { product: 'Bloques', commune: 'Rancagua', quantity: '120 unidades',
  service_scope: 'material', fulfillment: 'delivery', access_restrictions: 'Sin restricciones' };
const policyFor = (text = 'Rancagua') => compileV3TurnPolicy(buildV3PolicyInput({
  inbound_event_id: 991, conversation_id: 22, external_message_id: 'address-repeat-3',
  text_body: text, pending_question_key: 'address', qualification_context: context,
  previous_commercial_pending_question_key: 'address', previous_commercial_question_retry: 2,
}));
const proposalFor = (policy, overrides = {}) => ({
  version: 'ai_conversation_proposal/v3', policy_digest: policy.policy_digest,
  reply_text: '¿Cuál es la calle y número aproximado?', primary_request: { goal_id: 'address' },
  catalog_resolution: { status: 'not_applicable', evidence_quote: null, evidence_occurrence: null, grounding_ref: null },
  observations: [], state_mutations: [], effect_requests: [], ...overrides,
});

describe('v3 address retry hard bound', () => {
  test('third repeated request without commercial progress cannot ask address again', () => {
    const policy = policyFor();
    const validation = validateV3AiProposal(policy, proposalFor(policy));
    expect(validation.valid).toBe(false);
    expect(validation.errors.map(({ code }) => code)).toEqual(expect.arrayContaining([
      'address_retry_exhausted', 'address_retry_handoff_required',
    ]));
    expect(validation.authorized_effect_requests).toEqual([]);
  });

  test('new exact address evidence resets the bound and allows natural progress', () => {
    const policy = policyFor('Calle Uno 120');
    const validation = validateV3AiProposal(policy, proposalFor(policy, {
      reply_text: 'Gracias, registré los datos. ¿Confirmas la solicitud?', primary_request: { goal_id: 'final_confirmation' },
      observations: [{ id: 'obs-address', concept: 'address', raw_value: 'Calle Uno 120',
        normalized_value: 'Calle Uno 120', evidence_quote: 'Calle Uno 120', evidence_occurrence: 1,
        grounding_ref: null, resolves_goal_ids: ['address'] }],
      state_mutations: [{ operation: 'set', field: 'address', observation_id: 'obs-address', replaces_fact_id: null }],
    }));
    expect(validation.valid).toBe(true);
    expect(validation.authorized_mutations[0]).toMatchObject({ field: 'address', projected_value: 'Calle Uno 120' });
  });

  test('existing permitted handoff needs no quote address and carries the domain reason', () => {
    const policy = policyFor();
    const proposal = proposalFor(policy, { reply_text: 'Registré el caso para revisión por una persona del equipo.',
      primary_request: null, effect_requests: [{ type: 'handoff', reason_observation_ids: [] }] });
    const validation = validateV3AiProposal(policy, proposal);
    expect(validation.valid).toBe(true);
    const decision = authorizeV3ConversationDecision(policy, proposal, validation);
    expect(decision.effect_commands[0]).toMatchObject({ type: 'handoff', required_before_reply: true,
      payload: { escalation_reason: 'no_progress_commercial_question_loop', pending_question_key: 'address' } });
  });

  test('one failed repair falls to a receipted internal handoff, never another address question', () => {
    const policy = policyFor();
    const proposal = proposalFor(policy);
    const validation = validateV3AiProposal(policy, proposal);
    expect(planV3Recovery({ policy, validation, repairAttempt: 0, proposal, preTurnState: context }).action).toBe('repair');
    const terminal = planV3Recovery({ policy, validation, repairAttempt: 1, proposal, preTurnState: context });
    expect(terminal.action).toBe('contingency');
    expect(terminal.decision.reply.text).not.toContain('?');
    expect(terminal.decision.effect_commands[0]).toMatchObject({ type: 'internal_handoff', required_before_reply: true,
      payload: { recovery_reason: 'no_progress_commercial_question_loop' } });
    expect(terminal.preserved_state).toEqual(context);
  });
});
