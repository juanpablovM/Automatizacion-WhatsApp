// D9 (design.md): `Build ClickUp Payload` (crm-clickup-sync-lead.json) moves
// from an inline n8n Code node to the fixture
// crm-clickup-sync-lead/build-clickup-payload.js. The owner's hard
// requirement is that the extraction changes nothing for a single-item quote:
// this file's golden baseline
// (tests/fixtures/golden/build-clickup-payload-inline-v1.js) is a byte-for-byte
// copy of the inline node's jsCode, captured from the CURRENT code before any
// extraction, and every test below runs both sources through the same
// n8n-shaped harness (`items`/`$env` in scope, `runOnceForAllItems`) so the
// extracted fixture's output is proven equal to the inline node's output, not
// merely assumed equal.
import fs from 'node:fs';
import { describe, expect, test } from 'vitest';

const GOLDEN_INLINE_SOURCE = fs.readFileSync(
  'tests/fixtures/golden/build-clickup-payload-inline-v1.js',
  'utf8',
);
const FIXTURE_PATH = 'tests/fixtures/workflow-nodes/crm-clickup-sync-lead/build-clickup-payload.js';

const runNode = (source, row, env = {}) => new Function('items', '$env', source)([{ json: row }], env)[0].json;

const baseEnv = () => ({
  CLICKUP_LEADS_LIST_ID: 'list-901',
  CLICKUP_CF_WHATSAPP_NAME_ID: 'cf-name',
  CLICKUP_CF_PHONE_ID: 'cf-phone',
  CLICKUP_CF_SERVICE_ID: 'cf-service',
  CLICKUP_CF_CITY_ID: 'cf-city',
  CLICKUP_CF_REQUIREMENT_ID: 'cf-requirement',
  CLICKUP_CF_INTERNAL_LEAD_ID: 'cf-lead-id',
  CLICKUP_CF_SOURCE_NUMBER_ID: 'cf-source-number-id',
});

const singleItemRow = () => ({
  lead_id: 501,
  should_create_clickup: true,
  clickup_operation_key: 'clickup-task:lead:501',
  whatsapp_name: 'Juan Pérez',
  service: 'despacho',
  city: 'Santiago',
  requirement: 'hormigon H25 20 m3',
  phone_number: '+56912345678',
  channel: 'whatsapp',
  source_number_id: 7,
  full_conversation: '2026-09-26 10:00 Cliente: hola',
  advisor_output_payload: { lead_class: 'A', executive_summary: 'Cliente listo' },
  qualification_context: { modality: 'delivery', quantity: '20 m3', use_case: 'losa' },
  clickup_user_id: '123',
  attachments_json: [],
});

describe('Build ClickUp Payload — extracted fixture matches the inline node (D9)', () => {
  test('the extracted fixture produces byte-identical output to the current inline node for a single-item quote', () => {
    const row = singleItemRow();
    const env = baseEnv();

    const goldenOutput = runNode(GOLDEN_INLINE_SOURCE, row, env);
    const fixtureSource = fs.readFileSync(FIXTURE_PATH, 'utf8');
    const fixtureOutput = runNode(fixtureSource, row, env);

    expect(fixtureOutput).toEqual(goldenOutput);
  });

  test('the extracted fixture still lists every non-item qualification field, byte-identical to the inline node', () => {
    const row = singleItemRow();
    row.qualification_context = {
      modality: 'delivery', quantity: '20 m3', measurements: '3 metros de altura', terrain: 'plano',
    };
    const env = baseEnv();

    const goldenOutput = runNode(GOLDEN_INLINE_SOURCE, row, env);
    const fixtureSource = fs.readFileSync(FIXTURE_PATH, 'utf8');
    const fixtureOutput = runNode(fixtureSource, row, env);

    expect(fixtureOutput).toEqual(goldenOutput);
    expect(fixtureOutput.clickup_task_payload.description).toContain('Cantidad: 20 m3');
    expect(fixtureOutput.clickup_task_payload.description).toContain('Medidas: 3 metros de altura');
  });
});

describe('Build ClickUp Payload — skips flat Cantidad/Medidas for a multi-item quote (D9)', () => {
  test('skips the flat Cantidad and Medidas labels when qualification_context.line_items has more than one item', () => {
    const row = singleItemRow();
    row.qualification_context = {
      modality: 'delivery',
      quantity: '5 m2',
      measurements: '3 metros de altura',
      use_case: 'Cierre perimetral',
      line_items: [
        { item_id: 'li_a', product: 'Cierro de Hormigón', quantity: '5 m2', measurements: '3 metros de altura' },
        { item_id: 'li_b', product: 'Alambre de Púas', quantity: '200 ml', measurements: null },
      ],
      line_items_projection: { product: 'Cierro de Hormigón', quantity: '5 m2', measurements: '3 metros de altura' },
      line_items_schema: 'line_items/v1',
    };
    row.requirement = '• Cierro de Hormigón — 5 m2, 3 metros de altura\n• Alambre de Púas — 200 ml\nUso: Cierre perimetral';

    const fixtureSource = fs.readFileSync(FIXTURE_PATH, 'utf8');
    const output = runNode(fixtureSource, row, baseEnv());

    expect(output.clickup_task_payload.description).not.toContain('Cantidad:');
    expect(output.clickup_task_payload.description).not.toContain('Medidas:');
    expect(output.clickup_task_payload.description).toContain('Uso/proyecto: Cierre perimetral');
    expect(output.clickup_task_payload.description).toContain('Modalidad: delivery');
    expect(output.clickup_task_payload.description).toContain('Requerimiento: • Cierro de Hormigón — 5 m2, 3 metros de altura');
  });

  test('still shows the flat Cantidad and Medidas labels when there is exactly one item (or no line_items at all)', () => {
    const row = singleItemRow();
    row.qualification_context = {
      modality: 'delivery',
      quantity: '20 m3',
      measurements: '3 metros de altura',
      line_items: [{ item_id: 'li_0', product: 'hormigon H25', quantity: '20 m3', measurements: '3 metros de altura' }],
    };

    const fixtureSource = fs.readFileSync(FIXTURE_PATH, 'utf8');
    const output = runNode(fixtureSource, row, baseEnv());

    expect(output.clickup_task_payload.description).toContain('Cantidad: 20 m3');
    expect(output.clickup_task_payload.description).toContain('Medidas: 3 metros de altura');
  });
});
