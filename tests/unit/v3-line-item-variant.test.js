import fs from 'node:fs';
import { createRequire } from 'node:module';
import { describe, expect, test } from 'vitest';

const require = createRequire(import.meta.url);
const {
  reduceV3StateMutations, readLineItems, composeRequirement,
} = require('../fixtures/workflow-nodes/shared/v3-line-items.js');
const { buildV3LeadEffect } = require('../fixtures/workflow-nodes/wa-conversation-orchestrator/build-v3-lead-effect.js');

// -----------------------------------------------------------------------------
// Task 3c.33 (QA 2026-09-30, conversation 393, M1): the customer chose "Solera
// tipo zarpa" but the quote kept the generic "Soleras y Solerillas — 190
// metros"; nothing could store the chosen variant on the item. v3.1 now
// records it as the item field `variant`, and the lead requirement and the
// ClickUp text show it next to the product. L3: the requirement is always
// itemized, also for a single item.
// -----------------------------------------------------------------------------

const solera = (overrides = {}) => ({
  item_id: 'li_solera',
  product: 'Soleras y Solerillas',
  quantity: { kind: 'length', name: null, unit: 'metros', value: 190 },
  measurements: null,
  catalog_ref: null,
  requested_label: null,
  ...overrides,
});

describe('line item variant (M1)', () => {
  test('a variant mutation is stored on its item, not as a quote-level field', () => {
    const context = {
      product: 'Soleras y Solerillas',
      quantity: solera().quantity,
      measurements: null,
      line_items: [solera()],
      line_items_projection: { product: 'Soleras y Solerillas', quantity: solera().quantity, measurements: null },
      line_items_schema: 'line_items/v1',
    };
    const reduced = reduceV3StateMutations(context, [{
      operation: 'set', field: 'variant', item_id: 'li_solera', observation_id: 'obs-variant',
      replaces_fact_id: null, projected_value: 'Solera Zarpa',
    }]);

    expect(reduced).not.toHaveProperty('variant');
    expect(reduced.line_items).toEqual([solera({ variant: 'Solera Zarpa' })]);
    expect(readLineItems(reduced)[0].variant).toBe('Solera Zarpa');
  });

  test('the requirement shows the chosen variant next to the product', () => {
    expect(composeRequirement([solera({ variant: 'Solera Zarpa' })], {}))
      .toBe('• Soleras y Solerillas (Solera Zarpa) — 190 metros');
  });

  test('the v3.1 lead effect carries the variant into the lead requirement', () => {
    const lead = buildV3LeadEffect({
      operation_key: 'op', source_number_id: 1, phone_number: '+56900000000', conversation_id: 9,
      qualification_context: {
        product: 'Soleras y Solerillas', quantity: solera().quantity, measurements: null,
        line_items: [solera()],
        line_items_projection: { product: 'Soleras y Solerillas', quantity: solera().quantity, measurements: null },
        line_items_schema: 'line_items/v1',
        service_scope: 'material', fulfillment: 'delivery', commune: 'Colina',
      },
      v3_decision: { state_mutations: [{
        operation: 'set', field: 'variant', item_id: 'li_solera', observation_id: 'obs-variant',
        replaces_fact_id: null, projected_value: 'Solera Zarpa',
      }] },
    });

    expect(lead.requirement).toBe('• Soleras y Solerillas (Solera Zarpa) — 190 metros');
  });
});

describe('single-item requirement is itemized (L3)', () => {
  test('one item renders one bullet line', () => {
    expect(composeRequirement([{ item_id: 'li_0', product: 'Bloques de Hormigón', quantity: 100, measurements: null }], {}))
      .toBe('• Bloques de Hormigón — 100');
  });

  test('one item keeps its measurements and the Uso line', () => {
    expect(composeRequirement(
      [{ item_id: 'li_0', product: 'Bordes de Piscina', quantity: '33 unidades', measurements: 'piscina 7x8 m' }],
      { use_case: 'piscina' },
    )).toBe('• Bordes de Piscina — 33 unidades, piscina 7x8 m\nUso: piscina');
  });

  test('a single item without a product still invents no requirement', () => {
    expect(composeRequirement([{ item_id: 'li_0', product: null, quantity: '500 ml', measurements: null }], {})).toBe('');
  });
});

describe('ClickUp text for a single item (L3)', () => {
  const runNode = (source, row, env = {}) => new Function('items', '$env', source)([{ json: row }], env)[0].json;
  const source = fs.readFileSync('tests/fixtures/workflow-nodes/crm-clickup-sync-lead/build-clickup-payload.js', 'utf8');

  test('a one-item quote shows the bullet requirement and no flat Cantidad/Medidas lines', () => {
    const output = runNode(source, {
      lead_id: 9, should_create_clickup: true, whatsapp_name: 'Cliente', service: 'despacho', city: 'Colina',
      requirement: '• Soleras y Solerillas (Solera Zarpa) — 190 metros',
      phone_number: '+56900000000', advisor_output_payload: {},
      qualification_context: {
        modality: 'delivery', quantity: '190 metros', measurements: '50 cm',
        line_items: [solera({ variant: 'Solera Zarpa' })],
      },
    }, { CLICKUP_LEADS_LIST_ID: 'list-1' });

    expect(output.clickup_task_payload.description).toContain('Requerimiento: • Soleras y Solerillas (Solera Zarpa) — 190 metros');
    expect(output.clickup_task_payload.description).not.toContain('Cantidad:');
    expect(output.clickup_task_payload.description).not.toContain('Medidas:');
  });
});
