import { createRequire } from 'node:module';
import { describe, expect, test } from 'vitest';
import { buildTurnPolicy } from '../ops/v3-line-items-live-replay.mjs';

const require = createRequire(import.meta.url);
const {
  validateV3AiProposal, authorizeV3ConversationDecision, V3_CONTRACTS,
} = require('../fixtures/workflow-nodes/shared/v3-contract-runtime.js');

// -----------------------------------------------------------------------------
// Live v3.1 2026-10-13 (controlled phone). Turn 1: "quiero que me instalen 30
// metros de cierro de hormigón en Temuco". The bot correctly refused the
// out-of-area installation, but the turn still committed commune=Temuco and
// service_scope=installation. Turn 2 asked a material + pickup quote for
// another product and the bot asked about the terrain: the policy compiled
// from the stale installation scope kept terrain/truck_access/debris_removal
// as create_lead goals, and the projected service_scope=material of the turn
// never removed them.
//
// Owner direction: a refused out-of-area delivery/installation leaves no
// service or destination state behind (commune, service_scope, fulfillment,
// the legacy service and the installation/delivery details are withheld, not
// committed). The requested items stay, so "sí, solo el material y lo
// retiro" continues the quote with service_scope=material and
// fulfillment=pickup. Installation goals depend only on the current scope.
// -----------------------------------------------------------------------------

const GROUNDING = Object.freeze({
  catalog: [
    { ref: 'product:cemento', concept: 'product', value: 'Cemento' },
    { ref: 'service:instalacion', concept: 'service', value: 'Instalación' },
  ],
});
const INSTALLATION_LIMIT_REPLY = 'Lamentablemente por ahora no alcanzamos a llegar a *Temuco*: hacemos despachos e instalaciones en la *Región Metropolitana*, *Viña del Mar*, *Valparaíso*, *Concepción* y *Rancagua*.\n\nSi te sirve, podemos cotizarte solo el material, sin instalación, para que lo retires en nuestra fábrica en San Bernardo.';
const DELIVERY_LIMIT_REPLY = 'Lamentablemente por ahora no alcanzamos a llegar a *Temuco*: hacemos despachos e instalaciones en la *Región Metropolitana*, *Viña del Mar*, *Valparaíso*, *Concepción* y *Rancagua*.\n\nSi te sirve, puedes retirar el material en nuestra fábrica en San Bernardo.\n\n¿Te acomoda retirarlo?';
const PICKUP_SUMMARY = '*Resumen de tu cotización*\n\n• Cemento — 10 unidades\n\n*Retiro en fábrica*\nPortezuelo 1502, San Bernardo\n\n¿Está todo correcto?';
const QUANTITY = Object.freeze({ kind: 'quantity', name: null, unit: 'unidades', value: 10 });

const observation = (id, concept, quote, normalizedValue, extra = {}) => ({
  id, concept, raw_value: quote, normalized_value: normalizedValue, evidence_quote: quote,
  evidence_occurrence: 1, grounding_ref: null, resolves_goal_ids: [], item_ref: null, ...extra,
});
const mutation = (field, observationId, extra = {}) => ({
  operation: 'set', field, item_ref: null, observation_id: observationId, replaces_fact_id: null, ...extra,
});
const proposal = (policy, overrides = {}) => ({
  version: V3_CONTRACTS.proposal_v3_1,
  policy_digest: policy.policy_digest,
  reply_text: INSTALLATION_LIMIT_REPLY,
  primary_request: null,
  catalog_resolutions: [],
  observations: [],
  state_mutations: [],
  effect_requests: [],
  ...overrides,
});
const codes = (validation) => validation.errors.map((error) => error.code);
const fields = (mutations) => mutations.map((entry) => entry.field);

// First turn: a new item plus the requested service and comuna.
const firstTurn = (text, serviceObservations, serviceMutations, overrides = {}) => {
  const policy = buildTurnPolicy('v3.1', {}, GROUNDING, { text });
  const candidate = proposal(policy, {
    catalog_resolutions: [{
      item_ref: 'new:1', status: 'matched', evidence_quote: 'cemento', evidence_occurrence: 1, grounding_ref: 'product:cemento',
    }],
    observations: [
      observation('obs_p', 'product', 'cemento', 'Cemento', { item_ref: 'new:1', grounding_ref: 'product:cemento' }),
      observation('obs_q', 'quantity', '10 unidades', QUANTITY, { item_ref: 'new:1' }),
      observation('obs_c', 'commune', 'Temuco', 'Temuco'),
      ...serviceObservations,
    ],
    state_mutations: [
      mutation('product', 'obs_p', { item_ref: 'new:1' }),
      mutation('quantity', 'obs_q', { item_ref: 'new:1' }),
      mutation('commune', 'obs_c'),
      ...serviceMutations,
    ],
    ...overrides,
  });
  const validation = validateV3AiProposal(policy, candidate);
  return { policy, candidate, validation };
};

const installationTurn = (commune = 'Temuco') => {
  const text = `Hola, quiero 10 unidades de cemento con instalación en ${commune}`;
  const result = firstTurn(text, [
    observation('obs_s', 'service_scope', 'instalación', 'installation', { grounding_ref: 'service_scope:installation' }),
    observation('obs_sv', 'service', 'instalación', 'Instalación', { grounding_ref: 'service:instalacion' }),
  ], [mutation('service_scope', 'obs_s'), mutation('service', 'obs_sv')]);
  return result;
};

describe('a refused out-of-area request leaves no service or destination state', () => {
  test('installation in Temuco: the items commit, the comuna and the installation scope are withheld', () => {
    const { policy, candidate, validation } = installationTurn();
    expect(codes(validation)).toEqual([]);
    expect(validation.valid).toBe(true);
    expect(fields(validation.authorized_mutations)).toEqual(['product', 'quantity']);
    expect(fields(validation.withheld_mutations).sort()).toEqual(['commune', 'service', 'service_scope']);

    const decision = authorizeV3ConversationDecision(policy, candidate, validation);
    expect(fields(decision.state_mutations)).toEqual(['product', 'quantity']);
    expect(fields(decision.withheld_mutations).sort()).toEqual(['commune', 'service', 'service_scope']);
  });

  test('the repair instruction tells the model what the refusal turn records', () => {
    const { validation } = installationTurn();
    const policy = buildTurnPolicy('v3.1', lineItems({ commune: 'Temuco', service_scope: 'installation' }), GROUNDING, { text: 'ok' });
    const repaired = validateV3AiProposal(policy, proposal(policy, { primary_request: { goal_id: 'terrain', item_ref: null } }));
    expect(validation.valid).toBe(true);
    const error = repaired.errors.find((entry) => entry.code === 'service_area_unsupported');
    expect(error.instruction).toContain('This turn records only the requested products, their quantities and the customer\'s name; the comuna, the service, the installation and the delivery are not recorded.');
  });

  test('material delivery to Temuco offering pickup: the delivery and the comuna are withheld', () => {
    const { validation } = firstTurn('Hola, quiero 10 unidades de cemento con despacho a Temuco', [
      observation('obs_s', 'service_scope', 'cemento', 'material', { grounding_ref: 'service_scope:material', evidence_occurrence: 1 }),
      observation('obs_f', 'fulfillment', 'despacho', 'delivery', { grounding_ref: 'fulfillment:delivery' }),
    ], [mutation('service_scope', 'obs_s'), mutation('fulfillment', 'obs_f')], {
      reply_text: DELIVERY_LIMIT_REPLY,
      primary_request: { goal_id: 'fulfillment', item_ref: null },
    });
    expect(codes(validation)).toEqual([]);
    expect(fields(validation.authorized_mutations)).toEqual(['product', 'quantity']);
    expect(fields(validation.withheld_mutations).sort()).toEqual(['commune', 'fulfillment', 'service_scope']);
  });

  test('the customer name given in the same message is still recorded', () => {
    const policy = buildTurnPolicy('v3.1', {}, GROUNDING, { text: 'Soy Ana, quiero 10 unidades de cemento con instalación en Temuco' });
    const validation = validateV3AiProposal(policy, proposal(policy, {
      catalog_resolutions: [{
        item_ref: 'new:1', status: 'matched', evidence_quote: 'cemento', evidence_occurrence: 1, grounding_ref: 'product:cemento',
      }],
      observations: [
        observation('obs_n', 'name', 'Ana', 'Ana'),
        observation('obs_p', 'product', 'cemento', 'Cemento', { item_ref: 'new:1', grounding_ref: 'product:cemento' }),
        observation('obs_q', 'quantity', '10 unidades', QUANTITY, { item_ref: 'new:1' }),
        observation('obs_c', 'commune', 'Temuco', 'Temuco'),
        observation('obs_s', 'service_scope', 'instalación', 'installation', { grounding_ref: 'service_scope:installation' }),
      ],
      state_mutations: [
        mutation('name', 'obs_n'),
        mutation('product', 'obs_p', { item_ref: 'new:1' }),
        mutation('quantity', 'obs_q', { item_ref: 'new:1' }),
        mutation('commune', 'obs_c'),
        mutation('service_scope', 'obs_s'),
      ],
    }));
    expect(codes(validation)).toEqual([]);
    expect(fields(validation.authorized_mutations)).toEqual(['name', 'product', 'quantity']);
    expect(fields(validation.withheld_mutations).sort()).toEqual(['commune', 'service_scope']);
  });

  test('inside the service area the same installation request commits everything', () => {
    const policy = buildTurnPolicy('v3.1', {}, GROUNDING, { text: 'Hola, quiero 10 unidades de cemento con instalación en Maipú' });
    const validation = validateV3AiProposal(policy, proposal(policy, {
      reply_text: 'Perfecto.\n\n¿Cuál es la dirección de la obra?',
      primary_request: { goal_id: 'address', item_ref: null },
      catalog_resolutions: [{
        item_ref: 'new:1', status: 'matched', evidence_quote: 'cemento', evidence_occurrence: 1, grounding_ref: 'product:cemento',
      }],
      observations: [
        observation('obs_p', 'product', 'cemento', 'Cemento', { item_ref: 'new:1', grounding_ref: 'product:cemento' }),
        observation('obs_q', 'quantity', '10 unidades', QUANTITY, { item_ref: 'new:1' }),
        observation('obs_c', 'commune', 'Maipú', 'Maipú'),
        observation('obs_s', 'service_scope', 'instalación', 'installation', { grounding_ref: 'service_scope:installation' }),
      ],
      state_mutations: [
        mutation('product', 'obs_p', { item_ref: 'new:1' }),
        mutation('quantity', 'obs_q', { item_ref: 'new:1' }),
        mutation('commune', 'obs_c'),
        mutation('service_scope', 'obs_s'),
      ],
    }));
    expect(codes(validation)).toEqual([]);
    expect(fields(validation.authorized_mutations)).toEqual(['product', 'quantity', 'commune', 'service_scope']);
    expect(validation.withheld_mutations).toEqual([]);
  });
});

const item = (overrides = {}) => ({
  item_id: 'li_c', product: 'Cemento', quantity: QUANTITY, measurements: null, catalog_ref: null, requested_label: null, ...overrides,
});
const lineItems = (overrides = {}) => ({ line_items: [item()], line_items_schema: 'line_items/v1', ...overrides });
const materialPickupTurn = (context, text, overrides = {}) => {
  const policy = buildTurnPolicy('v3.1', context, GROUNDING, { text });
  const scopeFact = policy.facts.find((fact) => fact.field === 'service_scope');
  const fulfillmentFact = policy.facts.find((fact) => fact.field === 'fulfillment');
  const write = (field, observationId, fact) => (fact
    ? mutation(field, observationId, { operation: 'replace', replaces_fact_id: fact.fact_id })
    : mutation(field, observationId));
  return validateV3AiProposal(policy, proposal(policy, {
    reply_text: PICKUP_SUMMARY,
    primary_request: { goal_id: 'final_confirmation', item_ref: null },
    observations: [
      observation('obs_s', 'service_scope', 'solo el material', 'material', {
        grounding_ref: 'service_scope:material', resolves_goal_ids: ['service_scope'],
      }),
      observation('obs_f', 'fulfillment', 'lo retiro', 'pickup', { grounding_ref: 'fulfillment:pickup', resolves_goal_ids: ['fulfillment'] }),
    ],
    state_mutations: [write('service_scope', 'obs_s', scopeFact), write('fulfillment', 'obs_f', fulfillmentFact)],
    ...overrides,
  }));
};

describe('accepting the real alternative continues the quote', () => {
  test('after the refusal only the items persisted: "sí, solo el material y lo retiro" reaches final confirmation', () => {
    const validation = materialPickupTurn(lineItems(), 'Sí, solo el material y lo retiro en fábrica');
    expect(codes(validation)).toEqual([]);
    expect(fields(validation.authorized_mutations)).toEqual(['service_scope', 'fulfillment']);
    expect(validation.withheld_mutations).toEqual([]);
  });
});

describe('installation goals depend only on the current service_scope', () => {
  // Live turn 2 state: the stale installation scope, the out-of-area comuna and
  // the legacy service were committed before this fix.
  const staleInstallation = lineItems({ commune: 'Temuco', service: 'Instalación', service_scope: 'installation' });
  const inAreaInstallation = lineItems({ commune: 'Maipú', service_scope: 'installation' });

  test.each([['stale out-of-area', staleInstallation], ['in-area', inAreaInstallation]])(
    'a %s installation switched to material + pickup may ask final confirmation',
    (_label, context) => {
      expect(codes(materialPickupTurn(context, 'Mejor solo el material y lo retiro en fábrica'))).toEqual([]);
    },
  );

  test.each(['terrain', 'truck_access', 'debris_removal'])(
    'a quote switched to material + pickup cannot ask %s',
    (goalId) => {
      const validation = materialPickupTurn(staleInstallation, 'Mejor solo el material y lo retiro en fábrica', {
        reply_text: 'Perfecto.\n\n¿Qué tipo de terreno tienes previsto para el proyecto?',
        primary_request: { goal_id: goalId, item_ref: null },
      });
      expect(codes(validation)).toEqual(['primary_request_goal_inapplicable']);
      const [error] = validation.errors;
      expect(error.related_ids).toEqual([goalId, 'material']);
      expect(error.allowed_values).toEqual(['final_confirmation']);
    },
  );

  test.each(['terrain', 'truck_access', 'debris_removal'])('a committed material quote cannot ask %s', (goalId) => {
    const policy = buildTurnPolicy('v3.1', lineItems({ service_scope: 'material', fulfillment: 'pickup' }), GROUNDING, { text: 'Hola' });
    const validation = validateV3AiProposal(policy, proposal(policy, {
      reply_text: 'Hola.\n\n¿Qué tipo de terreno tienes previsto para el proyecto?',
      primary_request: { goal_id: goalId, item_ref: null },
    }));
    expect(codes(validation)).toContain('primary_request_goal_inapplicable');
  });

  test.each(['terrain', 'truck_access', 'debris_removal'])('an installation quote may still ask %s', (goalId) => {
    const policy = buildTurnPolicy('v3.1', lineItems({ service_scope: 'installation', commune: 'Maipú', address: 'Calle Uno 100' }), GROUNDING, { text: 'Hola' });
    const validation = validateV3AiProposal(policy, proposal(policy, {
      reply_text: 'Hola.\n\n¿Me cuentas un poco más de la obra?',
      primary_request: { goal_id: goalId, item_ref: null },
    }));
    expect(codes(validation)).not.toContain('primary_request_goal_inapplicable');
  });
});
