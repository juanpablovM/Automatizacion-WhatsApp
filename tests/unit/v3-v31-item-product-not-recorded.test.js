import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { describe, expect, test } from 'vitest';
import { buildTurnPolicy } from '../ops/v3-line-items-live-replay.mjs';

const require = createRequire(import.meta.url);
const {
  validateV3AiProposal, authorizeV3ConversationDecision, V3_CONTRACTS,
} = require('../fixtures/workflow-nodes/shared/v3-contract-runtime.js');

// -----------------------------------------------------------------------------
// Live production 2026-09-28 (conversation 347, v3.1 enabled for all):
// "Necesito cotizar una pandereta de 500 metros de largo por 1,80 de altura,
// con concertina y alambre pua. Uds realizan ese servicio?"
// The model resolved pandereta as unsupported (new:1) and matched concertina
// (new:2) and alambre pua (new:3), observed both wire products, but emitted
// state_mutations only for new:1's quantity and measurements. The proposal
// validated clean, so two requested products silently vanished from the lead.
// item_product_not_recorded rejects (repairable) a product observation for a
// matched new item, or for an existing item with no product fact yet, that has
// no product state_mutation, unless D5 withholds that product
// (ambiguous/unsupported resolution).
// -----------------------------------------------------------------------------

const fixturePath = path.join(
  process.cwd(), 'tests', 'fixtures', 'v3-line-items', 'captured-matched-products-dropped.json',
);
const captured = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));
const { policy } = captured;
const [capturedProposal] = captured.proposals;
const clone = (value) => JSON.parse(JSON.stringify(value));
const errorCodes = (validation) => validation.errors.map((error) => error.code);

const productNotRecordedInstruction = (itemRef, observationId) => `Add a state_mutation with operation "set", field "product", item_ref "${itemRef}", observation_id "${observationId}" and replaces_fact_id null. Every product the customer requests, including accessories such as wire or concertina mentioned "with" another product, is its own item and needs its own product mutation; never leave a product observation without its mutation.`;

const productSet = (itemRef, observationId) => ({
  operation: 'set', field: 'product', item_ref: itemRef, observation_id: observationId, replaces_fact_id: null,
});

const withProductMutations = (proposal) => {
  const next = clone(proposal);
  next.state_mutations.push(productSet('new:2', 'obs_product_1'), productSet('new:3', 'obs_product_2'));
  return next;
};

describe('captured proposal: matched products observed without product mutations', () => {
  test('the fixture is the v3.1 first turn with one unsupported and two matched items', () => {
    expect(policy.version).toBe(V3_CONTRACTS.policy_v3_1);
    expect(policy.facts).toEqual([]);
    expect(capturedProposal.catalog_resolutions.map((entry) => [entry.item_ref, entry.status]))
      .toEqual([['new:1', 'unsupported'], ['new:2', 'matched'], ['new:3', 'matched']]);
    expect(capturedProposal.state_mutations.map((entry) => entry.field)).toEqual(['quantity', 'measurements']);
  });

  test('is rejected only with item_product_not_recorded, once per unrecorded product observation', () => {
    const validation = validateV3AiProposal(policy, capturedProposal);

    expect(validation.valid).toBe(false);
    expect(errorCodes(validation)).toEqual(['item_product_not_recorded', 'item_product_not_recorded']);
    expect(validation.errors).toEqual([
      {
        code: 'item_product_not_recorded',
        path: 'observations[0]',
        disposition: 'repairable',
        related_ids: ['obs_product_1'],
        allowed_values: ['new:2'],
        instruction: productNotRecordedInstruction('new:2', 'obs_product_1'),
      },
      {
        code: 'item_product_not_recorded',
        path: 'observations[1]',
        disposition: 'repairable',
        related_ids: ['obs_product_2'],
        allowed_values: ['new:3'],
        instruction: productNotRecordedInstruction('new:3', 'obs_product_2'),
      },
    ]);
  });

  test('the same proposal with both product set mutations validates clean', () => {
    const proposal = withProductMutations(capturedProposal);
    const validation = validateV3AiProposal(policy, proposal);

    expect(validation.errors).toEqual([]);
    expect(validation.valid).toBe(true);
    expect(validation.withheld_mutations).toEqual([]);
    expect(validation.authorized_mutations).toEqual(expect.arrayContaining([
      expect.objectContaining({ field: 'product', item_ref: 'new:2', projected_value: 'Alambre Concertina' }),
      expect.objectContaining({ field: 'product', item_ref: 'new:3', projected_value: 'Alambre de Púas' }),
    ]));
  });

  test('the corrected proposal authorizes three items, both wire products recorded', () => {
    const proposal = withProductMutations(capturedProposal);
    const decision = authorizeV3ConversationDecision(policy, proposal, validateV3AiProposal(policy, proposal));
    const itemIds = new Set(decision.state_mutations.filter((m) => m.item_id !== null).map((m) => m.item_id));
    const products = decision.state_mutations.filter((m) => m.field === 'product').map((m) => m.value ?? m.projected_value);

    expect(itemIds.size).toBe(3);
    expect(products).toHaveLength(2);
  });

  test('recording only one product still rejects the other one', () => {
    const proposal = clone(capturedProposal);
    proposal.state_mutations.push(productSet('new:2', 'obs_product_1'));
    const validation = validateV3AiProposal(policy, proposal);

    expect(errorCodes(validation)).toEqual(['item_product_not_recorded']);
    expect(validation.errors[0].related_ids).toEqual(['obs_product_2']);
  });

  test('D5: an unsupported item\'s product observation without a mutation is not rejected', () => {
    const proposal = clone(capturedProposal);
    const wire = proposal.catalog_resolutions.find((entry) => entry.item_ref === 'new:3');
    wire.status = 'unsupported';
    wire.grounding_ref = null;
    const validation = validateV3AiProposal(policy, proposal);

    expect(errorCodes(validation)).toEqual(['item_product_not_recorded']);
    expect(validation.errors[0].related_ids).toEqual(['obs_product_1']);
  });

  test('D5: an ambiguous item\'s product mutation is still withheld, not rejected', () => {
    const proposal = withProductMutations(capturedProposal);
    const wire = proposal.catalog_resolutions.find((entry) => entry.item_ref === 'new:3');
    wire.status = 'ambiguous';
    wire.grounding_ref = null;
    proposal.primary_request = { goal_id: 'product', item_ref: 'new:3' };
    const validation = validateV3AiProposal(policy, proposal);

    expect(errorCodes(validation)).not.toContain('item_product_not_recorded');
    expect(validation.valid).toBe(true);
    expect(validation.withheld_mutations).toEqual([
      expect.objectContaining({ field: 'product', item_ref: 'new:3', observation_id: 'obs_product_2' }),
    ]);
  });
});

// Turns on existing items, built with the live-replay policy builder.
const PANDERETA_REF = 'li_pandereta01';
const WIRE_REF = 'li_wire000001';
const existingContext = {
  line_items: [
    { item_id: PANDERETA_REF, product: null, requested_label: 'pandereta', quantity: '500 ml', measurements: '3 metros de altura' },
    { item_id: WIRE_REF, product: 'Alambre de Púas', quantity: null, measurements: null },
  ],
};
const policyWith = (text) => buildTurnPolicy('v3.1', existingContext, undefined, { text });
const catalogEntry = (targetPolicy, ref) => targetPolicy.grounding.catalog.find((entry) => entry.ref === ref);

const productTurn = (targetPolicy, { itemRef, groundingRef, quote, resolution = null, mutations = [] }) => ({
  version: V3_CONTRACTS.proposal_v3_1,
  policy_digest: targetPolicy.policy_digest,
  reply_text: 'Entendido.',
  primary_request: null,
  catalog_resolutions: resolution ? [{
    status: resolution, evidence_quote: quote, evidence_occurrence: 1,
    grounding_ref: resolution === 'matched' ? groundingRef : null, item_ref: itemRef,
  }] : [],
  observations: [{
    id: 'obs-product', concept: 'product', raw_value: quote,
    normalized_value: catalogEntry(targetPolicy, groundingRef).value,
    evidence_quote: quote, evidence_occurrence: 1, grounding_ref: groundingRef,
    resolves_goal_ids: [], item_ref: itemRef,
  }],
  state_mutations: mutations,
  effect_requests: [],
});

describe('item_product_not_recorded on existing items', () => {
  test('restating an existing item\'s product fact without a mutation is accepted', () => {
    const targetPolicy = policyWith('el alambre de púas viene en rollos?');
    const validation = validateV3AiProposal(targetPolicy, productTurn(targetPolicy, {
      itemRef: WIRE_REF, groundingRef: 'product:alambre-de-puas', quote: 'alambre de púas',
    }));

    expect(errorCodes(validation)).not.toContain('item_product_not_recorded');
    expect(validation.valid).toBe(true);
  });

  test('naming another product for an item that already has a product fact is not this guard', () => {
    const targetPolicy = policyWith('y el cierro de hormigón es más caro?');
    const validation = validateV3AiProposal(targetPolicy, productTurn(targetPolicy, {
      itemRef: WIRE_REF, groundingRef: 'product:cierro-de-hormigon', quote: 'cierro de hormigón',
    }));

    expect(errorCodes(validation)).not.toContain('item_product_not_recorded');
  });

  test('clarifying the product of an item with no product fact, without a mutation, is rejected', () => {
    const targetPolicy = policyWith('sí, me refiero al cierro de hormigón');
    const validation = validateV3AiProposal(targetPolicy, productTurn(targetPolicy, {
      itemRef: PANDERETA_REF, groundingRef: 'product:cierro-de-hormigon', quote: 'cierro de hormigón', resolution: 'matched',
    }));

    expect(errorCodes(validation)).toEqual(['item_product_not_recorded']);
    expect(validation.errors[0]).toEqual(expect.objectContaining({
      path: 'observations[0]',
      related_ids: ['obs-product'],
      allowed_values: [PANDERETA_REF],
      instruction: productNotRecordedInstruction(PANDERETA_REF, 'obs-product'),
    }));
  });

  test('the same clarification with its product set mutation validates clean', () => {
    const targetPolicy = policyWith('sí, me refiero al cierro de hormigón');
    const validation = validateV3AiProposal(targetPolicy, productTurn(targetPolicy, {
      itemRef: PANDERETA_REF, groundingRef: 'product:cierro-de-hormigon', quote: 'cierro de hormigón', resolution: 'matched',
      mutations: [productSet(PANDERETA_REF, 'obs-product')],
    }));

    expect(validation.errors).toEqual([]);
    expect(validation.authorized_mutations).toContainEqual(expect.objectContaining({
      field: 'product', item_ref: PANDERETA_REF,
    }));
  });

  test('D5: a still-unsupported clarification of an item with no product fact is not rejected', () => {
    const targetPolicy = policyWith('sí, me refiero al cierro de hormigón');
    const validation = validateV3AiProposal(targetPolicy, productTurn(targetPolicy, {
      itemRef: PANDERETA_REF, groundingRef: 'product:cierro-de-hormigon', quote: 'cierro de hormigón', resolution: 'unsupported',
    }));

    expect(errorCodes(validation)).not.toContain('item_product_not_recorded');
  });
});

describe('item_product_not_recorded never changes other captured outcomes', () => {
  const fixtureDir = path.join(process.cwd(), 'tests', 'fixtures', 'v3-line-items');
  const otherCaptured = fs.readdirSync(fixtureDir)
    .filter((file) => file.endsWith('.json') && file !== 'captured-matched-products-dropped.json')
    .flatMap((file) => {
      const data = JSON.parse(fs.readFileSync(path.join(fixtureDir, file), 'utf8'));
      return Array.isArray(data)
        ? data.map((entry, index) => [`${file}#${index}`, entry.turn_policy, entry.proposal])
        : data.proposals.map((proposal, index) => [`${file}#${index}`, data.policy, proposal]);
    });

  test.each(otherCaptured)('%s does not raise item_product_not_recorded', (_name, capturedPolicy, proposal) => {
    expect(errorCodes(validateV3AiProposal(capturedPolicy, proposal))).not.toContain('item_product_not_recorded');
  });
});
