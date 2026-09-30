import { createRequire } from 'node:module';
import { describe, expect, test } from 'vitest';

const require = createRequire(import.meta.url);
const {
  V3_CONTRACTS,
  compileV3TurnPolicy,
  validateV3AiProposal,
  authorizeV3ConversationDecision,
} = require('./v3-contract-runtime.js');

// -----------------------------------------------------------------------------
// Slice 2a — Contract, dark. These tests exercise the v3.1 item-aware artifact
// versions added on top of the unchanged v3 route family (design.md D1-D6).
// v3.1 never runs at runtime in this slice: compileV3TurnPolicy only produces
// it when explicitly asked via `input.version: 'v3.1'`, which nothing in
// production wires until Slice 2b's switch.
// -----------------------------------------------------------------------------

const itemFacts = (items) => items.flatMap((item) => ['product', 'quantity', 'measurements']
  .filter((field) => item[field] !== undefined && item[field] !== null)
  .map((field) => ({
    fact_id: `fact:item:${item.item_id}:${field}`,
    field,
    value: item[field],
    mutability: 'customer_correctable',
    source: { message_id: 'previous', evidence_digest: 'a'.repeat(64) },
  })));

const ITEM_MUTATION_AUTHORITY = ['product', 'quantity', 'measurements'].flatMap((field) => [
  { operation: 'set', concept: field, field },
  { operation: 'replace', concept: field, field },
]).concat([{ operation: 'remove_item', concept: 'line_items', field: null }]);

const policyV31For = (message, {
  items = [], goals = [], allowedMutations = [], grounding = {},
  effectRequirements = [], effectPermissions = [], pendingQuestionGoalId = null,
} = {}) => compileV3TurnPolicy({
  version: 'v3.1',
  turn: {
    id: 'turn-v31',
    conversation_id: 'conversation-v31',
    conversation_revision: 1,
    pending_question_goal_id: pendingQuestionGoalId,
    message: { id: 'message-v31', text: message },
  },
  history: { messages: [] },
  facts: itemFacts(items),
  goals,
  allowed_mutations: [...ITEM_MUTATION_AUTHORITY, ...allowedMutations],
  grounding,
  claim_rules: [],
  effect_permissions: effectPermissions,
  effect_requirements: effectRequirements,
});

const observation = (overrides) => ({
  id: 'obs',
  concept: 'product',
  raw_value: 'value',
  normalized_value: 'value',
  evidence_quote: 'value',
  evidence_occurrence: 1,
  grounding_ref: null,
  resolves_goal_ids: [],
  item_ref: null,
  ...overrides,
});

const proposalV31 = (policy, overrides) => ({
  version: V3_CONTRACTS.proposal_v3_1,
  policy_digest: policy.policy_digest,
  reply_text: 'Entendido.',
  primary_request: null,
  catalog_resolutions: [],
  observations: [],
  state_mutations: [],
  effect_requests: [],
  ...overrides,
});

describe('V3_CONTRACTS v3.1 artifact versions (2a.1)', () => {
  test('adds v3.1 versions ending in v3.1 without touching the existing v3 entries', () => {
    expect(V3_CONTRACTS.policy).toBe('ai_prd_turn_policy/v3');
    expect(V3_CONTRACTS.proposal).toBe('ai_conversation_proposal/v3');
    expect(V3_CONTRACTS.validation).toBe('conversation_validation_result/v3');
    expect(V3_CONTRACTS.decision).toBe('validated_conversation_decision/v3');
    expect(V3_CONTRACTS.policy_v3_1).toBe('ai_prd_turn_policy/v3.1');
    expect(V3_CONTRACTS.proposal_v3_1).toBe('ai_conversation_proposal/v3.1');
    expect(V3_CONTRACTS.validation_v3_1).toBe('conversation_validation_result/v3.1');
    expect(V3_CONTRACTS.decision_v3_1).toBe('validated_conversation_decision/v3.1');
  });
});

describe('version-dispatched compiler (2a.2)', () => {
  test('compileV3TurnPolicy stays on v3 by default and switches to v3.1 only when asked', () => {
    const v3Policy = compileV3TurnPolicy({
      turn: { id: 't', conversation_id: 'c', conversation_revision: 1, message: { id: 'm', text: 'hola' } },
      history: { messages: [] }, facts: [], goals: [], allowed_mutations: [], grounding: {},
      claim_rules: [], effect_permissions: [], effect_requirements: [],
    });
    expect(v3Policy.version).toBe(V3_CONTRACTS.policy);

    const v31Policy = policyV31For('hola');
    expect(v31Policy.version).toBe(V3_CONTRACTS.policy_v3_1);
  });
});

describe('version-dispatched validator/authorizer (2a.3/2a.4)', () => {
  test('a v3 policy still runs the unchanged v3 validator', () => {
    const policy = compileV3TurnPolicy({
      turn: { id: 't', conversation_id: 'c', conversation_revision: 1, message: { id: 'm', text: 'hola' } },
      history: { messages: [] }, facts: [], goals: [], allowed_mutations: [], grounding: {},
      claim_rules: [], effect_permissions: [], effect_requirements: [],
    });
    const validation = validateV3AiProposal(policy, {
      version: 'ai_conversation_proposal/v3',
      policy_digest: policy.policy_digest,
      reply_text: 'Hola, ¿en qué te puedo ayudar?',
      primary_request: null,
      catalog_resolution: { status: 'not_applicable', evidence_quote: null, evidence_occurrence: null, grounding_ref: null },
      observations: [],
      state_mutations: [],
      effect_requests: [],
    });
    expect(validation.version).toBe(V3_CONTRACTS.validation);
    expect(validation.valid).toBe(true);
  });

  test('a v3.1 policy runs the item-aware validator and stamps the v3.1 validation version', () => {
    const policy = policyV31For('hola');
    const validation = validateV3AiProposal(policy, proposalV31(policy, {
      reply_text: 'Hola, ¿en qué te puedo ayudar?',
    }));
    expect(validation.version).toBe(V3_CONTRACTS.validation_v3_1);
    expect(validation.valid).toBe(true);
  });
});

describe('mutation_target_duplicate (2a.5/2a.6)', () => {
  test('rejects two mutations targeting the same (item_ref, field)', () => {
    const policy = policyV31For('quiero 2 cosas', {
      items: [{ item_id: 'li_0', product: 'Adoquín', quantity: null, measurements: null }],
    });
    const validation = validateV3AiProposal(policy, proposalV31(policy, {
      catalog_resolutions: [],
      observations: [
        observation({
          id: 'obs-1', concept: 'quantity', normalized_value: 100, evidence_quote: 'cosas', item_ref: 'li_0', resolves_goal_ids: [],
        }),
        observation({
          id: 'obs-2', concept: 'quantity', normalized_value: 200, evidence_quote: 'cosas', item_ref: 'li_0', resolves_goal_ids: [],
        }),
      ],
      state_mutations: [
        { operation: 'set', field: 'quantity', item_ref: 'li_0', observation_id: 'obs-1', replaces_fact_id: null },
        { operation: 'set', field: 'quantity', item_ref: 'li_0', observation_id: 'obs-2', replaces_fact_id: null },
      ],
    }));
    expect(validation.valid).toBe(false);
    expect(validation.errors).toContainEqual(expect.objectContaining({ code: 'mutation_target_duplicate' }));
  });
});

describe('line_items_limit_exceeded (2a.7/2a.8)', () => {
  test('rejects the whole proposal when an 11th item would be introduced', () => {
    const items = Array.from({ length: 10 }, (_, index) => ({
      item_id: `li_${index}`, product: `Producto ${index}`, quantity: 1, measurements: null,
    }));
    const policy = policyV31For('agrega uno más', {
      items,
      grounding: { catalog: [{ ref: 'product:extra', concept: 'product', value: 'Producto Extra' }] },
    });
    const validation = validateV3AiProposal(policy, proposalV31(policy, {
      catalog_resolutions: [{
        item_ref: 'new:1', status: 'matched', evidence_quote: 'agrega', evidence_occurrence: 1,
        grounding_ref: 'product:extra',
      }],
      observations: [
        observation({
          id: 'obs-extra', concept: 'product', normalized_value: 'Producto Extra',
          evidence_quote: 'agrega', item_ref: 'new:1', grounding_ref: 'product:extra',
        }),
      ],
      state_mutations: [
        { operation: 'set', field: 'product', item_ref: 'new:1', observation_id: 'obs-extra', replaces_fact_id: null },
      ],
    }));

    expect(validation.valid).toBe(false);
    expect(validation.errors).toContainEqual(expect.objectContaining({ code: 'line_items_limit_exceeded' }));
  });
});

describe('item_identity_required (2a.9/2a.10)', () => {
  test('a new item with neither a matched product nor an ambiguous/unsupported entry is rejected', () => {
    const policy = policyV31For('quiero algo más', { items: [] });
    const validation = validateV3AiProposal(policy, proposalV31(policy, {
      catalog_resolutions: [],
      observations: [
        observation({
          id: 'obs-qty', concept: 'quantity', normalized_value: 5, evidence_quote: 'algo más',
          item_ref: 'new:1', resolves_goal_ids: [],
        }),
      ],
      state_mutations: [
        { operation: 'set', field: 'quantity', item_ref: 'new:1', observation_id: 'obs-qty', replaces_fact_id: null },
      ],
    }));

    expect(validation.valid).toBe(false);
    expect(validation.errors).toContainEqual(expect.objectContaining({ code: 'item_identity_required' }));
  });
});

describe('item_target_required (2a.11/2a.12)', () => {
  test('a null item_ref with two existing items asks which one', () => {
    const policy = policyV31For('mejor 3 metros de altura', {
      items: [
        { item_id: 'li_a', product: 'Adoquín', quantity: 10, measurements: null },
        { item_id: 'li_b', product: 'Pastelón', quantity: 5, measurements: null },
      ],
    });
    const validation = validateV3AiProposal(policy, proposalV31(policy, {
      observations: [
        observation({
          id: 'obs-measure', concept: 'measurements', normalized_value: '3 metros de altura',
          evidence_quote: 'mejor 3 metros de altura', item_ref: null, resolves_goal_ids: [],
        }),
      ],
      state_mutations: [
        { operation: 'set', field: 'measurements', item_ref: null, observation_id: 'obs-measure', replaces_fact_id: null },
      ],
    }));

    expect(validation.valid).toBe(false);
    expect(validation.errors).toContainEqual(expect.objectContaining({ code: 'item_target_required' }));
  });

  test('a null item_ref with exactly one existing item resolves to it', () => {
    const policy = policyV31For('mejor 3 metros de altura', {
      items: [{ item_id: 'li_a', product: 'Adoquín', quantity: 10, measurements: null }],
    });
    const validation = validateV3AiProposal(policy, proposalV31(policy, {
      observations: [
        observation({
          id: 'obs-measure', concept: 'measurements', normalized_value: '3 metros de altura',
          evidence_quote: 'mejor 3 metros de altura', item_ref: null, resolves_goal_ids: [],
        }),
      ],
      state_mutations: [
        { operation: 'set', field: 'measurements', item_ref: null, observation_id: 'obs-measure', replaces_fact_id: null },
      ],
    }));

    expect(validation.errors).not.toContainEqual(expect.objectContaining({ code: 'item_target_required' }));
    expect(validation.valid).toBe(true);
    expect(validation.authorized_mutations).toContainEqual(expect.objectContaining({
      field: 'measurements', item_ref: 'li_a', projected_value: '3 metros de altura',
    }));
  });
});

// Slice 3c follow-up (live A/B round 2): 3 of 20 live first-turn proposals
// and 1 of 6 valid corrections misattributed a quantity/measurement across
// items — the same evidenced text ended up resolving the same item concept
// on two different items. That specific shape is deterministically
// detectable (spec's "A quantity or measurement fact MUST attach only to the
// item its evidence names"): the same (evidence_quote, evidence_occurrence,
// field) triple can never legitimately authorize two different item_ref
// values in one proposal. A single span reattached to the *wrong* item (no
// duplicate) is a different, non-shape-detectable defect — see
// tests/unit/v3-v31-item-evidence-span-conflict.test.js for that documented
// boundary and task 3c.8's prompt fix.
describe('item_evidence_span_conflict (3c.7)', () => {
  test('rejects the same evidence span resolving quantity on two different items', () => {
    const policy = policyV31For('aprox 500 ml de alambre y pandereta', {
      items: [
        { item_id: 'li_a', product: 'Adoquín', quantity: null, measurements: null },
        { item_id: 'li_b', product: 'Pastelón', quantity: null, measurements: null },
      ],
    });
    const validation = validateV3AiProposal(policy, proposalV31(policy, {
      observations: [
        observation({
          id: 'obs-qty-a', concept: 'quantity', normalized_value: 500,
          evidence_quote: 'aprox 500 ml', evidence_occurrence: 1, item_ref: 'li_a', resolves_goal_ids: [],
        }),
        observation({
          id: 'obs-qty-b', concept: 'quantity', normalized_value: 500,
          evidence_quote: 'aprox 500 ml', evidence_occurrence: 1, item_ref: 'li_b', resolves_goal_ids: [],
        }),
      ],
      state_mutations: [
        { operation: 'set', field: 'quantity', item_ref: 'li_a', observation_id: 'obs-qty-a', replaces_fact_id: null },
        { operation: 'set', field: 'quantity', item_ref: 'li_b', observation_id: 'obs-qty-b', replaces_fact_id: null },
      ],
    }));

    expect(validation.valid).toBe(false);
    expect(validation.errors).toContainEqual(expect.objectContaining({ code: 'item_evidence_span_conflict' }));
  });

  test('does not flag the same text cited at two different occurrences (distinct evidence spans)', () => {
    const policy = policyV31For('aprox 500 ml de alambre, aprox 500 ml de pandereta', {
      items: [
        { item_id: 'li_a', product: 'Adoquín', quantity: null, measurements: null },
        { item_id: 'li_b', product: 'Pastelón', quantity: null, measurements: null },
      ],
    });
    const validation = validateV3AiProposal(policy, proposalV31(policy, {
      observations: [
        observation({
          id: 'obs-qty-a', concept: 'quantity', normalized_value: 500,
          evidence_quote: 'aprox 500 ml', evidence_occurrence: 1, item_ref: 'li_a', resolves_goal_ids: [],
        }),
        observation({
          id: 'obs-qty-b', concept: 'quantity', normalized_value: 500,
          evidence_quote: 'aprox 500 ml', evidence_occurrence: 2, item_ref: 'li_b', resolves_goal_ids: [],
        }),
      ],
      state_mutations: [
        { operation: 'set', field: 'quantity', item_ref: 'li_a', observation_id: 'obs-qty-a', replaces_fact_id: null },
        { operation: 'set', field: 'quantity', item_ref: 'li_b', observation_id: 'obs-qty-b', replaces_fact_id: null },
      ],
    }));

    expect(validation.errors).not.toContainEqual(expect.objectContaining({ code: 'item_evidence_span_conflict' }));
    expect(validation.valid).toBe(true);
  });

  test('does not flag the same evidence text used for two different item concepts', () => {
    const policy = policyV31For('3 metros de cierre', {
      items: [
        { item_id: 'li_a', product: 'Adoquín', quantity: null, measurements: null },
        { item_id: 'li_b', product: 'Pastelón', quantity: null, measurements: null },
      ],
    });
    const validation = validateV3AiProposal(policy, proposalV31(policy, {
      observations: [
        observation({
          id: 'obs-qty-a', concept: 'quantity', normalized_value: 3,
          evidence_quote: '3 metros', evidence_occurrence: 1, item_ref: 'li_a', resolves_goal_ids: [],
        }),
        observation({
          id: 'obs-measure-b', concept: 'measurements', normalized_value: '3 metros',
          evidence_quote: '3 metros', evidence_occurrence: 1, item_ref: 'li_b', resolves_goal_ids: [],
        }),
      ],
      state_mutations: [
        { operation: 'set', field: 'quantity', item_ref: 'li_a', observation_id: 'obs-qty-a', replaces_fact_id: null },
        { operation: 'set', field: 'measurements', item_ref: 'li_b', observation_id: 'obs-measure-b', replaces_fact_id: null },
      ],
    }));

    expect(validation.errors).not.toContainEqual(expect.objectContaining({ code: 'item_evidence_span_conflict' }));
    expect(validation.valid).toBe(true);
  });

  test('also rejects a duplicated product evidence span across two new, matched items', () => {
    const policy = policyV31For('del listado quiero a y b', {
      items: [],
      grounding: { catalog: [
        { ref: 'product:a', concept: 'product', value: 'Adoquín' },
        { ref: 'product:b', concept: 'product', value: 'Pastelón' },
      ] },
    });
    const validation = validateV3AiProposal(policy, proposalV31(policy, {
      catalog_resolutions: [
        { item_ref: 'new:1', status: 'matched', evidence_quote: 'listado', evidence_occurrence: 1, grounding_ref: 'product:a' },
        { item_ref: 'new:2', status: 'matched', evidence_quote: 'listado', evidence_occurrence: 1, grounding_ref: 'product:b' },
      ],
      observations: [
        observation({
          id: 'obs-product-a', concept: 'product', normalized_value: 'Adoquín',
          evidence_quote: 'listado', evidence_occurrence: 1, item_ref: 'new:1', grounding_ref: 'product:a',
        }),
        observation({
          id: 'obs-product-b', concept: 'product', normalized_value: 'Pastelón',
          evidence_quote: 'listado', evidence_occurrence: 1, item_ref: 'new:2', grounding_ref: 'product:b',
        }),
      ],
      state_mutations: [
        { operation: 'set', field: 'product', item_ref: 'new:1', observation_id: 'obs-product-a', replaces_fact_id: null },
        { operation: 'set', field: 'product', item_ref: 'new:2', observation_id: 'obs-product-b', replaces_fact_id: null },
      ],
    }));

    expect(validation.valid).toBe(false);
    expect(validation.errors).toContainEqual(expect.objectContaining({ code: 'item_evidence_span_conflict' }));
  });
});

describe('withholding an ambiguous/unsupported item product mutation (2a.13/2a.14)', () => {
  test('drops the product mutation into withheld_mutations while quantity and measurements still authorize', () => {
    const policy = policyV31For('pandereta de 3 metros, son 500 ml', {
      items: [],
      grounding: { catalog: [{ ref: 'product:cierros', concept: 'product', value: 'Cierros de Hormigón' }] },
    });
    const validation = validateV3AiProposal(policy, proposalV31(policy, {
      catalog_resolutions: [{
        item_ref: 'new:1', status: 'ambiguous', evidence_quote: 'pandereta', evidence_occurrence: 1, grounding_ref: null,
      }],
      primary_request: { goal_id: 'product', item_ref: 'new:1' },
      observations: [
        observation({
          id: 'obs-product', concept: 'product', normalized_value: 'Cierros de Hormigón',
          evidence_quote: 'pandereta', item_ref: 'new:1', grounding_ref: 'product:cierros',
        }),
        observation({
          id: 'obs-quantity', concept: 'quantity', normalized_value: '500 ml',
          evidence_quote: '500 ml', item_ref: 'new:1', resolves_goal_ids: [],
        }),
        observation({
          id: 'obs-measurements', concept: 'measurements', normalized_value: '3 metros de altura',
          evidence_quote: '3 metros', item_ref: 'new:1', resolves_goal_ids: [],
        }),
      ],
      state_mutations: [
        { operation: 'set', field: 'product', item_ref: 'new:1', observation_id: 'obs-product', replaces_fact_id: null },
        { operation: 'set', field: 'quantity', item_ref: 'new:1', observation_id: 'obs-quantity', replaces_fact_id: null },
        { operation: 'set', field: 'measurements', item_ref: 'new:1', observation_id: 'obs-measurements', replaces_fact_id: null },
      ],
    }));

    expect(validation.valid).toBe(true);
    expect(validation.errors.some((error) => error.code === 'catalog_resolution_conflict')).toBe(false);
    expect(validation.errors.some((error) => error.code === 'catalog_resolution_action_forbidden')).toBe(false);
    expect(validation.withheld_mutations).toHaveLength(1);
    expect(validation.withheld_mutations[0]).toEqual(expect.objectContaining({ field: 'product' }));
    expect(validation.authorized_mutations.some((mutation) => mutation.field === 'product')).toBe(false);
    expect(validation.authorized_mutations).toContainEqual(expect.objectContaining({ field: 'quantity', projected_value: '500 ml' }));
    expect(validation.authorized_mutations).toContainEqual(expect.objectContaining({
      field: 'measurements', projected_value: '3 metros de altura',
    }));
  });
});

describe('live scenario — pandereta + wire + commune (2a.15/2a.16)', () => {
  test('wire item commits its product, pandereta commits quantity/measurements with product withheld, commune commits at quote level', () => {
    const message = 'pandereta de 3 metros de altura con alambre púa. Son aprox 500 ml en la comuna de Lo Prado';
    const policy = policyV31For(message, {
      items: [],
      goals: [{ goal_id: 'commune', status: 'unresolved' }],
      allowedMutations: [{ operation: 'set', concept: 'commune', field: 'commune' }],
      grounding: { catalog: [{ ref: 'product:alambre-puas', concept: 'product', value: 'Alambre de Púas' }] },
    });
    const proposal = proposalV31(policy, {
      reply_text: 'Anoté el alambre de púas. Para la pandereta, ¿podrías confirmar el producto exacto?',
      primary_request: { goal_id: 'product', item_ref: 'new:1' },
      catalog_resolutions: [{
        item_ref: 'new:1', status: 'ambiguous', evidence_quote: 'pandereta', evidence_occurrence: 1, grounding_ref: null,
      }, {
        item_ref: 'new:2', status: 'matched', evidence_quote: 'alambre púa', evidence_occurrence: 1,
        grounding_ref: 'product:alambre-puas',
      }],
      observations: [
        observation({
          id: 'obs-pandereta-quantity', concept: 'quantity', normalized_value: '500 ml',
          evidence_quote: '500 ml', item_ref: 'new:1', resolves_goal_ids: [],
        }),
        observation({
          id: 'obs-pandereta-measurements', concept: 'measurements', normalized_value: '3 metros de altura',
          evidence_quote: '3 metros de altura', item_ref: 'new:1', resolves_goal_ids: [],
        }),
        observation({
          id: 'obs-wire-product', concept: 'product', normalized_value: 'Alambre de Púas',
          evidence_quote: 'alambre púa', item_ref: 'new:2', grounding_ref: 'product:alambre-puas',
          resolves_goal_ids: [],
        }),
        observation({
          id: 'obs-commune', concept: 'commune', normalized_value: 'Lo Prado',
          evidence_quote: 'Lo Prado', item_ref: null, resolves_goal_ids: ['commune'],
        }),
      ],
      state_mutations: [
        { operation: 'set', field: 'quantity', item_ref: 'new:1', observation_id: 'obs-pandereta-quantity', replaces_fact_id: null },
        { operation: 'set', field: 'measurements', item_ref: 'new:1', observation_id: 'obs-pandereta-measurements', replaces_fact_id: null },
        { operation: 'set', field: 'product', item_ref: 'new:2', observation_id: 'obs-wire-product', replaces_fact_id: null },
        { operation: 'set', field: 'commune', item_ref: null, observation_id: 'obs-commune', replaces_fact_id: null },
      ],
    });

    const validation = validateV3AiProposal(policy, proposal);

    expect(validation.valid).toBe(true);
    expect(validation.withheld_mutations).toHaveLength(0);
    expect(validation.authorized_mutations).toContainEqual(expect.objectContaining({ field: 'quantity', projected_value: '500 ml' }));
    expect(validation.authorized_mutations).toContainEqual(expect.objectContaining({
      field: 'measurements', projected_value: '3 metros de altura',
    }));
    expect(validation.authorized_mutations).toContainEqual(expect.objectContaining({ field: 'product', projected_value: 'Alambre de Púas' }));
    expect(validation.authorized_mutations).toContainEqual(expect.objectContaining({ field: 'commune', projected_value: 'Lo Prado' }));
    expect(validation.authorized_mutations.some((mutation) => mutation.item_ref === 'new:1' && mutation.field === 'product')).toBe(false);

    const decision = authorizeV3ConversationDecision(policy, proposal, validation);
    expect(decision.version).toBe(V3_CONTRACTS.decision_v3_1);
    const wireMutation = decision.state_mutations.find((mutation) => mutation.field === 'product');
    const pandItemId = decision.state_mutations.find((mutation) => mutation.field === 'quantity').item_id;
    expect(wireMutation.item_id).not.toBe(pandItemId);
    expect(decision.state_mutations.find((mutation) => mutation.field === 'commune').item_id).toBe(null);
  });
});

describe('catalog_resolution_clarification_required never rejects mutations (2a.17/2a.18)', () => {
  test('an ambiguous item without a matching primary_request gets the notice but other mutations still commit', () => {
    const policy = policyV31For('pandereta y adoquin', {
      items: [],
      goals: [{ goal_id: 'commune', status: 'unresolved' }],
      allowedMutations: [{ operation: 'set', concept: 'commune', field: 'commune' }],
    });
    const proposal = proposalV31(policy, {
      primary_request: null,
      catalog_resolutions: [{
        item_ref: 'new:1', status: 'ambiguous', evidence_quote: 'pandereta', evidence_occurrence: 1, grounding_ref: null,
      }],
      observations: [
        observation({
          id: 'obs-commune', concept: 'commune', normalized_value: 'Santiago', evidence_quote: 'adoquin',
          item_ref: null, resolves_goal_ids: ['commune'],
        }),
      ],
      state_mutations: [
        { operation: 'set', field: 'commune', item_ref: null, observation_id: 'obs-commune', replaces_fact_id: null },
      ],
    });

    const validation = validateV3AiProposal(policy, proposal);

    expect(validation.errors).toContainEqual(expect.objectContaining({ code: 'catalog_resolution_clarification_required' }));
    expect(validation.valid).toBe(true);
    expect(validation.authorized_mutations).toContainEqual(expect.objectContaining({ field: 'commune', projected_value: 'Santiago' }));
  });
});

describe('line_items required goal — effectiveRequiredGoalIds v3.1 (2a.19/2a.20)', () => {
  test('resolves when every item (1-10) has product and quantity', () => {
    const policy = policyV31For('confirmo', {
      items: [
        { item_id: 'li_a', product: 'Adoquín', quantity: 10, measurements: null },
        { item_id: 'li_b', product: 'Pastelón', quantity: 5, measurements: null },
      ],
      effectPermissions: [{ type: 'create_lead' }],
      effectRequirements: [{
        effect_type: 'create_lead', required_goal_ids: ['product', 'quantity', 'commune'], trigger: 'explicit_confirmation_when_ready',
      }],
      goals: [{ goal_id: 'commune', status: 'resolved' }],
    });
    const validation = validateV3AiProposal(policy, proposalV31(policy, {
      effect_requests: [{ type: 'create_lead', reason_observation_ids: [] }],
    }));

    expect(validation.errors.some((error) => error.code === 'effect_prerequisite_unresolved')).toBe(false);
  });

  test('surfaces product@<ref> and quantity@<ref> for an unresolved item', () => {
    const policy = policyV31For('confirmo', {
      items: [
        { item_id: 'li_a', product: 'Adoquín', quantity: 10, measurements: null },
        { item_id: 'li_b', product: null, quantity: null, measurements: 'sin definir' },
      ],
      effectPermissions: [{ type: 'create_lead' }],
      effectRequirements: [{
        effect_type: 'create_lead', required_goal_ids: ['product', 'quantity'], trigger: 'explicit_confirmation_when_ready',
      }],
    });
    const validation = validateV3AiProposal(policy, proposalV31(policy, {
      effect_requests: [{ type: 'create_lead', reason_observation_ids: [] }],
    }));

    const error = validation.errors.find((entry) => entry.code === 'effect_prerequisite_unresolved');
    expect(error).toBeDefined();
    expect(error.related_ids).toEqual(expect.arrayContaining(['product@li_b', 'quantity@li_b']));
  });
});

describe('the full existing v3 suite stays green (2a.27 — smoke check here, full proof in v3-runtime-compatibility.test.js)', () => {
  test('an unrelated v3 proposal with no items keeps validating exactly as before', () => {
    const policy = compileV3TurnPolicy({
      turn: { id: 't', conversation_id: 'c', conversation_revision: 1, message: { id: 'm', text: 'Hola' } },
      history: { messages: [] },
      facts: [], goals: [{ goal_id: 'product', status: 'unresolved' }], allowed_mutations: [
        { operation: 'set', concept: 'product', field: 'product' },
      ], grounding: { catalog: [{ ref: 'product:x', concept: 'product', value: 'X' }] },
      claim_rules: [], effect_permissions: [], effect_requirements: [],
    });
    const validation = validateV3AiProposal(policy, {
      version: 'ai_conversation_proposal/v3',
      policy_digest: policy.policy_digest,
      reply_text: 'Anoté X.',
      primary_request: null,
      catalog_resolution: { status: 'matched', evidence_quote: 'Hola', evidence_occurrence: 1, grounding_ref: 'product:x' },
      observations: [{
        id: 'obs-x', concept: 'product', raw_value: 'Hola', normalized_value: 'X', evidence_quote: 'Hola',
        evidence_occurrence: 1, grounding_ref: 'product:x', resolves_goal_ids: ['product'],
      }],
      state_mutations: [{ operation: 'set', field: 'product', observation_id: 'obs-x', replaces_fact_id: null }],
      effect_requests: [],
    });
    expect(validation.valid).toBe(true);
    expect(validation.version).toBe(V3_CONTRACTS.validation);
  });
});
