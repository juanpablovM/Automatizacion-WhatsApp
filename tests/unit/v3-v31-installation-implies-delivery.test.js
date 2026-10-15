import fs from 'node:fs';
import { createRequire } from 'node:module';
import { describe, expect, test } from 'vitest';
import { buildTurnPolicy } from '../ops/v3-line-items-live-replay.mjs';

const require = createRequire(import.meta.url);
const { validateV3AiProposal, V3_CONTRACTS } = require('../fixtures/workflow-nodes/shared/v3-contract-runtime.js');
const { buildV3LeadEffect } = require('../fixtures/workflow-nodes/wa-conversation-orchestrator/build-v3-lead-effect.js');

// -----------------------------------------------------------------------------
// Task 3c.24 (owner rule from 3c.12: installation is only offered with
// delivery). Live conversations 388 and 389 (2026-09-30, sanitized here):
// service_scope=both ("Ambas opciones" / "Ambos") made `fulfillment` a required
// goal, so after the installation questions the bot asked "¿confirmas que
// entreguemos el material en <dirección>?" four or five times. Every bare "Si"
// was correctly refused as fulfillment evidence (fulfillment_evidence_invalid
// protects pickup/delivery from a generic acknowledgement), so the proposal
// recorded nothing and asked again, until the bot asked the customer to type
// "despacho". With installation in scope delivery is the only valid fulfillment,
// so v3.1 never asks it: the goal is not required and asking it is rejected.
// -----------------------------------------------------------------------------

const GROUNDING = Object.freeze({
  catalog: [
    { ref: 'product:pastelones', concept: 'product', value: 'Pastelones' },
    { ref: 'product:cierros-hormigon', concept: 'product', value: 'Cierros de Hormigón' },
  ],
});
const ITEM = 'li_pastelones';
const installationContext = (overrides = {}) => ({
  product: 'Pastelones',
  quantity: '500 unidades',
  measurements: null,
  line_items: [{
    item_id: ITEM, product: 'Pastelones', quantity: '500 unidades', measurements: null, catalog_ref: null, requested_label: null,
  }],
  line_items_schema: 'line_items/v1',
  line_items_projection: { product: 'Pastelones', quantity: '500 unidades', measurements: null },
  service_scope: 'both',
  commune: 'Lo Barnechea',
  address: 'Calle Uno 123',
  terrain: 'Desnivelado',
  truck_access: 'Hasta cierto punto, luego carga manual',
  access_restrictions: 'Hasta cierto punto, luego carga manual',
  ...overrides,
});
const codes = (validation) => validation.errors.map((error) => error.code);
const proposal = (policy, overrides = {}) => ({
  version: V3_CONTRACTS.proposal_v3_1,
  policy_digest: policy.policy_digest,
  reply_text: 'Gracias, lo dejo anotado.\n\n¿Está todo correcto?',
  primary_request: null,
  catalog_resolutions: [],
  observations: [],
  state_mutations: [],
  effect_requests: [],
  ...overrides,
});
const debrisAnswer = {
  observations: [{
    id: 'obs_debris_removal', concept: 'debris_removal', item_ref: null, raw_value: 'Si', normalized_value: 'Sí',
    evidence_quote: 'Si', evidence_occurrence: 1, grounding_ref: null, resolves_goal_ids: ['debris_removal'],
  }],
  state_mutations: [{
    operation: 'set', field: 'debris_removal', item_ref: null, observation_id: 'obs_debris_removal', replaces_fact_id: null,
  }],
};

describe.each(['both', 'installation'])('v3.1 policy: service_scope=%s never requires fulfillment', (scope) => {
  test('the fulfillment goal is optional and create_lead does not require it', () => {
    const policy = buildTurnPolicy('v3.1', installationContext({ service_scope: scope }), GROUNDING, { text: 'Si' });
    const goal = policy.goals.find((entry) => entry.goal_id === 'fulfillment');
    expect(goal).toMatchObject({ status: 'unresolved', importance: 'optional', blocks_effects: [] });
    const createLead = policy.effect_authority.requirements.find((entry) => entry.effect_type === 'create_lead');
    expect(createLead.required_goal_ids).not.toContain('fulfillment');
    for (const goalId of ['commune', 'address', 'terrain', 'truck_access', 'debris_removal']) {
      expect(createLead.required_goal_ids).toContain(goalId);
    }
  });
});

describe('v3 (rollback path) keeps its policy unchanged', () => {
  test('service_scope=both still requires fulfillment in v3', () => {
    const policy = buildTurnPolicy('v3', installationContext(), GROUNDING, { text: 'Si' });
    const createLead = policy.effect_authority.requirements.find((entry) => entry.effect_type === 'create_lead');
    expect(createLead.required_goal_ids).toContain('fulfillment');
    expect(policy.goals.find((entry) => entry.goal_id === 'fulfillment').importance).toBe('required_for_effect');
  });
});

describe('v3.1 validator: conv 388/389 replay, scope both goes straight to the next real goal', () => {
  const debrisTurn = () => buildTurnPolicy('v3.1', installationContext(), GROUNDING, {
    text: 'Si', pendingQuestionKey: 'debris_removal',
  });

  test('after the last installation answer, asking the delivery confirmation is rejected', () => {
    const policy = debrisTurn();
    const validation = validateV3AiProposal(policy, proposal(policy, {
      ...debrisAnswer,
      reply_text: 'Gracias, anoto el retiro de escombros.\n\n¿Confirmas que entreguemos el material en Calle Uno 123?',
      primary_request: { goal_id: 'fulfillment', item_ref: null },
    }));
    expect(validation.valid).toBe(false);
    expect(codes(validation)).toEqual(['primary_request_goal_inapplicable']);
    const [error] = validation.errors;
    expect(error.disposition).toBe('repairable');
    expect(error.allowed_values).toEqual(['final_confirmation']);
    expect(error.instruction).toContain('implies delivery');
  });

  test('after the last installation answer, final_confirmation is ready without fulfillment', () => {
    const policy = debrisTurn();
    const validation = validateV3AiProposal(policy, proposal(policy, {
      ...debrisAnswer,
      primary_request: { goal_id: 'final_confirmation', item_ref: null },
    }));
    expect(codes(validation)).toEqual([]);
    expect(validation.valid).toBe(true);
  });

  test('an in-flight conversation pending on fulfillment moves to final_confirmation on a bare "Si"', () => {
    const policy = buildTurnPolicy('v3.1', installationContext({ debris_removal: 'Sí' }), GROUNDING, {
      text: 'Si', pendingQuestionKey: 'fulfillment',
    });
    const validation = validateV3AiProposal(policy, proposal(policy, {
      primary_request: { goal_id: 'final_confirmation', item_ref: null },
    }));
    expect(codes(validation)).toEqual([]);
    expect(validation.valid).toBe(true);
  });

  test('a bare "Si" is still never fulfillment evidence (protection kept)', () => {
    const policy = buildTurnPolicy('v3.1', installationContext({ debris_removal: 'Sí' }), GROUNDING, {
      text: 'Si', pendingQuestionKey: 'fulfillment',
    });
    const validation = validateV3AiProposal(policy, proposal(policy, {
      primary_request: { goal_id: 'final_confirmation', item_ref: null },
      observations: [{
        id: 'obs_fulfillment', concept: 'fulfillment', item_ref: null, raw_value: 'Si', normalized_value: 'delivery',
        evidence_quote: 'Si', evidence_occurrence: 1, grounding_ref: 'fulfillment:delivery', resolves_goal_ids: ['fulfillment'],
      }],
      state_mutations: [{ operation: 'set', field: 'fulfillment', item_ref: null, observation_id: 'obs_fulfillment', replaces_fact_id: null }],
    }));
    expect(codes(validation)).toContain('fulfillment_evidence_invalid');
    expect(validation.valid).toBe(false);
  });

  test('the confirmed summary creates the lead without fulfillment', () => {
    const policy = buildTurnPolicy('v3.1', installationContext({ debris_removal: 'Sí' }), GROUNDING, {
      text: 'Esta perfecto', pendingQuestionKey: 'confirm',
    });
    const validation = validateV3AiProposal(policy, proposal(policy, {
      reply_text: '¡Gracias por confirmar!\n\nTu solicitud quedó registrada.',
      effect_requests: [{ type: 'create_lead', reason_observation_ids: [] }],
    }));
    expect(codes(validation)).toEqual([]);
    expect(validation.valid).toBe(true);
    expect(validation.authorized_effect_requests.map((effect) => effect.type)).toEqual(['create_lead']);
  });

  test('an explicit delivery mention is still recorded', () => {
    const policy = buildTurnPolicy('v3.1', installationContext({ debris_removal: 'Sí' }), GROUNDING, {
      text: 'Sí, con despacho a la obra',
    });
    const validation = validateV3AiProposal(policy, proposal(policy, {
      primary_request: { goal_id: 'final_confirmation', item_ref: null },
      observations: [{
        id: 'obs_fulfillment', concept: 'fulfillment', item_ref: null, raw_value: 'con despacho', normalized_value: 'delivery',
        evidence_quote: 'con despacho', evidence_occurrence: 1, grounding_ref: 'fulfillment:delivery', resolves_goal_ids: ['fulfillment'],
      }],
      state_mutations: [{ operation: 'set', field: 'fulfillment', item_ref: null, observation_id: 'obs_fulfillment', replaces_fact_id: null }],
    }));
    expect(codes(validation)).toEqual([]);
    expect(validation.authorized_mutations.map((mutation) => mutation.field)).toEqual(['fulfillment']);
  });
});

describe('v3.1 validator: material-only still needs fulfillment, pickup + installation still rejected', () => {
  test('material-only asks pickup versus delivery as before', () => {
    const policy = buildTurnPolicy('v3.1', installationContext({ service_scope: 'material', terrain: null, truck_access: null }), GROUNDING, {
      text: 'Solo material',
    });
    const validation = validateV3AiProposal(policy, proposal(policy, {
      reply_text: 'Perfecto.\n\n¿Prefieres despacho o retiro en fábrica?',
      primary_request: { goal_id: 'fulfillment', item_ref: null },
    }));
    expect(codes(validation)).toEqual([]);
    const createLead = policy.effect_authority.requirements.find((entry) => entry.effect_type === 'create_lead');
    expect(createLead.required_goal_ids).toContain('fulfillment');
  });

  test('a persisted both + pickup conflict is still rejected and may still ask fulfillment to correct it', () => {
    const policy = buildTurnPolicy('v3.1', installationContext({ fulfillment: 'pickup', debris_removal: 'Sí' }), GROUNDING, {
      text: 'Continuemos',
    });
    const withEffect = validateV3AiProposal(policy, proposal(policy, {
      effect_requests: [{ type: 'create_lead', reason_observation_ids: [] }],
    }));
    expect(codes(withEffect)).toContain('installation_requires_delivery');
    const clarification = validateV3AiProposal(policy, proposal(policy, {
      reply_text: 'La instalación requiere despacho.\n\n¿Prefieres despacho o solo material con retiro?',
      primary_request: { goal_id: 'fulfillment', item_ref: null },
    }));
    expect(codes(clarification)).toEqual([]);
    expect(clarification.valid).toBe(true);
  });
});

describe('v3.1 prompt: no contradictory delivery instruction', () => {
  const systemPrompt = (version) => {
    const source = fs.readFileSync('tests/fixtures/workflow-nodes/ai-lead-qualification-assistant/build-ai-request.js', 'utf8');
    const turnPolicy = buildTurnPolicy(version, installationContext(), GROUNDING, { text: 'Si' });
    const output = new Function('items', '$env', source)(
      [{ json: { contract_version: 'v3', turn_policy: turnPolicy } }],
      { AI_PROVIDER: 'openai', OPENAI_API_KEY: 'fake-key-123' },
    );
    return output[0].json.ai_request.input[0].content;
  };

  test('v3.1 never asks fulfillment for material and installation together', () => {
    const prompt = systemPrompt('v3.1');
    expect(prompt).not.toContain('Si service_scope es material o both, necesitas resolver fulfillment');
    expect(prompt).not.toContain('Si service_scope es material o both: fulfillment.');
    expect(prompt).toContain('Si service_scope es material, necesitas resolver fulfillment');
    expect(prompt).toContain('Si service_scope es material: fulfillment.');
    expect(prompt).toContain('nunca preguntes por fulfillment ni pidas confirmar el despacho');
  });

  test('v3 keeps its prompt lines', () => {
    const prompt = systemPrompt('v3');
    expect(prompt).toContain('Si service_scope es material o both, necesitas resolver fulfillment');
    expect(prompt).toContain('Si service_scope es material o both: fulfillment.');
  });
});

describe('lead effect: installation implies delivery', () => {
  const turn = (context) => ({
    operation_key: 'v3-lead:installation', conversation_id: 7, phone_number: '15550001111', source_number_id: 2,
    qualification_context: context,
    v3_decision: { version: 'validated_conversation_decision/v3.1', state_mutations: [] },
  });

  test.each([
    ['both', 'material e instalacion'],
    ['installation', 'instalacion'],
  ])('scope %s without fulfillment reaches the lead as delivery', (scope, service) => {
    const lead = buildV3LeadEffect(turn(installationContext({ service_scope: scope, debris_removal: 'Sí' })));
    expect(lead.service).toBe(service);
    expect(lead.qualification_context.fulfillment).toBe('delivery');
    expect(JSON.parse(lead.qualification_context_json).fulfillment).toBe('delivery');
  });

  test('material-only without fulfillment is not invented', () => {
    const lead = buildV3LeadEffect(turn(installationContext({ service_scope: 'material' })));
    expect(lead.qualification_context.fulfillment).toBeUndefined();
  });

  test('an explicit fulfillment is never overwritten', () => {
    const lead = buildV3LeadEffect(turn(installationContext({ service_scope: 'both', fulfillment: 'pickup' })));
    expect(lead.qualification_context.fulfillment).toBe('pickup');
  });
});
