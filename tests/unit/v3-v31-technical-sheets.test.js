import fs from 'node:fs';
import { createRequire } from 'node:module';
import { describe, expect, test } from 'vitest';

const require = createRequire(import.meta.url);
const { buildV3PolicyInput } = require('../fixtures/workflow-nodes/shared/v3-policy-builder.js');
const { compileV3TurnPolicy } = require('../fixtures/workflow-nodes/shared/v3-contract-runtime.js');

// -----------------------------------------------------------------------------
// Task 3c.20: catalog_items.metadata.technical_sheet (private data) reaches
// the v3.1 grounding, but only for the products relevant to this turn: the
// products already in the quote's line items plus the products (or services)
// the current message names, by name or listed synonym. Everything else keeps
// just its name and synonyms. The selected sheets are compacted and capped at
// TECHNICAL_SHEETS_MAX_BYTES; a sheet that does not fit drops trailing
// variants deterministically and says how many (`variants_omitted`). v3, the
// rollback path, never carries a sheet.
// -----------------------------------------------------------------------------

const LOAD_SQL = 'db/queries/n8n/wa-conversation-orchestrator/01_load_active_context.sql';
const BUILD_AI_REQUEST = 'tests/fixtures/workflow-nodes/ai-lead-qualification-assistant/build-ai-request.js';
const MAX_BYTES = 6144;
const utf8Bytes = (value) => Buffer.byteLength(JSON.stringify(value), 'utf8');

const variant = (name, extra = {}) => ({
  name, code: null, dimensions: null, weight: null, yield: null, resistance: null, colors: [], finishes: [], other: {}, ...extra,
});
// SYNTHETIC sheets: every value is made up (the real data is private).
const BLOQUE_SHEET = {
  description: 'Producto Demo Bloque, ficha inventada.',
  general_specs: { norma: 'Norma Demo 1' },
  variants: [
    variant('Bloque Demo 1', { dimensions: '1x2x3 cm', weight: '1 kg', yield: '10 un/m²' }),
    variant('Bloque Demo 2', { dimensions: '2x3x4 cm', weight: '2 kg', yield: '10 un/m²', colors: ['Gris Demo'] }),
  ],
  unconfirmed: {},
  source_files: ['ficha-demo-bloque.pdf'],
};
const COLOR_SHEET = {
  description: 'Producto Demo Color, ficha inventada.',
  general_specs: {},
  variants: [variant('Color Demo Rojo', { colors: ['Rojo Demo'] })],
  unconfirmed: { 'Color Demo Negro · fórmula': ['Fórmula Demo'] },
  source_files: ['ficha-demo-color.pdf'],
};
const SERVICIO_SHEET = {
  description: 'Servicio Demo de Carga, ficha inventada.',
  general_specs: {},
  variants: [variant('Camión Demo', { other: { capacidad: '1 t demo' } })],
  unconfirmed: {},
  source_files: ['ficha-demo-servicio.pdf'],
};
const PLACA_SHEET = {
  description: 'Placas Demo, ficha inventada.',
  general_specs: { hormigon: 'Demo' },
  variants: [variant('Placa Demo 1', { weight: '3 kg' })],
  unconfirmed: {},
  source_files: [],
};

const GROUNDING = Object.freeze({
  catalog: [
    { ref: 'product:demo-bloque', concept: 'product', value: 'Producto Demo Bloque', synonyms: ['bloques demo de cemento', 'bloque demo de cemento'], technical_sheet: BLOQUE_SHEET },
    { ref: 'product:demo-cemento', concept: 'product', value: 'Cemento', synonyms: ['saco demo'] },
    { ref: 'product:demo-color', concept: 'product', value: 'Producto Demo Color', synonyms: ['color demo'], technical_sheet: COLOR_SHEET },
    { ref: 'product:demo-placa-50', concept: 'product', value: 'Placas Demo de 50', synonyms: ['placa demo de 50'], technical_sheet: PLACA_SHEET },
    { ref: 'product:demo-placa-60', concept: 'product', value: 'Placas Demo de 60', synonyms: ['placa demo de 60'], technical_sheet: PLACA_SHEET },
    { ref: 'service:demo-servicio', concept: 'service', value: 'Servicio Demo de Carga', technical_sheet: SERVICIO_SHEET },
  ],
});
const withoutSheets = (grounding) => ({
  catalog: grounding.catalog.map(({ technical_sheet: _sheet, ...entry }) => entry),
});
const baseRow = (overrides = {}) => ({
  inbound_event_id: 'event-sheet',
  conversation_id: 'conversation-sheet',
  external_message_id: 'message-sheet',
  text_body: '¿Cuánto pesa el bloque demo de cemento?',
  qualification_context: {},
  v3_grounding: GROUNDING,
  ...overrides,
});
const v31 = (row) => buildV3PolicyInput(row, { version: 'v3.1' });
const sheetRefs = (input) => input.grounding.catalog.filter((entry) => 'technical_sheet' in entry).map((entry) => entry.ref);
const entryFor = (input, ref) => input.grounding.catalog.find((entry) => entry.ref === ref);

describe('the load query forwards technical_sheet', () => {
  test('only when it is an object, and never its source_files', () => {
    const sql = fs.readFileSync(LOAD_SQL, 'utf8');
    expect(sql).toContain("jsonb_typeof(ci.metadata->'technical_sheet') = 'object'");
    expect(sql).toContain("jsonb_build_object('technical_sheet', (ci.metadata->'technical_sheet') - 'source_files')");
  });
});

describe('v3 (the rollback path) never carries technical sheets', () => {
  test('its policy is identical to one built without sheets, even when the message names the product', () => {
    const withSheets = compileV3TurnPolicy(buildV3PolicyInput(baseRow()));
    const without = compileV3TurnPolicy(buildV3PolicyInput(baseRow({ v3_grounding: withoutSheets(GROUNDING) })));

    expect(withSheets.grounding.catalog.some((entry) => 'technical_sheet' in entry)).toBe(false);
    expect(withSheets).toEqual(without);
    expect(withSheets.policy_digest).toBe(without.policy_digest);
  });

  test('a catalog entry with a sheet and no synonyms is stripped too', () => {
    const input = buildV3PolicyInput(baseRow({ text_body: 'Servicio Demo de Carga' }));
    expect(entryFor(input, 'service:demo-servicio')).toEqual({
      ref: 'service:demo-servicio', concept: 'service', value: 'Servicio Demo de Carga',
    });
  });
});

describe('v3.1 sends a sheet only for the products relevant to this turn', () => {
  test('a product named by a listed synonym in the current message', () => {
    expect(sheetRefs(v31(baseRow()))).toEqual(['product:demo-bloque']);
  });

  test('products already in the quote line items, even when the message does not name them', () => {
    const input = v31(baseRow({
      text_body: '¿Y cuánto pesa cada uno?',
      qualification_context: {
        line_items: [
          { item_id: 'li_color000001', product: 'Producto Demo Color', quantity: null, measurements: null },
          { item_id: 'li_unknown0001', product: 'Algo que no está', quantity: null, measurements: null },
        ],
      },
    }));
    expect(sheetRefs(input)).toEqual(['product:demo-color']);
  });

  test('a service named in the message', () => {
    expect(sheetRefs(v31(baseRow({ text_body: 'y el servicio demo de carga, ¿qué camión usan?' })))).toEqual(['service:demo-servicio']);
  });

  test('a generic shared term names nothing, so no sheet is sent', () => {
    expect(sheetRefs(v31(baseRow({ text_body: '¿cuánto pesa una placa demo?' })))).toEqual([]);
  });

  test('longest match: "placa demo de 60" sends only that product\'s sheet', () => {
    expect(sheetRefs(v31(baseRow({ text_body: 'necesito placa demo de 60' })))).toEqual(['product:demo-placa-60']);
  });

  test('irrelevant entries keep exactly {ref, concept, value, synonyms?}', () => {
    const input = v31(baseRow());
    expect(entryFor(input, 'product:demo-color')).toEqual({
      ref: 'product:demo-color', concept: 'product', value: 'Producto Demo Color', synonyms: ['color demo'],
    });
  });

  test('the forwarded sheet is compact: no source_files, no empty fields, no unknown keys', () => {
    const input = v31(baseRow({
      v3_grounding: {
        catalog: [{
          ...GROUNDING.catalog[0],
          technical_sheet: { ...BLOQUE_SHEET, private_note: 'x', prices: [1] },
        }],
      },
    }));
    expect(entryFor(input, 'product:demo-bloque').technical_sheet).toEqual({
      description: 'Producto Demo Bloque, ficha inventada.',
      general_specs: { norma: 'Norma Demo 1' },
      variants: [
        { name: 'Bloque Demo 1', dimensions: '1x2x3 cm', weight: '1 kg', yield: '10 un/m²' },
        { name: 'Bloque Demo 2', dimensions: '2x3x4 cm', weight: '2 kg', yield: '10 un/m²', colors: ['Gris Demo'] },
      ],
    });
  });

  test('unconfirmed values are forwarded so the model knows not to state them', () => {
    const input = v31(baseRow({ text_body: 'quiero color demo negro' }));
    expect(entryFor(input, 'product:demo-color').technical_sheet.unconfirmed).toEqual({ 'Color Demo Negro · fórmula': ['Fórmula Demo'] });
  });

  test('a malformed sheet is ignored', () => {
    const input = v31(baseRow({
      v3_grounding: { catalog: [{ ...GROUNDING.catalog[0], technical_sheet: 'bloque demo 1 kg' }] },
    }));
    expect(entryFor(input, 'product:demo-bloque')).not.toHaveProperty('technical_sheet');
  });

  test('the sheet reaches the model inside turn_policy.grounding and changes the digest', () => {
    const runCodeNode = (source, items, env = {}) => new Function('items', '$env', source)(items, env);
    const policy = compileV3TurnPolicy(v31(baseRow()));
    const without = compileV3TurnPolicy(v31(baseRow({ v3_grounding: withoutSheets(GROUNDING) })));
    const output = runCodeNode(fs.readFileSync(BUILD_AI_REQUEST, 'utf8'),
      [{ json: { contract_version: 'v3', turn_policy: policy } }],
      { AI_PROVIDER: 'openai', OPENAI_API_KEY: 'fake-key-123' });
    const userPrompt = JSON.parse(output[0].json.ai_request.input[1].content);

    expect(userPrompt.turn_policy.grounding.catalog.find((entry) => entry.ref === 'product:demo-bloque').technical_sheet.variants)
      .toHaveLength(2);
    expect(policy.policy_digest).not.toBe(without.policy_digest);
  });
});

describe('the synced production node selects sheets without relative require', () => {
  // n8n Code nodes get shared/v3-contract-runtime.js concatenated ahead of the
  // policy builder and cannot require sibling files, so the builder must fall
  // back to the outer productRefsMentionedV31.
  const workflow = JSON.parse(fs.readFileSync('n8n/workflows/wa-conversation-orchestrator.json', 'utf8'));
  const node = workflow.nodes.find((candidate) => candidate.name === 'Compile V3 Turn Policy');
  const run = (lineItemsMode) => new Function('items', '$env', 'module', 'require', node.parameters.jsCode)(
    [{ json: { ...baseRow(), contract_version: 'v3', phone_number: '56911111111' } }],
    { AI_PRD_V3_LINE_ITEMS: lineItemsMode },
    { exports: {} },
    () => { throw new Error('relative require is unavailable in n8n'); },
  )[0].json.turn_policy;

  test('v3.1 attaches the relevant sheet; v3 attaches none', () => {
    const withSheet = (policy) => policy.grounding.catalog.filter((entry) => entry.technical_sheet).map((entry) => entry.ref);
    expect(withSheet(run('enabled'))).toEqual(['product:demo-bloque']);
    expect(withSheet(run('disabled'))).toEqual([]);
  });
});

describe('v3.1 technical sheets are capped at 6 KB, deterministically', () => {
  const bigSheet = (label, count) => ({
    description: `Ficha ${label}.`,
    general_specs: { hormigon: 'G25' },
    variants: Array.from({ length: count }, (_, index) => variant(`${label} variante ${index + 1}`, {
      dimensions: `${index + 10}x${index + 20}x${index + 30} cm`,
      weight: `${index + 5} kg`,
      other: { nota: 'x'.repeat(120) },
    })),
    unconfirmed: { 'Peso': ['1 kg', '2 kg'] },
    source_files: [],
  });
  const bigGrounding = {
    catalog: ['alfa', 'beta', 'gamma', 'delta'].map((label, index) => ({
      ref: `product:${label}`, concept: 'product', value: `Producto ${label}`, technical_sheet: bigSheet(label, 10 + index * 10),
    })),
  };
  const row = baseRow({
    v3_grounding: bigGrounding,
    text_body: 'Necesito Producto alfa, Producto beta, Producto gamma y Producto delta',
  });

  test('the selected sheets together never exceed the cap, and truncation is announced', () => {
    const input = v31(row);
    const sheets = input.grounding.catalog.map((entry) => entry.technical_sheet).filter(Boolean);

    expect(sheets).toHaveLength(4);
    expect(sheets.reduce((total, sheet) => total + utf8Bytes(sheet), 0)).toBeLessThanOrEqual(MAX_BYTES);
    const truncated = sheets.filter((sheet) => sheet.variants_omitted > 0);
    expect(truncated.length).toBeGreaterThan(0);
    for (const sheet of truncated) {
      expect(sheet.description).toMatch(/^Ficha /);
      expect(sheet.unconfirmed).toEqual({ Peso: ['1 kg', '2 kg'] });
    }
  });

  test('truncation keeps the leading variants in order', () => {
    const delta = entryFor(v31(row), 'product:delta').technical_sheet;
    const kept = delta.variants.map((candidate) => candidate.name);
    expect(kept).toEqual(Array.from({ length: kept.length }, (_, index) => `delta variante ${index + 1}`));
    expect(kept.length + delta.variants_omitted).toBe(40);
  });

  test('the same turn always compiles to the same policy digest', () => {
    const first = compileV3TurnPolicy(v31(row));
    const second = compileV3TurnPolicy(v31(structuredClone(row)));
    expect(second.policy_digest).toBe(first.policy_digest);
  });

  test('one sheet alone larger than the cap is truncated to fit', () => {
    const input = v31(baseRow({
      v3_grounding: { catalog: [{ ref: 'product:enorme', concept: 'product', value: 'Producto enorme', technical_sheet: bigSheet('enorme', 80) }] },
      text_body: 'Producto enorme',
    }));
    const sheet = entryFor(input, 'product:enorme').technical_sheet;
    expect(utf8Bytes(sheet)).toBeLessThanOrEqual(MAX_BYTES);
    expect(sheet.variants_omitted).toBeGreaterThan(0);
  });
});

describe('the v3.1 prompt explains technical sheets; v3 stays unchanged', () => {
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
  const RULE_START = 'Algunas entradas del grounding traen technical_sheet';

  test('v3.1 adds the technical-sheet rule right after the synonyms rule', () => {
    const lines = systemPromptFor('ai_prd_turn_policy/v3.1').split('\n');
    const index = lines.findIndex((line) => line.startsWith(RULE_START));
    expect(index).toBeGreaterThan(0);
    expect(lines[index - 1]).toMatch(/^Algunas entradas product del grounding traen synonyms/);
    const rule = lines[index];
    expect(rule).toContain('medidas, peso, rendimiento por m², resistencia, colores o terminaciones');
    expect(rule).toContain('indica a qué variante corresponde');
    expect(rule).toContain('nunca inventes ni estimes');
    expect(rule).toContain('unconfirmed');
    expect(rule).toContain('variants_omitted');
    expect(rule).toContain('una ejecutiva de Hormiglass');
    expect(rule).toContain('solo con el rendimiento (yield)');
    expect(rule).toContain('referencial');
    expect(rule).toContain('Nunca des precios');
    expect(rule).toContain('marcas de proveedores');
  });

  test('v3 does not get the rule', () => {
    expect(systemPromptFor('ai_prd_turn_policy/v3')).not.toContain(RULE_START);
  });
});
