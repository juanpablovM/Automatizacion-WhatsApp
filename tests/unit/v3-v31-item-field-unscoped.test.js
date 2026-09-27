import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { describe, expect, test } from 'vitest';

const require = createRequire(import.meta.url);
const {
  validateV3AiProposal, authorizeV3ConversationDecision, compileV3TurnPolicy, V3_CONTRACTS,
} = require('../fixtures/workflow-nodes/shared/v3-contract-runtime.js');

// -----------------------------------------------------------------------------
// Live canary 2026-09-27 (run 2, first turn): "Hola, necesito cotizar una
// pandereta de 3 metros de altura con alambre púa, 500 ml en Lo Prado".
// The model scoped the product (new:2) and the measurements (new:1) but left
// the quantity "500 ml" with item_ref:null. The validator accepted it and the
// null ref fell back to the flat item, so the decision persisted a THIRD,
// headless item (product null, quantity 500 ml) that can never resolve: the
// quote never completes and the bot loops asking for quantities.
// item_field_unscoped rejects that shape (repairable) whenever the quote
// would hold two or more items after this proposal.
// -----------------------------------------------------------------------------

const fixturePath = path.join(
  process.cwd(), 'tests', 'fixtures', 'v3-line-items', 'captured-first-turn-headless-item.json',
);
const captured = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));
const { policy } = captured;
const [capturedProposal] = captured.proposals;
const clone = (value) => JSON.parse(JSON.stringify(value));
const errorCodes = (validation) => validation.errors.map((error) => error.code);

const withQuantityRef = (proposal, itemRef) => {
  const next = clone(proposal);
  next.observations.find((entry) => entry.id === 'obs-quantity').item_ref = itemRef;
  next.state_mutations.find((entry) => entry.observation_id === 'obs-quantity').item_ref = itemRef;
  return next;
};

describe('captured first-turn proposal with an unscoped quantity (headless item)', () => {
  test('the fixture is the v3.1 first turn with two new items and no prior facts', () => {
    expect(policy.version).toBe(V3_CONTRACTS.policy_v3_1);
    expect(policy.facts).toEqual([]);
    expect(policy.turn.message.text)
      .toBe('Hola, necesito cotizar una pandereta de 3 metros de altura con alambre púa, 500 ml en Lo Prado');
  });

  test('is rejected only with item_field_unscoped, repairable, on the quantity observation', () => {
    const validation = validateV3AiProposal(policy, capturedProposal);

    expect(validation.valid).toBe(false);
    expect(errorCodes(validation)).toEqual(['item_field_unscoped']);
    const [error] = validation.errors;
    expect(error.disposition).toBe('repairable');
    expect(error.path).toBe('observations[2].item_ref');
    expect(error.related_ids).toEqual(['obs-quantity']);
    expect(error.allowed_values).toEqual(['new:1', 'new:2']);
  });

  test('the rejection carries the repair hint to attach the value to its product item', () => {
    const [error] = validateV3AiProposal(policy, capturedProposal).errors;

    expect(error.instruction).toBe(
      'Set item_ref to the item whose product this value describes (one of: new:1, new:2); a quantity or measurement written next to a product belongs to that product\'s item. Never leave a product, quantity or measurements observation or state_mutation without item_ref when the quote has several items.',
    );
  });

  test('the same proposal with the quantity on the pandereta item (new:1) validates clean', () => {
    const proposal = withQuantityRef(capturedProposal, 'new:1');
    const validation = validateV3AiProposal(policy, proposal);

    expect(validation.errors).toEqual([]);
    expect(validation.valid).toBe(true);
    expect(validation.authorized_mutations).toContainEqual(expect.objectContaining({
      field: 'quantity', item_ref: 'new:1',
    }));
  });

  test('the corrected proposal authorizes exactly two items, the quantity on the pandereta item', () => {
    const proposal = withQuantityRef(capturedProposal, 'new:1');
    const decision = authorizeV3ConversationDecision(policy, proposal, validateV3AiProposal(policy, proposal));
    const itemIds = new Set(decision.state_mutations.filter((m) => m.item_id !== null).map((m) => m.item_id));
    const measurementsItem = decision.state_mutations.find((m) => m.field === 'measurements').item_id;

    expect(itemIds.size).toBe(2);
    expect(decision.state_mutations.find((m) => m.field === 'quantity').item_id).toBe(measurementsItem);
  });

  test('a null item_ref on the mutation alone (observation scoped) is also rejected', () => {
    const proposal = withQuantityRef(capturedProposal, 'new:1');
    proposal.state_mutations.find((entry) => entry.observation_id === 'obs-quantity').item_ref = null;
    const validation = validateV3AiProposal(policy, proposal);

    expect(errorCodes(validation)).toEqual(['item_field_unscoped']);
    expect(validation.errors[0].path).toBe('state_mutations[2].item_ref');
    expect(validation.errors[0].related_ids).toEqual(['obs-quantity']);
  });

  test('a quote-level field (commune) with item_ref null stays accepted', () => {
    const proposal = withQuantityRef(capturedProposal, 'new:1');
    const validation = validateV3AiProposal(policy, proposal);

    expect(validation.authorized_mutations).toContainEqual(expect.objectContaining({
      field: 'commune', item_ref: null,
    }));
  });
});

// At most one item after the proposal: today's null item_ref behavior is
// unchanged (null resolves to the single existing item, or to the flat item).
const ITEM_MUTATION_AUTHORITY = ['product', 'quantity', 'measurements'].flatMap((field) => [
  { operation: 'set', concept: field, field },
  { operation: 'replace', concept: field, field },
]);

const policyFor = (message, items = []) => compileV3TurnPolicy({
  version: 'v3.1',
  turn: {
    id: 'turn-unscoped', conversation_id: 'conversation-unscoped', conversation_revision: 1,
    pending_question_goal_id: null, message: { id: 'message-unscoped', text: message },
  },
  history: { messages: [] },
  facts: items.flatMap((item) => ['product', 'quantity']
    .filter((field) => item[field] !== undefined && item[field] !== null)
    .map((field) => ({
      fact_id: `fact:item:${item.item_id}:${field}`, field, value: item[field],
      mutability: 'customer_correctable', source: { message_id: 'previous', evidence_digest: 'a'.repeat(64) },
    }))),
  goals: [], allowed_mutations: ITEM_MUTATION_AUTHORITY, grounding: {}, claim_rules: [],
  effect_permissions: [], effect_requirements: [],
});

const quantityProposal = (targetPolicy, evidence, extra = {}) => ({
  version: V3_CONTRACTS.proposal_v3_1,
  policy_digest: targetPolicy.policy_digest,
  reply_text: 'Entendido.',
  primary_request: null,
  catalog_resolutions: [],
  observations: [{
    id: 'obs-quantity', concept: 'quantity', raw_value: evidence, normalized_value: evidence,
    evidence_quote: evidence, evidence_occurrence: 1, grounding_ref: null, resolves_goal_ids: [], item_ref: null,
  }],
  state_mutations: [
    { operation: 'set', field: 'quantity', item_ref: null, observation_id: 'obs-quantity', replaces_fact_id: null },
  ],
  effect_requests: [],
  ...extra,
});

describe('item_field_unscoped never fires with at most one item', () => {
  test('no item at all ("necesito 100 unidades"): null item_ref still resolves to the flat item', () => {
    const targetPolicy = policyFor('necesito 100 unidades');
    const validation = validateV3AiProposal(targetPolicy, quantityProposal(targetPolicy, '100 unidades'));

    expect(validation.errors).toEqual([]);
    expect(validation.valid).toBe(true);
    expect(validation.authorized_mutations).toContainEqual(expect.objectContaining({
      field: 'quantity', item_ref: 'li_0',
    }));
  });

  test('one existing item: null item_ref still resolves to that item', () => {
    const targetPolicy = policyFor('mejor 100 unidades', [{ item_id: 'li_a', product: 'Adoquín' }]);
    const validation = validateV3AiProposal(targetPolicy, quantityProposal(targetPolicy, '100 unidades'));

    expect(validation.errors).toEqual([]);
    expect(validation.valid).toBe(true);
    expect(validation.authorized_mutations).toContainEqual(expect.objectContaining({
      field: 'quantity', item_ref: 'li_a',
    }));
  });

  test('single-product first turn (one new item): no item_field_unscoped', () => {
    const proposal = clone(capturedProposal);
    proposal.catalog_resolutions = proposal.catalog_resolutions.filter((entry) => entry.item_ref === 'new:2');
    proposal.observations = proposal.observations.filter((entry) => entry.id !== 'obs-measurements');
    proposal.state_mutations = proposal.state_mutations.filter((entry) => entry.observation_id !== 'obs-measurements');
    proposal.primary_request = null;
    const validation = validateV3AiProposal(policy, proposal);

    expect(errorCodes(validation)).not.toContain('item_field_unscoped');
  });

  test('two existing items keep item_target_required as the only item-scope rejection', () => {
    const targetPolicy = policyFor('mejor 100 unidades', [
      { item_id: 'li_a', product: 'Adoquín' },
      { item_id: 'li_b', product: 'Pastelón' },
    ]);
    const validation = validateV3AiProposal(targetPolicy, quantityProposal(targetPolicy, '100 unidades'));

    expect(errorCodes(validation)).toEqual(['item_target_required']);
  });
});
