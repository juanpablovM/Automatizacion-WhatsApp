import { createRequire } from 'node:module';
import { describe, expect, test } from 'vitest';

const require = createRequire(import.meta.url);
const { buildV3PolicyInput } = require('../fixtures/workflow-nodes/shared/v3-policy-builder.js');
const { compileV3TurnPolicy, validateV3AiProposal } = require('../fixtures/workflow-nodes/shared/v3-contract-runtime.js');

const baseContext = { product: 'Bloques', commune: 'Rancagua', quantity: '120 unidades' };
const rowFor = (context, overrides = {}) => ({
  inbound_event_id: 'commercial-turn', conversation_id: 'commercial-conversation',
  external_message_id: 'commercial-message', text_body: 'sí',
  pending_question_key: 'final_confirmation', qualification_context: context, ...overrides,
});
const requiredFor = (input) => input.effect_requirements.find((rule) => rule.effect_type === 'create_lead').required_goal_ids;
const policyFor = (context, overrides = {}) => compileV3TurnPolicy(buildV3PolicyInput(rowFor(context, overrides)));
const proposalFor = (policy, overrides = {}) => ({
  version: 'ai_conversation_proposal/v3', policy_digest: policy.policy_digest,
  reply_text: 'Solicitud registrada para revisión comercial.', primary_request: null,
  catalog_resolution: { status: 'not_applicable', evidence_quote: null, evidence_occurrence: null, grounding_ref: null },
  observations: [], state_mutations: [], effect_requests: [{ type: 'create_lead', reason_observation_ids: [] }],
  ...overrides,
});
const observation = (concept, evidence, value, groundingRef = null) => ({
  id: `obs-${concept}`, concept, raw_value: evidence, normalized_value: value,
  evidence_quote: evidence, evidence_occurrence: 1, grounding_ref: groundingRef,
  resolves_goal_ids: [concept],
});
const mutation = (concept) => ({ operation: 'set', field: concept, observation_id: `obs-${concept}`, replaces_fact_id: null });
const unresolved = (validation) => validation.errors.filter((error) => error.code === 'effect_prerequisite_unresolved').flatMap((error) => error.related_ids);

describe('v3 commercial profile requirements', () => {
  test('pickup material cannot create a lead without quantity', () => {
    const policy = policyFor({ product: 'Bloques', commune: 'Rancagua', service_scope: 'material', fulfillment: 'pickup' });
    const validation = validateV3AiProposal(policy, proposalFor(policy));
    expect(validation.valid).toBe(false);
    expect(unresolved(validation)).toContain('quantity');
  });

  test('complete pickup material is not blocked by delivery or installation data', () => {
    const policy = policyFor({ product: 'Bloques', quantity: '120 unidades', service_scope: 'material', fulfillment: 'pickup' });
    expect(requiredFor(buildV3PolicyInput(rowFor({ product: 'Bloques', quantity: '120 unidades', service_scope: 'material', fulfillment: 'pickup' })))).not.toContain('commune');
    expect(validateV3AiProposal(policy, proposalFor(policy)).valid).toBe(true);
  });

  test('pickup final confirmation must state the single factory address', () => {
    const context = { product: 'Bloques', quantity: '120 unidades', service_scope: 'material', fulfillment: 'pickup' };
    const policy = policyFor(context, { text_body: 'Quiero retirar en fábrica', pending_question_key: null });
    const withoutAddress = validateV3AiProposal(policy, proposalFor(policy, {
      reply_text: 'Confirmá los datos para retirar en fábrica.',
      primary_request: { goal_id: 'final_confirmation' },
      effect_requests: [],
    }));
    expect(withoutAddress.valid).toBe(false);
    expect(withoutAddress.errors).toContainEqual(expect.objectContaining({ code: 'pickup_factory_address_required' }));

    const withAddress = validateV3AiProposal(policy, proposalFor(policy, {
      reply_text: 'Confirmá los datos para retirar en Portezuelo 1502, San Bernardo.',
      primary_request: { goal_id: 'final_confirmation' },
      effect_requests: [],
    }));
    expect(withAddress.valid).toBe(true);
  });

  test('committed delivery requires an address and access restrictions', () => {
    const input = buildV3PolicyInput(rowFor({ ...baseContext, service_scope: 'material', fulfillment: 'delivery' }));
    expect(requiredFor(input)).toEqual(expect.arrayContaining(['address', 'access_restrictions']));
    expect(requiredFor(input)).not.toContain('terrain');
  });

  test('installation requires site and installation data but no pickup-versus-delivery choice', () => {
    const input = buildV3PolicyInput(rowFor({ ...baseContext, service_scope: 'installation' }));
    expect(requiredFor(input)).toEqual(expect.arrayContaining(['address', 'terrain', 'truck_access', 'debris_removal']));
    expect(requiredFor(input)).not.toContain('fulfillment');
  });

  test('both proposals retain installation prerequisites and material fulfillment', () => {
    const input = buildV3PolicyInput(rowFor({ ...baseContext, service_scope: 'both', fulfillment: 'delivery' }));
    expect(requiredFor(input)).toEqual(expect.arrayContaining(['fulfillment', 'address', 'terrain', 'truck_access', 'debris_removal', 'access_restrictions']));
  });

  test('false access and debris answers are resolved facts, not missing values', () => {
    const policy = policyFor({ ...baseContext, service_scope: 'installation', address: 'Calle Uno 120', terrain: 'Plano', truck_access: false, debris_removal: false });
    expect(policy.goals.find((goal) => goal.goal_id === 'truck_access').status).toBe('resolved');
    expect(policy.goals.find((goal) => goal.goal_id === 'debris_removal').status).toBe('resolved');
    expect(validateV3AiProposal(policy, proposalFor(policy)).valid).toBe(true);
  });

  test.each(['pickup', 'delivery'])('legacy %s context keeps evidenced scope and fulfillment', (modality) => {
    const input = buildV3PolicyInput(rowFor({ ...baseContext, modality }));
    expect(input.facts.find((fact) => fact.field === 'service_scope').value).toBe('material');
    expect(input.facts.find((fact) => fact.field === 'fulfillment').value).toBe(modality);
  });

  test('B2B retains company, contact, and purchase order requirements', () => {
    const input = buildV3PolicyInput(rowFor({ ...baseContext, service_scope: 'material', fulfillment: 'pickup', customer_type: 'b2b' }));
    expect(requiredFor(input)).toEqual(expect.arrayContaining(['commune', 'company', 'contact_name', 'purchase_order']));
  });

  test('lead class D retains commune and B2B requirements even for pickup', () => {
    const input = buildV3PolicyInput(rowFor({ product: 'Bloques', quantity: '120 unidades', service_scope: 'material', fulfillment: 'pickup', lead_class: 'D' }));
    expect(requiredFor(input)).toEqual(expect.arrayContaining(['commune', 'company', 'contact_name', 'purchase_order']));
  });

  test.each([
    [{ product: 'Bloques', quantity: '120 unidades', service_scope: 'material', fulfillment: 'delivery' }, 'delivery'],
    [{ product: 'Bloques', quantity: '120 unidades', service_scope: 'installation' }, 'installation'],
  ])('%s still requires commune', (context) => {
    expect(requiredFor(buildV3PolicyInput(rowFor(context)))).toContain('commune');
  });

  test('current-turn legacy heuristic fields never become committed commercial facts', () => {
    const input = buildV3PolicyInput(rowFor({}, { product: 'Bloques', city: 'Rancagua', service: 'instalación' }));
    expect(input.facts).toEqual([]);
  });
});

describe('v3 current-turn profile projection', () => {
  test('same-turn pickup removes commune and address from effective create-lead requirements', () => {
    const context = { product: 'Bloques', quantity: '120 unidades', service_scope: 'material' };
    const policy = policyFor(context, { text_body: 'retiro' });
    const validation = validateV3AiProposal(policy, proposalFor(policy, {
      observations: [observation('fulfillment', 'retiro', 'pickup', 'fulfillment:pickup')],
      state_mutations: [mutation('fulfillment')],
      effect_requests: [{ type: 'create_lead', reason_observation_ids: ['obs-fulfillment'] }],
    }));
    expect(unresolved(validation)).not.toEqual(expect.arrayContaining(['commune', 'address']));
    expect(validation.valid).toBe(true);
  });
  test.each([
    ['service_scope', 'instalación', 'installation', 'service_scope:installation', ['address', 'terrain', 'truck_access', 'debris_removal'], baseContext],
    ['fulfillment', 'despacho', 'delivery', 'fulfillment:delivery', ['address', 'access_restrictions'], { ...baseContext, service_scope: 'material' }],
    ['customer_type', 'empresa', 'b2b', null, ['company', 'contact_name', 'purchase_order'], { ...baseContext, service_scope: 'material', fulfillment: 'pickup' }],
  ])('new %s evidence cannot bypass additional required goals', (concept, evidence, value, groundingRef, missing, context) => {
    const policy = policyFor(context, { text_body: evidence });
    const validation = validateV3AiProposal(policy, proposalFor(policy, {
      observations: [observation(concept, evidence, value, groundingRef)],
      state_mutations: [mutation(concept)],
      effect_requests: [{ type: 'create_lead', reason_observation_ids: [`obs-${concept}`] }],
    }));
    expect(validation.valid).toBe(false);
    expect(unresolved(validation)).toEqual(expect.arrayContaining(missing));
  });
});

describe('v3 contextual bounded address clarification', () => {
  const addressGuidance = (overrides = {}) => policyFor({ ...baseContext, service_scope: 'material', fulfillment: 'delivery' }, {
    text_body: 'Rancagua', pending_question_key: 'address',
    previous_commercial_pending_question_key: 'address', previous_commercial_question_retry: 1, ...overrides,
  }).goals.find((goal) => goal.goal_id === 'address').guidance;

  test('compiled policy carries known commune and street-and-number focus', () => {
    expect(addressGuidance()).toMatchObject({ known_commune: 'Rancagua', question_focus: 'street_and_approximate_number', commune_alone_is_not_address: true, next_action_without_progress: 'clarify' });
  });

  test('third unsuccessful repeated address request asks the advisor to hand off', () => {
    expect(addressGuidance({ previous_commercial_question_retry: 2 }).next_action_without_progress).toBe('handoff');
  });

  test('a changed pending goal does not inherit an unrelated retry count', () => {
    expect(addressGuidance({ previous_commercial_pending_question_key: 'quantity', previous_commercial_question_retry: 9 })).toMatchObject({ next_retry_count_without_progress: 0, next_action_without_progress: 'ask' });
  });

  test('persisted JSON metadata remains compatible with pre-v3 retries', () => {
    expect(addressGuidance({ previous_commercial_pending_question_key: undefined, previous_commercial_question_retry: undefined, metadata_json: JSON.stringify({ pending_question_key: 'address', commercial_question_retry: 2 }) }).next_action_without_progress).toBe('handoff');
  });

  test.each(['Rancagua', 'Calle inventada 123'])('a commune-only answer cannot be recorded as address %s', (value) => {
    const policy = policyFor({ ...baseContext, service_scope: 'material', fulfillment: 'delivery' }, { text_body: 'Rancagua', pending_question_key: 'address' });
    const validation = validateV3AiProposal(policy, proposalFor(policy, {
      reply_text: '¿Cuál es la calle y el número aproximado?', primary_request: { goal_id: 'address' },
      observations: [observation('address', 'Rancagua', value)], state_mutations: [mutation('address')], effect_requests: [],
    }));
    expect(validation.valid).toBe(false);
    expect(validation.errors).toContainEqual(expect.objectContaining({ code: 'address_requires_street_details' }));
    expect(validation.authorized_mutations).toEqual([]);
  });

  test('street details are valid without inventing a mandatory numeric street address', () => {
    const policy = policyFor({ ...baseContext, service_scope: 'material', fulfillment: 'delivery' }, { text_body: 'Camino Los Aromos sin número', pending_question_key: 'address' });
    const validation = validateV3AiProposal(policy, proposalFor(policy, {
      reply_text: '¿Hay restricciones de acceso?', primary_request: { goal_id: 'access_restrictions' },
      observations: [observation('address', 'Camino Los Aromos sin número', 'Camino Los Aromos sin número')],
      state_mutations: [mutation('address')], effect_requests: [],
    }));
    expect(validation.valid).toBe(true);
  });
});
