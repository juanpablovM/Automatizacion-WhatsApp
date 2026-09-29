import fs from 'node:fs';
import { createRequire } from 'node:module';
import { describe, expect, test } from 'vitest';
import { buildTurnPolicy } from '../ops/v3-line-items-live-replay.mjs';

const require = createRequire(import.meta.url);
const { buildV3PolicyInput } = require('../fixtures/workflow-nodes/shared/v3-policy-builder.js');
const {
  compileV3TurnPolicy, validateV3AiProposal, V3_CONTRACTS, digestObject, sha256,
} = require('../fixtures/workflow-nodes/shared/v3-contract-runtime.js');

// -----------------------------------------------------------------------------
// Task 3c.19 (live 2026-09-29, v3.1): "Bloques de cemento" -> the bot asked
// "¿Te refieres a Bloques de Hormigón?" and then said it could not confirm it
// was the same thing. catalog_items.metadata.synonyms (migration 026) now
// reaches the v3.1 grounding as an optional `synonyms` array per catalog
// entry, the v3.1 prompt tells the model a listed synonym IS that product,
// and the v3.1 validator's product-name matchers count a synonym as naming
// its product. v3 (the rollback path) never sees the field.
// -----------------------------------------------------------------------------

const LOAD_SQL = 'db/queries/n8n/wa-conversation-orchestrator/01_load_active_context.sql';
const BUILD_AI_REQUEST = 'tests/fixtures/workflow-nodes/ai-lead-qualification-assistant/build-ai-request.js';

const GROUNDING = Object.freeze({
  catalog: [
    { ref: 'product:adoquin', concept: 'product', value: 'Adoquín', synonyms: ['adoquines', 'adoquín de cemento'] },
    { ref: 'product:bloques-hormigon', concept: 'product', value: 'Bloques de Hormigón', synonyms: ['bloques de cemento', 'bloque de cemento'] },
    { ref: 'product:cemento', concept: 'product', value: 'Cemento', synonyms: ['saco de cemento'] },
    { ref: 'product:pigmentos', concept: 'product', value: 'Pigmentos', synonyms: ['pigmento', 'colorante para hormigón'] },
    { ref: 'product:placas-50-cm', concept: 'product', value: 'Placas de 50 cm', synonyms: ['placa de 50'] },
    { ref: 'product:placas-50-cm-reforzadas', concept: 'product', value: 'Placas de 50 cm Reforzadas', synonyms: ['placa de 50 reforzada'] },
    { ref: 'product:alambre-puas', concept: 'product', value: 'Alambre de Púas', synonyms: ['alambre púa'] },
    { ref: 'product:cierros-hormigon', concept: 'product', value: 'Cierros de Hormigón' },
    { ref: 'service:instalacion', concept: 'service', value: 'Instalación' },
  ],
});
const withoutSynonyms = (grounding) => ({
  catalog: grounding.catalog.map(({ synonyms, ...entry }) => entry),
});

const baseRow = (overrides = {}) => ({
  inbound_event_id: 'event-syn',
  conversation_id: 'conversation-syn',
  external_message_id: 'message-syn',
  text_body: 'Bloques de cemento',
  qualification_context: {},
  v3_grounding: GROUNDING,
  ...overrides,
});
const errorCodes = (validation) => validation.errors.map((error) => error.code);

describe('synonyms reach the grounding (loader SQL + policy builder)', () => {
  test('the load query forwards metadata.synonyms only when it is a non-empty array', () => {
    const sql = fs.readFileSync(LOAD_SQL, 'utf8');
    expect(sql).toContain("jsonb_typeof(ci.metadata->'synonyms') = 'array'");
    expect(sql).toContain("jsonb_build_object('synonyms', ci.metadata->'synonyms')");
  });

  test('v3.1 catalog entries carry sanitized synonyms; entries without synonyms are untouched', () => {
    const input = buildV3PolicyInput(baseRow({
      v3_grounding: {
        catalog: [
          { ref: 'product:bloques-hormigon', concept: 'product', value: 'Bloques de Hormigón',
            synonyms: [' bloques de cemento ', 'bloques de cemento', '', 7, null, 'bloque de cemento'] },
          { ref: 'product:adoquin', concept: 'product', value: 'Adoquín', synonyms: [] },
          { ref: 'product:cemento', concept: 'product', value: 'Cemento', synonyms: 'saco' },
          { ref: 'product:pigmentos', concept: 'product', value: 'Pigmentos' },
        ],
      },
    }), { version: 'v3.1' });

    expect(input.grounding.catalog).toEqual([
      { ref: 'product:bloques-hormigon', concept: 'product', value: 'Bloques de Hormigón', synonyms: ['bloques de cemento', 'bloque de cemento'] },
      { ref: 'product:adoquin', concept: 'product', value: 'Adoquín' },
      { ref: 'product:cemento', concept: 'product', value: 'Cemento' },
      { ref: 'product:pigmentos', concept: 'product', value: 'Pigmentos' },
    ]);
  });

  test('compileV3TurnPolicy keeps the synonyms in the v3.1 policy and its digests', () => {
    const withSyn = compileV3TurnPolicy(buildV3PolicyInput(baseRow(), { version: 'v3.1' }));
    const withoutSyn = compileV3TurnPolicy(buildV3PolicyInput(baseRow({ v3_grounding: withoutSynonyms(GROUNDING) }), { version: 'v3.1' }));

    expect(withSyn.grounding.catalog.find((entry) => entry.ref === 'product:bloques-hormigon').synonyms)
      .toEqual(['bloques de cemento', 'bloque de cemento']);
    expect(withSyn.policy_digest).toMatch(/^[a-f0-9]{64}$/);
    expect(withSyn.policy_digest).not.toBe(withoutSyn.policy_digest);
    expect(withSyn.grounding.snapshot_digest).not.toBe(withoutSyn.grounding.snapshot_digest);
  });

  test('v3 (the rollback path) never carries synonyms: its policy is identical to one built without them', () => {
    const withSyn = compileV3TurnPolicy(buildV3PolicyInput(baseRow()));
    const withoutSyn = compileV3TurnPolicy(buildV3PolicyInput(baseRow({ v3_grounding: withoutSynonyms(GROUNDING) })));

    expect(withSyn.grounding.catalog.some((entry) => 'synonyms' in entry)).toBe(false);
    expect(withSyn).toEqual(withoutSyn);
    expect(withSyn.policy_digest).toBe(withoutSyn.policy_digest);
  });
});

describe('the v3.1 prompt explains synonyms; v3 stays unchanged', () => {
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
  const RULE_START = 'Algunas entradas product del grounding traen synonyms';

  test('v3.1 adds the synonyms rule with the cemento/concreto/hormigón and generic-term clauses', () => {
    const prompt = systemPromptFor('ai_prd_turn_policy/v3.1');
    const rule = prompt.split('\n').find((line) => line.startsWith(RULE_START));

    expect(rule).toBeDefined();
    expect(rule).toContain('catalog_resolutions matched');
    expect(rule).toContain('sin preguntar');
    expect(rule).toContain('"cemento", "concreto" y "hormigón" son intercambiables');
    expect(rule).toContain('excepto el producto Cemento');
    expect(rule).toContain('"no necesariamente es lo mismo"');
    expect(rule).toContain('la coincidencia más larga');
    expect(rule).toContain('pandereta, placa, poste');
  });

  test('v3 does not get the rule', () => {
    expect(systemPromptFor('ai_prd_turn_policy/v3')).not.toContain(RULE_START);
  });

  test('the synonyms are visible to the model inside turn_policy.grounding', () => {
    const policy = compileV3TurnPolicy(buildV3PolicyInput(baseRow(), { version: 'v3.1' }));
    const output = runCodeNode(fs.readFileSync(BUILD_AI_REQUEST, 'utf8'),
      [{ json: { contract_version: 'v3', turn_policy: policy } }],
      { AI_PROVIDER: 'openai', OPENAI_API_KEY: 'fake-key-123' });
    const userPrompt = JSON.parse(output[0].json.ai_request.input[1].content);
    expect(userPrompt.turn_policy.grounding.catalog.find((entry) => entry.ref === 'product:bloques-hormigon').synonyms)
      .toEqual(['bloques de cemento', 'bloque de cemento']);
  });
});

describe('v3.1 validator: a synonym names its product', () => {
  const NEW_ITEM = 'new:1';
  const matchedBloquesProposal = (targetPolicy) => ({
    version: V3_CONTRACTS.proposal_v3_1,
    policy_digest: targetPolicy.policy_digest,
    reply_text: '¡Hola! Bienvenido a Hormiglass 👋 Tomé nota de los Bloques de Hormigón. ¿Cuántas unidades necesitas?',
    primary_request: { goal_id: 'quantity', item_ref: NEW_ITEM },
    catalog_resolutions: [{
      status: 'matched', evidence_quote: 'Bloques de cemento', evidence_occurrence: 1,
      grounding_ref: 'product:bloques-hormigon', item_ref: NEW_ITEM,
    }],
    observations: [{
      id: 'obs_product', concept: 'product', raw_value: 'Bloques de cemento',
      normalized_value: 'Bloques de Hormigón', evidence_quote: 'Bloques de cemento', evidence_occurrence: 1,
      grounding_ref: 'product:bloques-hormigon', resolves_goal_ids: ['line_items'], item_ref: NEW_ITEM,
    }],
    state_mutations: [{
      operation: 'set', field: 'product', item_ref: NEW_ITEM, observation_id: 'obs_product', replaces_fact_id: null,
    }],
    effect_requests: [],
  });

  test('"Bloques de cemento" matched to Bloques de Hormigón is valid with no clarification', () => {
    const targetPolicy = buildTurnPolicy('v3.1', {}, GROUNDING, { text: 'Bloques de cemento' });
    const validation = validateV3AiProposal(targetPolicy, matchedBloquesProposal(targetPolicy));

    expect(errorCodes(validation)).toEqual([]);
    expect(validation.valid).toBe(true);
  });

  const ITEMS = { pigment: 'li_pigment0001', adoquin: 'li_adoquin0001', cement: 'li_cement00001' };
  const threeItemContext = () => ({
    commune: 'Lo Prado', address: 'Calle Uno 120', service_scope: 'material', fulfillment: 'delivery',
    access_restrictions: 'Sin restricciones',
    line_items: [
      { item_id: ITEMS.pigment, product: 'Pigmentos', quantity: null, measurements: null },
      { item_id: ITEMS.adoquin, product: 'Adoquín', quantity: null, measurements: null },
      { item_id: ITEMS.cement, product: 'Cemento', quantity: null, measurements: null },
    ],
  });
  const TWENTY = { kind: 'exact', value: 20, unit: 'unidades', name: null };
  const distributive = (targetPolicy, quote, targets) => {
    const observations = targets.map((itemRef) => ({
      id: `obs_quantity_${itemRef}`, concept: 'quantity', raw_value: quote, normalized_value: TWENTY,
      evidence_quote: quote, evidence_occurrence: 1, grounding_ref: null, resolves_goal_ids: ['line_items'], item_ref: itemRef,
    }));
    return {
      version: V3_CONTRACTS.proposal_v3_1,
      policy_digest: targetPolicy.policy_digest,
      reply_text: 'Perfecto, registré 20 unidades de cada uno.',
      primary_request: null,
      catalog_resolutions: [],
      observations,
      state_mutations: observations.map((entry) => ({
        operation: 'set', field: 'quantity', item_ref: entry.item_ref, observation_id: entry.id, replaces_fact_id: null,
      })),
      effect_requests: [],
    };
  };

  test('a distributive value naming one item by synonym reaches that item (3c.17 named-items matcher)', () => {
    const message = '20 unidades de cada uno para el colorante para hormigón y el adoquín';
    const targetPolicy = buildTurnPolicy('v3.1', threeItemContext(), GROUNDING, { text: message, pendingQuestionKey: 'quantity' });
    const validation = validateV3AiProposal(targetPolicy, distributive(targetPolicy, '20 unidades de cada uno', [ITEMS.pigment, ITEMS.adoquin]));

    expect(errorCodes(validation)).not.toContain('item_evidence_span_conflict');
    expect(errorCodes(validation)).not.toContain('distributive_assignment_unconfirmed');
  });

  test('without synonyms the same message still names only the adoquín (outcome unchanged)', () => {
    const message = '20 unidades de cada uno para el colorante para hormigón y el adoquín';
    const targetPolicy = buildTurnPolicy('v3.1', threeItemContext(), withoutSynonyms(GROUNDING), { text: message, pendingQuestionKey: 'quantity' });
    const validation = validateV3AiProposal(targetPolicy, distributive(targetPolicy, '20 unidades de cada uno', [ITEMS.pigment, ITEMS.adoquin]));

    expect(errorCodes(validation)).toEqual(['item_evidence_span_conflict']);
    expect(validation.errors[0].allowed_values).toEqual([ITEMS.adoquin]);
  });

  test('the item a synonym does not name is still excluded', () => {
    const message = '20 unidades de cada uno para el colorante para hormigón y el adoquín';
    const targetPolicy = buildTurnPolicy('v3.1', threeItemContext(), GROUNDING, { text: message, pendingQuestionKey: 'quantity' });
    const validation = validateV3AiProposal(targetPolicy, distributive(targetPolicy, '20 unidades de cada uno', [ITEMS.pigment, ITEMS.adoquin, ITEMS.cement]));

    expect(errorCodes(validation)).toEqual(['item_evidence_span_conflict']);
    expect(validation.errors[0].related_ids).toEqual([`obs_quantity_${ITEMS.cement}`]);
    expect(validation.errors[0].allowed_values).toEqual([ITEMS.adoquin, ITEMS.pigment].sort());
  });

  test('longest match: "placa de 50 reforzada" names the reinforced plate, not the plain 50 cm plate', () => {
    const plates = { plain: 'li_plate50plain', reinforced: 'li_plate50reinf' };
    const context = {
      commune: 'Lo Prado', address: 'Calle Uno 120', service_scope: 'material', fulfillment: 'delivery',
      access_restrictions: 'Sin restricciones',
      line_items: [
        { item_id: plates.plain, product: 'Placas de 50 cm', quantity: null, measurements: null },
        { item_id: plates.reinforced, product: 'Placas de 50 cm Reforzadas', quantity: null, measurements: null },
        { item_id: ITEMS.adoquin, product: 'Adoquín', quantity: null, measurements: null },
      ],
    };
    const message = '20 unidades de cada uno para la placa de 50 reforzada y los adoquines';
    const targetPolicy = buildTurnPolicy('v3.1', context, GROUNDING, { text: message, pendingQuestionKey: 'quantity' });
    const validation = validateV3AiProposal(targetPolicy, distributive(targetPolicy, '20 unidades de cada uno', [plates.plain, plates.reinforced, ITEMS.adoquin]));

    expect(errorCodes(validation)).toEqual(['item_evidence_span_conflict']);
    expect(validation.errors[0].related_ids).toEqual([`obs_quantity_${plates.plain}`]);
  });

  test('a spurious resolution citing a synonym is recognized as naming a product (repair guidance only)', () => {
    const captured = JSON.parse(fs.readFileSync('tests/fixtures/v3-line-items/captured-confirmation-spurious-resolution.json', 'utf8'));
    const [unsupported] = captured.proposals;
    const message = 'Sí, el alambre pua está correcto';
    const policyFor = (withSynonymsOnWire) => {
      const policy = structuredClone(captured.policy);
      policy.turn.message.text = message;
      policy.turn.message.sha256 = sha256(message);
      if (withSynonymsOnWire) {
        policy.grounding.catalog = policy.grounding.catalog.map((entry) => (entry.ref === 'product:alambre-puas'
          ? { ...entry, synonyms: ['alambre púa'] } : entry));
      }
      const { snapshot_digest: _snapshot, ...grounding } = policy.grounding;
      policy.grounding = { ...grounding, snapshot_digest: digestObject(grounding) };
      const { policy_digest: _digest, ...unsigned } = policy;
      return { ...unsigned, policy_digest: digestObject(unsigned) };
    };
    const proposalFor = (policy) => ({
      ...structuredClone(unsupported),
      policy_digest: policy.policy_digest,
      catalog_resolutions: [{ ...unsupported.catalog_resolutions[0], evidence_quote: 'alambre pua' }],
    });

    const beforePolicy = policyFor(false);
    const afterPolicy = policyFor(true);
    const before = validateV3AiProposal(beforePolicy, proposalFor(beforePolicy));
    const after = validateV3AiProposal(afterPolicy, proposalFor(afterPolicy));

    // The rejection itself is unchanged; only the guidance stops claiming "names no product".
    expect(errorCodes(before)).toEqual(['effect_prerequisite_unresolved']);
    expect(errorCodes(after)).toEqual(['effect_prerequisite_unresolved']);
    expect(before.errors[0].instruction).toContain('names no product');
    expect(after.errors[0].instruction ?? '').not.toContain('names no product');
  });
});
