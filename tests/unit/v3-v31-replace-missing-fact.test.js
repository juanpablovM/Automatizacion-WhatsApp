import { createRequire } from 'node:module';
import { describe, expect, test } from 'vitest';
import { buildTurnPolicy } from '../ops/v3-line-items-live-replay.mjs';

const require = createRequire(import.meta.url);
const { validateV3AiProposal, V3_CONTRACTS } = require('../fixtures/workflow-nodes/shared/v3-contract-runtime.js');

// -----------------------------------------------------------------------------
// Live A/B 2026-09-28 (N=10, transcript pandereta-live-then-wire-correction).
// After turn 1 the pandereta item holds 500 ml + 3 m (product withheld) and
// the Alambre de Púas item holds only its product. On turn 2 ("Corrección: el
// alambre de púas son 300 ml, no 500 ml") the model sometimes emitted a
// `replace` for the wire quantity citing a fact id that does not exist, was
// rejected with fact_not_replaceable (no guidance), repeated the mistake on
// repair and fell to contingency. The rejection MUST stay (the protection is
// never weakened); the fix only adds repair guidance.
// -----------------------------------------------------------------------------

const PANDERETA_REF = 'li_pandereta01';
const WIRE_REF = 'li_wire000001';
const CORRECTION_TEXT = 'Corrección: el alambre de púas son 300 ml, no 500 ml';

const postTurnOneContext = {
  commune: 'Lo Prado',
  line_items: [
    { item_id: PANDERETA_REF, product: null, requested_label: 'pandereta', quantity: '500 ml', measurements: '3 metros de altura' },
    { item_id: WIRE_REF, product: 'Alambre de Púas', quantity: null, measurements: null },
  ],
};
const policy = buildTurnPolicy('v3.1', postTurnOneContext, undefined, { text: CORRECTION_TEXT });

const proposalWith = (mutation, itemRef = WIRE_REF) => ({
  version: V3_CONTRACTS.proposal_v3_1,
  policy_digest: policy.policy_digest,
  reply_text: 'Anotado: 300 ml de Alambre de Púas.',
  primary_request: null,
  catalog_resolutions: [],
  observations: [{
    id: 'obs-wire-quantity',
    concept: 'quantity',
    raw_value: '300 ml',
    normalized_value: { kind: 'quantity', value: 300, unit: 'ml', name: null },
    evidence_quote: '300 ml',
    evidence_occurrence: 1,
    grounding_ref: null,
    resolves_goal_ids: ['quantity'],
    item_ref: itemRef,
  }],
  state_mutations: [{ field: 'quantity', item_ref: itemRef, observation_id: 'obs-wire-quantity', ...mutation }],
  effect_requests: [],
});

const MISSING_FACT_INSTRUCTION = `Item ${WIRE_REF} has no current quantity value, so there is nothing to replace: use operation "set" with replaces_fact_id: null on item_ref ${WIRE_REF}. A customer's correction of a value that was never recorded is a set.`;

describe('post-turn-1 correction: replace on an item field that has no current fact', () => {
  test('the policy holds the pandereta quantity/measurements and only the wire product', () => {
    expect(policy.version).toBe(V3_CONTRACTS.policy_v3_1);
    expect(policy.facts.map((fact) => fact.fact_id)).toEqual([
      'fact:commune',
      `fact:item:${PANDERETA_REF}:quantity`,
      `fact:item:${PANDERETA_REF}:measurements`,
      `fact:item:${WIRE_REF}:product`,
    ]);
  });

  test('replace with a nonexistent wire quantity fact id is still rejected, now with set/null guidance', () => {
    const validation = validateV3AiProposal(policy, proposalWith({
      operation: 'replace', replaces_fact_id: `fact:item:${WIRE_REF}:quantity`,
    }));

    expect(validation.valid).toBe(false);
    expect(validation.errors).toEqual([{
      code: 'fact_not_replaceable',
      path: 'state_mutations[0].replaces_fact_id',
      disposition: 'repairable',
      related_ids: ['obs-wire-quantity'],
      allowed_values: [null],
      instruction: MISSING_FACT_INSTRUCTION,
    }]);
  });

  test('replace citing the pandereta quantity fact for the wire item gets the same set/null guidance', () => {
    const validation = validateV3AiProposal(policy, proposalWith({
      operation: 'replace', replaces_fact_id: `fact:item:${PANDERETA_REF}:quantity`,
    }));

    expect(validation.valid).toBe(false);
    expect(validation.errors.map((error) => error.code)).toEqual(['fact_not_replaceable']);
    expect(validation.errors[0].instruction).toBe(MISSING_FACT_INSTRUCTION);
  });

  test('the same correction as set with replaces_fact_id null validates clean on the wire item', () => {
    const validation = validateV3AiProposal(policy, proposalWith({ operation: 'set', replaces_fact_id: null }));

    expect(validation.errors).toEqual([]);
    expect(validation.valid).toBe(true);
    expect(validation.authorized_mutations).toContainEqual(expect.objectContaining({
      operation: 'set', field: 'quantity', item_ref: WIRE_REF,
    }));
  });
});

describe('replace with a wrong fact id when the item field does have a current fact', () => {
  test('is still rejected and the guidance names the correct fact id', () => {
    const correctFactId = `fact:item:${PANDERETA_REF}:quantity`;
    const validation = validateV3AiProposal(policy, proposalWith({
      operation: 'replace', replaces_fact_id: 'fact:item:li_unknown:quantity',
    }, PANDERETA_REF));

    expect(validation.valid).toBe(false);
    expect(validation.errors).toEqual([{
      code: 'fact_not_replaceable',
      path: 'state_mutations[0].replaces_fact_id',
      disposition: 'repairable',
      related_ids: ['obs-wire-quantity'],
      allowed_values: [correctFactId],
      instruction: `Item ${PANDERETA_REF} already has a current quantity fact: to correct it use operation "replace" with replaces_fact_id: "${correctFactId}".`,
    }]);
  });

  test('the same replace with the correct fact id validates clean', () => {
    const validation = validateV3AiProposal(policy, proposalWith({
      operation: 'replace', replaces_fact_id: `fact:item:${PANDERETA_REF}:quantity`,
    }, PANDERETA_REF));

    expect(validation.errors).toEqual([]);
    expect(validation.valid).toBe(true);
  });
});

describe('unrelated fact_not_replaceable cases keep their exact error object', () => {
  test('a quote-level replace with a wrong fact id carries no instruction', () => {
    const quoteLevelPolicy = buildTurnPolicy('v3.1', postTurnOneContext, undefined, { text: 'Perdón, es en Pudahuel' });
    const validation = validateV3AiProposal(quoteLevelPolicy, {
      version: V3_CONTRACTS.proposal_v3_1,
      policy_digest: quoteLevelPolicy.policy_digest,
      reply_text: 'Anotado, Pudahuel.',
      primary_request: null,
      catalog_resolutions: [],
      observations: [{
        id: 'obs-commune',
        concept: 'commune',
        raw_value: 'Pudahuel',
        normalized_value: 'Pudahuel',
        evidence_quote: 'Pudahuel',
        evidence_occurrence: 1,
        grounding_ref: null,
        resolves_goal_ids: ['commune'],
        item_ref: null,
      }],
      state_mutations: [{
        operation: 'replace', field: 'commune', item_ref: null, observation_id: 'obs-commune', replaces_fact_id: 'fact:wrong',
      }],
      effect_requests: [],
    });

    const error = validation.errors.find((entry) => entry.code === 'fact_not_replaceable');
    expect(error).toEqual({
      code: 'fact_not_replaceable',
      path: 'state_mutations[0].replaces_fact_id',
      disposition: 'repairable',
      related_ids: ['obs-commune'],
      allowed_values: [],
    });
  });

  test('an item-field replace without item_ref carries no instruction', () => {
    const validation = validateV3AiProposal(policy, proposalWith({
      operation: 'replace', item_ref: null, replaces_fact_id: 'fact:item:li_unknown:quantity',
    }));

    const error = validation.errors.find((entry) => entry.code === 'fact_not_replaceable');
    expect(error).toEqual({
      code: 'fact_not_replaceable',
      path: 'state_mutations[0].replaces_fact_id',
      disposition: 'repairable',
      related_ids: ['obs-wire-quantity'],
      allowed_values: [],
    });
  });
});
