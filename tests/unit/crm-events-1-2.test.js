// =============================================================================
// CRM events sender, contract revision 1.2 ("1.2a"): the full lead.qualified
// record, record-hash corrections, message.new and the 1.2 success shapes.
// Every built event is checked against a local mirror of the CRM validator
// (tests/support/crm-events-validator.js): the CRM answers 400 to anything else.
// =============================================================================
import crypto from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { describe, expect, test } from 'vitest';

const require = createRequire(import.meta.url);
const runtimePath = 'tests/fixtures/workflow-nodes/crm-events-dispatcher/crm-events-runtime.js';
const {
  readCrmEventsConfig,
  buildLeadQualifiedEvent,
  buildMessageNewEvent,
  crmMessageText,
  classifyCrmResponse,
} = require('../fixtures/workflow-nodes/crm-events-dispatcher/crm-events-runtime.js');
const { validateCrmEvent } = require('../support/crm-events-validator.js');

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const runtime = fs.readFileSync(runtimePath, 'utf8');
const nodeSource = (fixture) => `${runtime}\n\n${fs.readFileSync(`tests/fixtures/workflow-nodes/crm-events-dispatcher/${fixture}`, 'utf8')}`;
const requireCrypto = (name) => {
  if (name !== 'crypto') throw new Error(`unexpected require: ${name}`);
  return crypto;
};
const runNode = (fixture, items, env = {}, helpers = {}) =>
  new AsyncFunction('items', '$env', 'helpers', 'require', nodeSource(fixture))(items, env, helpers, requireCrypto);

const SELLER_UUID = '6f1c2a34-5b6d-4e7f-8a9b-0c1d2e3f4a5b';
const CUSTOMER_UUID = '11111111-2222-4333-8444-555555555555';
const OPPORTUNITY_UUID = '66666666-7777-4888-9999-aaaaaaaaaaaa';
const MESSAGE_UUID = '77777777-8888-4999-8aaa-bbbbbbbbbbbb';

const ENV_12 = {
  CRM_EVENTS_ENABLED: 'true',
  CRM_EVENTS_URL: 'https://crm.example.test/api/integrations/whatsapp/events',
  CRM_EVENTS_HMAC_SECRET: 'test-crm-secret',
  CRM_EVENTS_SINCE: '2026-11-11T00:00:00Z',
  CRM_EVENTS_PROTOCOL_REVISION: '1.2',
  CRM_EVENTS_ID_PREFIX: 'test',
};
const CONFIG_12 = { protocol_revision: '1.2', id_prefix: 'test' };
const CONFIG_11 = { protocol_revision: '1.1', id_prefix: 'test' };

const BASE_KEYS = ['lead_id', 'revision', 'phone', 'name', 'crm_seller_id', 'title', 'requirement'];

const minimalLead = (overrides = {}) => ({
  lead_id: 42,
  revision: 1,
  conversation_id: 7,
  phone_number: '56912345678',
  whatsapp_name: 'Juan Pérez',
  service: null,
  city: null,
  requirement: '50 bloques de hormigón',
  qualification_context: {},
  advisor_output_payload: {},
  source_number_phone: null,
  crm_user_id: SELLER_UUID,
  crm_source_hash: 'source-hash-1',
  ...overrides,
});

const fullLead = (overrides = {}) => minimalLead({
  service: 'instalacion',
  city: 'Santiago',
  source_number_phone: '56 2 2345 6789',
  qualification_context: {
    customer_type: 'b2b',
    company: 'Constructora Andes SpA',
    company_rut: '76.123.456-7',
    purchase_order: 'OC-2026-118',
    invoice_required: true,
    service_scope: 'installation',
    commune: 'Ñuñoa',
    address: 'Av. Irarrázaval 1234',
    use_case: 'Patio de estacionamiento',
    urgency: 'alta',
    desired_date: '2026-12-15',
    terrain: 'tierra compactada',
    truck_access: true,
    debris_removal: false,
    access_restrictions: 'Solo después de las 18:00',
    line_items: [
      { item_id: 'li_0', product: 'Adoquín', variant: 'Adoquín corriente', quantity: '120 m2', measurements: '20x10x6' },
      { item_id: 'li_1', product: 'Solerilla', variant: null, quantity: 40, measurements: null, unit: 'u' },
    ],
  },
  advisor_output_payload: {
    lead_class: 'A',
    next_best_action: 'Agendar visita técnica',
    executive_summary: 'Constructora busca instalar adoquines en patio.',
    diagnostic_datos: { pain: 'Barro en invierno', scope: '120 m2', timing: 'Diciembre', obstacle: 'Presupuesto' },
  },
  ...overrides,
});

const dataOf = (result) => JSON.parse(result.body).data;
const expectValid = (body) => expect(validateCrmEvent(body)).toEqual([]);

describe('readCrmEventsConfig under 1.2', () => {
  test('accepts 1.2 and still defaults to 1.1', () => {
    expect(readCrmEventsConfig(ENV_12)).toMatchObject({ errors: [], protocol_revision: '1.2' });
    expect(readCrmEventsConfig({ ...ENV_12, CRM_EVENTS_PROTOCOL_REVISION: '' }).protocol_revision).toBe('1.1');
    expect(readCrmEventsConfig({ ...ENV_12, CRM_EVENTS_PROTOCOL_REVISION: '1.3' }).errors)
      .toEqual(['CRM_EVENTS_PROTOCOL_REVISION_unsupported:1.3']);
  });

  test('delivers 100 events per pass under 1.2 so message bursts do not lag; 1.1 keeps 20', () => {
    expect(readCrmEventsConfig(ENV_12)).toMatchObject({ deliver_batch_size: 100, message_batch_size: 100, enqueue_batch_size: 20 });
    expect(readCrmEventsConfig({ ...ENV_12, CRM_EVENTS_PROTOCOL_REVISION: '1.1' })).toMatchObject({ deliver_batch_size: 20 });
  });

  test('CRM_EVENTS_BATCH_SIZE bounds lead enqueue; delivery under 1.2 only follows CRM_EVENTS_DELIVER_BATCH_SIZE', () => {
    // docker-compose always passes CRM_EVENTS_BATCH_SIZE=20; it must not shrink 1.2 delivery.
    expect(readCrmEventsConfig({ ...ENV_12, CRM_EVENTS_BATCH_SIZE: '20' })).toMatchObject({ deliver_batch_size: 100, enqueue_batch_size: 20 });
    expect(readCrmEventsConfig({ ...ENV_12, CRM_EVENTS_PROTOCOL_REVISION: '1.1', CRM_EVENTS_BATCH_SIZE: '30' })).toMatchObject({ deliver_batch_size: 30 });
    expect(readCrmEventsConfig({ ...ENV_12, CRM_EVENTS_BATCH_SIZE: '30', CRM_EVENTS_DELIVER_BATCH_SIZE: '250', CRM_EVENTS_MESSAGE_BATCH_SIZE: '500' }))
      .toMatchObject({ deliver_batch_size: 250, message_batch_size: 500, enqueue_batch_size: 30 });
    expect(readCrmEventsConfig({ ...ENV_12, CRM_EVENTS_DELIVER_BATCH_SIZE: '' })).toMatchObject({ deliver_batch_size: 100 });
  });

  test('the delivery time budget defaults to 450 s, under the 600 s execution timeout', () => {
    expect(readCrmEventsConfig(ENV_12).deliver_budget_seconds).toBe(450);
    expect(readCrmEventsConfig({ ...ENV_12, CRM_EVENTS_DELIVER_BUDGET_SECONDS: '120' }).deliver_budget_seconds).toBe(120);
  });
});

describe('Load CRM Events Config node under 1.2', () => {
  test('passes the id prefix and the message batch size to the stages', async () => {
    const [out] = await runNode('load-crm-events-config.js', [{ json: {} }], ENV_12);
    expect(out.json).toMatchObject({ protocol_revision: '1.2', id_prefix: 'test', message_batch_size: 100, deliver_batch_size: 100 });
  });
});

describe('buildLeadQualifiedEvent under 1.2', () => {
  test('a full record maps every bot field and passes the CRM validator', () => {
    const result = buildLeadQualifiedEvent(fullLead(), CONFIG_12);
    expect(result.blocked_reason).toBeNull();
    expectValid(result.body);
    const parsed = JSON.parse(result.body);
    expect(parsed.protocol_revision).toBe('1.2');
    expect(Object.keys(parsed.data)).toEqual([
      ...BASE_KEYS.slice(0, 4), 'rut', ...BASE_KEYS.slice(4),
      'customer_type', 'company', 'tax_document', 'purchase_order', 'service', 'fulfillment', 'city', 'commune',
      'address', 'use_case', 'urgency', 'desired_date', 'source_number', 'site', 'items', 'ai_summary',
    ]);
    expect(parsed.data).toMatchObject({
      rut: '76.123.456-7',
      customer_type: 'company',
      company: 'Constructora Andes SpA',
      tax_document: 'factura',
      purchase_order: 'OC-2026-118',
      service: 'instalacion',
      fulfillment: 'install',
      city: 'Santiago',
      commune: 'Ñuñoa',
      address: 'Av. Irarrázaval 1234',
      use_case: 'Patio de estacionamiento',
      urgency: 'alta',
      desired_date: '2026-12-15',
      source_number: '+56223456789',
      site: { terrain: 'tierra compactada', truck_access: true, debris_removal: false, access_restrictions: 'Solo después de las 18:00' },
      items: [
        { product: 'Adoquín', variant: 'Adoquín corriente', quantity: 120, unit: 'm2', measurements: '20x10x6' },
        { product: 'Solerilla', variant: null, quantity: 40, unit: 'u', measurements: null },
      ],
      ai_summary: {
        lead_class: 'A',
        next_best_action: 'Agendar visita técnica',
        executive_summary: 'Constructora busca instalar adoquines en patio.',
        pain: 'Barro en invierno',
        scope: '120 m2',
        timing: 'Diciembre',
        obstacle: 'Presupuesto',
      },
    });
    expect(result.record_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  test('with every optional field missing it sends only the required keys and passes the validator', () => {
    const result = buildLeadQualifiedEvent(minimalLead(), CONFIG_12);
    expectValid(result.body);
    expect(Object.keys(dataOf(result))).toEqual(BASE_KEYS);
  });

  test('omits a key instead of sending blank, null or unmappable values', () => {
    const result = buildLeadQualifiedEvent(minimalLead({
      service: '   ',
      city: '',
      qualification_context: {
        customer_type: 'returning_customer',
        company: '',
        invoice_required: 'si',
        purchase_order: 'x'.repeat(101),
        modality: 'unknown',
        commune: null,
        urgency: 'pronto',
        desired_date: '2026-02-30',
        truck_access: 'si',
        debris_removal: null,
        line_items: [{ product: '  ', quantity: 2 }],
      },
      advisor_output_payload: { lead_class: 'none', executive_summary: '  ', diagnostic_datos: {} },
      source_number_phone: '123',
    }), CONFIG_12);
    expectValid(result.body);
    expect(Object.keys(dataOf(result))).toEqual(BASE_KEYS);
  });

  test.each([
    [{ customer_type: 'b2c' }, 'natural'],
    [{ customer_type: 'Particular' }, 'natural'],
    [{ customer_type: 'contractor' }, 'company'],
    [{ customer_type: 'empresa' }, 'company'],
  ])('maps customer_type %j to %s', (qualification, expected) => {
    expect(dataOf(buildLeadQualifiedEvent(minimalLead({ qualification_context: qualification }), CONFIG_12)).customer_type).toBe(expected);
  });

  test('maps invoice_required false to boleta', () => {
    expect(dataOf(buildLeadQualifiedEvent(minimalLead({ qualification_context: { invoice_required: false } }), CONFIG_12)).tax_document).toBe('boleta');
  });

  test.each([
    [{ service_scope: 'material', fulfillment: 'delivery' }, 'delivery'],
    [{ modality: 'delivery' }, 'delivery'],
    [{ service_scope: 'both' }, 'install'],
    [{ modality: 'installation' }, 'install'],
    [{ modality: 'material' }, undefined],
  ])('maps %j to fulfillment %s', (qualification, expected) => {
    expect(dataOf(buildLeadQualifiedEvent(minimalLead({ city: 'Talca', qualification_context: qualification }), CONFIG_12)).fulfillment).toBe(expected);
  });

  test('a factory pickup is fulfillment pickup and carries no city or commune', () => {
    for (const overrides of [
      { service: 'retiro', city: 'Talca', qualification_context: { commune: 'Talca' } },
      { city: 'Santiago', qualification_context: { modality: 'pickup', commune: 'Maipú' } },
      { city: null, qualification_context: { service_scope: 'material', fulfillment: 'pickup' } },
    ]) {
      const result = buildLeadQualifiedEvent(minimalLead(overrides), CONFIG_12);
      expectValid(result.body);
      const data = dataOf(result);
      expect(data.fulfillment).toBe('pickup');
      expect(data).not.toHaveProperty('city');
      expect(data).not.toHaveProperty('commune');
    }
  });

  test.each([
    ['urgente', 'urgente'], ['Urgent', 'urgente'], ['high', 'alta'], ['ALTA', 'alta'],
    ['medium', 'media'], ['media', 'media'], ['low', 'baja'], ['baja', 'baja'], ['para ayer', undefined],
  ])('maps urgency %s to %s', (urgency, expected) => {
    expect(dataOf(buildLeadQualifiedEvent(minimalLead({ qualification_context: { urgency } }), CONFIG_12)).urgency).toBe(expected);
  });

  test.each([
    ['2026-12-15', '2026-12-15'], ['15/12/2026', '2026-12-15'], ['5-1-2027', '2027-01-05'],
    ['2028-02-29', '2028-02-29'], ['2027-02-29', undefined], ['31/04/2026', undefined], ['el lunes', undefined], ['2026-12-15T10:00', undefined],
  ])('maps desired_date %s to %s', (desiredDate, expected) => {
    expect(dataOf(buildLeadQualifiedEvent(minimalLead({ qualification_context: { desired_date: desiredDate } }), CONFIG_12)).desired_date).toBe(expected);
  });

  test('items: parses a leading number into quantity and unit, else sends null; caps at 50', () => {
    const lineItems = [
      { product: 'Hormigón H25', quantity: '20 m3' },
      { product: 'Bloque', quantity: '1.500,5 unidades' },
      { product: 'Baldosa', quantity: 'unas cuantas' },
      { product: 'Malla', quantity: '0' },
      { product: 'Arena', quantity: '2,5 m3 aprox de arena gruesa' },
      { product: 'Cemento', quantity: -3 },
      ...Array.from({ length: 60 }, (_, index) => ({ product: `P${index}`, quantity: 1 })),
    ];
    const result = buildLeadQualifiedEvent(minimalLead({ qualification_context: { line_items: lineItems } }), CONFIG_12);
    expectValid(result.body);
    const { items } = dataOf(result);
    expect(items).toHaveLength(50);
    expect(items[0]).toEqual({ product: 'Hormigón H25', variant: null, quantity: 20, unit: 'm3', measurements: null });
    expect(items[1]).toMatchObject({ quantity: null, unit: null });
    expect(items[2]).toMatchObject({ quantity: null, unit: null });
    expect(items[3]).toMatchObject({ quantity: null, unit: null });
    expect(items[4]).toMatchObject({ quantity: null, unit: null });
    expect(items[5]).toMatchObject({ quantity: null });
  });

  test('a flat historical quote without line_items becomes one item', () => {
    const { items } = dataOf(buildLeadQualifiedEvent(minimalLead({
      qualification_context: { product: 'Adoquín', quantity: '30', measurements: '20x10' },
    }), CONFIG_12));
    expect(items).toEqual([{ product: 'Adoquín', variant: null, quantity: 30, unit: null, measurements: '20x10' }]);
  });

  test('truncates free text to its maximum and strips NUL characters', () => {
    const result = buildLeadQualifiedEvent(minimalLead({
      whatsapp_name: 'Ana\u0000 María',
      service: 's'.repeat(150),
      qualification_context: {
        company: 'c'.repeat(250),
        address: 'a'.repeat(400),
        use_case: 'u'.repeat(300),
        access_restrictions: 'r'.repeat(600),
        line_items: [{ product: 'p'.repeat(250), variant: 'v'.repeat(250), measurements: 'm'.repeat(250), quantity: 1, unit: 'unidades-muy-largas-de-verdad' }],
      },
      advisor_output_payload: { executive_summary: 'e'.repeat(5000) },
    }), CONFIG_12);
    expectValid(result.body);
    const data = dataOf(result);
    expect(data.name).toBe('Ana María');
    expect(data.service).toHaveLength(100);
    expect(data.company).toHaveLength(200);
    expect(data.address).toHaveLength(300);
    expect(data.use_case).toHaveLength(200);
    expect(data.site.access_restrictions).toHaveLength(500);
    expect(data.items[0].product).toHaveLength(200);
    expect(data.items[0].unit).toBeNull();
    expect(data.ai_summary.executive_summary).toHaveLength(4000);
  });

  test('the record hash ignores the AI summary but changes with any business field', () => {
    const base = buildLeadQualifiedEvent(fullLead(), CONFIG_12).record_hash;
    const churn = buildLeadQualifiedEvent(fullLead({ advisor_output_payload: { lead_class: 'B', executive_summary: 'Otro resumen' } }), CONFIG_12);
    expect(churn.record_hash).toBe(base);
    expect(buildLeadQualifiedEvent(fullLead({ revision: 2 }), CONFIG_12).record_hash).toBe(base);
    expect(buildLeadQualifiedEvent(fullLead({ city: 'Valparaíso' }), CONFIG_12).record_hash).not.toBe(base);
    const otherItems = fullLead();
    otherItems.qualification_context = { ...otherItems.qualification_context, line_items: [{ product: 'Adoquín', quantity: '121 m2' }] };
    expect(buildLeadQualifiedEvent(otherItems, CONFIG_12).record_hash).not.toBe(base);
    expect(buildLeadQualifiedEvent(fullLead({ crm_user_id: '0a0a0a0a-1b1b-4c2c-8d3d-4e4e4e4e4e4e' }), CONFIG_12).record_hash).not.toBe(base);
  });

  test('keeps the body within 65,536 bytes, dropping the AI summary before cutting the requirement', () => {
    const result = buildLeadQualifiedEvent(fullLead({
      requirement: '\u0001'.repeat(16000),
      advisor_output_payload: { executive_summary: '\u0001'.repeat(4000), next_best_action: '\u0001'.repeat(4000) },
    }), CONFIG_12);
    expect(result.blocked_reason).toBeNull();
    expect(Buffer.byteLength(result.body, 'utf8')).toBeLessThanOrEqual(65536);
    expectValid(result.body);
  });

  test('1.1 keeps sending only the 1.1 keys and no record hash', () => {
    const result = buildLeadQualifiedEvent(fullLead(), CONFIG_11);
    expectValid(result.body);
    expect(Object.keys(dataOf(result))).toEqual([...BASE_KEYS.slice(0, 4), 'rut', ...BASE_KEYS.slice(4)]);
    expect(JSON.parse(result.body).protocol_revision).toBe('1.1');
    expect(result.record_hash).toBeNull();
  });
});

describe('Build Lead Qualified Events node under 1.2', () => {
  test('passes the record hash and the source hash to the insert', async () => {
    const out = await runNode('build-lead-qualified-events.js', [{ json: fullLead() }, { json: minimalLead({ lead_id: 43, phone_number: '1' }) }], ENV_12);
    expect(out[0].json).toMatchObject({ lead_id: 42, blocked_reason: null, source_hash: 'source-hash-1' });
    expect(out[0].json.record_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(out[1].json).toMatchObject({ lead_id: 43, blocked_reason: 'invalid_phone', record_hash: null, source_hash: 'source-hash-1' });
  });

  test('under 1.1 the hashes stay empty so the insert keeps its requirement rule', async () => {
    const out = await runNode('build-lead-qualified-events.js', [{ json: fullLead() }], { ...ENV_12, CRM_EVENTS_PROTOCOL_REVISION: '1.1' });
    expect(out[0].json).toMatchObject({ record_hash: null, source_hash: null });
  });
});

const message = (overrides = {}) => ({
  message_id: 501,
  conversation_id: 7,
  direction: 'incoming',
  sender_type: 'customer',
  message_type: 'text',
  text_body: 'Hola, necesito adoquines',
  file_name: null,
  sent_at: '2026-11-11T14:03:22.120Z',
  crm_user_id: null,
  ...overrides,
});

describe('buildMessageNewEvent', () => {
  test('an inbound customer message', () => {
    const result = buildMessageNewEvent(message(), CONFIG_12);
    expect(result.blocked_reason).toBeNull();
    expectValid(result.body);
    expect(JSON.parse(result.body)).toEqual({
      schema_version: 1,
      protocol_revision: '1.2',
      event_id: 'wa-test-message-501-e1',
      type: 'message.new',
      conversation_id: 'wa-test-conversation-7',
      data: {
        message_id: 'wa-test-message-501',
        direction: 'inbound',
        text: 'Hola, necesito adoquines',
        sent_at: '2026-11-11T14:03:22.120Z',
        sender: 'customer',
      },
    });
    expect(result).toMatchObject({ event_id: 'wa-test-message-501-e1', conversation_id: 'wa-test-conversation-7', message_id: 501 });
  });

  test.each([
    ['bot', 'bot'],
    ['system', 'system'],
  ])('an outgoing %s message is sender %s without crm_seller_id', (senderType, sender) => {
    const result = buildMessageNewEvent(message({ direction: 'outgoing', sender_type: senderType, crm_user_id: SELLER_UUID }), CONFIG_12);
    expectValid(result.body);
    const { data } = JSON.parse(result.body);
    expect(data).toMatchObject({ direction: 'outbound', sender });
    expect(data).not.toHaveProperty('crm_seller_id');
  });

  test('an outgoing human message is sender seller with the conversation seller', () => {
    const result = buildMessageNewEvent(message({ direction: 'outgoing', sender_type: 'human', crm_user_id: SELLER_UUID.toUpperCase() }), CONFIG_12);
    expectValid(result.body);
    expect(JSON.parse(result.body).data).toMatchObject({ direction: 'outbound', sender: 'seller', crm_seller_id: SELLER_UUID });
    expect(Object.keys(JSON.parse(result.body).data)).toEqual(['message_id', 'direction', 'text', 'sent_at', 'sender', 'crm_seller_id']);
  });

  test('a human message whose seller is not mapped is blocked, never sent as bot', () => {
    expect(buildMessageNewEvent(message({ direction: 'outgoing', sender_type: 'human', crm_user_id: null }), CONFIG_12))
      .toMatchObject({ blocked_reason: 'seller_not_mapped', body: null });
    expect(buildMessageNewEvent(message({ direction: 'outgoing', sender_type: 'human', crm_user_id: 'nope' }), CONFIG_12))
      .toMatchObject({ blocked_reason: 'invalid_seller_uuid', body: null });
  });

  test('a sender that contradicts the direction, or an unknown one, is blocked', () => {
    expect(buildMessageNewEvent(message({ direction: 'outgoing', sender_type: 'customer' }), CONFIG_12).blocked_reason).toBe('sender_direction_mismatch');
    expect(buildMessageNewEvent(message({ direction: 'outgoing', sender_type: null }), CONFIG_12).blocked_reason).toBe('unknown_sender_type');
    expect(buildMessageNewEvent(message({ direction: 'sideways' }), CONFIG_12).blocked_reason).toBe('invalid_direction');
  });

  test('an incoming message is always the customer', () => {
    const { data } = JSON.parse(buildMessageNewEvent(message({ sender_type: 'bot' }), CONFIG_12).body);
    expect(data).toMatchObject({ direction: 'inbound', sender: 'customer' });
  });

  test('is never built under 1.1', () => {
    expect(buildMessageNewEvent(message(), CONFIG_11)).toMatchObject({ blocked_reason: 'protocol_revision_unsupported', body: null });
  });

  test('blocks an invalid sent_at, message id or conversation', () => {
    expect(buildMessageNewEvent(message({ sent_at: '2026-11-11 14:03:22' }), CONFIG_12).blocked_reason).toBe('invalid_sent_at');
    expect(buildMessageNewEvent(message({ message_id: 0 }), CONFIG_12).blocked_reason).toBe('invalid_message_id');
    expect(buildMessageNewEvent(message({ conversation_id: null }), CONFIG_12).blocked_reason).toBe('conversation_missing');
  });

  test('normalizes a Date or offset timestamp to UTC with Z', () => {
    const fromDate = buildMessageNewEvent(message({ sent_at: new Date('2026-11-11T11:03:22-03:00') }), CONFIG_12);
    expect(JSON.parse(fromDate.body).data.sent_at).toBe('2026-11-11T14:03:22.000Z');
  });

  test('caps the text at 16,000 characters', () => {
    const result = buildMessageNewEvent(message({ text_body: 'x'.repeat(20000) }), CONFIG_12);
    expectValid(result.body);
    expect(JSON.parse(result.body).data.text).toHaveLength(16000);
  });
});

describe('crmMessageText', () => {
  test.each([
    [{ message_type: 'text', text_body: '  hola  ' }, 'hola'],
    [{ message_type: 'text', text_body: '' }, '[empty message]'],
    [{ message_type: 'image', text_body: null }, '[image]'],
    [{ message_type: 'image', text_body: 'mi patio' }, '[image]\nmi patio'],
    [{ message_type: 'audio', text_body: null }, '[audio]'],
    [{ message_type: 'video', text_body: 'mira' }, '[video]\nmira'],
    [{ message_type: 'document', text_body: null, file_name: 'ficha.pdf' }, '[document] ficha.pdf'],
    [{ message_type: 'document', text_body: 'la OC', file_name: 'oc.pdf' }, '[document] oc.pdf\nla OC'],
    [{ message_type: 'document', text_body: null, file_name: null }, '[document]'],
    [{ message_type: 'location', text_body: 'Obra Maipú' }, '[location]\nObra Maipú'],
    [{ message_type: 'interactive', text_body: 'opcion_1' }, 'opcion_1'],
    [{ message_type: 'unknown', text_body: null }, '[unsupported message]'],
    [{ message_type: 'sticker', text_body: null }, '[unsupported message]'],
  ])('%j -> %j', (row, expected) => {
    expect(crmMessageText(row)).toBe(expected);
  });
});

describe('Build Message Events node', () => {
  test('emits one item with every event or block as JSON, skipping the empty-result item', async () => {
    const out = await runNode('build-message-events.js', [
      { json: { success: true } },
      { json: message() },
      { json: message({ message_id: 502, direction: 'outgoing', sender_type: 'human', crm_user_id: null }) },
    ], ENV_12);
    expect(out).toHaveLength(1);
    const events = JSON.parse(out[0].json.events_json);
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({ message_id: 501, event_id: 'wa-test-message-501-e1', conversation_id: 'wa-test-conversation-7', blocked_reason: null });
    expectValid(events[0].body);
    expect(events[1]).toEqual({ message_id: 502, event_id: null, conversation_id: null, body: null, blocked_reason: 'seller_not_mapped' });
  });

  test('emits nothing under 1.1, while disabled, or without candidates', async () => {
    expect(await runNode('build-message-events.js', [{ json: message() }], { ...ENV_12, CRM_EVENTS_PROTOCOL_REVISION: '1.1' })).toEqual([]);
    expect(await runNode('build-message-events.js', [{ json: message() }], {})).toEqual([]);
    expect(await runNode('build-message-events.js', [{ json: { success: true } }], ENV_12)).toEqual([]);
  });
});

describe('classifyCrmResponse 1.2 success shapes', () => {
  const leadOk = { event_id: 'wa-test-lead-42-r1', crm_customer_id: CUSTOMER_UUID, crm_opportunity_id: OPPORTUNITY_UUID };

  test.each(['created', 'updated', 'ignored_stale', 'duplicate'])('lead.qualified status %s is delivered', (status) => {
    expect(classifyCrmResponse({ statusCode: 200, body: { ...leadOk, status } }, leadOk.event_id, 'lead.qualified'))
      .toMatchObject({ outcome: 'delivered', crm_customer_id: CUSTOMER_UUID, crm_opportunity_id: OPPORTUNITY_UUID });
  });

  test('a lead.qualified result with an unknown status is parked', () => {
    expect(classifyCrmResponse({ statusCode: 200, body: { ...leadOk, status: 'weird' } }, leadOk.event_id, 'lead.qualified'))
      .toMatchObject({ outcome: 'parked', error: 'invalid_success_response' });
  });

  test.each(['created', 'duplicate'])('message.new status %s is delivered without lead ids', (status) => {
    const body = { event_id: 'wa-test-message-501-e1', crm_message_id: MESSAGE_UUID, status };
    expect(classifyCrmResponse({ statusCode: 200, body: JSON.stringify(body) }, body.event_id, 'message.new'))
      .toMatchObject({ outcome: 'delivered', crm_customer_id: null, crm_opportunity_id: null, error: null });
  });

  test('a message.new result without crm_message_id or with a lead status is parked', () => {
    const eventId = 'wa-test-message-501-e1';
    for (const body of [
      { event_id: eventId, status: 'created' },
      { event_id: eventId, crm_message_id: MESSAGE_UUID, status: 'updated' },
      { event_id: eventId, crm_message_id: '  ', status: 'created' },
      { event_id: 'other', crm_message_id: MESSAGE_UUID, status: 'created' },
    ]) {
      expect(classifyCrmResponse({ statusCode: 200, body }, eventId, 'message.new')).toMatchObject({ outcome: 'parked', error: 'invalid_success_response' });
    }
  });

  test('422 invalid_seller on a message is parked, 503 retried', () => {
    expect(classifyCrmResponse({ statusCode: 422, body: { error: 'invalid_seller' } }, 'x', 'message.new')).toMatchObject({ outcome: 'parked', error: 'http_422:invalid_seller' });
    expect(classifyCrmResponse({ statusCode: 503, body: {} }, 'x', 'message.new').outcome).toBe('retry');
  });
});

describe('Deliver CRM Events node time budget', () => {
  test('stops starting requests that could outlive the budget and releases the rest for a prompt retry', async () => {
    const built = buildMessageNewEvent(message(), CONFIG_12);
    const claimedRow = (id) => ({
      crm_event_id: id, event_id: `${built.event_id}-${id}`, event_type: 'message.new', claim_token: `token-${id}`, attempt_count: 1, body: built.body,
    });
    // A real-looking epoch: the signature needs a 10-digit unix-seconds timestamp.
    let now = 1_762_819_200_000;
    const realNow = Date.now;
    Date.now = () => now;
    try {
      const calls = [];
      const httpRequest = async () => {
        calls.push(now);
        now += 8_000;
        return { statusCode: 503, body: {} };
      };
      const env = { ...ENV_12, CRM_EVENTS_DELIVER_BUDGET_SECONDS: '30', CRM_EVENTS_TIMEOUT_MS: '15000' };
      const out = await runNode('deliver-crm-events.js', [1, 2, 3, 4].map((id) => ({ json: claimedRow(id) })), env, { httpRequest });
      // 0 s and 8 s start (8 + 15 <= 30); at 16 s a 15 s request could end at 31 s.
      expect(calls).toHaveLength(2);
      expect(out.map((item) => item.json.delivery_outcome)).toEqual(['retry', 'retry', 'retry', 'retry']);
      expect(out.slice(2).map((item) => item.json)).toEqual([3, 4].map((id) => expect.objectContaining({
        crm_event_id: id, http_status: null, delivery_error: 'deferred:execution_budget', retry_delay_seconds: 1,
      })));
    } finally {
      Date.now = realNow;
    }
  });
});

describe('Deliver CRM Events node with message events', () => {
  test('classifies a claimed message.new by its event type and leaves the lead ids empty', async () => {
    const built = buildMessageNewEvent(message(), CONFIG_12);
    const httpRequest = async () => ({ statusCode: 200, body: JSON.stringify({ event_id: built.event_id, crm_message_id: MESSAGE_UUID, status: 'created' }) });
    const [out] = await runNode('deliver-crm-events.js', [{ json: {
      crm_event_id: 11, event_id: built.event_id, event_type: 'message.new', claim_token: 'f7d1b8a2-0000-4000-8000-000000000002', attempt_count: 1, body: built.body,
    } }], ENV_12, { httpRequest });
    expect(out.json).toMatchObject({ delivery_outcome: 'delivered', crm_customer_id: null, crm_opportunity_id: null, event_type: 'message.new' });
  });
});
