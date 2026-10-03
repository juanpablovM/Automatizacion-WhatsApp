import fs from 'node:fs';
import { createRequire } from 'node:module';
import { describe, expect, test } from 'vitest';
import { buildTurnPolicy } from '../ops/v3-line-items-live-replay.mjs';

const require = createRequire(import.meta.url);
const { validateV3AiProposal, V3_CONTRACTS } = require('../fixtures/workflow-nodes/shared/v3-contract-runtime.js');

// -----------------------------------------------------------------------------
// Task 3c.26. Live conversation 387 (2026-09-30, sanitized to the public
// catalog): "Baldosas" -> Baldosa Minvu; "No quiero baldosas minvu" -> the item
// was removed (remove_item); the next message "Baldosas" set product=Baldosa
// Minvu again on a new item while the reply said "no buscas Baldosa Minvu".
// `Load Conversation State` lists the removed products
// (v3_grounding.removed_products, from the committed turn ledger); the v3.1
// policy marks their catalog entries `removed_by_customer: true` unless the
// product is in the quote again; the v3.1 validator rejects recording such a
// product (`product_previously_rejected`, repairable) unless the current
// message names it by its full catalog name. A synonym is not enough:
// "baldosas" was exactly the generic word the customer was moving away from.
//
// CATALOG is the catalog of conversation 387 (026 synonyms, before 3c.27).
// Since 3c.27 "Baldosas" is its own product (CATALOG_3C27, end of this file):
// after removing Baldosa Minvu the customer may ask for Baldosas.
// -----------------------------------------------------------------------------

const CATALOG = [
  { ref: 'product:baldosa-minvu', concept: 'product', value: 'Baldosa Minvu', synonyms: ['baldosas minvu', 'baldosa', 'baldosas', 'baldosa de vereda'] },
  { ref: 'product:pastelones', concept: 'product', value: 'Pastelones', synonyms: ['pastelón', 'losetas'] },
  { ref: 'product:adoquin', concept: 'product', value: 'Adoquín', synonyms: ['adoquines'] },
];
const groundingWith = (removed) => ({ catalog: CATALOG, ...(removed ? { removed_products: removed } : {}) });
const ITEM = 'li_baldosa';
const contextWithItems = (items) => (items.length === 0 ? {
  line_items: [], line_items_schema: 'line_items/v1',
  line_items_projection: { product: null, quantity: null, measurements: null },
} : {
  product: items[0].product, quantity: items[0].quantity ?? null, measurements: null,
  line_items: items.map((entry) => ({
    item_id: entry.item_id, product: entry.product, quantity: entry.quantity ?? null,
    measurements: null, catalog_ref: null, requested_label: null,
  })),
  line_items_schema: 'line_items/v1',
  line_items_projection: { product: items[0].product, quantity: items[0].quantity ?? null, measurements: null },
});
const codes = (validation) => validation.errors.map((error) => error.code);

const setProductProposal = (policy, { quote, itemRef = 'new:1', operation = 'set', replacesFactId = null }) => ({
  version: V3_CONTRACTS.proposal_v3_1,
  policy_digest: policy.policy_digest,
  reply_text: 'Perfecto, anoto *Baldosa Minvu*.\n\n👉 ¿Qué cantidad necesitas?',
  primary_request: { goal_id: 'quantity', item_ref: itemRef },
  catalog_resolutions: [{
    status: 'matched', item_ref: itemRef, grounding_ref: 'product:baldosa-minvu', evidence_quote: quote, evidence_occurrence: 1,
  }],
  observations: [{
    id: 'obs_product', concept: 'product', item_ref: itemRef, raw_value: quote, normalized_value: 'Baldosa Minvu',
    evidence_quote: quote, evidence_occurrence: 1, grounding_ref: 'product:baldosa-minvu', resolves_goal_ids: ['product'],
  }],
  state_mutations: [{
    operation, field: 'product', item_ref: itemRef, observation_id: 'obs_product', replaces_fact_id: replacesFactId,
  }],
  effect_requests: [],
});

describe('v3.1 policy marks the products the customer removed', () => {
  test('a removed product not in the quote is marked removed_by_customer', () => {
    const policy = buildTurnPolicy('v3.1', contextWithItems([]), groundingWith(['Baldosa Minvu']), { text: 'Baldosas' });
    expect(policy.grounding.catalog.find((entry) => entry.ref === 'product:baldosa-minvu'))
      .toMatchObject({ value: 'Baldosa Minvu', removed_by_customer: true });
    expect(policy.grounding.catalog.find((entry) => entry.ref === 'product:pastelones')).not.toHaveProperty('removed_by_customer');
  });

  test('matching is accent and case insensitive', () => {
    const policy = buildTurnPolicy('v3.1', contextWithItems([]), groundingWith(['adoquin']), { text: 'hola' });
    expect(policy.grounding.catalog.find((entry) => entry.ref === 'product:adoquin').removed_by_customer).toBe(true);
  });

  test('a removed product that is back in the quote is not marked', () => {
    const policy = buildTurnPolicy('v3.1', contextWithItems([{ item_id: ITEM, product: 'Baldosa Minvu' }]),
      groundingWith(['Baldosa Minvu']), { text: '20 m2' });
    expect(policy.grounding.catalog.find((entry) => entry.ref === 'product:baldosa-minvu')).not.toHaveProperty('removed_by_customer');
  });

  test('without removals the v3.1 policy is identical to before', () => {
    const withoutKey = buildTurnPolicy('v3.1', contextWithItems([]), groundingWith(null), { text: 'Baldosas' });
    const emptyList = buildTurnPolicy('v3.1', contextWithItems([]), groundingWith([]), { text: 'Baldosas' });
    expect(emptyList.grounding).toEqual(withoutKey.grounding);
    expect(withoutKey.grounding.catalog.some((entry) => 'removed_by_customer' in entry)).toBe(false);
  });

  test('v3 (rollback path) never carries the mark', () => {
    const policy = buildTurnPolicy('v3', contextWithItems([]), groundingWith(['Baldosa Minvu']), { text: 'Baldosas' });
    expect(policy.grounding.catalog.some((entry) => 'removed_by_customer' in entry)).toBe(false);
  });
});

describe('v3.1 validator: conv 387 replay, a removed product is not re-added', () => {
  const rejectedTurn = (text, context = contextWithItems([])) => buildTurnPolicy('v3.1', context,
    groundingWith(['Baldosa Minvu']), { text, pendingQuestionKey: 'product' });

  test('"Baldosas" after removing Baldosa Minvu is rejected with product_previously_rejected', () => {
    const policy = rejectedTurn('Baldosas');
    const validation = validateV3AiProposal(policy, setProductProposal(policy, { quote: 'Baldosas' }));
    expect(validation.valid).toBe(false);
    expect(codes(validation)).toEqual(['product_previously_rejected']);
    const [error] = validation.errors;
    expect(error).toMatchObject({
      disposition: 'repairable',
      path: 'state_mutations[0]',
      related_ids: ['obs_product'],
      allowed_values: ['product:baldosa-minvu'],
    });
    expect(error.instruction).toContain('Baldosa Minvu');
    expect(error.instruction).toContain('alternatives');
  });

  test('the repaired proposal (no product recorded, real alternatives offered) is valid', () => {
    const policy = rejectedTurn('Baldosas');
    const validation = validateV3AiProposal(policy, {
      version: V3_CONTRACTS.proposal_v3_1,
      policy_digest: policy.policy_digest,
      reply_text: 'Entiendo, no buscas *Baldosa Minvu*. Para pisos exteriores también tenemos *Pastelones* y *Adoquín*.\n\n👉 ¿Te interesa alguno de ellos?',
      primary_request: { goal_id: 'product', item_ref: null },
      catalog_resolutions: [],
      observations: [],
      state_mutations: [],
      effect_requests: [],
    });
    expect(codes(validation)).toEqual([]);
    expect(validation.valid).toBe(true);
  });

  test.each([
    'Sí, quiero baldosas minvu',
    'Bueno, cotízame la Baldosa Minvu',
    'baldosa minvu',
  ])('naming the full product again re-requests it: "%s"', (text) => {
    const policy = rejectedTurn(text);
    const quote = text.match(/baldosas? minvu/i)[0];
    const validation = validateV3AiProposal(policy, setProductProposal(policy, { quote }));
    expect(codes(validation)).not.toContain('product_previously_rejected');
    expect(validation.valid).toBe(true);
  });

  test('replacing another item\'s product with the removed product is rejected too', () => {
    const context = contextWithItems([{ item_id: 'li_pastelones', product: 'Pastelones' }]);
    const policy = rejectedTurn('mejor baldosas', context);
    const fact = policy.facts.find((entry) => entry.fact_id === 'fact:item:li_pastelones:product');
    const validation = validateV3AiProposal(policy, setProductProposal(policy, {
      quote: 'baldosas', itemRef: 'li_pastelones', operation: 'replace', replacesFactId: fact.fact_id,
    }));
    expect(codes(validation)).toContain('product_previously_rejected');
  });

  test('other products are unaffected', () => {
    const policy = rejectedTurn('Pastelones');
    const validation = validateV3AiProposal(policy, {
      ...setProductProposal(policy, { quote: 'Pastelones' }),
      catalog_resolutions: [{
        status: 'matched', item_ref: 'new:1', grounding_ref: 'product:pastelones', evidence_quote: 'Pastelones', evidence_occurrence: 1,
      }],
      observations: [{
        id: 'obs_product', concept: 'product', item_ref: 'new:1', raw_value: 'Pastelones', normalized_value: 'Pastelones',
        evidence_quote: 'Pastelones', evidence_occurrence: 1, grounding_ref: 'product:pastelones', resolves_goal_ids: ['product'],
      }],
    });
    expect(codes(validation)).toEqual([]);
  });

  test('without a removal "Baldosas" keeps recording Baldosa Minvu (conversation 387 catalog, before 3c.27)', () => {
    const policy = buildTurnPolicy('v3.1', contextWithItems([]), groundingWith(null), { text: 'Baldosas' });
    const validation = validateV3AiProposal(policy, setProductProposal(policy, { quote: 'Baldosas' }));
    expect(codes(validation)).toEqual([]);
  });
});

describe('v3.1 prompt rule', () => {
  const systemPrompt = (version) => {
    const source = fs.readFileSync('tests/fixtures/workflow-nodes/ai-lead-qualification-assistant/build-ai-request.js', 'utf8');
    const turnPolicy = buildTurnPolicy(version, contextWithItems([]), groundingWith(['Baldosa Minvu']), { text: 'Baldosas' });
    const output = new Function('items', '$env', source)(
      [{ json: { contract_version: 'v3', turn_policy: turnPolicy } }],
      { AI_PROVIDER: 'openai', OPENAI_API_KEY: 'fake-key-123' },
    );
    return output[0].json.ai_request.input[0].content;
  };

  test('v3.1 tells the model not to re-add a removed product and to offer real alternatives', () => {
    const prompt = systemPrompt('v3.1');
    expect(prompt).toContain('removed_by_customer');
    expect(prompt).toContain('no lo vuelvas a registrar salvo que el cliente lo pida de nuevo');
    expect(prompt).toContain('alternativas reales del catálogo');
    expect(systemPrompt('v3')).not.toContain('removed_by_customer');
  });

  test('3c.27: the rule never calls "baldosas" a synonym (it is another product) and lets another product be recorded', () => {
    const prompt = systemPrompt('v3.1');
    expect(prompt).not.toContain('(por ejemplo "baldosas") no basta');
    expect(prompt).toContain('un sinónimo (por ejemplo "baldosa táctil") no basta');
    expect(prompt).toContain('Otro producto distinto del catálogo (por ejemplo "Baldosas") sí puede registrarse');
  });

  // Owner request 2026-10-03: after "No quiero baldosas minvu" the bot offered
  // pastelones and adoquines instead of the other tiles.
  test('alternatives come first from the same product family, then from other lines', () => {
    const prompt = systemPrompt('v3.1');
    expect(prompt).toContain('primero ofrece las alternativas de la misma familia del producto');
    expect(prompt).toContain('si quita "Baldosa Minvu", ofrece "Baldosas" y sus tipos');
    expect(prompt).toContain('Solo si no hay otro producto de esa familia, ofrece otras líneas del catálogo');
    expect(systemPrompt('v3')).not.toContain('misma familia del producto');
  });
});

// -----------------------------------------------------------------------------
// Task 3c.27 (owner decision): Baldosa Minvu is only the tactile MINVU tiles and
// "Baldosas" is a different product that owns the generic phrases (029 plus the
// private catalog data). Replaying conversation 387 on that catalog: after "No
// quiero baldosas minvu", "Baldosas" may be recorded as Baldosas; recording
// Baldosa Minvu again from a generic word or a synonym is still rejected.
// -----------------------------------------------------------------------------
const CATALOG_3C27 = [
  {
    ref: 'product:baldosa-minvu', concept: 'product', value: 'Baldosa Minvu',
    synonyms: ['baldosas minvu', 'baldosa minvu táctil', 'baldosa táctil', 'baldosas táctiles', 'baldosa podotáctil', 'baldosas podotáctiles'],
  },
  { ref: 'product:baldosas', concept: 'product', value: 'Baldosas', synonyms: ['baldosa', 'baldosa de vereda'] },
  { ref: 'product:pastelones', concept: 'product', value: 'Pastelones', synonyms: ['pastelón', 'losetas'] },
];
const recordProduct = (policy, { quote, ref, name }) => {
  const proposal = setProductProposal(policy, { quote });
  return {
    ...proposal,
    reply_text: `Perfecto, anoto *${name}*.\n\n👉 ¿Qué cantidad necesitas?`,
    catalog_resolutions: [{ ...proposal.catalog_resolutions[0], grounding_ref: ref }],
    observations: [{ ...proposal.observations[0], normalized_value: name, grounding_ref: ref }],
  };
};

describe('3c.27 catalog: Baldosas is a different product from Baldosa Minvu', () => {
  const turn = (text, removed = ['Baldosa Minvu']) => buildTurnPolicy('v3.1', contextWithItems([]),
    { catalog: CATALOG_3C27, ...(removed ? { removed_products: removed } : {}) }, { text, pendingQuestionKey: 'product' });

  test('only Baldosa Minvu is marked after "No quiero baldosas minvu"', () => {
    const policy = turn('Baldosas');
    expect(policy.grounding.catalog.find((entry) => entry.ref === 'product:baldosa-minvu').removed_by_customer).toBe(true);
    expect(policy.grounding.catalog.find((entry) => entry.ref === 'product:baldosas')).not.toHaveProperty('removed_by_customer');
  });

  test.each(['Baldosas', 'baldosa lisa', 'Necesito baldosas de vereda'])('"%s" may record Baldosas', (text) => {
    const policy = turn(text);
    const quote = text.match(/baldosas?/i)[0];
    const validation = validateV3AiProposal(policy, recordProduct(policy, { quote, ref: 'product:baldosas', name: 'Baldosas' }));
    expect(codes(validation)).toEqual([]);
    expect(validation.valid).toBe(true);
  });

  test('recording Baldosa Minvu again from "Baldosas" is still rejected', () => {
    const policy = turn('Baldosas');
    const validation = validateV3AiProposal(policy, setProductProposal(policy, { quote: 'Baldosas' }));
    expect(codes(validation)).toEqual(['product_previously_rejected']);
  });

  test('a Baldosa Minvu synonym is not enough to re-add it, its full name is', () => {
    const bySynonym = turn('mejor baldosa táctil');
    expect(codes(validateV3AiProposal(bySynonym, setProductProposal(bySynonym, { quote: 'baldosa táctil' }))))
      .toEqual(['product_previously_rejected']);
    const byName = turn('Bueno, sí quiero las baldosas minvu');
    expect(codes(validateV3AiProposal(byName, setProductProposal(byName, { quote: 'baldosas minvu' })))).toEqual([]);
  });

  test('removing Baldosas does not block Baldosa Minvu', () => {
    const policy = turn('baldosa minvu', ['Baldosas']);
    expect(policy.grounding.catalog.find((entry) => entry.ref === 'product:baldosas').removed_by_customer).toBe(true);
    expect(policy.grounding.catalog.find((entry) => entry.ref === 'product:baldosa-minvu')).not.toHaveProperty('removed_by_customer');
    expect(codes(validateV3AiProposal(policy, setProductProposal(policy, { quote: 'baldosa minvu' })))).toEqual([]);
  });
});
