import { createRequire } from 'node:module';
import { describe, expect, test } from 'vitest';
import { buildTurnPolicy } from '../ops/v3-line-items-live-replay.mjs';

const require = createRequire(import.meta.url);
const {
  validateV3AiProposal, authorizeV3ConversationDecision, V3_CONTRACTS,
} = require('../fixtures/workflow-nodes/shared/v3-contract-runtime.js');

// -----------------------------------------------------------------------------
// Task 3c.17 (contract v3.1 only). Task 3c.16 let one explicit distributive
// quantity quote ("500 metros de cada uno") set the same quantity on several
// items. The owner narrowed and extended that exception:
//   1. measurements get the same exception as quantity;
//   2. a distributive span only fills items that have no value for that field
//      yet (never overwrites; item_evidence_span_conflict otherwise);
//   3. when the message names products of the quote, the value only goes to
//      the named items (item_evidence_span_conflict otherwise);
//   4. when the message names none of them and the value lands on two or more
//      items, the same turn must not ask for final_confirmation nor create the
//      lead (distributive_assignment_unconfirmed): it asks the customer to
//      confirm which items the value applies to, through an item-scoped
//      primary_request for the distributed field.
// -----------------------------------------------------------------------------

const CONCERTINA_REF = 'li_concertina1';
const WIRE_REF = 'li_wire000001';
const FENCE_REF = 'li_fence00001';

// Live production 2026-09-28 state: every quote-level goal known, Cierro de
// Hormigón already with 500 m, both wires without quantity, and the bot had
// just asked the concertina quantity.
const GROUNDING = Object.freeze({
  catalog: [
    { ref: 'product:alambre-concertina', concept: 'product', value: 'Alambre Concertina' },
    { ref: 'product:alambre-de-puas', concept: 'product', value: 'Alambre de Púas' },
    { ref: 'product:cierro-de-hormigon', concept: 'product', value: 'Cierro de Hormigón' },
  ],
});
const QUOTE_LEVEL_FACTS = {
  commune: 'Lo Prado',
  address: 'Calle Uno 120',
  service_scope: 'material',
  fulfillment: 'delivery',
  access_restrictions: 'Sin restricciones',
};
const liveContext = ({
  concertinaQuantity = null, wireQuantity = null, concertinaMeasurements = null, wireMeasurements = null,
} = {}) => ({
  ...QUOTE_LEVEL_FACTS,
  line_items: [
    { item_id: CONCERTINA_REF, product: 'Alambre Concertina', quantity: concertinaQuantity, measurements: concertinaMeasurements },
    { item_id: WIRE_REF, product: 'Alambre de Púas', quantity: wireQuantity, measurements: wireMeasurements },
    { item_id: FENCE_REF, product: 'Cierro de Hormigón', quantity: '500 ml', measurements: null },
  ],
});
const policyWith = (text, { context = liveContext(), pendingQuestionKey = 'quantity' } = {}) => (
  buildTurnPolicy('v3.1', context, GROUNDING, { text, pendingQuestionKey })
);
const errorCodes = (validation) => validation.errors.map((error) => error.code);

const itemObservation = (concept, id, itemRef, quote, normalizedValue) => ({
  id,
  concept,
  raw_value: quote,
  normalized_value: normalizedValue,
  evidence_quote: quote,
  evidence_occurrence: 1,
  grounding_ref: null,
  resolves_goal_ids: ['line_items'],
  item_ref: itemRef,
});
const FIVE_HUNDRED_METERS = { kind: 'exact', value: 500, unit: 'm', name: null };
const TWO_METERS_HIGH = { kind: 'exact', value: 2, unit: 'm', name: 'alto' };

// One observation + one mutation per target item, all citing the same quote.
const distributiveProposal = (targetPolicy, {
  quote, targets, concept = 'quantity', value = FIVE_HUNDRED_METERS,
  primaryRequest = null, effectRequests = [], replyText = 'Perfecto, registré los 500 metros.',
  operationFor = () => 'set',
}) => {
  const observations = targets.map((itemRef) => itemObservation(concept, `obs_${concept}_${itemRef}`, itemRef, quote, value));
  return {
    version: V3_CONTRACTS.proposal_v3_1,
    policy_digest: targetPolicy.policy_digest,
    reply_text: replyText,
    primary_request: primaryRequest,
    catalog_resolutions: [],
    observations,
    state_mutations: observations.map((entry) => {
      const operation = operationFor(entry.item_ref);
      return {
        operation,
        field: concept,
        item_ref: entry.item_ref,
        observation_id: entry.id,
        replaces_fact_id: operation === 'replace' ? `fact:item:${entry.item_ref}:${concept}` : null,
      };
    }),
    effect_requests: effectRequests,
  };
};

const FINAL_CONFIRMATION = { goal_id: 'final_confirmation', item_ref: null };
const ASSIGNMENT_CONFIRMATION = { goal_id: 'quantity', item_ref: CONCERTINA_REF };
const ASSIGNMENT_REPLY = 'Registré 500 metros para cada uno. ¿Los 500 metros son para el alambre concertina y para el alambre de púas?';

describe('live "500 metros de cada uno": unnamed distributive value on two items (3c.17)', () => {
  const message = '500 metros de cada uno';

  test('the live state is a v3.1 policy that is otherwise ready for final confirmation', () => {
    const targetPolicy = policyWith(message);
    expect(targetPolicy.version).toBe(V3_CONTRACTS.policy_v3_1);
    expect(targetPolicy.turn.pending_question_goal_id).toBe('quantity');
  });

  test('setting 500 on both wires and asking final_confirmation in the same turn is rejected', () => {
    const targetPolicy = policyWith(message);
    const validation = validateV3AiProposal(targetPolicy, distributiveProposal(targetPolicy, {
      quote: message, targets: [CONCERTINA_REF, WIRE_REF], primaryRequest: FINAL_CONFIRMATION,
    }));

    expect(validation.valid).toBe(false);
    expect(errorCodes(validation)).toEqual(['distributive_assignment_unconfirmed']);
    const [error] = validation.errors;
    expect(error.disposition).toBe('repairable');
    expect(error.related_ids).toEqual([CONCERTINA_REF, WIRE_REF]);
    expect(error.allowed_values).toEqual([CONCERTINA_REF, WIRE_REF]);
    expect(error.instruction).toContain('Alambre Concertina');
    expect(error.instruction).toContain('Alambre de Púas');
    expect(error.instruction).toContain('do not ask for final confirmation');
    expect(error.instruction).toContain('"goal_id":"quantity"');
    expect(error.instruction).toContain(`"item_ref":"${CONCERTINA_REF}"`);
  });

  test('requesting create_lead in that same turn is rejected with the same code', () => {
    const targetPolicy = policyWith(message, { pendingQuestionKey: 'final_confirmation' });
    const validation = validateV3AiProposal(targetPolicy, distributiveProposal(targetPolicy, {
      quote: message,
      targets: [CONCERTINA_REF, WIRE_REF],
      effectRequests: [{ type: 'create_lead', reason_observation_ids: [] }],
    }));

    expect(validation.valid).toBe(false);
    expect(errorCodes(validation)).toContain('distributive_assignment_unconfirmed');
  });

  test('the same values with an item-scoped assignment-confirmation question are valid and committed', () => {
    const targetPolicy = policyWith(message);
    const proposal = distributiveProposal(targetPolicy, {
      quote: message, targets: [CONCERTINA_REF, WIRE_REF], primaryRequest: ASSIGNMENT_CONFIRMATION, replyText: ASSIGNMENT_REPLY,
    });
    const validation = validateV3AiProposal(targetPolicy, proposal);

    expect(validation.errors).toEqual([]);
    expect(validation.valid).toBe(true);
    const decision = authorizeV3ConversationDecision(targetPolicy, proposal, validation);
    expect(decision.state_mutations
      .filter((mutation) => mutation.field === 'quantity')
      .map((mutation) => mutation.item_id)
      .sort()).toEqual([CONCERTINA_REF, WIRE_REF].sort());
  });

  test.each([
    ['primary_request null', null],
    ['a request scoped to a non-target item', { goal_id: 'quantity', item_ref: FENCE_REF }],
    ['a request for another goal', { goal_id: 'line_items', item_ref: CONCERTINA_REF }],
    ['a request for the other item field', { goal_id: 'measurements', item_ref: CONCERTINA_REF }],
    ['a quote-level request', { goal_id: 'quantity', item_ref: null }],
  ])('the assignment question is mandatory: %s is rejected', (_label, primaryRequest) => {
    const targetPolicy = policyWith(message);
    const validation = validateV3AiProposal(targetPolicy, distributiveProposal(targetPolicy, {
      quote: message, targets: [CONCERTINA_REF, WIRE_REF], primaryRequest, replyText: ASSIGNMENT_REPLY,
    }));

    expect(validation.valid).toBe(false);
    expect(errorCodes(validation)).toContain('distributive_assignment_unconfirmed');
    const error = validation.errors.find((entry) => entry.code === 'distributive_assignment_unconfirmed');
    expect(error.path).toBe('primary_request');
    expect(error.allowed_values).toEqual([CONCERTINA_REF, WIRE_REF]);
  });

  test('the item-scoped question plus a create_lead request is still rejected', () => {
    const targetPolicy = policyWith(message, { pendingQuestionKey: 'final_confirmation' });
    const validation = validateV3AiProposal(targetPolicy, distributiveProposal(targetPolicy, {
      quote: message,
      targets: [CONCERTINA_REF, WIRE_REF],
      primaryRequest: ASSIGNMENT_CONFIRMATION,
      replyText: ASSIGNMENT_REPLY,
      effectRequests: [{ type: 'create_lead', reason_observation_ids: [] }],
    }));

    expect(validation.valid).toBe(false);
    const error = validation.errors.find((entry) => entry.code === 'distributive_assignment_unconfirmed');
    expect(error.path).toBe('effect_requests');
  });

  test('the assignment confirmation may also be scoped to the other target item', () => {
    const targetPolicy = policyWith(message);
    const validation = validateV3AiProposal(targetPolicy, distributiveProposal(targetPolicy, {
      quote: message, targets: [CONCERTINA_REF, WIRE_REF], primaryRequest: { goal_id: 'quantity', item_ref: WIRE_REF }, replyText: ASSIGNMENT_REPLY,
    }));

    expect(validation.errors).toEqual([]);
    expect(validation.valid).toBe(true);
  });

  test('applying it also to Cierro de Hormigón, which already has 500 m, is rejected (no overwrite via set)', () => {
    const targetPolicy = policyWith(message);
    const validation = validateV3AiProposal(targetPolicy, distributiveProposal(targetPolicy, {
      quote: message, targets: [CONCERTINA_REF, WIRE_REF, FENCE_REF], primaryRequest: ASSIGNMENT_CONFIRMATION, replyText: ASSIGNMENT_REPLY,
    }));

    expect(validation.valid).toBe(false);
    expect(errorCodes(validation)).toEqual(['item_evidence_span_conflict']);
    const [error] = validation.errors;
    expect(error.path).toBe('state_mutations[2]');
    expect(error.related_ids).toEqual([`obs_quantity_${FENCE_REF}`]);
    expect(error.instruction).toContain(`item ${FENCE_REF} already has a quantity value`);
    expect(error.instruction).toContain('only to items missing that field');
    expect(error.instruction).toContain('the customer must name that product');
  });

  test('applying it to Cierro de Hormigón through replace is rejected too (no overwrite via replace)', () => {
    const targetPolicy = policyWith(message);
    const validation = validateV3AiProposal(targetPolicy, distributiveProposal(targetPolicy, {
      quote: message,
      targets: [CONCERTINA_REF, WIRE_REF, FENCE_REF],
      primaryRequest: ASSIGNMENT_CONFIRMATION,
      replyText: ASSIGNMENT_REPLY,
      operationFor: (itemRef) => (itemRef === FENCE_REF ? 'replace' : 'set'),
    }));

    expect(validation.valid).toBe(false);
    expect(errorCodes(validation)).toEqual(['item_evidence_span_conflict']);
  });

  test('the overwrite guard also holds when the item holding a value is the first one citing the span', () => {
    const targetPolicy = policyWith(message);
    const validation = validateV3AiProposal(targetPolicy, distributiveProposal(targetPolicy, {
      quote: message, targets: [FENCE_REF, CONCERTINA_REF], primaryRequest: ASSIGNMENT_CONFIRMATION, replyText: ASSIGNMENT_REPLY,
    }));

    expect(validation.valid).toBe(false);
    expect(errorCodes(validation)).toEqual(['item_evidence_span_conflict']);
    expect(validation.errors[0].path).toBe('state_mutations[0]');
  });

  test('the next turn\'s "sí" (after the assignment question) reaches final confirmation normally', () => {
    const targetPolicy = policyWith('Sí', {
      context: liveContext({ concertinaQuantity: '500 m', wireQuantity: '500 m' }),
      pendingQuestionKey: 'quantity',
    });
    const validation = validateV3AiProposal(targetPolicy, {
      version: V3_CONTRACTS.proposal_v3_1,
      policy_digest: targetPolicy.policy_digest,
      reply_text: 'Perfecto. Resumen:\n• Alambre Concertina: 500 m\n• Alambre de Púas: 500 m\n• Cierro de Hormigón: 500 ml\n¿Confirmas la cotización?',
      primary_request: FINAL_CONFIRMATION,
      catalog_resolutions: [],
      observations: [],
      state_mutations: [],
      effect_requests: [],
    });

    expect(validation.errors).toEqual([]);
    expect(validation.valid).toBe(true);
  });

  test('that "sí" answers the assignment question only: it cannot create the lead before the final confirmation', () => {
    const targetPolicy = policyWith('Sí', {
      context: liveContext({ concertinaQuantity: '500 m', wireQuantity: '500 m' }),
      pendingQuestionKey: 'quantity',
    });
    const validation = validateV3AiProposal(targetPolicy, {
      version: V3_CONTRACTS.proposal_v3_1,
      policy_digest: targetPolicy.policy_digest,
      reply_text: 'Listo, registré tu solicitud.',
      primary_request: null,
      catalog_resolutions: [],
      observations: [],
      state_mutations: [],
      effect_requests: [{ type: 'create_lead', reason_observation_ids: [] }],
    });

    expect(validation.valid).toBe(false);
    expect(errorCodes(validation)).toContain('effect_trigger_context_invalid');
  });
});

describe('named distributive value restricts its targets (3c.17)', () => {
  const message = '500 metros de cada uno, concertina y púas';

  test('applied to exactly the two named products it goes straight to final confirmation', () => {
    const targetPolicy = policyWith(message);
    const validation = validateV3AiProposal(targetPolicy, distributiveProposal(targetPolicy, {
      quote: message, targets: [CONCERTINA_REF, WIRE_REF], primaryRequest: FINAL_CONFIRMATION,
    }));

    expect(validation.errors).toEqual([]);
    expect(validation.valid).toBe(true);
  });

  test('applied also to an unnamed third item it is rejected with the allowed item refs', () => {
    const targetPolicy = policyWith(message, {
      context: {
        ...QUOTE_LEVEL_FACTS,
        line_items: [
          { item_id: CONCERTINA_REF, product: 'Alambre Concertina', quantity: null, measurements: null },
          { item_id: WIRE_REF, product: 'Alambre de Púas', quantity: null, measurements: null },
          { item_id: FENCE_REF, product: 'Cierro de Hormigón', quantity: null, measurements: null },
        ],
      },
    });
    const validation = validateV3AiProposal(targetPolicy, distributiveProposal(targetPolicy, {
      quote: message, targets: [CONCERTINA_REF, WIRE_REF, FENCE_REF], primaryRequest: FINAL_CONFIRMATION,
    }));

    expect(validation.valid).toBe(false);
    expect(errorCodes(validation)).toContain('item_evidence_span_conflict');
    const conflict = validation.errors.find((error) => error.code === 'item_evidence_span_conflict');
    expect(conflict.path).toBe('state_mutations[2]');
    expect(conflict.allowed_values).toEqual([CONCERTINA_REF, WIRE_REF]);
    expect(conflict.instruction).toContain(`${CONCERTINA_REF}, ${WIRE_REF}`);
    expect(conflict.instruction).toContain(FENCE_REF);
    expect(errorCodes(validation)).not.toContain('distributive_assignment_unconfirmed');
  });

  test('a message naming only one product keeps the value off the other item', () => {
    const named = '500 metros de cada uno para la concertina';
    const targetPolicy = policyWith(named);
    const validation = validateV3AiProposal(targetPolicy, distributiveProposal(targetPolicy, {
      quote: named, targets: [CONCERTINA_REF, WIRE_REF], primaryRequest: ASSIGNMENT_CONFIRMATION, replyText: ASSIGNMENT_REPLY,
    }));

    expect(validation.valid).toBe(false);
    expect(errorCodes(validation)).toEqual(['item_evidence_span_conflict']);
    expect(validation.errors[0].allowed_values).toEqual([CONCERTINA_REF]);
  });

  test('named products are matched with accents and case folded', () => {
    const named = '500 METROS DE CADA UNO: CONCERTINA Y PUAS';
    const targetPolicy = policyWith(named);
    const validation = validateV3AiProposal(targetPolicy, distributiveProposal(targetPolicy, {
      quote: named, targets: [CONCERTINA_REF, WIRE_REF], primaryRequest: FINAL_CONFIRMATION,
    }));

    expect(validation.errors).toEqual([]);
    expect(validation.valid).toBe(true);
  });
});

describe('distributive measurements (3c.17)', () => {
  const message = '2 metros de alto cada uno';
  // Both wires already carry their quantity, so only measurements are missing
  // and a final confirmation is otherwise ready.
  const measurementPolicy = (text, extra = {}) => policyWith(text, {
    context: liveContext({ concertinaQuantity: '500 m', wireQuantity: '500 m', ...extra }),
    pendingQuestionKey: 'measurements',
  });

  test('two items missing measurements accept one distributive measurement quote', () => {
    const targetPolicy = measurementPolicy(message);
    const proposal = distributiveProposal(targetPolicy, {
      quote: message,
      targets: [CONCERTINA_REF, WIRE_REF],
      concept: 'measurements',
      value: TWO_METERS_HIGH,
      primaryRequest: { goal_id: 'measurements', item_ref: CONCERTINA_REF },
      replyText: '¿Los 2 metros de alto son para el alambre concertina y para el alambre de púas?',
    });
    const validation = validateV3AiProposal(targetPolicy, proposal);

    expect(validation.errors).toEqual([]);
    expect(validation.valid).toBe(true);
    expect(validation.authorized_mutations).toEqual(expect.arrayContaining([
      expect.objectContaining({ field: 'measurements', item_ref: CONCERTINA_REF }),
      expect.objectContaining({ field: 'measurements', item_ref: WIRE_REF }),
    ]));
  });

  test('unnamed distributive measurements on two items cannot ask final confirmation in the same turn', () => {
    const targetPolicy = measurementPolicy(message);
    const validation = validateV3AiProposal(targetPolicy, distributiveProposal(targetPolicy, {
      quote: message, targets: [CONCERTINA_REF, WIRE_REF], concept: 'measurements', value: TWO_METERS_HIGH, primaryRequest: FINAL_CONFIRMATION,
    }));

    expect(validation.valid).toBe(false);
    expect(errorCodes(validation)).toEqual(['distributive_assignment_unconfirmed']);
    expect(validation.errors[0].instruction).toContain('"goal_id":"measurements"');
  });

  test('named distributive measurements go straight to final confirmation', () => {
    const named = '2 metros de alto cada uno, concertina y púas';
    const targetPolicy = measurementPolicy(named);
    const validation = validateV3AiProposal(targetPolicy, distributiveProposal(targetPolicy, {
      quote: named, targets: [CONCERTINA_REF, WIRE_REF], concept: 'measurements', value: TWO_METERS_HIGH, primaryRequest: FINAL_CONFIRMATION,
    }));

    expect(validation.errors).toEqual([]);
    expect(validation.valid).toBe(true);
  });

  test('an item that already has measurements is never overwritten by the distributive quote', () => {
    const targetPolicy = measurementPolicy(message, { wireMeasurements: '1,5 m de alto' });
    const validation = validateV3AiProposal(targetPolicy, distributiveProposal(targetPolicy, {
      quote: message,
      targets: [CONCERTINA_REF, WIRE_REF],
      concept: 'measurements',
      value: TWO_METERS_HIGH,
      primaryRequest: { goal_id: 'measurements', item_ref: CONCERTINA_REF },
    }));

    expect(validation.valid).toBe(false);
    expect(errorCodes(validation)).toEqual(['item_evidence_span_conflict']);
    expect(validation.errors[0].instruction).toContain(`item ${WIRE_REF} already has a measurements value`);
  });

  test('a shared measurement quote without a distributive marker keeps the rejection', () => {
    const plain = '2 metros de alto';
    const targetPolicy = measurementPolicy(plain);
    const validation = validateV3AiProposal(targetPolicy, distributiveProposal(targetPolicy, {
      quote: plain,
      targets: [CONCERTINA_REF, WIRE_REF],
      concept: 'measurements',
      value: TWO_METERS_HIGH,
      primaryRequest: { goal_id: 'measurements', item_ref: CONCERTINA_REF },
    }));

    expect(validation.valid).toBe(false);
    expect(errorCodes(validation)).toEqual(['item_evidence_span_conflict']);
  });

  test('different measurement values from one distributive quote keep the rejection', () => {
    const targetPolicy = measurementPolicy(message);
    const proposal = distributiveProposal(targetPolicy, {
      quote: message,
      targets: [CONCERTINA_REF, WIRE_REF],
      concept: 'measurements',
      value: TWO_METERS_HIGH,
      primaryRequest: { goal_id: 'measurements', item_ref: CONCERTINA_REF },
    });
    proposal.observations[1].normalized_value = { kind: 'exact', value: 3, unit: 'm', name: 'alto' };
    const validation = validateV3AiProposal(targetPolicy, proposal);

    expect(validation.valid).toBe(false);
    expect(errorCodes(validation)).toEqual(['item_evidence_span_conflict']);
  });
});
