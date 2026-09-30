import { createRequire } from 'node:module';
import { describe, expect, test } from 'vitest';

const require = createRequire(import.meta.url);
const { buildV3PolicyInput } = require('../fixtures/workflow-nodes/shared/v3-policy-builder.js');
const {
  compileV3TurnPolicy, validateV3AiProposal, authorizeV3ConversationDecision,
} = require('../fixtures/workflow-nodes/shared/v3-contract-runtime.js');
const { toV31Input, toV31Proposal } = require('../support/v3-v31-translate.js');

const rowFor = (context, text) => ({
  inbound_event_id: 820, conversation_id: 81, external_message_id: 'installation-delivery-policy',
  text_body: text, qualification_context: context,
});
const proposalFor = (policy, overrides = {}) => ({
  version: 'ai_conversation_proposal/v3', policy_digest: policy.policy_digest,
  reply_text: 'Gracias, revisaremos la solicitud.', primary_request: null,
  catalog_resolution: { status: 'not_applicable', evidence_quote: null, evidence_occurrence: null, grounding_ref: null },
  observations: [], state_mutations: [], effect_requests: [], ...overrides,
});
const observation = (field, quote, value) => ({
  id: `obs-${field}`, concept: field, raw_value: quote, normalized_value: value,
  evidence_quote: quote, evidence_occurrence: 1, grounding_ref: `${field}:${value}`,
  resolves_goal_ids: [field],
});
const run = (version, context, text, changes = {}) => {
  const input = buildV3PolicyInput(rowFor(context, text));
  const policy = compileV3TurnPolicy(version === 'v3.1' ? toV31Input(input) : input);
  const rawProposal = proposalFor(policy, changes);
  const proposal = version === 'v3.1' ? toV31Proposal(policy, rawProposal) : rawProposal;
  return { policy, proposal, validation: validateV3AiProposal(policy, proposal) };
};
const codes = (validation) => validation.errors.map((error) => error.code);
const quote = { product: 'Bloques', quantity: '120 unidades' };

describe.each(['v3', 'v3.1'])('%s installation requires delivery', (version) => {
  test('rejects a persisted both + pickup quote and authorizes no decision', () => {
    const { policy, proposal, validation } = run(version,
      { ...quote, service_scope: 'both', fulfillment: 'pickup' }, 'Continuemos');
    expect(codes(validation)).toContain('installation_requires_delivery');
    expect(validation.valid).toBe(false);
    expect(validation.authorized_mutations).toEqual([]);
    expect(validation.authorized_effect_requests).toEqual([]);
    expect(() => authorizeV3ConversationDecision(policy, proposal, validation)).toThrow();
    expect(validation.errors.find((error) => error.code === 'installation_requires_delivery'))
      .toMatchObject({
        disposition: 'repairable', path: 'fulfillment', allowed_values: ['fulfillment:delivery'],
        instruction: expect.stringContaining('If this conflict is already persisted'),
      });
  });

  test('a persisted conflict can ask to correct fulfillment without authorizing effects', () => {
    const { policy, proposal, validation } = run(version,
      { ...quote, service_scope: 'both', fulfillment: 'pickup' }, 'Continuemos', {
        reply_text: 'La instalación requiere despacho. ¿Prefieres despacho o solo material con retiro?',
        primary_request: { goal_id: 'fulfillment' },
      });
    expect(validation.valid).toBe(true);
    expect(codes(validation)).not.toContain('primary_request_goal_resolved');
    expect(validation.authorized_mutations).toEqual([]);
    expect(validation.authorized_effect_requests).toEqual([]);
    expect(authorizeV3ConversationDecision(policy, proposal, validation).effect_commands).toEqual([]);
  });

  test('a persisted installation-only conflict can ask to correct service scope', () => {
    const { validation } = run(version,
      { ...quote, service_scope: 'installation', fulfillment: 'pickup' }, 'Continuemos', {
        reply_text: 'La instalación requiere despacho. ¿Necesitas instalación con despacho o solo material con retiro?',
        primary_request: { goal_id: 'service_scope' },
      });
    expect(validation.valid).toBe(true);
    expect(codes(validation)).not.toContain('primary_request_goal_resolved');
  });

  test('a persisted conflict still rejects a lead request or repeated invalid assertion', () => {
    const context = { ...quote, service_scope: 'both', fulfillment: 'pickup' };
    const { validation: withEffect } = run(version, context, 'Confirmo', {
      primary_request: { goal_id: 'fulfillment' },
      effect_requests: [{ type: 'create_lead', reason_observation_ids: [] }],
    });
    expect(codes(withEffect)).toContain('installation_requires_delivery');
    expect(withEffect.authorized_effect_requests).toEqual([]);

    const { validation: repeated } = run(version, context, 'retiro', {
      primary_request: { goal_id: 'fulfillment' },
      observations: [observation('fulfillment', 'retiro', 'pickup')],
    });
    expect(codes(repeated)).toContain('installation_requires_delivery');
  });

  test('rejects a same-turn installation + pickup proposal', () => {
    const changes = {
      observations: [observation('service_scope', 'instalación', 'installation'), observation('fulfillment', 'retiro', 'pickup')],
      state_mutations: ['service_scope', 'fulfillment'].map((field) => ({
        operation: 'set', field, observation_id: `obs-${field}`, replaces_fact_id: null,
      })),
    };
    const { validation } = run(version, quote, 'instalación con retiro', changes);
    expect(codes(validation)).toContain('installation_requires_delivery');
    expect(validation.valid).toBe(false);
  });

  test('rejects same-turn both + pickup even when the customer names both alternatives', () => {
    const { validation } = run(version, quote, 'material y también instalación con retiro', {
      observations: [observation('service_scope', 'material y también instalación', 'both'), observation('fulfillment', 'retiro', 'pickup')],
      state_mutations: ['service_scope', 'fulfillment'].map((field) => ({
        operation: 'set', field, observation_id: `obs-${field}`, replaces_fact_id: null,
      })),
    });
    expect(codes(validation)).toContain('installation_requires_delivery');
    expect(validation.valid).toBe(false);
  });

  test('rejects pickup newly proposed against persisted installation', () => {
    const { validation } = run(version, { ...quote, service_scope: 'installation' }, 'Quiero retiro', {
      observations: [observation('fulfillment', 'retiro', 'pickup')],
      state_mutations: [{ operation: 'set', field: 'fulfillment', observation_id: 'obs-fulfillment', replaces_fact_id: null }],
    });
    expect(codes(validation)).toContain('installation_requires_delivery');
    expect(validation.valid).toBe(false);
  });

  test('correcting fulfillment to delivery clears a persisted conflict', () => {
    const context = { ...quote, service_scope: 'both', fulfillment: 'pickup' };
    const { policy } = run(version, context, 'Prefiero despacho');
    const oldFact = policy.facts.find((fact) => fact.field === 'fulfillment');
    const { validation } = run(version, context, 'Prefiero despacho', {
      observations: [observation('fulfillment', 'despacho', 'delivery')],
      state_mutations: [{ operation: 'replace', field: 'fulfillment', observation_id: 'obs-fulfillment', replaces_fact_id: oldFact.fact_id }],
    });
    expect(codes(validation)).not.toContain('installation_requires_delivery');
    expect(validation.valid).toBe(true);
  });

  test('correcting scope to material clears a persisted conflict', () => {
    const context = { ...quote, service_scope: 'both', fulfillment: 'pickup' };
    const { policy } = run(version, context, 'Solo material');
    const oldFact = policy.facts.find((fact) => fact.field === 'service_scope');
    const { validation } = run(version, context, 'Solo material', {
      observations: [observation('service_scope', 'material', 'material')],
      state_mutations: [{ operation: 'replace', field: 'service_scope', observation_id: 'obs-service_scope', replaces_fact_id: oldFact.fact_id }],
    });
    expect(codes(validation)).not.toContain('installation_requires_delivery');
    expect(validation.valid).toBe(true);
  });

  test('material-only pickup and installation-only without fulfillment remain valid', () => {
    for (const context of [
      { ...quote, service_scope: 'material', fulfillment: 'pickup' },
      { ...quote, service_scope: 'installation' },
      { ...quote, service_scope: 'both', fulfillment: 'delivery' },
    ]) {
      const { validation } = run(version, context, 'Continuemos');
      expect(codes(validation)).not.toContain('installation_requires_delivery');
      expect(validation.valid).toBe(true);
    }
  });
});
