// Owner decision 2026-10-14: the lead task moves to Hormiglass's own ClickUp
// list "Cotizaciones WhatsApp" and adapts to the fields that list already has.
// Every new field is opt-in by environment, so a deployment without these
// variables keeps producing the payload the golden baseline pins
// (build-clickup-payload.test.js). Every ID below is SYNTHETIC.
import fs from 'node:fs';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const FIXTURE_SOURCE = fs.readFileSync(
  'tests/fixtures/workflow-nodes/crm-clickup-sync-lead/build-clickup-payload.js',
  'utf8',
);
const runNode = (row, env) => new Function('items', '$env', FIXTURE_SOURCE)([{ json: row }], env)[0].json;

const PRODUCT_OPTIONS = {
  Adoquines: 'opt-adoquines',
  Baldosas: 'opt-baldosas',
  'Bloques de cemento': 'opt-bloques',
  'Soleras': 'opt-soleras',
  'Solerillas': 'opt-solerillas',
  'Tapas de cámara': 'opt-tapas',
};
const SERVICE_OPTIONS = {
  'Instalación': 'opt-instalacion',
  Despacho: 'opt-despacho',
  'Venta de Producto': 'opt-venta',
};

const hormiglassEnv = () => ({
  CLICKUP_LEADS_LIST_ID: 'list-cotizaciones-whatsapp',
  CLICKUP_LEAD_INITIAL_STATUS: 'nueva',
  CLICKUP_CF_WHATSAPP_NAME_ID: 'cf-contact-name',
  CLICKUP_CF_PHONE_ID: 'cf-contact-phone',
  CLICKUP_CF_REQUIREMENT_ID: 'cf-request',
  CLICKUP_CF_WHATSAPP_LINK_ID: 'cf-whatsapp-link',
  CLICKUP_CF_CONSULTATION_DATE_ID: 'cf-consultation-date',
  CLICKUP_CF_REFERRAL_ID: 'cf-referral',
  CLICKUP_CF_REFERRAL_OPTION_WHATSAPP_ID: 'opt-referral-whatsapp',
  CLICKUP_CF_PRODUCT_TYPE_ID: 'cf-product-type',
  CLICKUP_CF_PRODUCT_TYPE_OPTIONS_JSON: JSON.stringify(PRODUCT_OPTIONS),
  CLICKUP_CF_SERVICE_TYPE_ID: 'cf-service-type',
  CLICKUP_CF_SERVICE_TYPE_OPTIONS_JSON: JSON.stringify(SERVICE_OPTIONS),
});

const leadRow = (overrides = {}) => ({
  lead_id: 812,
  should_create_clickup: true,
  whatsapp_name: 'Cliente Demo',
  service: 'instalacion',
  city: 'Santiago',
  requirement: '• Baldosa Minvu — 40 m2\n• Soleras y Solerillas — 30 ml',
  phone_number: '+56 9 1111 2222',
  channel: 'whatsapp',
  source_number_id: 3,
  qualification_context: {
    line_items: [
      { item_id: 'li_0', product: 'Baldosa Minvu', quantity: '40 m2' },
      { item_id: 'li_1', product: 'Soleras y Solerillas', quantity: '30 ml' },
    ],
  },
  clickup_user_id: '89274684',
  ...overrides,
});

const fieldValue = (output, id) => output.clickup_task_payload.custom_fields.find((field) => field.id === id)?.value;

const CREATED_AT = Date.parse('2026-10-14T15:30:00Z');
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(CREATED_AT); });
afterEach(() => { vi.useRealTimers(); });

describe('the lead task fits the Cotizaciones WhatsApp list', () => {
  test('the task starts in the configured status', () => {
    expect(runNode(leadRow(), hormiglassEnv()).clickup_task_payload.status).toBe('nueva');
  });

  test('contact, request, WhatsApp link, consultation date and referral fill their fields', () => {
    const output = runNode(leadRow(), hormiglassEnv());
    expect(fieldValue(output, 'cf-contact-name')).toBe('Cliente Demo');
    expect(fieldValue(output, 'cf-contact-phone')).toBe('+56911112222');
    expect(fieldValue(output, 'cf-request')).toContain('Baldosa Minvu');
    expect(fieldValue(output, 'cf-whatsapp-link')).toBe('https://wa.me/56911112222');
    expect(fieldValue(output, 'cf-consultation-date')).toBe(CREATED_AT);
    expect(fieldValue(output, 'cf-referral')).toEqual(['opt-referral-whatsapp']);
  });

  test('each quoted product picks its product type label, singular or plural', () => {
    const output = runNode(leadRow(), hormiglassEnv());
    expect(fieldValue(output, 'cf-product-type')).toEqual(['opt-baldosas', 'opt-soleras', 'opt-solerillas']);

    const adoquin = runNode(leadRow({
      qualification_context: { line_items: [{ item_id: 'li_0', product: 'Adoquín' }, { item_id: 'li_1', product: 'Bloques de Hormigón' }] },
    }), hormiglassEnv());
    expect(fieldValue(adoquin, 'cf-product-type')).toEqual(['opt-adoquines', 'opt-bloques']);
  });

  test('a product with no matching label leaves the product type empty', () => {
    const output = runNode(leadRow({
      qualification_context: { line_items: [{ item_id: 'li_0', product: 'Alambre de Púas' }] },
    }), hormiglassEnv());
    expect(fieldValue(output, 'cf-product-type')).toBeUndefined();
  });

  test('the service picks its service type label only when one matches', () => {
    expect(fieldValue(runNode(leadRow(), hormiglassEnv()), 'cf-service-type')).toEqual(['opt-instalacion']);
    expect(fieldValue(runNode(leadRow({ service: 'material e instalacion' }), hormiglassEnv()), 'cf-service-type'))
      .toEqual(['opt-instalacion']);
    expect(fieldValue(runNode(leadRow({ service: 'despacho' }), hormiglassEnv()), 'cf-service-type'))
      .toEqual(['opt-despacho']);
    expect(fieldValue(runNode(leadRow({ service: 'retiro' }), hormiglassEnv()), 'cf-service-type')).toBeUndefined();
  });

  test('unconfigured fields are not sent', () => {
    const output = runNode(leadRow(), hormiglassEnv());
    const ids = output.clickup_task_payload.custom_fields.map((field) => field.id);
    expect(ids).not.toContain(undefined);
    expect(ids).toHaveLength(8);
  });

  test('a broken options mapping skips its field instead of failing the lead', () => {
    const env = { ...hormiglassEnv(), CLICKUP_CF_PRODUCT_TYPE_OPTIONS_JSON: '{not json' };
    const output = runNode(leadRow(), env);
    expect(fieldValue(output, 'cf-product-type')).toBeUndefined();
    expect(fieldValue(output, 'cf-service-type')).toEqual(['opt-instalacion']);
  });

  test('without the new variables the payload has no status and none of the new fields', () => {
    const output = runNode(leadRow(), { CLICKUP_LEADS_LIST_ID: 'list-901' });
    expect(output.clickup_task_payload).not.toHaveProperty('status');
    expect(output.clickup_task_payload.custom_fields).toEqual([]);
  });
});
