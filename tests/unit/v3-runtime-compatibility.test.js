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
const {
  buildV3PolicyInput,
} = require('../fixtures/workflow-nodes/shared/v3-rollout-runtime.js');

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
const noProductAssertion = () => ({
  status: 'not_applicable',
  evidence_quote: null,
  evidence_occurrence: null,
  grounding_ref: null,
});

describe('v3 runtime contract compatibility', () => {
  test('accepts the event-541 follow-up when scope and fulfillment are distinct', () => {
    const message = 'Quiero comprar 120 bloques de hormigón para una ampliación en Rancagua. Los necesito solo como material, sin instalación.';
    const policy = compileV3TurnPolicy({
      ...policyFor(message),
      goals: [
        { goal_id: 'product', status: 'unresolved' },
        { goal_id: 'quantity', status: 'unresolved' },
        { goal_id: 'commune', status: 'unresolved' },
        { goal_id: 'service_scope', status: 'unresolved' },
        { goal_id: 'fulfillment', status: 'unresolved' },
      ],
      allowed_mutations: [
        { operation: 'set', concept: 'product', field: 'product' },
        { operation: 'set', concept: 'quantity', field: 'quantity' },
        { operation: 'set', concept: 'commune', field: 'commune' },
        { operation: 'set', concept: 'service_scope', field: 'service_scope' },
        { operation: 'set', concept: 'fulfillment', field: 'fulfillment' },
      ],
      grounding: {
        catalog: [
          { ref: 'product:bloques-hormigon', concept: 'product', value: 'Bloques de Hormigón' },
        ],
        modality_synonyms: [
          { ref: 'service_scope:material', concept: 'service_scope', value: 'material' },
          { ref: 'fulfillment:delivery', concept: 'fulfillment', value: 'delivery' },
          { ref: 'fulfillment:pickup', concept: 'fulfillment', value: 'pickup' },
        ],
      },
    });
    const proposal = {
      version: 'ai_conversation_proposal/v3',
      policy_digest: policy.policy_digest,
      reply_text: 'Perfecto. ¿Preferís retirar los productos o necesitás despacho?',
      primary_request: { goal_id: 'fulfillment' },
      catalog_resolution: {
        status: 'matched', evidence_quote: 'bloques de hormigón', evidence_occurrence: 1,
        grounding_ref: 'product:bloques-hormigon',
      },
      observations: [
        {
          id: 'obs-product', concept: 'product', raw_value: 'bloques de hormigón',
          normalized_value: 'Bloques de Hormigón', evidence_quote: 'bloques de hormigón',
          evidence_occurrence: 1, grounding_ref: 'product:bloques-hormigon', resolves_goal_ids: ['product'],
        },
        {
          id: 'obs-quantity', concept: 'quantity', raw_value: '120', normalized_value: 120,
          evidence_quote: '120', evidence_occurrence: 1, grounding_ref: null,
          resolves_goal_ids: ['quantity'],
        },
        {
          id: 'obs-commune', concept: 'commune', raw_value: 'Rancagua', normalized_value: 'Rancagua',
          evidence_quote: 'Rancagua', evidence_occurrence: 1, grounding_ref: null,
          resolves_goal_ids: ['commune'],
        },
        {
          id: 'obs-scope', concept: 'service_scope', raw_value: 'solo como material',
          normalized_value: 'material', evidence_quote: 'solo como material', evidence_occurrence: 1,
          grounding_ref: 'service_scope:material', resolves_goal_ids: ['service_scope'],
        },
      ],
      state_mutations: [
        { operation: 'set', field: 'product', observation_id: 'obs-product', replaces_fact_id: null },
        { operation: 'set', field: 'quantity', observation_id: 'obs-quantity', replaces_fact_id: null },
        { operation: 'set', field: 'commune', observation_id: 'obs-commune', replaces_fact_id: null },
        { operation: 'set', field: 'service_scope', observation_id: 'obs-scope', replaces_fact_id: null },
      ],
      effect_requests: [],
    };

    const validation = validateV3AiProposal(policy, proposal);

    expect(validation.errors).toEqual([]);
    expect(validation.valid).toBe(true);
  });

  test('allows a confirmation request without pretending it resolves a commercial goal', () => {
    const policy = compileV3TurnPolicy({
      ...policyFor('Quiero revisar el resumen antes de avanzar'),
      goals: [
        { goal_id: 'product', status: 'resolved' },
        { goal_id: 'commune', status: 'resolved' },
        { goal_id: 'quantity', status: 'resolved' },
        { goal_id: 'service_scope', status: 'resolved' },
      ],
    });
    const validation = validateV3AiProposal(policy, {
      version: 'ai_conversation_proposal/v3',
      policy_digest: policy.policy_digest,
      reply_text: '¿Confirmás que estos datos están correctos?',
      primary_request: { goal_id: 'final_confirmation' },
      catalog_resolution: noProductAssertion(),
      observations: [],
      state_mutations: [],
      effect_requests: [],
    });

    expect(validation.errors).toEqual([]);
    expect(validation.valid).toBe(true);
  });

  test('keeps a primary request semantic instead of duplicating reply text', () => {
    const policy = compileV3TurnPolicy({
      ...policyFor('Necesito despacho a domicilio.'),
      goals: [
        { goal_id: 'fulfillment', status: 'unresolved' },
        { goal_id: 'address', status: 'unresolved' },
      ],
      allowed_mutations: [
        { operation: 'set', concept: 'fulfillment', field: 'fulfillment' },
      ],
      grounding: {
        modality_synonyms: [
          { ref: 'fulfillment:delivery', concept: 'fulfillment', value: 'delivery' },
        ],
      },
    });
    const validation = validateV3AiProposal(policy, {
      version: 'ai_conversation_proposal/v3',
      policy_digest: policy.policy_digest,
      reply_text: 'Entendido. Para continuar, ¿podrías indicarme la dirección exacta de entrega?',
      primary_request: { goal_id: 'address' },
      catalog_resolution: noProductAssertion(),
      observations: [{
        id: 'obs-fulfillment',
        concept: 'fulfillment',
        raw_value: 'despacho a domicilio',
        normalized_value: 'delivery',
        evidence_quote: 'despacho a domicilio',
        evidence_occurrence: 1,
        grounding_ref: 'fulfillment:delivery',
        resolves_goal_ids: ['fulfillment'],
      }],
      state_mutations: [{
        operation: 'set',
        field: 'fulfillment',
        observation_id: 'obs-fulfillment',
        replaces_fact_id: null,
      }],
      effect_requests: [],
    });

    expect(validation.errors).toEqual([]);
    expect(validation.valid).toBe(true);
  });

  test('accepts an evidenced unsupported catalog request without fixing the reply wording', () => {
    const policy = compileV3TurnPolicy({
      ...policyFor('Quiero una losa de 100 m2'),
      goals: [{ goal_id: 'product', status: 'unresolved' }],
      allowed_mutations: [{ operation: 'set', concept: 'product', field: 'product' }],
      grounding: {
        catalog: [{ ref: 'product:bloques', concept: 'product', value: 'Bloques de Hormigón' }],
      },
    });
    const validation = validateV3AiProposal(policy, {
      version: 'ai_conversation_proposal/v3',
      policy_digest: policy.policy_digest,
      reply_text: 'Ese trabajo no está dentro de nuestra oferta actual. Puedo contarte qué productos manejamos.',
      primary_request: null,
      catalog_resolution: {
        status: 'unsupported',
        evidence_quote: 'losa',
        evidence_occurrence: 1,
        grounding_ref: null,
      },
      observations: [],
      state_mutations: [],
      effect_requests: [],
    });

    expect(validation.errors).toEqual([]);
    expect(validation.valid).toBe(true);
    expect(validation.catalog_resolution.status).toBe('unsupported');
  });

  test('blocks a generic product re-question after classifying the explicit request as unsupported', () => {
    const policy = compileV3TurnPolicy({
      ...policyFor('Quiero una losa de 100 m2'),
      goals: [{ goal_id: 'product', status: 'unresolved' }],
      grounding: {
        catalog: [{ ref: 'product:bloques', concept: 'product', value: 'Bloques de Hormigón' }],
      },
    });
    const validation = validateV3AiProposal(policy, {
      version: 'ai_conversation_proposal/v3',
      policy_digest: policy.policy_digest,
      reply_text: '¿Qué producto necesitás?',
      primary_request: { goal_id: 'product' },
      catalog_resolution: {
        status: 'unsupported',
        evidence_quote: 'losa',
        evidence_occurrence: 1,
        grounding_ref: null,
      },
      observations: [],
      state_mutations: [],
      effect_requests: [],
    });

    expect(validation.valid).toBe(false);
    expect(validation.errors).toContainEqual(expect.objectContaining({
      code: 'catalog_resolution_action_forbidden',
      path: 'primary_request.goal_id',
    }));
  });

  test('allows a natural opt-in question about real alternatives after an unsupported request', () => {
    const policy = compileV3TurnPolicy({
      ...policyFor('Quiero una losa de 100 m2'),
      goals: [{ goal_id: 'product', status: 'unresolved' }],
      grounding: {
        catalog: [{ ref: 'product:pastelones', concept: 'product', value: 'Pastelones' }],
      },
    });
    const validation = validateV3AiProposal(policy, {
      version: 'ai_conversation_proposal/v3',
      policy_digest: policy.policy_digest,
      reply_text: 'Las losas no forman parte de nuestro catálogo. ¿Te gustaría conocer alternativas como Pastelones?',
      primary_request: { goal_id: 'product' },
      catalog_resolution: {
        status: 'unsupported', evidence_quote: 'losa', evidence_occurrence: 1, grounding_ref: null,
      },
      observations: [], state_mutations: [], effect_requests: [],
    });

    expect(validation.errors).toEqual([]);
  });

  test('blocks downstream qualification after an unsupported request', () => {
    const policy = compileV3TurnPolicy({
      ...policyFor('Quiero una losa de 100 m2'),
      goals: [
        { goal_id: 'product', status: 'unresolved' },
        { goal_id: 'service_scope', status: 'unresolved' },
      ],
      grounding: {
        catalog: [{ ref: 'product:pastelones', concept: 'product', value: 'Pastelones' }],
      },
    });
    const validation = validateV3AiProposal(policy, {
      version: 'ai_conversation_proposal/v3',
      policy_digest: policy.policy_digest,
      reply_text: 'Las losas no forman parte de nuestro catálogo. ¿Necesitás solo material o también instalación?',
      primary_request: { goal_id: 'service_scope' },
      catalog_resolution: {
        status: 'unsupported', evidence_quote: 'losa', evidence_occurrence: 1, grounding_ref: null,
      },
      observations: [], state_mutations: [], effect_requests: [],
    });

    expect(validation.valid).toBe(false);
    expect(validation.errors).toContainEqual(expect.objectContaining({
      code: 'catalog_resolution_action_forbidden',
      path: 'primary_request.goal_id',
    }));
  });

  test('allows a focused product clarification when the catalog match is ambiguous', () => {
    const policy = compileV3TurnPolicy({
      ...policyFor('Necesito una placa para el cierre'),
      goals: [{ goal_id: 'product', status: 'unresolved' }],
      grounding: {
        catalog: [
          { ref: 'product:placa-50', concept: 'product', value: 'Placa de 50 cm' },
          { ref: 'product:placa-60', concept: 'product', value: 'Placa de 60 cm' },
        ],
      },
    });
    const validation = validateV3AiProposal(policy, {
      version: 'ai_conversation_proposal/v3',
      policy_digest: policy.policy_digest,
      reply_text: '¿La necesitás de 50 cm o de 60 cm?',
      primary_request: { goal_id: 'product' },
      catalog_resolution: {
        status: 'ambiguous',
        evidence_quote: 'placa',
        evidence_occurrence: 1,
        grounding_ref: null,
      },
      observations: [],
      state_mutations: [],
      effect_requests: [],
    });

    expect(validation.errors).toEqual([]);
    expect(validation.valid).toBe(true);
  });

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

  test('returns exact same-concept refs and an actionable instruction for invented grounding', () => {
    const policy = compileV3TurnPolicy({
      ...policyFor('Necesito bombeo'),
      goals: [{ goal_id: 'service', status: 'unresolved' }],
      allowed_mutations: [{ operation: 'set', concept: 'service', field: 'service' }],
      grounding: {
        catalog: [
          { ref: 'service:BOMBEO', concept: 'service', value: 'bombeo de hormigón' },
          { ref: 'service:DESPACHO', concept: 'service', value: 'despacho' },
          { ref: 'product:H25', concept: 'product', value: 'hormigón H25' },
        ],
      },
    });
    const validation = validateV3AiProposal(policy, {
      version: 'ai_conversation_proposal/v3',
      policy_digest: policy.policy_digest,
      reply_text: 'Perfecto, anoté el servicio de bombeo.',
      primary_request: null,
      catalog_resolution: noProductAssertion(),
      observations: [{
        id: 'obs:service_confirmed',
        concept: 'service',
        raw_value: 'bombeo',
        normalized_value: 'bombeo',
        evidence_quote: 'bombeo',
        evidence_occurrence: 1,
        grounding_ref: 'service:confirmed',
        resolves_goal_ids: ['service'],
      }],
      state_mutations: [{
        operation: 'set',
        field: 'service',
        observation_id: 'obs:service_confirmed',
        replaces_fact_id: null,
      }],
      effect_requests: [],
    });
    const groundingError = validation.errors.find(({ code }) => code === 'grounding_invalid');

    expect(validation.valid).toBe(false);
    expect(groundingError.allowed_values).toEqual(['service:BOMBEO', 'service:DESPACHO']);
    expect(groundingError.instruction).toBe(
      'Replace grounding_ref with one allowed value, or remove this observation and every dependent mutation.',
    );

    const repair = buildV3RepairRequest({ policy, validation });
    expect(repair.errors.find(({ code }) => code === 'grounding_invalid')).toEqual(groundingError);
  });

  test('derives accepted grounded values and mutation projections from the policy entry', () => {
    const policy = compileV3TurnPolicy({
      ...policyFor('Necesito bombeo de hormigón'),
      goals: [{ goal_id: 'service', status: 'unresolved' }],
      allowed_mutations: [{ operation: 'set', concept: 'service', field: 'service' }],
      grounding: {
        catalog: [
          { ref: 'service:BOMBEO', concept: 'service', value: 'bombeo de hormigón' },
        ],
      },
    });
    const validation = validateV3AiProposal(policy, {
      version: 'ai_conversation_proposal/v3',
      policy_digest: policy.policy_digest,
      reply_text: 'Perfecto, anoté el bombeo de hormigón.',
      primary_request: null,
      catalog_resolution: noProductAssertion(),
      observations: [{
        id: 'obs:service',
        concept: 'service',
        raw_value: 'bombeo de hormigón',
        normalized_value: '  BOMBEO DE HORMIGÓN  ',
        evidence_quote: 'bombeo de hormigón',
        evidence_occurrence: 1,
        grounding_ref: 'service:BOMBEO',
        resolves_goal_ids: ['service'],
      }],
      state_mutations: [{
        operation: 'set',
        field: 'service',
        observation_id: 'obs:service',
        replaces_fact_id: null,
      }],
      effect_requests: [],
    });

    expect(validation.valid).toBe(true);
    expect(validation.accepted_observations[0].normalized_value).toBe('bombeo de hormigón');
    expect(validation.authorized_mutations[0].projected_value).toBe('bombeo de hormigón');
  });

  test('requires the configured effect after a direct create-lead request when every prerequisite is resolved', () => {
    const requiredGoals = ['product', 'commune', 'quantity', 'service_scope', 'fulfillment'];
    const policy = compileV3TurnPolicy({
      ...policyFor('Creá la solicitud, por favor.'),
      turn: {
        ...policyFor('Creá la solicitud, por favor.').turn,
        pending_question_goal_id: 'final_confirmation',
      },
      facts: requiredGoals.map((field) => ({
        fact_id: `fact:${field}`,
        field,
        value: field,
        mutability: 'customer_correctable',
        source: { message_id: 'previous', evidence_digest: 'a'.repeat(64) },
      })),
      goals: requiredGoals.map((goal_id) => ({
        goal_id,
        status: 'resolved',
        importance: 'required_for_effect',
        blocks_effects: ['create_lead'],
      })),
      effect_permissions: [{ type: 'create_lead' }],
      effect_requirements: [{
        effect_type: 'create_lead',
        required_goal_ids: requiredGoals,
        trigger: 'explicit_confirmation_when_ready',
      }],
    });
    const validation = validateV3AiProposal(policy, {
      version: 'ai_conversation_proposal/v3',
      policy_digest: policy.policy_digest,
      reply_text: 'Perfecto, avanzamos.',
      primary_request: null,
      catalog_resolution: noProductAssertion(),
      observations: [],
      state_mutations: [],
      effect_requests: [],
    });

    expect(validation.valid).toBe(false);
    expect(validation.errors).toContainEqual(expect.objectContaining({
      code: 'effect_required',
      path: 'effect_requests',
      related_ids: ['create_lead'],
    }));
  });

  test('rejects a primary request for a goal resolved by the same proposal', () => {
    const policy = compileV3TurnPolicy({
      ...policyFor('Necesito 100 bloques'),
      goals: [{ goal_id: 'quantity', status: 'unresolved' }],
      allowed_mutations: [{ operation: 'set', concept: 'quantity', field: 'quantity' }],
    });
    const validation = validateV3AiProposal(policy, {
      version: 'ai_conversation_proposal/v3',
      policy_digest: policy.policy_digest,
      reply_text: 'Anoté 100. ¿Qué cantidad necesitás?',
      primary_request: { goal_id: 'quantity' },
      catalog_resolution: noProductAssertion(),
      observations: [{
        id: 'obs:quantity',
        concept: 'quantity',
        raw_value: '100',
        normalized_value: 100,
        evidence_quote: '100',
        evidence_occurrence: 1,
        grounding_ref: null,
        resolves_goal_ids: ['quantity'],
      }],
      state_mutations: [{
        operation: 'set',
        field: 'quantity',
        observation_id: 'obs:quantity',
        replaces_fact_id: null,
      }],
      effect_requests: [],
    });

    expect(validation.valid).toBe(false);
    expect(validation.errors).toContainEqual(expect.objectContaining({
      code: 'primary_request_goal_resolved',
      path: 'primary_request.goal_id',
      related_ids: ['quantity'],
    }));
  });

  test('routes the conversation-159 repair to address instead of asking resolved service scope', () => {
    const message = 'Santiago, 30 mtl de cierro';
    const facts = [
      ['product', 'Pastelones'],
      ['service_scope', 'installation'],
      ['terrain', 'Plano'], ['truck_access', true], ['debris_removal', false],
    ].map(([field, value]) => ({
      fact_id: `fact:${field}`,
      field,
      value,
      mutability: 'customer_correctable',
      source: { message_id: 'previous', evidence_digest: 'a'.repeat(64) },
    }));
    const policy = compileV3TurnPolicy({
      ...policyFor(message),
      facts,
      goals: [
        { goal_id: 'product', status: 'resolved' },
        { goal_id: 'commune', status: 'unresolved' },
        { goal_id: 'quantity', status: 'unresolved' },
        { goal_id: 'service_scope', status: 'resolved' },
        { goal_id: 'address', status: 'unresolved' },
        { goal_id: 'terrain', status: 'resolved' },
        { goal_id: 'truck_access', status: 'resolved' },
        { goal_id: 'debris_removal', status: 'resolved' },
      ],
      allowed_mutations: [
        { operation: 'replace', concept: 'product', field: 'product', current_fact_id: 'fact:product' },
        { operation: 'set', concept: 'commune', field: 'commune' },
        { operation: 'set', concept: 'quantity', field: 'quantity' },
      ],
      grounding: {
        catalog: [{ ref: 'product:cierros-hormigon', concept: 'product', value: 'Cierros de Hormigón' }],
        modality_synonyms: [{ ref: 'service_scope:installation', concept: 'service_scope', value: 'installation' }],
      },
      effect_permissions: [{ type: 'create_lead' }],
      effect_requirements: [{
        effect_type: 'create_lead',
        required_goal_ids: ['product', 'commune', 'quantity', 'service_scope'],
        trigger: 'explicit_confirmation_when_ready',
      }],
    });
    const observations = [
      {
        id: 'obs:product', concept: 'product', raw_value: 'cierro',
        normalized_value: 'Cierros de Hormigón', evidence_quote: 'cierro',
        evidence_occurrence: 1, grounding_ref: 'product:cierros-hormigon', resolves_goal_ids: ['product'],
      },
      {
        id: 'obs:commune', concept: 'commune', raw_value: 'Santiago',
        normalized_value: 'Santiago', evidence_quote: 'Santiago', evidence_occurrence: 1,
        grounding_ref: null, resolves_goal_ids: ['commune'],
      },
      {
        id: 'obs:quantity', concept: 'quantity', raw_value: '30 mtl',
        normalized_value: { kind: 'quantity', value: 30, unit: 'mtl', name: '30 mtl' },
        evidence_quote: '30 mtl', evidence_occurrence: 1, grounding_ref: null,
        resolves_goal_ids: ['quantity'],
      },
    ];
    const validation = validateV3AiProposal(policy, {
      version: 'ai_conversation_proposal/v3',
      policy_digest: policy.policy_digest,
      reply_text: 'Anoté los cierros en Santiago. ¿Necesitás material o instalación?',
      primary_request: { goal_id: 'service_scope' },
      catalog_resolution: {
        status: 'matched', evidence_quote: 'cierro', evidence_occurrence: 1,
        grounding_ref: 'product:cierros-hormigon',
      },
      observations,
      state_mutations: [
        { operation: 'replace', field: 'product', observation_id: 'obs:product', replaces_fact_id: 'fact:product' },
        { operation: 'set', field: 'commune', observation_id: 'obs:commune', replaces_fact_id: null },
        { operation: 'set', field: 'quantity', observation_id: 'obs:quantity', replaces_fact_id: null },
      ],
      effect_requests: [],
    });

    expect(validation.valid).toBe(false);
    expect(validation.errors).toContainEqual(expect.objectContaining({
      code: 'primary_request_goal_resolved',
      related_ids: ['service_scope'],
      allowed_values: ['address'],
    }));
  });

  test('requires an explicit linear quantity to be persisted instead of only repeated in the reply', () => {
    const policy = compileV3TurnPolicy({
      ...policyFor('Santiago, 30 mtl de cierro'),
      goals: [{ goal_id: 'quantity', status: 'unresolved' }],
      grounding: {
        catalog: [{ ref: 'product:cierros-hormigon', concept: 'product', value: 'Cierros de Hormigón' }],
      },
    });
    const validation = validateV3AiProposal(policy, {
      version: 'ai_conversation_proposal/v3',
      policy_digest: policy.policy_digest,
      reply_text: 'Anoté los 30 metros lineales de cierro.',
      primary_request: null,
      catalog_resolution: {
        status: 'matched', evidence_quote: 'cierro', evidence_occurrence: 1,
        grounding_ref: 'product:cierros-hormigon',
      },
      observations: [], state_mutations: [], effect_requests: [],
    });

    expect(validation.valid).toBe(false);
    expect(validation.errors).toContainEqual(expect.objectContaining({
      code: 'quantity_observation_required',
      path: 'observations',
      allowed_values: ['quantity'],
    }));
  });

  test('allows the event-541 material request to ask the still-unresolved fulfillment goal', () => {
    const policy = compileV3TurnPolicy({
      ...policyFor('Necesito 120 bloques en Rancagua, solo material.'),
      goals: [
        { goal_id: 'product', status: 'unresolved' },
        { goal_id: 'commune', status: 'unresolved' },
        { goal_id: 'quantity', status: 'unresolved' },
        { goal_id: 'service_scope', status: 'unresolved' },
        { goal_id: 'fulfillment', status: 'unresolved' },
      ],
      allowed_mutations: [
        { operation: 'set', concept: 'product', field: 'product' },
        { operation: 'set', concept: 'commune', field: 'commune' },
        { operation: 'set', concept: 'quantity', field: 'quantity' },
        { operation: 'set', concept: 'service_scope', field: 'service_scope' },
      ],
      grounding: {
        catalog: [
          { ref: 'product:bloques', concept: 'product', value: 'Bloques de Hormigón' },
          { ref: 'service_scope:material', concept: 'service_scope', value: 'material' },
        ],
      },
    });
    const validation = validateV3AiProposal(policy, {
      version: 'ai_conversation_proposal/v3',
      policy_digest: policy.policy_digest,
      reply_text: 'Perfecto. ¿Preferís retiro o despacho?',
      primary_request: { goal_id: 'fulfillment' },
      catalog_resolution: {
        status: 'matched',
        evidence_quote: 'bloques',
        evidence_occurrence: 1,
        grounding_ref: 'product:bloques',
      },
      observations: [
        {
          id: 'obs:product', concept: 'product', raw_value: 'bloques',
          normalized_value: 'Bloques de Hormigón', evidence_quote: 'bloques',
          evidence_occurrence: 1, grounding_ref: 'product:bloques', resolves_goal_ids: ['product'],
        },
        {
          id: 'obs:commune', concept: 'commune', raw_value: 'Rancagua',
          normalized_value: 'Rancagua', evidence_quote: 'Rancagua',
          evidence_occurrence: 1, grounding_ref: null, resolves_goal_ids: ['commune'],
        },
        {
          id: 'obs:quantity', concept: 'quantity', raw_value: '120',
          normalized_value: 120, evidence_quote: '120', evidence_occurrence: 1,
          grounding_ref: null, resolves_goal_ids: ['quantity'],
        },
        {
          id: 'obs:service-scope', concept: 'service_scope', raw_value: 'solo material',
          normalized_value: 'material', evidence_quote: 'solo material', evidence_occurrence: 1,
          grounding_ref: 'service_scope:material', resolves_goal_ids: ['service_scope'],
        },
      ],
      state_mutations: [
        { operation: 'set', field: 'product', observation_id: 'obs:product', replaces_fact_id: null },
        { operation: 'set', field: 'commune', observation_id: 'obs:commune', replaces_fact_id: null },
        { operation: 'set', field: 'quantity', observation_id: 'obs:quantity', replaces_fact_id: null },
        { operation: 'set', field: 'service_scope', observation_id: 'obs:service-scope', replaces_fact_id: null },
      ],
      effect_requests: [],
    });

    expect(validation.errors).toEqual([]);
    expect(validation.valid).toBe(true);
    expect(validation.errors).not.toContainEqual(expect.objectContaining({
      code: 'primary_request_goal_resolved',
    }));
  });

  test('does not treat a generic confirmation as final while another question is pending', () => {
    const requiredGoals = ['product', 'commune', 'quantity', 'service_scope', 'fulfillment'];
    const base = policyFor('Confirmo que estos datos están correctos');
    const policy = compileV3TurnPolicy({
      ...base,
      turn: { ...base.turn, pending_question_goal_id: 'name' },
      facts: requiredGoals.map((field) => ({
        fact_id: `fact:${field}`,
        field,
        value: field === 'service_scope' ? 'material' : field === 'fulfillment' ? 'pickup' : field,
        mutability: 'customer_correctable',
        source: { message_id: 'previous', evidence_digest: 'a'.repeat(64) },
      })),
      goals: [...requiredGoals, 'name'].map((goal_id) => ({
        goal_id,
        status: requiredGoals.includes(goal_id) ? 'resolved' : 'unresolved',
      })),
      effect_permissions: [{ type: 'create_lead' }],
      effect_requirements: [{
        effect_type: 'create_lead',
        required_goal_ids: ['product', 'commune', 'quantity', 'service_scope'],
        trigger: 'explicit_confirmation_when_ready',
      }],
    });

    const validation = validateV3AiProposal(policy, {
      version: 'ai_conversation_proposal/v3',
      policy_digest: policy.policy_digest,
      reply_text: 'Gracias por confirmar.',
      primary_request: null,
      catalog_resolution: noProductAssertion(),
      observations: [],
      state_mutations: [],
      effect_requests: [{ type: 'create_lead', reason_observation_ids: [] }],
    });

    expect(validation.valid).toBe(false);
    expect(validation.errors).toContainEqual(expect.objectContaining({
      code: 'effect_trigger_context_invalid',
      path: 'effect_requests[0]',
    }));
  });

  test.each([
    'Correcto',
    'Perfecto',
    'Todo impecable, avancemos entonces',
    'Está todo bien por mi parte',
    'Bueno, hagámoslo',
  ])('authorizes Gemini semantic acceptance %j when final confirmation is pending', (message) => {
    const requiredGoals = ['product', 'commune', 'quantity', 'service_scope', 'fulfillment'];
    const base = policyFor(message);
    const policy = compileV3TurnPolicy({
      ...base,
      turn: { ...base.turn, pending_question_goal_id: 'final_confirmation' },
      facts: requiredGoals.map((field) => ({
        fact_id: `fact:${field}`,
        field,
        value: field === 'service_scope' ? 'material' : field === 'fulfillment' ? 'pickup' : field,
        mutability: 'customer_correctable',
        source: { message_id: 'previous', evidence_digest: 'a'.repeat(64) },
      })),
      goals: requiredGoals.map((goal_id) => ({ goal_id, status: 'resolved' })),
      effect_permissions: [{ type: 'create_lead' }],
      effect_requirements: [{
        effect_type: 'create_lead',
        required_goal_ids: ['product', 'commune', 'quantity', 'service_scope'],
        trigger: 'explicit_confirmation_when_ready',
      }],
    });

    const validation = validateV3AiProposal(policy, {
      version: 'ai_conversation_proposal/v3',
      policy_digest: policy.policy_digest,
      reply_text: 'Perfecto, registraré tu solicitud para revisión comercial.',
      primary_request: null,
      catalog_resolution: noProductAssertion(),
      observations: [],
      state_mutations: [],
      effect_requests: [{ type: 'create_lead', reason_observation_ids: [] }],
    });

    expect(validation.errors).toEqual([]);
    expect(validation.authorized_effect_requests).toEqual([
      { type: 'create_lead', reason_observation_ids: [] },
    ]);
  });

  test('blocks Gemini semantic acceptance when a create_lead prerequisite is unresolved', () => {
    const requiredGoals = ['product', 'commune', 'quantity', 'service_scope', 'fulfillment'];
    const base = policyFor('Perfecto, avancemos');
    const policy = compileV3TurnPolicy({
      ...base,
      turn: { ...base.turn, pending_question_goal_id: 'final_confirmation' },
      facts: requiredGoals.filter((field) => field !== 'quantity').map((field) => ({
        fact_id: `fact:${field}`,
        field,
        value: field === 'service_scope' ? 'material' : field === 'fulfillment' ? 'pickup' : field,
        mutability: 'customer_correctable',
        source: { message_id: 'previous', evidence_digest: 'a'.repeat(64) },
      })),
      goals: requiredGoals.map((goal_id) => ({
        goal_id,
        status: goal_id === 'quantity' ? 'unresolved' : 'resolved',
      })),
      effect_permissions: [{ type: 'create_lead' }],
      effect_requirements: [{
        effect_type: 'create_lead',
        required_goal_ids: requiredGoals,
        trigger: 'explicit_confirmation_when_ready',
      }],
    });

    const validation = validateV3AiProposal(policy, {
      version: 'ai_conversation_proposal/v3',
      policy_digest: policy.policy_digest,
      reply_text: 'Perfecto, registraré tu solicitud.',
      primary_request: null,
      catalog_resolution: noProductAssertion(),
      observations: [],
      state_mutations: [],
      effect_requests: [{ type: 'create_lead', reason_observation_ids: [] }],
    });

    expect(validation.valid).toBe(false);
    expect(validation.errors).toContainEqual(expect.objectContaining({
      code: 'effect_prerequisite_unresolved',
      path: 'effect_requests[0]',
      related_ids: ['quantity'],
    }));
  });

  test('accepts Gemini withholding create_lead for an explicit rejection', () => {
    const requiredGoals = ['product', 'commune', 'quantity', 'service_scope', 'fulfillment'];
    const message = 'No, la dirección está incorrecta';
    const base = policyFor(message);
    const policy = compileV3TurnPolicy({
      ...base,
      turn: { ...base.turn, pending_question_goal_id: 'final_confirmation' },
      facts: requiredGoals.map((field) => ({
        fact_id: `fact:${field}`,
        field,
        value: field === 'service_scope' ? 'material' : field === 'fulfillment' ? 'pickup' : field,
        mutability: 'customer_correctable',
        source: { message_id: 'previous', evidence_digest: 'a'.repeat(64) },
      })),
      goals: requiredGoals.map((goal_id) => ({ goal_id, status: 'resolved' })),
      effect_permissions: [{ type: 'create_lead' }],
      effect_requirements: [{
        effect_type: 'create_lead',
        required_goal_ids: requiredGoals,
        trigger: 'explicit_confirmation_when_ready',
      }],
    });

    const validation = validateV3AiProposal(policy, {
      version: 'ai_conversation_proposal/v3',
      policy_digest: policy.policy_digest,
      reply_text: 'Entendido, corrijamos los datos antes de continuar.',
      primary_request: null,
      catalog_resolution: noProductAssertion(),
      observations: [],
      state_mutations: [],
      effect_requests: [],
    });

    expect(validation.errors).toEqual([]);
    expect(validation.valid).toBe(true);
    expect(validation.authorized_effect_requests).toEqual([]);
  });

  test('accepts an evidenced correction while Gemini withholds create_lead', () => {
    const requiredGoals = ['product', 'commune', 'quantity', 'service_scope', 'fulfillment'];
    const message = 'En realidad necesito 600 ml, no 656';
    const base = policyFor(message);
    const policy = compileV3TurnPolicy({
      ...base,
      turn: { ...base.turn, pending_question_goal_id: 'final_confirmation' },
      facts: requiredGoals.map((field) => ({
        fact_id: `fact:${field}`,
        field,
        value: field === 'service_scope' ? 'material' : field === 'fulfillment' ? 'pickup' : field,
        mutability: 'customer_correctable',
        source: { message_id: 'previous', evidence_digest: 'a'.repeat(64) },
      })),
      goals: requiredGoals.map((goal_id) => ({ goal_id, status: 'resolved' })),
      allowed_mutations: [{
        operation: 'replace', concept: 'quantity', field: 'quantity', current_fact_id: 'fact:quantity',
      }],
      effect_permissions: [{ type: 'create_lead' }],
      effect_requirements: [{
        effect_type: 'create_lead',
        required_goal_ids: requiredGoals,
        trigger: 'explicit_confirmation_when_ready',
      }],
    });

    const validation = validateV3AiProposal(policy, {
      version: 'ai_conversation_proposal/v3',
      policy_digest: policy.policy_digest,
      reply_text: 'Entendido, actualicé la cantidad a 600 ml.',
      primary_request: null,
      catalog_resolution: noProductAssertion(),
      observations: [{
        id: 'obs:quantity-correction',
        concept: 'quantity',
        raw_value: '600 ml',
        normalized_value: { kind: 'quantity', value: 600, unit: 'ml', name: '600 ml' },
        evidence_quote: '600 ml',
        evidence_occurrence: 1,
        grounding_ref: null,
        resolves_goal_ids: ['quantity'],
      }],
      state_mutations: [{
        operation: 'replace',
        field: 'quantity',
        observation_id: 'obs:quantity-correction',
        replaces_fact_id: 'fact:quantity',
      }],
      effect_requests: [],
    });

    expect(validation.errors).toEqual([]);
    expect(validation.valid).toBe(true);
    expect(validation.authorized_mutations).toContainEqual(expect.objectContaining({
      operation: 'replace', field: 'quantity', projected_value: expect.objectContaining({ value: 600 }),
    }));
    expect(validation.authorized_effect_requests).toEqual([]);
  });

  test('does not ask pickup versus delivery for installation', () => {
    const base = policyFor('Necesito instalación');
    const policy = compileV3TurnPolicy({
      ...base,
      facts: [{
        fact_id: 'fact:service_scope', field: 'service_scope', value: 'installation',
        mutability: 'customer_correctable',
        source: { message_id: 'previous', evidence_digest: 'a'.repeat(64) },
      }],
      goals: [
        { goal_id: 'service_scope', status: 'resolved' },
        { goal_id: 'fulfillment', status: 'unresolved' },
      ],
    });

    const validation = validateV3AiProposal(policy, {
      version: 'ai_conversation_proposal/v3',
      policy_digest: policy.policy_digest,
      reply_text: '¿Preferís retiro o despacho?',
      primary_request: { goal_id: 'fulfillment' },
      catalog_resolution: noProductAssertion(),
      observations: [], state_mutations: [], effect_requests: [],
    });

    expect(validation.errors).toContainEqual(expect.objectContaining({
      code: 'primary_request_goal_inapplicable',
      path: 'primary_request.goal_id',
    }));
  });

  test('represents both commercial proposals without collapsing them into one scope', () => {
    const message = 'Quiero ambas propuestas: solo material y también con instalación';
    const policy = compileV3TurnPolicy({
      ...policyFor(message),
      goals: [
        { goal_id: 'service_scope', status: 'unresolved' },
        { goal_id: 'fulfillment', status: 'unresolved' },
      ],
      allowed_mutations: [{ operation: 'set', concept: 'service_scope', field: 'service_scope' }],
      grounding: { modality_synonyms: [
        { ref: 'service_scope:both', concept: 'service_scope', value: 'both' },
      ] },
    });

    const validation = validateV3AiProposal(policy, {
      version: 'ai_conversation_proposal/v3',
      policy_digest: policy.policy_digest,
      reply_text: 'Prepararemos ambas alternativas. ¿Para el material preferís retiro o despacho?',
      primary_request: { goal_id: 'fulfillment' },
      catalog_resolution: noProductAssertion(),
      observations: [{
        id: 'obs:scope', concept: 'service_scope', raw_value: 'ambas propuestas',
        normalized_value: 'both', evidence_quote: 'ambas propuestas', evidence_occurrence: 1,
        grounding_ref: 'service_scope:both', resolves_goal_ids: ['service_scope'],
      }],
      state_mutations: [{
        operation: 'set', field: 'service_scope', observation_id: 'obs:scope', replaces_fact_id: null,
      }],
      effect_requests: [],
    });

    expect(validation.errors).toEqual([]);
    expect(validation.authorized_mutations[0].projected_value).toBe('both');
  });

  test('rejects both when the evidence only says installation', () => {
    const message = 'Necesito 100 bloques con instalación en Santiago';
    const policy = compileV3TurnPolicy({
      ...policyFor(message),
      goals: [{ goal_id: 'service_scope', status: 'unresolved' }],
      allowed_mutations: [{ operation: 'set', concept: 'service_scope', field: 'service_scope' }],
      grounding: { modality_synonyms: [
        { ref: 'service_scope:material', concept: 'service_scope', value: 'material' },
        { ref: 'service_scope:installation', concept: 'service_scope', value: 'installation' },
        { ref: 'service_scope:both', concept: 'service_scope', value: 'both' },
      ] },
    });
    const validation = validateV3AiProposal(policy, {
      version: 'ai_conversation_proposal/v3', policy_digest: policy.policy_digest,
      reply_text: 'Entendido.', primary_request: null,
      catalog_resolution: noProductAssertion(),
      observations: [{
        id: 'obs:scope', concept: 'service_scope', raw_value: 'instalación',
        normalized_value: 'both', evidence_quote: 'instalación', evidence_occurrence: 1,
        grounding_ref: 'service_scope:both', resolves_goal_ids: ['service_scope'],
      }],
      state_mutations: [{
        operation: 'set', field: 'service_scope', observation_id: 'obs:scope', replaces_fact_id: null,
      }],
      effect_requests: [],
    });

    expect(validation.errors).toContainEqual(expect.objectContaining({
      code: 'service_scope_both_evidence_invalid',
      path: 'observations[0].grounding_ref',
    }));
  });

  test('accepts natural material-and-installation wording as explicit both evidence', () => {
    const message = 'Necesito 40 pastelones: quiero el material y también la instalación';
    const policy = compileV3TurnPolicy({
      ...policyFor(message),
      goals: [{ goal_id: 'service_scope', status: 'unresolved' }],
      allowed_mutations: [{ operation: 'set', concept: 'service_scope', field: 'service_scope' }],
      grounding: { modality_synonyms: [
        { ref: 'service_scope:both', concept: 'service_scope', value: 'both' },
      ] },
    });
    const validation = validateV3AiProposal(policy, {
      version: 'ai_conversation_proposal/v3', policy_digest: policy.policy_digest,
      reply_text: 'Entendido. Prepararemos las dos alternativas.', primary_request: null,
      catalog_resolution: noProductAssertion(),
      observations: [{
        id: 'obs:scope', concept: 'service_scope',
        raw_value: 'material y también la instalación', normalized_value: 'both',
        evidence_quote: 'material y también la instalación', evidence_occurrence: 1,
        grounding_ref: 'service_scope:both', resolves_goal_ids: ['service_scope'],
      }],
      state_mutations: [{
        operation: 'set', field: 'service_scope', observation_id: 'obs:scope', replaces_fact_id: null,
      }],
      effect_requests: [],
    });

    expect(validation.errors).toEqual([]);
    expect(validation.authorized_mutations[0].projected_value).toBe('both');
  });

  test('rejects a generic acknowledgement as fulfillment evidence', () => {
    const message = 'Ok, dale';
    const policy = compileV3TurnPolicy({
      ...policyFor(message),
      goals: [
        { goal_id: 'fulfillment', status: 'unresolved' },
        { goal_id: 'address', status: 'unresolved' },
      ],
      allowed_mutations: [{ operation: 'set', concept: 'fulfillment', field: 'fulfillment' }],
      grounding: { modality_synonyms: [
        { ref: 'fulfillment:delivery', concept: 'fulfillment', value: 'delivery' },
      ] },
    });
    const validation = validateV3AiProposal(policy, {
      version: 'ai_conversation_proposal/v3', policy_digest: policy.policy_digest,
      reply_text: 'Perfecto. Indicame la dirección.', primary_request: { goal_id: 'address' },
      catalog_resolution: noProductAssertion(),
      observations: [{
        id: 'obs:fulfillment', concept: 'fulfillment', raw_value: 'dale',
        normalized_value: 'delivery', evidence_quote: 'dale', evidence_occurrence: 1,
        grounding_ref: 'fulfillment:delivery', resolves_goal_ids: ['fulfillment'],
      }],
      state_mutations: [{
        operation: 'set', field: 'fulfillment', observation_id: 'obs:fulfillment', replaces_fact_id: null,
      }],
      effect_requests: [],
    });

    expect(validation.errors).toContainEqual(expect.objectContaining({
      code: 'fulfillment_evidence_invalid',
      path: 'observations[0].grounding_ref',
    }));
  });

  test('accepts an explicit natural delivery choice as fulfillment evidence', () => {
    const message = 'Me lo pueden llevar a la obra, por favor';
    const policy = compileV3TurnPolicy({
      ...policyFor(message),
      goals: [
        { goal_id: 'fulfillment', status: 'unresolved' },
        { goal_id: 'address', status: 'unresolved' },
      ],
      allowed_mutations: [{ operation: 'set', concept: 'fulfillment', field: 'fulfillment' }],
      grounding: { modality_synonyms: [
        { ref: 'fulfillment:delivery', concept: 'fulfillment', value: 'delivery' },
      ] },
    });
    const validation = validateV3AiProposal(policy, {
      version: 'ai_conversation_proposal/v3', policy_digest: policy.policy_digest,
      reply_text: 'Perfecto. ¿Cuál es la dirección?', primary_request: { goal_id: 'address' },
      catalog_resolution: noProductAssertion(),
      observations: [{
        id: 'obs:fulfillment', concept: 'fulfillment', raw_value: 'llevar a la obra',
        normalized_value: 'delivery', evidence_quote: 'llevar a la obra', evidence_occurrence: 1,
        grounding_ref: 'fulfillment:delivery', resolves_goal_ids: ['fulfillment'],
      }],
      state_mutations: [{
        operation: 'set', field: 'fulfillment', observation_id: 'obs:fulfillment', replaces_fact_id: null,
      }],
      effect_requests: [],
    });

    expect(validation.errors).toEqual([]);
  });

  test('blocks unreceipted quote and delivery progress claims', () => {
    const validateReply = (replyText) => {
      const input = buildV3PolicyInput({
        inbound_event_id: 'claim-turn', conversation_id: 'claim-conversation',
        text_body: 'Gracias', qualification_context: {},
      });
      const policy = compileV3TurnPolicy(input);
      return validateV3AiProposal(policy, {
        version: 'ai_conversation_proposal/v3', policy_digest: policy.policy_digest,
        reply_text: replyText, primary_request: null,
        catalog_resolution: noProductAssertion(), observations: [],
        state_mutations: [], effect_requests: [],
      });
    };

    expect(validateReply('Tu cotización ya está en proceso.').errors).toContainEqual(
      expect.objectContaining({ code: 'forbidden_claim', related_ids: ['no_unreceipted_quote_progress'] }),
    );
    expect(validateReply('Coordinaremos todo para que recibas tu material pronto.').errors).toContainEqual(
      expect.objectContaining({ code: 'forbidden_claim', related_ids: ['no_unreceipted_delivery_progress'] }),
    );
  });

  test('keeps a sanitized prior request outside current facts, goals and mutation authority', () => {
    const input = buildV3PolicyInput({
      inbound_event_id: 'repeat-turn',
      conversation_id: 'new-conversation',
      text_body: 'Quiero cotizar lo mismo',
      qualification_context: {},
      reference_context: {
        prior_request: {
          lead_id: 404,
          source_conversation_id: 303,
          completed_at: '2026-09-08T12:00:00.000Z',
          lead_status_code: 'qualified',
          values: {
            product: 'Cierros de Hormigón',
            service_scope: 'both',
            fulfillment: 'delivery',
            private_internal_key: 'must-not-leak',
          },
          phone_number: '56999999999',
        },
      },
    });
    const policy = compileV3TurnPolicy(input);

    expect(policy.reference_context.prior_request).toEqual({
      lead_id: '404',
      source_conversation_id: '303',
      completed_at: '2026-09-08T12:00:00.000Z',
      lead_status_code: 'qualified',
      values: {
        product: 'Cierros de Hormigón',
        service_scope: 'both',
        fulfillment: 'delivery',
      },
    });
    expect(policy.facts).toEqual([]);
    expect(policy.goals.find(({ goal_id }) => goal_id === 'product').status).toBe('unresolved');
    expect(policy.state_authority.allowed_mutations.find(({ field }) => field === 'product'))
      .toMatchObject({ operation: 'set', field: 'product' });
    expect(policy.reference_context.prior_request).not.toHaveProperty('phone_number');
    expect(policy.reference_context.prior_request.values).not.toHaveProperty('private_internal_key');
  });

  test('allows lexical guard bypasses only for exact values in prior_request with current evidence', () => {
    const message = 'Hazme otra idéntica a esa';
    const policy = compileV3TurnPolicy({
      ...policyFor(message),
      facts: [
        ['commune', 'Santiago'],
        ['terrain', 'Plano'], ['truck_access', true], ['debris_removal', false],
        ['access_restrictions', 'Sin restricciones'],
      ].map(([field, value]) => ({ fact_id: `fact:${field}`, field, value,
        mutability: 'customer_correctable', source: { message_id: 'previous', evidence_digest: 'previous-evidence' } })),
      reference_context: { prior_request: {
        lead_id: '404',
        values: { service_scope: 'both', fulfillment: 'delivery', commune: 'Santiago', address: 'Pismonte 124' },
      } },
      goals: [
        { goal_id: 'commune', status: 'resolved' },
        { goal_id: 'service_scope', status: 'unresolved' },
        { goal_id: 'fulfillment', status: 'unresolved' },
        { goal_id: 'address', status: 'unresolved' },
        ...['terrain', 'truck_access', 'debris_removal', 'access_restrictions']
          .map((goal_id) => ({ goal_id, status: 'resolved' })),
      ],
      allowed_mutations: [
        { operation: 'set', concept: 'service_scope', field: 'service_scope' },
        { operation: 'set', concept: 'fulfillment', field: 'fulfillment' },
        { operation: 'set', concept: 'address', field: 'address' },
      ],
      grounding: { modality_synonyms: [
        { ref: 'service_scope:both', concept: 'service_scope', value: 'both' },
        { ref: 'fulfillment:delivery', concept: 'fulfillment', value: 'delivery' },
        { ref: 'fulfillment:pickup', concept: 'fulfillment', value: 'pickup' },
      ] },
    });
    const proposal = {
      version: 'ai_conversation_proposal/v3', policy_digest: policy.policy_digest,
      reply_text: 'Entendido. Te resumo la solicitud anterior para que confirmes los datos.',
      primary_request: { goal_id: 'final_confirmation' },
      catalog_resolution: noProductAssertion(),
      observations: [
        {
          id: 'obs:scope', concept: 'service_scope', raw_value: 'idéntica a esa',
          normalized_value: 'both', evidence_quote: 'idéntica a esa', evidence_occurrence: 1,
          grounding_ref: 'service_scope:both', resolves_goal_ids: ['service_scope'],
        },
        {
          id: 'obs:fulfillment', concept: 'fulfillment', raw_value: 'idéntica a esa',
          normalized_value: 'delivery', evidence_quote: 'idéntica a esa', evidence_occurrence: 1,
          grounding_ref: 'fulfillment:delivery', resolves_goal_ids: ['fulfillment'],
        },
        {
          id: 'obs:address', concept: 'address', raw_value: 'idéntica a esa',
          normalized_value: 'Pismonte 124', evidence_quote: 'idéntica a esa', evidence_occurrence: 1,
          grounding_ref: null, resolves_goal_ids: ['address'],
        },
      ],
      state_mutations: [
        { operation: 'set', field: 'service_scope', observation_id: 'obs:scope', replaces_fact_id: null },
        { operation: 'set', field: 'fulfillment', observation_id: 'obs:fulfillment', replaces_fact_id: null },
        { operation: 'set', field: 'address', observation_id: 'obs:address', replaces_fact_id: null },
      ],
      effect_requests: [],
    };

    expect(validateV3AiProposal(policy, proposal).errors).toEqual([]);

    const nonExact = compileV3TurnPolicy({
      ...policyFor(message),
      reference_context: { prior_request: {
        lead_id: '404', values: { service_scope: 'both', fulfillment: 'pickup', address: 'Pismonte 124' },
      } },
      goals: policy.goals,
      allowed_mutations: policy.state_authority.allowed_mutations,
      grounding: policy.grounding,
    });
    const rejected = validateV3AiProposal(nonExact, { ...proposal, policy_digest: nonExact.policy_digest });
    expect(rejected.errors).toContainEqual(expect.objectContaining({ code: 'fulfillment_evidence_invalid' }));
  });

  test('accepts an exact structured prior quantity copy regardless of object key order', () => {
    const message = 'Quiero cotizar lo mismo';
    const priorQuantity = { kind: 'linear', value: 656, unit: 'ml', name: null };
    const policy = compileV3TurnPolicy({
      ...policyFor(message),
      reference_context: { prior_request: {
        lead_id: '405', values: { quantity: priorQuantity },
      } },
      goals: [{ goal_id: 'quantity', status: 'unresolved' }],
      allowed_mutations: [{ operation: 'set', concept: 'quantity', field: 'quantity' }],
    });
    const proposal = {
      version: 'ai_conversation_proposal/v3', policy_digest: policy.policy_digest,
      reply_text: 'Entendido. Voy a resumirte la solicitud antes de confirmar.',
      primary_request: null,
      catalog_resolution: noProductAssertion(),
      observations: [{
        id: 'obs:quantity', concept: 'quantity', raw_value: 'lo mismo',
        normalized_value: { unit: 'ml', name: null, value: 656, kind: 'linear' },
        evidence_quote: 'lo mismo', evidence_occurrence: 1,
        grounding_ref: null, resolves_goal_ids: ['quantity'],
      }],
      state_mutations: [{
        operation: 'set', field: 'quantity', observation_id: 'obs:quantity', replaces_fact_id: null,
      }],
      effect_requests: [],
    };

    const validation = validateV3AiProposal(policy, proposal);
    expect(validation.errors).toEqual([]);
    expect(validation.authorized_mutations[0].projected_value).toEqual(priorQuantity);
  });

  test('requires a fresh final confirmation before creating a lead from prior-request hydration', () => {
    const message = 'Crea una solicitud igual a la anterior';
    const priorQuantity = { kind: 'linear', value: 656, unit: 'ml', name: null };
    const policy = compileV3TurnPolicy({
      ...policyFor(message),
      reference_context: { prior_request: {
        lead_id: '406', values: { quantity: priorQuantity },
      } },
      goals: [{ goal_id: 'quantity', status: 'unresolved' }],
      allowed_mutations: [{ operation: 'set', concept: 'quantity', field: 'quantity' }],
      effect_permissions: [{ type: 'create_lead' }],
      effect_requirements: [{
        effect_type: 'create_lead', required_goal_ids: ['quantity'],
        trigger: 'explicit_confirmation_when_ready',
      }],
    });
    const validation = validateV3AiProposal(policy, {
      version: 'ai_conversation_proposal/v3', policy_digest: policy.policy_digest,
      reply_text: 'Te resumo la solicitud repetida. ¿Confirmás que está correcta?',
      primary_request: { goal_id: 'final_confirmation' },
      catalog_resolution: noProductAssertion(),
      observations: [{
        id: 'obs:quantity', concept: 'quantity', raw_value: 'igual a la anterior',
        normalized_value: { unit: 'ml', value: 656, name: null, kind: 'linear' },
        evidence_quote: 'igual a la anterior', evidence_occurrence: 1,
        grounding_ref: null, resolves_goal_ids: ['quantity'],
      }],
      state_mutations: [{
        operation: 'set', field: 'quantity', observation_id: 'obs:quantity', replaces_fact_id: null,
      }],
      effect_requests: [{ type: 'create_lead', reason_observation_ids: ['obs:quantity'] }],
    });

    expect(validation.errors).toContainEqual(expect.objectContaining({
      code: 'effect_trigger_context_invalid',
      path: 'effect_requests[0]',
    }));
    expect(validation.errors).not.toContainEqual(expect.objectContaining({ code: 'effect_required' }));
    expect(validation.authorized_effect_requests).toEqual([]);
  });

  test('does not mistake an explicit same-number different-unit value for prior hydration', () => {
    const message = 'Crea una solicitud de 656 m2';
    const policy = compileV3TurnPolicy({
      ...policyFor(message),
      reference_context: { prior_request: {
        lead_id: '407',
        values: { quantity: { kind: 'linear', value: 656, unit: 'ml', name: null } },
      } },
      goals: [{ goal_id: 'quantity', status: 'unresolved' }],
      allowed_mutations: [{ operation: 'set', concept: 'quantity', field: 'quantity' }],
      effect_permissions: [{ type: 'create_lead' }],
      effect_requirements: [{
        effect_type: 'create_lead', required_goal_ids: ['quantity'],
        trigger: 'explicit_confirmation_when_ready',
      }],
    });
    const validation = validateV3AiProposal(policy, {
      version: 'ai_conversation_proposal/v3', policy_digest: policy.policy_digest,
      reply_text: 'Registraré la solicitud indicada.', primary_request: null,
      catalog_resolution: noProductAssertion(),
      observations: [{
        id: 'obs:quantity', concept: 'quantity', raw_value: '656 m2',
        normalized_value: { kind: 'area', value: 656, unit: 'm2', name: null },
        evidence_quote: '656 m2', evidence_occurrence: 1,
        grounding_ref: null, resolves_goal_ids: ['quantity'],
      }],
      state_mutations: [{
        operation: 'set', field: 'quantity', observation_id: 'obs:quantity', replaces_fact_id: null,
      }],
      effect_requests: [{ type: 'create_lead', reason_observation_ids: ['obs:quantity'] }],
    });

    expect(validation.errors).toEqual([]);
    expect(validation.authorized_effect_requests).toHaveLength(1);
  });


  test('does not globally forbid optional questions before the commercial request is ready', () => {
    const policy = compileV3TurnPolicy({
      ...policyFor('Quiero consultar'),
      goals: [
        { goal_id: 'product', status: 'unresolved' },
        { goal_id: 'name', status: 'unresolved' },
      ],
    });
    const validation = validateV3AiProposal(policy, {
      version: 'ai_conversation_proposal/v3', policy_digest: policy.policy_digest,
      reply_text: 'Gracias. ¿Cómo preferís que te llamemos?',
      primary_request: { goal_id: 'name' },
      catalog_resolution: noProductAssertion(), observations: [],
      state_mutations: [], effect_requests: [],
    });

    expect(validation.errors).toEqual([]);
  });
});
