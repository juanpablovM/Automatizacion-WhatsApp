import { createRequire } from 'node:module';
import { describe, expect, test } from 'vitest';
import { buildTurnPolicy } from '../ops/v3-line-items-live-replay.mjs';

const require = createRequire(import.meta.url);
const {
  validateV3AiProposal, authorizeV3ConversationDecision, V3_CONTRACTS,
} = require('../fixtures/workflow-nodes/shared/v3-contract-runtime.js');

// -----------------------------------------------------------------------------
// Task 3c.33 — QA review of live conversations 387-393 (2026-09-30), v3.1 only.
//   M1  the variant the customer chooses is recorded on its item (`variant`).
//   M2  a quoted product whose technical sheet lists 2+ variants needs a chosen
//       variant before final_confirmation (products without variants never do).
//   M3  an item quantity needs a unit; a bare number is asked again.
//   M6  the full summary is not resent when nothing changed since the last one.
//   L1  internal documents ("fichas editables", file names) are never named.
//   L2  a commune must be one of Chile's 346 comunas ("Chiloé" is a province).
// Variant names below are synthetic placeholders, never private sheet data.
// -----------------------------------------------------------------------------

const GROUNDING = Object.freeze({
  catalog: [
    {
      ref: 'product:pastelones', concept: 'product', value: 'Pastelones',
      technical_sheet: { variants: [{ name: 'Formato Uno' }, { name: 'Formato Dos' }] },
    },
    {
      ref: 'product:soleras', concept: 'product', value: 'Soleras y Solerillas',
      technical_sheet: { variants: [{ name: 'Solera Tipo Uno' }, { name: 'Solera Zarpa' }] },
    },
    { ref: 'product:cemento', concept: 'product', value: 'Cemento' },
    {
      ref: 'product:alambre', concept: 'product', value: 'Alambre de Púas',
      technical_sheet: { variants: [{ name: 'Alambre único' }] },
    },
  ],
});

const PICKUP_REPLY = 'Gracias.\n\n*Resumen de tu cotización*\n\n*Productos*\n• Pastelones — 100 m²\n\n*Retiro en fábrica*\nPortezuelo 1502, San Bernardo\n\n¿Está todo correcto?';
const quantity = (value, unit) => ({ kind: 'quantity', name: null, unit, value });
const item = (itemId, product, overrides = {}) => ({
  item_id: itemId, product, quantity: quantity(100, 'm²'), measurements: null,
  catalog_ref: null, requested_label: null, ...overrides,
});
const pickupContext = (items) => ({
  service_scope: 'material', fulfillment: 'pickup', line_items: items, line_items_schema: 'line_items/v1',
});
const proposal = (policy, overrides = {}) => ({
  version: V3_CONTRACTS.proposal_v3_1,
  policy_digest: policy.policy_digest,
  reply_text: PICKUP_REPLY,
  primary_request: { goal_id: 'final_confirmation', item_ref: null },
  catalog_resolutions: [],
  observations: [],
  state_mutations: [],
  effect_requests: [],
  ...overrides,
});
const observation = (id, concept, quote, normalizedValue, itemRef = null) => ({
  id, concept, raw_value: quote, normalized_value: normalizedValue, evidence_quote: quote,
  evidence_occurrence: 1, grounding_ref: null, resolves_goal_ids: [], item_ref: itemRef,
});
const setMutation = (field, observationId, itemRef = null) => ({
  operation: 'set', field, item_ref: itemRef, observation_id: observationId, replaces_fact_id: null,
});
const codes = (validation) => validation.errors.map((error) => error.code);

describe('M1/M2: variant of a product with several technical-sheet variants', () => {
  test('the v3.1 policy lists variant options for quoted products and authorizes variant mutations', () => {
    const policy = buildTurnPolicy('v3.1', pickupContext([item('li_p', 'Pastelones'), item('li_c', 'Cemento')]), GROUNDING, { text: 'hola' });
    const pastelones = policy.grounding.catalog.find((entry) => entry.ref === 'product:pastelones');
    const cemento = policy.grounding.catalog.find((entry) => entry.ref === 'product:cemento');
    expect(pastelones.variant_options).toEqual(['Formato Uno', 'Formato Dos']);
    expect(cemento).not.toHaveProperty('variant_options');
    expect(policy.state_authority.allowed_mutations).toEqual(expect.arrayContaining([
      { operation: 'set', concept: 'variant', field: 'variant' },
      { operation: 'replace', concept: 'variant', field: 'variant' },
    ]));
    expect(policy.goals.find((goal) => goal.goal_id === 'line_items').status).toBe('unresolved');
  });

  test('v3 never sees variant options or variant authority', () => {
    const policy = buildTurnPolicy('v3', pickupContext([item('li_p', 'Pastelones')]), GROUNDING, { text: 'hola' });
    expect(JSON.stringify(policy)).not.toContain('variant_options');
    expect(policy.state_authority.allowed_mutations.some((entry) => entry.field === 'variant')).toBe(false);
  });

  test('final_confirmation is not ready while a multi-variant product has no chosen variant', () => {
    const policy = buildTurnPolicy('v3.1', pickupContext([item('li_p', 'Pastelones')]), GROUNDING, { text: 'Anotaste bien?' });
    const validation = validateV3AiProposal(policy, proposal(policy));
    expect(validation.valid).toBe(false);
    const error = validation.errors.find((entry) => entry.code === 'final_confirmation_not_ready');
    expect(error.allowed_values).toContain('variant@li_p');
    expect(error.instruction).toContain('Formato Uno');
    expect(error.instruction).toContain('"goal_id": "variant", "item_ref": "li_p"');
  });

  test('a product without variants (or with one) never blocks final_confirmation', () => {
    const policy = buildTurnPolicy('v3.1', pickupContext([item('li_c', 'Cemento'), item('li_a', 'Alambre de Púas')]), GROUNDING, { text: 'ok' });
    const validation = validateV3AiProposal(policy, proposal(policy, {
      reply_text: PICKUP_REPLY.replace('• Pastelones — 100 m²', '• Cemento — 100 m²\n• Alambre de Púas — 100 m²'),
    }));
    expect(codes(validation)).toEqual([]);
  });

  test('a chosen variant from the options is authorized on its item and unblocks final_confirmation', () => {
    const policy = buildTurnPolicy('v3.1', pickupContext([item('li_p', 'Pastelones')]), GROUNDING, { text: 'el formato dos', pendingQuestionKey: 'variant' });
    const candidate = proposal(policy, {
      observations: [observation('obs_v', 'variant', 'formato dos', 'Formato Dos', 'li_p')],
      state_mutations: [setMutation('variant', 'obs_v', 'li_p')],
    });
    const validation = validateV3AiProposal(policy, candidate);
    expect(codes(validation)).toEqual([]);
    expect(validation.authorized_mutations).toEqual([expect.objectContaining({ field: 'variant', item_ref: 'li_p', projected_value: 'Formato Dos' })]);
    const decision = authorizeV3ConversationDecision(policy, candidate, validation);
    expect(decision.state_mutations[0]).toMatchObject({ field: 'variant', item_id: 'li_p' });
  });

  test('a variant outside the listed options is rejected with the options as allowed values', () => {
    const policy = buildTurnPolicy('v3.1', pickupContext([item('li_s', 'Soleras y Solerillas')]), GROUNDING, { text: 'tipo cuadrada' });
    const validation = validateV3AiProposal(policy, proposal(policy, {
      primary_request: null,
      reply_text: 'Anoto la solera cuadrada.',
      observations: [observation('obs_v', 'variant', 'tipo cuadrada', 'Solera Cuadrada', 'li_s')],
      state_mutations: [setMutation('variant', 'obs_v', 'li_s')],
    }));
    expect(codes(validation)).toContain('item_variant_unknown');
    expect(validation.errors.find((entry) => entry.code === 'item_variant_unknown').allowed_values)
      .toEqual(['Solera Tipo Uno', 'Solera Zarpa']);
  });

  test('the variant question is an item-scoped primary_request', () => {
    const policy = buildTurnPolicy('v3.1', pickupContext([item('li_p', 'Pastelones')]), GROUNDING, { text: 'pastelones por favor' });
    const validation = validateV3AiProposal(policy, proposal(policy, {
      reply_text: '¿Qué formato de *Pastelones* necesitas: *Formato Uno* o *Formato Dos*?',
      primary_request: { goal_id: 'variant', item_ref: 'li_p' },
    }));
    expect(codes(validation)).toEqual([]);
  });
});

describe('M3: an item quantity needs a unit', () => {
  test('a bare number is rejected and asked again', () => {
    const policy = buildTurnPolicy('v3.1', pickupContext([item('li_c', 'Cemento', { quantity: null })]), GROUNDING, { text: '33', pendingQuestionKey: 'quantity' });
    const validation = validateV3AiProposal(policy, proposal(policy, {
      primary_request: null,
      reply_text: 'Anoto 33.',
      observations: [observation('obs_q', 'quantity', '33', quantity(33, null), 'li_c')],
      state_mutations: [setMutation('quantity', 'obs_q', 'li_c')],
    }));
    expect(codes(validation)).toEqual(['quantity_unit_required']);
    const error = validation.errors[0];
    expect(error.related_ids).toEqual(['obs_q']);
    expect(error.instruction).toContain('"goal_id": "quantity", "item_ref": "li_c"');
  });

  test.each([
    ['33 unidades', quantity(33, 'unidades')],
    ['33 sacos', '33 sacos'],
  ])('%s keeps its unit', (quote, value) => {
    const policy = buildTurnPolicy('v3.1', pickupContext([item('li_c', 'Cemento', { quantity: null })]), GROUNDING, { text: quote, pendingQuestionKey: 'quantity' });
    const validation = validateV3AiProposal(policy, proposal(policy, {
      primary_request: null,
      reply_text: 'Anotado.',
      observations: [observation('obs_q', 'quantity', quote, value, 'li_c')],
      state_mutations: [setMutation('quantity', 'obs_q', 'li_c')],
    }));
    expect(codes(validation)).toEqual([]);
  });

  test('a recorded unitless quantity keeps final_confirmation not ready', () => {
    const policy = buildTurnPolicy('v3.1', pickupContext([item('li_c', 'Cemento', { quantity: quantity(33, null) })]), GROUNDING, { text: 'ok' });
    const validation = validateV3AiProposal(policy, proposal(policy, { reply_text: PICKUP_REPLY.replace('Pastelones — 100 m²', 'Cemento — 33') }));
    expect(validation.errors.find((entry) => entry.code === 'final_confirmation_not_ready').allowed_values).toContain('quantity@li_c');
  });
});

describe('M6: the summary is not resent when nothing changed', () => {
  const cementReply = 'Gracias.\n\n*Resumen de tu cotización*\n\n*Productos*\n• Cemento — 100 m²\n\n*Despacho*\nCalle Uno 100, Colina\nSin restricciones de acceso\n\n¿Está todo correcto?';
  const history = [
    { role: 'assistant', content: cementReply },
    { role: 'user', content: 'Que hormigón ocupan?' },
  ];
  const deliveryContext = (items) => ({
    service_scope: 'material', fulfillment: 'delivery', commune: 'Colina', address: 'Calle Uno 100',
    access_restrictions: 'No', line_items: items, line_items_schema: 'line_items/v1',
  });
  const resolvedContext = deliveryContext([item('li_c', 'Cemento')]);

  test('repeating the full summary with no new data is rejected', () => {
    const policy = buildTurnPolicy('v3.1', resolvedContext, GROUNDING, { text: 'Que hormigón ocupan?', pendingQuestionKey: 'final_confirmation', recentMessages: history });
    const validation = validateV3AiProposal(policy, proposal(policy, { reply_text: `Buena pregunta.\n\n${cementReply}` }));
    expect(codes(validation)).toEqual(['final_summary_repeated']);
  });

  test('a short answer that re-asks the confirmation is valid', () => {
    const policy = buildTurnPolicy('v3.1', resolvedContext, GROUNDING, { text: 'Que hormigón ocupan?', pendingQuestionKey: 'final_confirmation', recentMessages: history });
    const validation = validateV3AiProposal(policy, proposal(policy, {
      reply_text: 'Ese dato te lo indica una ejecutiva de Hormiglass.\n\n¿Confirmas que el resumen que te envié está correcto?',
    }));
    expect(codes(validation)).toEqual([]);
  });

  test('a customer who asks for the summary again gets it', () => {
    const policy = buildTurnPolicy('v3.1', resolvedContext, GROUNDING, { text: '¿Me repites el resumen?', pendingQuestionKey: 'final_confirmation', recentMessages: history });
    expect(codes(validateV3AiProposal(policy, proposal(policy, { reply_text: cementReply })))).toEqual([]);
  });

  test('a summary after a change is valid', () => {
    const policy = buildTurnPolicy('v3.1', deliveryContext([item('li_c', 'Cemento', { quantity: null })]), GROUNDING, {
      text: 'mejor 100 m2', pendingQuestionKey: 'final_confirmation', recentMessages: history,
    });
    const validation = validateV3AiProposal(policy, proposal(policy, {
      reply_text: cementReply,
      observations: [observation('obs_q', 'quantity', '100 m2', quantity(100, 'm²'), 'li_c')],
      state_mutations: [setMutation('quantity', 'obs_q', 'li_c')],
    }));
    expect(codes(validation)).toEqual([]);
  });
});

describe('L1: internal documents are never named to the customer', () => {
  const reply = (text) => {
    const policy = buildTurnPolicy('v3.1', pickupContext([item('li_c', 'Cemento', { quantity: null })]), GROUNDING, { text: 'que hormigon usan?' });
    return validateV3AiProposal(policy, proposal(policy, { primary_request: null, reply_text: text }));
  };

  test.each([
    'La ficha general indica H-25; algunas fichas editables señalan G25.',
    'La ficha disponible no confirma las alturas.',
    'Según el archivo pastelones-ficha.pdf es H-25.',
  ])('rejects "%s"', (text) => {
    const validation = reply(text);
    expect(codes(validation)).toEqual(['forbidden_claim']);
    expect(validation.errors[0].related_ids).toEqual(['no_internal_documents']);
  });

  test('announcing a technical sheet stays allowed', () => {
    expect(codes(reply('Ese dato te lo indica una ejecutiva. ¿Te mando la ficha técnica de *Cemento*?'))).toEqual([]);
  });
});

describe('L2: the commune must be an official Chilean comuna', () => {
  const withCommune = (text, value) => {
    const policy = buildTurnPolicy('v3.1', { service_scope: 'material', fulfillment: 'delivery', line_items: [item('li_c', 'Cemento')], line_items_schema: 'line_items/v1' }, GROUNDING, { text, pendingQuestionKey: 'commune' });
    return validateV3AiProposal(policy, proposal(policy, {
      primary_request: { goal_id: 'address', item_ref: null },
      reply_text: 'Anoto la comuna.\n\n👉 ¿Cuál es la calle y el número?',
      observations: [observation('obs_c', 'commune', text, value)],
      state_mutations: [setMutation('commune', 'obs_c')],
    }));
  };

  test('a province is rejected with an instruction to ask the comuna', () => {
    const validation = withCommune('Chiloe', 'Chiloe');
    expect(codes(validation)).toEqual(['commune_not_recognized']);
    expect(validation.errors[0].instruction).toContain('"goal_id": "commune", "item_ref": null');
  });

  test.each(['Puente alto', 'Ñuñoa', 'Chicureo', 'Castro'])('%s is accepted', (value) => {
    expect(codes(withCommune(value, value))).toEqual([]);
  });
});
