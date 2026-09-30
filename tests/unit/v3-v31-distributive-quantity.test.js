import { createRequire } from 'node:module';
import { describe, expect, test } from 'vitest';
import { buildTurnPolicy } from '../ops/v3-line-items-live-replay.mjs';

const require = createRequire(import.meta.url);
const {
  validateV3AiProposal, authorizeV3ConversationDecision, V3_CONTRACTS,
} = require('../fixtures/workflow-nodes/shared/v3-contract-runtime.js');

// -----------------------------------------------------------------------------
// Live production 2026-09-28 (contract v3.1): a quote with three items
// (Alambre Concertina and Alambre de Púas without quantity, Cierro de Hormigón
// with quantity). The bot asked "¿cuántos metros necesitas de alambre
// concertina y de alambre de púas?" and the customer answered "500 metros de
// cada uno". The model set 500 m only on the concertina item and asked again.
//
// Setting the same quantity on both wire items reuses one evidence span, which
// item_evidence_span_conflict (task 3c.7) rejected as a cross-item copy. Task
// 3c.16 narrowly accepts that shape only when the shared quantity quote itself
// carries an explicit distributive marker and every value is identical; every
// other shape the guard rejected stays rejected.
// -----------------------------------------------------------------------------

const CONCERTINA_REF = 'li_concertina1';
const WIRE_REF = 'li_wire000001';
const FENCE_REF = 'li_fence00001';
const existingContext = {
  line_items: [
    { item_id: CONCERTINA_REF, product: 'Alambre Concertina', quantity: null, measurements: null },
    { item_id: WIRE_REF, product: 'Alambre de Púas', quantity: null, measurements: null },
    { item_id: FENCE_REF, product: 'Cierro de Hormigón', quantity: '100 ml', measurements: null },
  ],
};
const policyWith = (text) => buildTurnPolicy('v3.1', existingContext, undefined, { text });
const errorCodes = (validation) => validation.errors.map((error) => error.code);

const quantityObservation = (id, itemRef, quote, value = 500, occurrence = 1) => ({
  id,
  concept: 'quantity',
  raw_value: quote,
  normalized_value: { kind: 'exact', value, unit: 'm', name: null },
  evidence_quote: quote,
  evidence_occurrence: occurrence,
  grounding_ref: null,
  resolves_goal_ids: ['line_items'],
  item_ref: itemRef,
});
const quantitySet = (itemRef, observationId) => ({
  operation: 'set', field: 'quantity', item_ref: itemRef, observation_id: observationId, replaces_fact_id: null,
});

const quantityTurn = (targetPolicy, observations) => ({
  version: V3_CONTRACTS.proposal_v3_1,
  policy_digest: targetPolicy.policy_digest,
  reply_text: 'Perfecto, 500 metros de cada uno. ¿Son para el alambre concertina y para el alambre de púas?',
  // 3c.17 (owner decision): an unnamed distributive value on 2+ items must
  // ask the item-assignment question through this item-scoped request.
  primary_request: { goal_id: 'quantity', item_ref: CONCERTINA_REF },
  catalog_resolutions: [],
  observations,
  state_mutations: observations.map((entry) => quantitySet(entry.item_ref, entry.id)),
  effect_requests: [],
});

const bothWires = (targetPolicy, quote, { concertinaValue = 500, wireValue = 500 } = {}) => quantityTurn(targetPolicy, [
  quantityObservation('obs_qty_concertina', CONCERTINA_REF, quote, concertinaValue),
  quantityObservation('obs_qty_wire', WIRE_REF, quote, wireValue),
]);

describe('explicit distributive quantity on several items (live "500 metros de cada uno")', () => {
  test('the policy is v3.1 with three existing items', () => {
    const targetPolicy = policyWith('500 metros de cada uno');
    expect(targetPolicy.version).toBe(V3_CONTRACTS.policy_v3_1);
  });

  test('the same quantity on both wire items from the shared distributive quote validates clean', () => {
    const targetPolicy = policyWith('500 metros de cada uno');
    const validation = validateV3AiProposal(targetPolicy, bothWires(targetPolicy, '500 metros de cada uno'));

    expect(validation.errors).toEqual([]);
    expect(validation.valid).toBe(true);
    expect(validation.authorized_mutations).toEqual(expect.arrayContaining([
      expect.objectContaining({ field: 'quantity', item_ref: CONCERTINA_REF }),
      expect.objectContaining({ field: 'quantity', item_ref: WIRE_REF }),
    ]));
  });

  test('the authorizer commits the quantity on both wire items and leaves the fence item untouched', () => {
    const targetPolicy = policyWith('500 metros de cada uno');
    const proposal = bothWires(targetPolicy, '500 metros de cada uno');
    const decision = authorizeV3ConversationDecision(targetPolicy, proposal, validateV3AiProposal(targetPolicy, proposal));
    const quantityItems = decision.state_mutations
      .filter((mutation) => mutation.field === 'quantity')
      .map((mutation) => mutation.item_id)
      .sort();

    expect(quantityItems).toEqual([CONCERTINA_REF, WIRE_REF].sort());
  });

  test.each([
    ['500 metros cada uno'],
    ['500 metros de cada una'],
    ['500 metros para ambos'],
    ['500 metros para los dos'],
    ['500 metros de cada producto'],
    ['Lo mismo para los dos, 500 metros'],
  ])('other distributive markers in the shared quote are accepted: %s', (message) => {
    const targetPolicy = policyWith(message);
    const validation = validateV3AiProposal(targetPolicy, bothWires(targetPolicy, message));

    expect(validation.errors).toEqual([]);
    expect(validation.valid).toBe(true);
  });

  test('a distributive marker elsewhere in the message but outside the shared quote keeps the rejection', () => {
    const targetPolicy = policyWith('500 metros de cada uno');
    const validation = validateV3AiProposal(targetPolicy, bothWires(targetPolicy, '500 metros'));

    expect(validation.valid).toBe(false);
    expect(errorCodes(validation)).toEqual(['item_evidence_span_conflict']);
  });

  test('the same shared quote WITHOUT a distributive marker keeps the rejection', () => {
    const targetPolicy = policyWith('500 metros');
    const validation = validateV3AiProposal(targetPolicy, bothWires(targetPolicy, '500 metros'));

    expect(validation.valid).toBe(false);
    expect(errorCodes(validation)).toEqual(['item_evidence_span_conflict']);
  });

  test('different values from the shared distributive quote keep the rejection', () => {
    const targetPolicy = policyWith('500 metros de cada uno');
    const validation = validateV3AiProposal(
      targetPolicy, bothWires(targetPolicy, '500 metros de cada uno', { wireValue: 300 }),
    );

    expect(validation.valid).toBe(false);
    expect(errorCodes(validation)).toEqual(['item_evidence_span_conflict']);
  });

  test('a different unit from the shared distributive quote keeps the rejection', () => {
    const targetPolicy = policyWith('500 metros de cada uno');
    const proposal = bothWires(targetPolicy, '500 metros de cada uno');
    proposal.observations[1].normalized_value.unit = 'unidades';
    const validation = validateV3AiProposal(targetPolicy, proposal);

    expect(validation.valid).toBe(false);
    expect(errorCodes(validation)).toEqual(['item_evidence_span_conflict']);
  });

  // 3c.17 (owner-approved) extends the exception to measurements, under the
  // same conditions; see tests/unit/v3-v31-distributive-assignment.test.js.
  test('a distributive measurement span shared across items missing measurements is accepted (3c.17)', () => {
    const message = '2 metros de alto cada uno';
    const targetPolicy = policyWith(message);
    const measurement = (id, itemRef) => ({
      id,
      concept: 'measurements',
      raw_value: message,
      normalized_value: { kind: 'exact', value: 2, unit: 'm', name: null },
      evidence_quote: message,
      evidence_occurrence: 1,
      grounding_ref: null,
      resolves_goal_ids: ['line_items'],
      item_ref: itemRef,
    });
    const proposal = quantityTurn(targetPolicy, [
      measurement('obs_meas_concertina', CONCERTINA_REF),
      measurement('obs_meas_wire', WIRE_REF),
    ]);
    proposal.state_mutations = proposal.state_mutations.map((mutation) => ({ ...mutation, field: 'measurements' }));
    proposal.primary_request = { goal_id: 'measurements', item_ref: CONCERTINA_REF };
    const validation = validateV3AiProposal(targetPolicy, proposal);

    expect(validation.errors).toEqual([]);
    expect(validation.valid).toBe(true);
  });
});
