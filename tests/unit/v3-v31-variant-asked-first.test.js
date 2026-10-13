import fs from 'node:fs';
import { createRequire } from 'node:module';
import { describe, expect, test } from 'vitest';
import { buildTurnPolicy } from '../ops/v3-line-items-live-replay.mjs';

const require = createRequire(import.meta.url);
const { validateV3AiProposal, V3_CONTRACTS } = require('../fixtures/workflow-nodes/shared/v3-contract-runtime.js');

// Live conversation 475 (2026-10-13): the customer named baldosas and
// solerillas, and the bot asked scope, commune, address, terrain, access and
// debris before asking which baldosa type. Owner decision: as soon as a quoted
// product has variants to choose from, the next question is its variant.
// Variant names are synthetic placeholders.

const GROUNDING = Object.freeze({
  catalog: [
    {
      ref: 'product:baldosas', concept: 'product', value: 'Baldosas',
      technical_sheet: { variants: [{ name: 'Baldosa Uno' }, { name: 'Baldosa Dos' }] },
    },
    {
      ref: 'product:soleras', concept: 'product', value: 'Soleras y Solerillas',
      technical_sheet: { variants: [{ name: 'Solerilla Uno' }, { name: 'Solerilla Dos' }] },
    },
    { ref: 'product:cemento', concept: 'product', value: 'Cemento' },
  ],
});
const item = (itemId, product, overrides = {}) => ({
  item_id: itemId, product, quantity: null, measurements: null, catalog_ref: null, requested_label: null, ...overrides,
});
const contextWith = (items) => ({ line_items: items, line_items_schema: 'line_items/v1' });
const policyFor = (items, text = 'Quiero baldosas', options = {}) => buildTurnPolicy('v3.1', contextWith(items), GROUNDING, { text, ...options });
const proposal = (policy, overrides = {}) => ({
  version: V3_CONTRACTS.proposal_v3_1,
  policy_digest: policy.policy_digest,
  reply_text: '¿En qué comuna sería el proyecto?',
  primary_request: { goal_id: 'commune', item_ref: null },
  catalog_resolutions: [],
  observations: [],
  state_mutations: [],
  effect_requests: [],
  ...overrides,
});
const codes = (validation) => validation.errors.map((error) => error.code);

describe('a product with variants gets its variant question before any other detail', () => {
  test('asking the commune while the baldosa type is unchosen is rejected with the variant to ask', () => {
    const policy = policyFor([item('li_b', 'Baldosas')]);
    const validation = validateV3AiProposal(policy, proposal(policy));
    expect(codes(validation)).toEqual(['variant_question_first']);
    const [error] = validation.errors;
    expect(error.allowed_values).toEqual(['variant@li_b']);
    expect(error.instruction).toContain('Baldosa Uno, Baldosa Dos');
    expect(error.instruction).toContain('"goal_id": "variant", "item_ref": "li_b"');
  });

  test('every quote detail waits: scope, quantity, address, terrain', () => {
    const policy = policyFor([item('li_b', 'Baldosas')]);
    for (const goalId of ['service_scope', 'fulfillment', 'address', 'terrain', 'truck_access', 'debris_removal']) {
      expect(codes(validateV3AiProposal(policy, proposal(policy, { primary_request: { goal_id: goalId, item_ref: null } }))), goalId)
        .toEqual(['variant_question_first']);
    }
    expect(codes(validateV3AiProposal(policy, proposal(policy, { primary_request: { goal_id: 'quantity', item_ref: 'li_b' } }))))
      .toEqual(['variant_question_first']);
  });

  test('asking the variant is valid', () => {
    const policy = policyFor([item('li_b', 'Baldosas')]);
    expect(validateV3AiProposal(policy, proposal(policy, {
      reply_text: '¿Qué tipo de baldosa prefieres: *Baldosa Uno* o *Baldosa Dos*?',
      primary_request: { goal_id: 'variant', item_ref: 'li_b' },
    })).errors).toEqual([]);
  });

  test('with two products without variant, either variant question is fine and other details wait', () => {
    const policy = policyFor([item('li_b', 'Baldosas'), item('li_s', 'Soleras y Solerillas')], 'Quiero baldosas y solerillas');
    for (const [ref, reply] of [['li_b', '¿Qué tipo de baldosa prefieres?'], ['li_s', '¿Qué tipo de solerilla prefieres?']]) {
      expect(validateV3AiProposal(policy, proposal(policy, {
        reply_text: reply, primary_request: { goal_id: 'variant', item_ref: ref },
      })).errors).toEqual([]);
    }
    const validation = validateV3AiProposal(policy, proposal(policy));
    expect(codes(validation)).toEqual(['variant_question_first']);
    expect(validation.errors[0].allowed_values).toEqual(['variant@li_b', 'variant@li_s']);
  });

  test('a product without variants, or with its variant already chosen, does not hold other questions', () => {
    const cemento = policyFor([item('li_c', 'Cemento')], 'Quiero cemento');
    expect(validateV3AiProposal(cemento, proposal(cemento)).errors).toEqual([]);
    const chosen = policyFor([item('li_b', 'Baldosas', { variant: 'Baldosa Dos' })], 'Vitacura');
    expect(validateV3AiProposal(chosen, proposal(chosen)).errors).toEqual([]);
  });

  test('a variant chosen in this same message unblocks the next question', () => {
    const policy = policyFor([item('li_b', 'Baldosas')], 'La baldosa dos');
    expect(validateV3AiProposal(policy, proposal(policy, {
      observations: [{
        id: 'obs_v', concept: 'variant', raw_value: 'baldosa dos', normalized_value: 'Baldosa Dos', evidence_quote: 'baldosa dos',
        evidence_occurrence: 1, grounding_ref: null, resolves_goal_ids: [], item_ref: 'li_b',
      }],
      state_mutations: [{ operation: 'set', field: 'variant', item_ref: 'li_b', observation_id: 'obs_v', replaces_fact_id: null }],
    })).errors).toEqual([]);
  });

  test('a reply with no question, or offering a technical sheet, is not held', () => {
    const policy = policyFor([item('li_b', 'Baldosas')]);
    expect(validateV3AiProposal(policy, proposal(policy, { reply_text: 'Gracias.', primary_request: null })).errors).toEqual([]);
  });

  test('the prompt asks the variant right after the product', () => {
    const source = fs.readFileSync('tests/fixtures/workflow-nodes/ai-lead-qualification-assistant/build-ai-request.js', 'utf8');
    const rule = source.match(/const V31_VARIANT_RULE = '([^']*)'/)[1];
    expect(rule).toContain('pregúntale cuál necesita apenas lo nombra, antes de cualquier otro dato (cantidad, alcance, comuna, dirección, terreno o acceso)');
  });
});

// Live 2026-10-13: with baldosas and solerillas in the quote, the bot asked
// "¿Cuántas unidades necesitas?" without saying for which product. Owner
// decision: an item question names its product when the quote has several.
describe('an item question names its product when the quote has several', () => {
  const twoItems = () => policyFor([
    item('li_b', 'Baldosas', { variant: 'Baldosa Uno' }),
    item('li_s', 'Soleras y Solerillas', { variant: 'Solerilla Dos' }),
  ], 'La solerilla dos');
  const ask = (policy, replyText, itemRef = 'li_s') => validateV3AiProposal(policy, proposal(policy, {
    reply_text: replyText, primary_request: { goal_id: 'quantity', item_ref: itemRef },
  }));

  test('a quantity question without the product is rejected', () => {
    const validation = ask(twoItems(), 'Gracias.\n\n¿Cuántas unidades necesitas?');
    expect(codes(validation)).toEqual(['item_question_product_unnamed']);
    expect(validation.errors[0].instruction).toContain('Soleras y Solerillas');
  });

  test('naming the product, its variant or a word of it is valid', () => {
    const policy = twoItems();
    for (const reply of [
      '¿Cuántas *solerillas* necesitas?',
      '¿Cuántas unidades de *Solerilla Dos* necesitas?',
      '¿Cuántos metros de soleras necesitas?',
    ]) {
      expect(ask(policy, reply).errors, reply).toEqual([]);
    }
  });

  test('naming the other product is not enough', () => {
    expect(codes(ask(twoItems(), '¿Cuántas baldosas necesitas?'))).toEqual(['item_question_product_unnamed']);
  });

  test('with a single item the question may omit the product', () => {
    const policy = policyFor([item('li_b', 'Baldosas', { variant: 'Baldosa Uno' })], 'La baldosa uno');
    expect(ask(policy, '¿Cuántas unidades necesitas?', 'li_b').errors).toEqual([]);
  });

  test('the prompt asks to name the product in an item question', () => {
    const source = fs.readFileSync('tests/fixtures/workflow-nodes/ai-lead-qualification-assistant/build-ai-request.js', 'utf8');
    const rule = source.match(/const V31_ITEM_REQUEST_GOAL_RULE = '([^']*)'/)[1];
    expect(rule).toContain('Si la cotización tiene más de un producto, la pregunta de un ítem nombra su producto');
    expect(rule).toContain('"¿Cuántas solerillas necesitas?"');
  });
});
