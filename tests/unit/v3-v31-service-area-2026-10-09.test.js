import { createRequire } from 'node:module';
import { describe, expect, test } from 'vitest';
import { buildTurnPolicy } from '../ops/v3-line-items-live-replay.mjs';

const require = createRequire(import.meta.url);
const { validateV3AiProposal, V3_CONTRACTS } = require('../fixtures/workflow-nodes/shared/v3-contract-runtime.js');

// -----------------------------------------------------------------------------
// Task 3c.34 — owner rule 2026-10-09: Hormiglass delivers and installs only in
// the Región Metropolitana and the comunas of Viña del Mar, Valparaíso,
// Concepción and Rancagua. Material-only factory pickup (San
// Bernardo) is accepted from anywhere. A delivery or installation quote for a
// recognized comuna outside that area must not continue (address, terrain,
// truck access, debris, access restrictions, final confirmation, create_lead);
// the reply tells the customer the area limit and, for material only, offers
// factory pickup. An unrecognized comuna is left to commune_not_recognized.
// -----------------------------------------------------------------------------

const GROUNDING = Object.freeze({ catalog: [{ ref: 'product:cemento', concept: 'product', value: 'Cemento' }] });
const LIMIT_REPLY = 'Lamentablemente por ahora no alcanzamos a llegar a *Temuco*: hacemos despachos e instalaciones en la *Región Metropolitana*, *Viña del Mar*, *Valparaíso*, *Concepción* y *Rancagua*.\n\nSi te sirve, puedes retirar el material en nuestra fábrica en San Bernardo.\n\n¿Te acomoda retirarlo?';
// Conversation 444: the installation "no" offers the real alternative (the
// material alone, picked up at the factory) without a pickup-with-installation.
const INSTALLATION_LIMIT_REPLY = 'Lamentablemente por ahora no alcanzamos a llegar a *Temuco*: hacemos despachos e instalaciones en la *Región Metropolitana*, *Viña del Mar*, *Valparaíso*, *Concepción* y *Rancagua*.\n\nSi te sirve, podemos cotizarte solo el material, sin instalación, para que lo retires en nuestra fábrica en San Bernardo.';
const LIMIT_INSTRUCTION = (commune) => `Lamentablemente por ahora no alcanzamos a llegar a *${commune}*: hacemos despachos e instalaciones en la *Región Metropolitana*, *Viña del Mar*, *Valparaíso*, *Concepción* y *Rancagua*.`;
const ADDRESS_REPLY = 'Anoto la comuna.\n\n¿Cuál es la calle y el número?';

const item = () => ({
  item_id: 'li_c', product: 'Cemento', quantity: { kind: 'quantity', name: null, unit: 'unidades', value: 10 },
  measurements: null, catalog_ref: null, requested_label: null,
});
const context = (overrides) => ({ line_items: [item()], line_items_schema: 'line_items/v1', ...overrides });
const proposal = (policy, overrides = {}) => ({
  version: V3_CONTRACTS.proposal_v3_1,
  policy_digest: policy.policy_digest,
  reply_text: ADDRESS_REPLY,
  primary_request: { goal_id: 'address', item_ref: null },
  catalog_resolutions: [],
  observations: [],
  state_mutations: [],
  effect_requests: [],
  ...overrides,
});
const observation = (id, concept, quote, normalizedValue) => ({
  id, concept, raw_value: quote, normalized_value: normalizedValue, evidence_quote: quote,
  evidence_occurrence: 1, grounding_ref: null, resolves_goal_ids: [], item_ref: null,
});
const setMutation = (field, observationId) => ({
  operation: 'set', field, item_ref: null, observation_id: observationId, replaces_fact_id: null,
});
const codes = (validation) => validation.errors.map((error) => error.code);

// The customer names the comuna in this turn and the proposal asks for the address.
const communeThisTurn = (scope, value) => {
  const policy = buildTurnPolicy('v3.1', context(scope), GROUNDING, { text: value, pendingQuestionKey: 'commune' });
  return validateV3AiProposal(policy, proposal(policy, {
    observations: [observation('obs_c', 'commune', value, value)],
    state_mutations: [setMutation('commune', 'obs_c')],
  }));
};
const DELIVERY = { service_scope: 'material', fulfillment: 'delivery' };
const INSTALLATION = { service_scope: 'installation' };
const BOTH = { service_scope: 'both', fulfillment: 'delivery' };

describe('inside the service area the quote continues', () => {
  test.each(['Maipú', 'Puente Alto', 'Chicureo', 'Santiago', 'Viña del Mar', 'Reñaca', 'San Bernardo', 'Valparaíso', 'Concepción', 'Rancagua'])(
    'delivery to %s may ask for the address',
    (commune) => { expect(codes(communeThisTurn(DELIVERY, commune))).toEqual([]); },
  );

  test.each(['Colina', 'Viña del Mar', 'Rancagua'])('installation in %s may ask for the address', (commune) => {
    expect(codes(communeThisTurn(INSTALLATION, commune))).toEqual([]);
  });
});

describe('outside the service area a delivery or installation quote does not continue', () => {
  test.each(['Talca', 'Castro', 'Temuco', 'Quilpué', 'San Antonio'])('delivery to %s cannot ask for the address', (commune) => {
    const validation = communeThisTurn(DELIVERY, commune);
    expect(codes(validation)).toEqual(['service_area_unsupported']);
    const [error] = validation.errors;
    expect(error.disposition).toBe('repairable');
    expect(error.path).toBe('primary_request.goal_id');
    expect(error.instruction).toContain(LIMIT_INSTRUCTION(commune));
    expect(error.instruction).toContain('Si te sirve, puedes retirar el material en nuestra fábrica en San Bernardo.');
    expect(error.allowed_values).toEqual(['fulfillment']);
  });

  test.each([[INSTALLATION, 'installation'], [BOTH, 'both']])('installation (%o) in Talca is rejected without a pickup offer', (scope) => {
    const validation = communeThisTurn(scope, 'Talca');
    expect(codes(validation)).toEqual(['service_area_unsupported']);
    const [error] = validation.errors;
    expect(error.instruction).toContain(LIMIT_INSTRUCTION('Talca'));
    expect(error.instruction).not.toContain('Si te sirve, puedes retirar el material');
    expect(error.instruction).toContain('Do not offer factory pickup with installation');
    expect(error.instruction).toContain('Si te sirve, podemos cotizarte solo el material, sin instalación, para que lo retires en nuestra fábrica en San Bernardo.');
    expect(error.instruction).toContain('Use primary_request null');
    expect(error.allowed_values).toEqual([]);
  });

  const persisted = (scope, goalId, overrides = {}) => {
    const policy = buildTurnPolicy('v3.1', context({ ...scope, commune: 'Temuco' }), GROUNDING, { text: 'ok' });
    return validateV3AiProposal(policy, proposal(policy, { primary_request: goalId ? { goal_id: goalId, item_ref: null } : null, ...overrides }));
  };

  test.each(['address', 'access_restrictions', 'final_confirmation'])('a persisted out-of-area delivery cannot ask %s', (goalId) => {
    expect(codes(persisted(DELIVERY, goalId))).toContain('service_area_unsupported');
  });

  test.each(['terrain', 'truck_access', 'debris_removal'])('a persisted out-of-area installation cannot ask %s', (goalId) => {
    expect(codes(persisted(INSTALLATION, goalId))).toContain('service_area_unsupported');
  });

  test('a create_lead request is rejected for an out-of-area delivery', () => {
    const validation = persisted(DELIVERY, null, { effect_requests: [{ type: 'create_lead', reason_observation_ids: [], sheet_ref: null }] });
    const error = validation.errors.find((entry) => entry.code === 'service_area_unsupported');
    expect(error).toBeDefined();
    expect(error.path).toBe('effect_requests[0]');
    expect(validation.authorized_effect_requests).toEqual([]);
  });

  test('informing the limit and offering pickup (asking fulfillment) is allowed', () => {
    expect(codes(persisted(DELIVERY, 'fulfillment', { reply_text: LIMIT_REPLY }))).toEqual([]);
  });

  test('informing the limit with no request is allowed', () => {
    expect(codes(persisted(DELIVERY, null, { reply_text: LIMIT_REPLY }))).toEqual([]);
    expect(codes(persisted(INSTALLATION, null, { reply_text: INSTALLATION_LIMIT_REPLY }))).toEqual([]);
  });

  test('installation out of area cannot ask fulfillment to offer pickup', () => {
    expect(codes(persisted(INSTALLATION, 'fulfillment', { reply_text: LIMIT_REPLY }))).not.toEqual([]);
  });
});

describe('material-only factory pickup is accepted from anywhere', () => {
  test.each(['Talca', 'Castro', 'Temuco'])('pickup with comuna %s may ask for final confirmation', (commune) => {
    const policy = buildTurnPolicy('v3.1', context({ service_scope: 'material', fulfillment: 'pickup', commune }), GROUNDING, { text: 'ok' });
    const validation = validateV3AiProposal(policy, proposal(policy, {
      reply_text: '*Resumen de tu cotización*\n\n• Cemento — 10 unidades\n\n*Retiro en fábrica*\nPortezuelo 1502, San Bernardo\n\n¿Está todo correcto?',
      primary_request: { goal_id: 'final_confirmation', item_ref: null },
    }));
    expect(codes(validation)).not.toContain('service_area_unsupported');
  });

  test('switching an out-of-area delivery to pickup clears the block in the same turn', () => {
    const policy = buildTurnPolicy('v3.1', context({ ...DELIVERY, commune: 'Talca' }), GROUNDING, { text: 'ok, lo retiro en fábrica', pendingQuestionKey: 'fulfillment' });
    const validation = validateV3AiProposal(policy, proposal(policy, {
      reply_text: '*Resumen de tu cotización*\n\n• Cemento — 10 unidades\n\n*Retiro en fábrica*\nPortezuelo 1502, San Bernardo\n\n¿Está todo correcto?',
      primary_request: { goal_id: 'final_confirmation', item_ref: null },
      observations: [{ ...observation('obs_f', 'fulfillment', 'lo retiro en fábrica', 'pickup'), grounding_ref: 'fulfillment:pickup' }],
      state_mutations: [{ operation: 'replace', field: 'fulfillment', item_ref: null, observation_id: 'obs_f', replaces_fact_id: 'fact:fulfillment' }],
    }));
    expect(codes(validation)).not.toContain('service_area_unsupported');
  });
});

describe('an unrecognized comuna is not judged by the service area', () => {
  test('a province is rejected only as commune_not_recognized', () => {
    expect(codes(communeThisTurn(DELIVERY, 'Chiloé'))).toEqual(['commune_not_recognized']);
  });
});
