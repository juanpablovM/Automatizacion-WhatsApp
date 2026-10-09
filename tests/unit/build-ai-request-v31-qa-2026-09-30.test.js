import fs from 'node:fs';
import { describe, expect, test } from 'vitest';

// Task 3c.33 — prompt and schema side of the QA review of conversations
// 387-393 (2026-09-30), v3.1 only: the v3 prompt is pinned by
// build-ai-request-v31-prompt.test.js and must not change.
const fixturePath = 'tests/fixtures/workflow-nodes/ai-lead-qualification-assistant/build-ai-request.js';
const runCodeNode = (source, items, env = {}) => new Function('items', '$env', source)(items, env);
const openAiEnv = { AI_PROVIDER: 'openai', OPENAI_API_KEY: 'fake-key-123' };

const policy = (version, overrides = {}) => ({
  version,
  policy_digest: 'a'.repeat(64),
  facts: [],
  goals: version === 'ai_prd_turn_policy/v3.1' ? [{ goal_id: 'line_items' }] : [{ goal_id: 'product' }, { goal_id: 'quantity' }],
  state_authority: { allowed_mutations: [] },
  effect_authority: { permissions: [] },
  grounding: {},
  ...overrides,
});
const requestFor = (turnPolicy) => runCodeNode(
  fs.readFileSync(fixturePath, 'utf8'),
  [{ json: { contract_version: 'v3', turn_policy: turnPolicy } }],
  openAiEnv,
)[0].json;
const promptFor = (version) => requestFor(policy(version)).ai_request.input[0].content;

describe('v3.1 prompt rules (task 3c.33)', () => {
  const v31 = () => promptFor('ai_prd_turn_policy/v3.1');
  const v3 = () => promptFor('ai_prd_turn_policy/v3');

  test('L4: the welcome is "Te damos la bienvenida", never a gendered "Bienvenido"', () => {
    expect(v31()).toContain('"Te damos la bienvenida a *Hormiglass*"');
    expect(v31()).toContain('nunca "Bienvenido" ni "Bienvenida"');
    expect(v31()).not.toContain('dale la bienvenida a Hormiglass');
    expect(v3()).toContain('dale la bienvenida a Hormiglass');
  });

  test('M1/M2: the variant is asked from variant_options before final_confirmation and shown in the summary', () => {
    expect(v31()).toContain('variant_options');
    expect(v31()).toContain('primary_request.goal_id=variant');
    expect(v31()).toContain('• Soleras y Solerillas (Solera Zarpa) — 190 m');
    expect(v3()).not.toContain('variant_options');
  });

  test('M3: a quantity is recorded only with its unit', () => {
    expect(v31()).toContain('Nunca registres una cantidad sin unidad');
  });

  test('M6: the full summary is not repeated when nothing changed', () => {
    expect(v31()).toContain('no vuelvas a enviar el resumen completo');
  });

  test('L1: internal documents are never mentioned', () => {
    expect(v31()).toContain('Nunca menciones documentos internos');
  });

  test('L2: the commune is an official Chilean comuna', () => {
    expect(v31()).toContain('una de las 346 comunas de Chile');
  });

  test('3c.34: deliveries and installations only in the service area', () => {
    expect(v31()).toContain('Por ahora hacemos despachos e instalaciones en la *Región Metropolitana*, *Viña del Mar*, *Valparaíso*, *Concepción* y *Rancagua*.');
    expect(v31()).toContain('Si te sirve, puedes retirar el material en nuestra fábrica en San Bernardo.');
    expect(v3()).not.toContain('Región Metropolitana');
  });
});

describe('v3.1 schema carries the item variant (task 3c.33, M1)', () => {
  const v31Policy = policy('ai_prd_turn_policy/v3.1', {
    facts: [{ fact_id: 'fact:item:li_p:product', field: 'product', value: 'Pastelones', mutability: 'customer_correctable' },
      { fact_id: 'fact:item:li_p:variant', field: 'variant', value: 'Formato Uno', mutability: 'customer_correctable' }],
    state_authority: { allowed_mutations: [
      { operation: 'set', concept: 'variant', field: 'variant' },
      { operation: 'replace', concept: 'variant', field: 'variant' },
    ] },
  });

  test('a variant observation, item-scoped variant mutations and the variant goal are representable', () => {
    const schema = requestFor(v31Policy).response_schema;
    const observationConcepts = schema.properties.observations.items.anyOf
      .flatMap((variant) => variant.properties.concept.enum);
    expect(observationConcepts).toContain('variant');
    const mutations = schema.properties.state_mutations.items.anyOf.filter((variant) => variant.properties.field.enum?.[0] === 'variant');
    expect(mutations).toHaveLength(2);
    expect(mutations.every((variant) => variant.properties.item_ref.enum.includes('li_p'))).toBe(true);
    expect(mutations.find((variant) => variant.properties.operation.enum[0] === 'replace').properties.replaces_fact_id.enum)
      .toEqual(['fact:item:li_p:variant']);
    expect(schema.properties.primary_request.properties.goal_id.enum).toContain('variant');
  });

  test('the v3 schema never offers a variant concept', () => {
    const schema = requestFor(policy('ai_prd_turn_policy/v3')).response_schema;
    expect(JSON.stringify(schema)).not.toContain('"variant"');
  });
});
