import fs from 'node:fs';
import { createRequire } from 'node:module';
import { describe, expect, test } from 'vitest';
import { buildTurnPolicy } from '../ops/v3-line-items-live-replay.mjs';

const require = createRequire(import.meta.url);
const {
  validateV3AiProposal, productRefsMentionedV31, V3_CONTRACTS,
} = require('../fixtures/workflow-nodes/shared/v3-contract-runtime.js');

// -----------------------------------------------------------------------------
// Task 3c.21 (owner rules, Hormiglass):
//   1. "muro"/"muros" without another product means Cierros de Hormigón
//      (migration 028 adds the synonyms); "muro camellón" stays Muro Tipo
//      Camellón by longest match.
//   2. A cierro is measured only in metros lineales plus a height; an area
//      (m², metros cuadrados) is never its quantity. The v3.1 validator rejects
//      such a quantity (linear_quantity_required) and the bot asks for the
//      linear meters and the height instead.
//   3. Bloques de Hormigón are unrelated to cierros: their m²-based quantities
//      are untouched.
// -----------------------------------------------------------------------------

const CIERROS_SYNONYMS = ['cierro de hormigón', 'muro', 'muros', 'muro perimetral', 'muro prefabricado'];
const GROUNDING = Object.freeze({
  catalog: [
    { ref: 'product:cierros-hormigon', concept: 'product', value: 'Cierros de Hormigón', synonyms: CIERROS_SYNONYMS },
    // Synthetic stand-in for the product the private data creates live.
    { ref: 'product:muro-camellon', concept: 'product', value: 'Muro Tipo Camellón', synonyms: ['muro camellón'] },
    { ref: 'product:bloques-hormigon', concept: 'product', value: 'Bloques de Hormigón', synonyms: ['bloques de cemento'] },
    { ref: 'product:adoquin', concept: 'product', value: 'Adoquín', synonyms: ['adoquines'] },
    { ref: 'service:instalacion', concept: 'service', value: 'Instalación' },
  ],
});
const NEW_ITEM = 'new:1';
const errorCodes = (validation) => validation.errors.map((error) => error.code);
const quantityValue = (value, unit) => ({ kind: 'exact', value, unit, name: null });

const newItemProposal = (targetPolicy, {
  productQuote, groundingRef, productName, quantityQuote = null, quantity = null, primaryRequest,
}) => {
  const observations = [{
    id: 'obs_product', concept: 'product', raw_value: productQuote, normalized_value: productName,
    evidence_quote: productQuote, evidence_occurrence: 1, grounding_ref: groundingRef,
    resolves_goal_ids: ['line_items'], item_ref: NEW_ITEM,
  }];
  const mutations = [{ operation: 'set', field: 'product', item_ref: NEW_ITEM, observation_id: 'obs_product', replaces_fact_id: null }];
  if (quantity) {
    observations.push({
      id: 'obs_quantity', concept: 'quantity', raw_value: quantityQuote, normalized_value: quantity,
      evidence_quote: quantityQuote, evidence_occurrence: 1, grounding_ref: null,
      resolves_goal_ids: ['line_items'], item_ref: NEW_ITEM,
    });
    mutations.push({ operation: 'set', field: 'quantity', item_ref: NEW_ITEM, observation_id: 'obs_quantity', replaces_fact_id: null });
  }
  return {
    version: V3_CONTRACTS.proposal_v3_1,
    policy_digest: targetPolicy.policy_digest,
    reply_text: '¡Hola! Bienvenido a Hormiglass 👋 Tomé nota. ¿Me cuentas un poco más?',
    primary_request: primaryRequest,
    catalog_resolutions: [{
      status: 'matched', evidence_quote: productQuote, evidence_occurrence: 1, grounding_ref: groundingRef, item_ref: NEW_ITEM,
    }],
    observations,
    state_mutations: mutations,
    effect_requests: [],
  };
};

describe('"muro" names Cierros de Hormigón; "muro camellón" keeps its own product', () => {
  test('a muro without another product is the cierros product', () => {
    expect([...productRefsMentionedV31(GROUNDING.catalog, 'Necesito un muro de 20 metros lineales')]).toEqual(['product:cierros-hormigon']);
    expect([...productRefsMentionedV31(GROUNDING.catalog, 'cotizo muros perimetrales')]).toEqual(['product:cierros-hormigon']);
    expect([...productRefsMentionedV31(GROUNDING.catalog, 'un muro prefabricado de 2 metros de alto')]).toEqual(['product:cierros-hormigon']);
  });

  test('longest match: "muro camellón" and the full name name only Muro Tipo Camellón', () => {
    expect([...productRefsMentionedV31(GROUNDING.catalog, 'necesito 10 muro camellón')]).toEqual(['product:muro-camellon']);
    expect([...productRefsMentionedV31(GROUNDING.catalog, 'precio del Muro Tipo Camellón')]).toEqual(['product:muro-camellon']);
  });

  test('bloques stay the bloques product', () => {
    expect([...productRefsMentionedV31(GROUNDING.catalog, 'necesito bloques de cemento para 30 m2')]).toEqual(['product:bloques-hormigon']);
  });

  test('"Necesito un muro de 20 metros lineales" records a cierros item with its linear quantity', () => {
    const message = 'Necesito un muro de 20 metros lineales';
    const targetPolicy = buildTurnPolicy('v3.1', {}, GROUNDING, { text: message });
    const validation = validateV3AiProposal(targetPolicy, newItemProposal(targetPolicy, {
      productQuote: 'muro', groundingRef: 'product:cierros-hormigon', productName: 'Cierros de Hormigón',
      quantityQuote: '20 metros lineales', quantity: quantityValue(20, 'metros lineales'),
      primaryRequest: { goal_id: 'measurements', item_ref: NEW_ITEM },
    }));

    expect(errorCodes(validation)).toEqual([]);
    expect(validation.valid).toBe(true);
  });
});

describe('v3.1 validator: a cierro quantity is never an area', () => {
  const cierroWithQuantity = (message, quantityQuote, unit) => {
    const targetPolicy = buildTurnPolicy('v3.1', {}, GROUNDING, { text: message });
    return validateV3AiProposal(targetPolicy, newItemProposal(targetPolicy, {
      productQuote: 'cierro de hormigón', groundingRef: 'product:cierros-hormigon', productName: 'Cierros de Hormigón',
      quantityQuote, quantity: quantityValue(50, unit),
      primaryRequest: { goal_id: 'measurements', item_ref: NEW_ITEM },
    }));
  };

  test('a cierro quantity in m² is rejected with linear_quantity_required and a linear-meters instruction', () => {
    const validation = cierroWithQuantity('Necesito un cierro de hormigón de 50 m²', '50 m²', 'm²');

    expect(validation.valid).toBe(false);
    expect(errorCodes(validation)).toEqual(['linear_quantity_required']);
    const [error] = validation.errors;
    expect(error.disposition).toBe('repairable');
    expect(error.path).toBe('state_mutations[1]');
    expect(error.related_ids).toEqual(['obs_quantity']);
    expect(error.allowed_values).toEqual([NEW_ITEM]);
    expect(error.instruction).toContain('metros lineales');
    expect(error.instruction).toContain('altura');
    expect(error.instruction).toContain(`"goal_id": "quantity", "item_ref": "${NEW_ITEM}"`);
  });

  test.each([
    'm2', 'M2', 'mt2', 'mts2', 'mts²', 'm^2', 'metros cuadrados', 'Metro cuadrado', 'square meters', 'sq m',
  ])('area unit %s is rejected', (unit) => {
    expect(errorCodes(cierroWithQuantity('Necesito un cierro de hormigón de 50 metros', '50 metros', unit))).toEqual(['linear_quantity_required']);
  });

  test.each(['metros lineales', 'metro lineal', 'ml', 'm', 'metros', 'mts'])('linear unit %s is valid', (unit) => {
    const validation = cierroWithQuantity('Necesito un cierro de hormigón de 50 metros', '50 metros', unit);
    expect(errorCodes(validation)).toEqual([]);
    expect(validation.valid).toBe(true);
  });

  test('replacing an existing cierro quantity with m² is rejected too', () => {
    const itemId = 'li_cierro00001';
    const context = {
      line_items: [{ item_id: itemId, product: 'Cierros de Hormigón', quantity: quantityValue(20, 'metros lineales'), measurements: null }],
    };
    const message = 'mejor que sean 40 m2';
    const targetPolicy = buildTurnPolicy('v3.1', context, GROUNDING, { text: message, pendingQuestionKey: 'quantity' });
    const quantityFact = targetPolicy.facts.find((fact) => fact.fact_id === `fact:item:${itemId}:quantity`);
    expect(quantityFact).toBeDefined();
    const validation = validateV3AiProposal(targetPolicy, {
      version: V3_CONTRACTS.proposal_v3_1,
      policy_digest: targetPolicy.policy_digest,
      reply_text: 'Perfecto, actualicé la cantidad.',
      primary_request: null,
      catalog_resolutions: [],
      observations: [{
        id: 'obs_quantity', concept: 'quantity', raw_value: '40 m2', normalized_value: quantityValue(40, 'm2'),
        evidence_quote: '40 m2', evidence_occurrence: 1, grounding_ref: null, resolves_goal_ids: ['line_items'], item_ref: itemId,
      }],
      state_mutations: [{
        operation: 'replace', field: 'quantity', item_ref: itemId, observation_id: 'obs_quantity', replaces_fact_id: quantityFact.fact_id,
      }],
      effect_requests: [],
    });

    expect(errorCodes(validation)).toContain('linear_quantity_required');
    expect(validation.errors.find((error) => error.code === 'linear_quantity_required').allowed_values).toEqual([itemId]);
  });

  test('asking for the linear meters instead of recording the m² is valid (no quantity_observation_required)', () => {
    const message = 'Necesito un cierro de hormigón de 50 m2';
    const targetPolicy = buildTurnPolicy('v3.1', {}, GROUNDING, { text: message });
    const validation = validateV3AiProposal(targetPolicy, newItemProposal(targetPolicy, {
      productQuote: 'cierro de hormigón', groundingRef: 'product:cierros-hormigon', productName: 'Cierros de Hormigón',
      primaryRequest: { goal_id: 'quantity', item_ref: NEW_ITEM },
    }));

    expect(errorCodes(validation)).toEqual([]);
    expect(validation.valid).toBe(true);
  });

  test('dropping an m² cierro quantity without asking for it still needs quantity_observation_required', () => {
    const message = 'Necesito un cierro de hormigón de 50 m2';
    const targetPolicy = buildTurnPolicy('v3.1', {}, GROUNDING, { text: message });
    const validation = validateV3AiProposal(targetPolicy, newItemProposal(targetPolicy, {
      productQuote: 'cierro de hormigón', groundingRef: 'product:cierros-hormigon', productName: 'Cierros de Hormigón',
      primaryRequest: { goal_id: 'measurements', item_ref: NEW_ITEM },
    }));

    expect(errorCodes(validation)).toContain('quantity_observation_required');
  });

  test('a linear quantity stated next to an m² one still needs its quantity observation', () => {
    const message = 'Necesito un cierro de hormigón de 50 m2 y 20 metros lineales';
    const targetPolicy = buildTurnPolicy('v3.1', {}, GROUNDING, { text: message });
    const validation = validateV3AiProposal(targetPolicy, newItemProposal(targetPolicy, {
      productQuote: 'cierro de hormigón', groundingRef: 'product:cierros-hormigon', productName: 'Cierros de Hormigón',
      primaryRequest: { goal_id: 'quantity', item_ref: NEW_ITEM },
    }));

    expect(errorCodes(validation)).toContain('quantity_observation_required');
  });

  test('bloques with an m²-based quantity are unaffected', () => {
    const message = 'Necesito bloques de cemento para 30 m2';
    const targetPolicy = buildTurnPolicy('v3.1', {}, GROUNDING, { text: message });
    const validation = validateV3AiProposal(targetPolicy, newItemProposal(targetPolicy, {
      productQuote: 'bloques de cemento', groundingRef: 'product:bloques-hormigon', productName: 'Bloques de Hormigón',
      quantityQuote: '30 m2', quantity: quantityValue(30, 'm2'),
      primaryRequest: { goal_id: 'measurements', item_ref: NEW_ITEM },
    }));

    expect(errorCodes(validation)).not.toContain('linear_quantity_required');
    expect(errorCodes(validation)).toEqual([]);
  });

  test('without the cierros entry in the grounding nothing changes (data-driven by product ref)', () => {
    const grounding = { catalog: GROUNDING.catalog.filter((entry) => entry.ref !== 'product:cierros-hormigon') };
    const message = 'Necesito adoquines para 50 m2';
    const targetPolicy = buildTurnPolicy('v3.1', {}, grounding, { text: message });
    const validation = validateV3AiProposal(targetPolicy, newItemProposal(targetPolicy, {
      productQuote: 'adoquines', groundingRef: 'product:adoquin', productName: 'Adoquín',
      quantityQuote: '50 m2', quantity: quantityValue(50, 'm2'),
      primaryRequest: { goal_id: 'measurements', item_ref: NEW_ITEM },
    }));
    expect(errorCodes(validation)).toEqual([]);
  });
});

describe('the v3.1 prompt explains muros and linear meters; v3 stays unchanged', () => {
  const BUILD_AI_REQUEST = 'tests/fixtures/workflow-nodes/ai-lead-qualification-assistant/build-ai-request.js';
  const runCodeNode = (source, items, env = {}) => new Function('items', '$env', source)(items, env);
  const systemPromptFor = (version) => {
    const turnPolicy = {
      version, policy_digest: 'a'.repeat(64), facts: [], goals: [{ goal_id: 'line_items' }],
      state_authority: { allowed_mutations: [] }, effect_authority: { permissions: [] }, grounding: {},
    };
    const output = runCodeNode(fs.readFileSync(BUILD_AI_REQUEST, 'utf8'),
      [{ json: { contract_version: 'v3', turn_policy: turnPolicy } }],
      { AI_PROVIDER: 'openai', OPENAI_API_KEY: 'fake-key-123' });
    return output[0].json.ai_request.input[0].content;
  };
  const RULE_START = 'Cuando el cliente dice "muro" o "muros"';

  test('v3.1 adds the muro / linear-meters rule right after the technical-sheet rule', () => {
    const lines = systemPromptFor('ai_prd_turn_policy/v3.1').split('\n');
    const index = lines.findIndex((line) => line.startsWith(RULE_START));
    expect(index).toBeGreaterThan(0);
    expect(lines[index - 1]).toMatch(/^Algunas entradas del grounding traen technical_sheet/);
    const rule = lines[index];
    expect(rule).toContain('Cierros de Hormigón');
    expect(rule).toContain('"muro camellón"');
    expect(rule).toContain('metros lineales');
    expect(rule).toContain('altura');
    expect(rule).toContain('nunca en m²');
    expect(rule).toContain('no registres ese valor como quantity');
    expect(rule).toContain('Bloques de Hormigón');
    expect(rule).toContain('no forman parte de los cierros');
  });

  test('v3 does not get the rule', () => {
    expect(systemPromptFor('ai_prd_turn_policy/v3')).not.toContain(RULE_START);
  });
});

describe('the rule is v3.1-only', () => {
  test('the v3 validator never emits linear_quantity_required', () => {
    const source = fs.readFileSync('tests/fixtures/workflow-nodes/shared/v3-contract-runtime.js', 'utf8');
    const v3Body = source.slice(source.indexOf('const validateV3AiProposalV3 = '), source.indexOf('const validateV3AiProposal = '));
    expect(v3Body.length).toBeGreaterThan(0);
    expect(v3Body).not.toContain('linear_quantity_required');
    expect(v3Body).not.toContain('linearQuantity');
  });
});
