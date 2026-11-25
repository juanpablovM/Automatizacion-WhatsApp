// =============================================================================
// CRM 1.2d: handoff.created (bot -> CRM), revision 1.2 only.
// Feature document: odd/tasks/crm-1-2d-contingency-handoffs.md (S1-S4, S7).
// Every built event is checked against the local mirror of the CRM validator
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
  buildHandoffCreatedEvent,
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
const OPPORTUNITY_UUID = '66666666-7777-4888-9999-aaaaaaaaaaaa';
const CASE_UUID = '88888888-9999-4aaa-8bbb-cccccccccccc';

const ENV_12 = {
  CRM_EVENTS_ENABLED: 'true',
  CRM_EVENTS_URL: 'https://crm.example.test/api/integrations/whatsapp/events',
  CRM_EVENTS_HMAC_SECRET: 'test-crm-secret',
  CRM_EVENTS_SINCE: '2026-11-11T00:00:00Z',
  CRM_EVENTS_PROTOCOL_REVISION: '1.2',
  CRM_EVENTS_ID_PREFIX: 'test',
};
const ENV_HANDOFFS = { ...ENV_12, CRM_EVENTS_HANDOFFS_ENABLED: 'true' };
const CONFIG_12 = { protocol_revision: '1.2', id_prefix: 'test', handoffs_enabled: true };

const sellerRow = (overrides = {}) => ({
  handoff_id: 301,
  revision: 1,
  conversation_id: 612,
  area: 'sales',
  motivo: 'talk_human',
  escalation_reason: null,
  prioridad: 'alta',
  phone_number: '56912345678',
  crm_opportunity_id: null,
  crm_seller_id: SELLER_UUID,
  customer_name: 'Juan Pérez',
  last_customer_message: 'Quiero hablar con una persona',
  ...overrides,
});
const opportunityRow = (overrides = {}) => sellerRow({ crm_opportunity_id: OPPORTUNITY_UUID, crm_seller_id: null, ...overrides });

const parse = (result) => JSON.parse(result.body);
const expectValid = (body) => expect(validateCrmEvent(body)).toEqual([]);

describe('readCrmEventsConfig: CRM_EVENTS_HANDOFFS_ENABLED (S7)', () => {
  test('is off by default', () => {
    expect(readCrmEventsConfig(ENV_12).handoffs_enabled).toBe(false);
  });

  test('turns on only with "true" under revision 1.2', () => {
    expect(readCrmEventsConfig(ENV_HANDOFFS).handoffs_enabled).toBe(true);
    for (const value of ['', 'false', 'TRUE', '1', 'yes']) {
      expect(readCrmEventsConfig({ ...ENV_12, CRM_EVENTS_HANDOFFS_ENABLED: value }).handoffs_enabled).toBe(false);
    }
    const under11 = readCrmEventsConfig({ ...ENV_HANDOFFS, CRM_EVENTS_PROTOCOL_REVISION: '1.1' });
    expect(under11.handoffs_enabled).toBe(false);
    expect(under11.errors).toEqual([]);
  });

  test('reads the lead test phones and test seller the same way the lead rotation does', () => {
    const config = readCrmEventsConfig({ ...ENV_HANDOFFS, LEAD_TEST_PHONE_NUMBERS: '+56 9 1234 5678, 56987654321', LEAD_TEST_SELLER_ID: ' 6 ' });
    expect(config).toMatchObject({ handoff_test_phones: '56912345678,56987654321', handoff_test_seller_id: '6' });
    // Both are needed; otherwise everyone rotates.
    expect(readCrmEventsConfig({ ...ENV_HANDOFFS, LEAD_TEST_PHONE_NUMBERS: '56912345678' }).handoff_test_seller_id).toBe('');
    expect(readCrmEventsConfig({ ...ENV_HANDOFFS, LEAD_TEST_SELLER_ID: '__PENDIENTE__', LEAD_TEST_PHONE_NUMBERS: '56912345678' }).handoff_test_seller_id).toBe('');
    expect(readCrmEventsConfig({ ...ENV_HANDOFFS, LEAD_TEST_SELLER_ID: 'x7', LEAD_TEST_PHONE_NUMBERS: '56912345678' }).handoff_test_seller_id).toBe('');
  });

  test('leaves every existing setting unchanged', () => {
    const before = readCrmEventsConfig(ENV_12);
    const after = readCrmEventsConfig(ENV_HANDOFFS);
    const { handoffs_enabled: _a, handoff_test_phones: _b, handoff_test_seller_id: _c, ...rest } = after;
    const { handoffs_enabled: _d, handoff_test_phones: _e, handoff_test_seller_id: _f, ...restBefore } = before;
    expect(rest).toEqual(restBefore);
  });
});

describe('Load CRM Events Config node', () => {
  test('passes the handoff flag and test routing to the stages', async () => {
    const [out] = await runNode('load-crm-events-config.js', [{ json: {} }], { ...ENV_HANDOFFS, LEAD_TEST_PHONE_NUMBERS: '56912345678', LEAD_TEST_SELLER_ID: '6' });
    expect(out.json).toMatchObject({ handoffs_enabled: true, handoff_test_phones: '56912345678', handoff_test_seller_id: '6' });
    const [off] = await runNode('load-crm-events-config.js', [{ json: {} }], ENV_12);
    expect(off.json).toMatchObject({ handoffs_enabled: false, handoff_test_phones: '', handoff_test_seller_id: '' });
  });
});

describe('buildHandoffCreatedEvent', () => {
  test('a seller-routed commercial handoff carries crm_seller_id, phone and name, in contract order (S1, S2)', () => {
    const result = buildHandoffCreatedEvent(sellerRow(), CONFIG_12);
    expect(result.blocked_reason).toBeNull();
    expectValid(result.body);
    const parsed = parse(result);
    expect(Object.keys(parsed)).toEqual(['schema_version', 'protocol_revision', 'event_id', 'type', 'conversation_id', 'data']);
    expect(parsed).toMatchObject({
      schema_version: 1,
      protocol_revision: '1.2',
      event_id: 'wa-test-handoff-301-r1',
      type: 'handoff.created',
      conversation_id: 'wa-test-conversation-612',
    });
    expect(parsed.data).toEqual({
      handoff_id: 'wa-test-handoff-301',
      kind: 'commercial',
      area: 'sales',
      reason: 'talk_human',
      priority: 'alta',
      description: 'El cliente pide hablar con una persona.\n\nÚltimo mensaje del cliente: Quiero hablar con una persona',
      crm_seller_id: SELLER_UUID,
      phone: '+56912345678',
      name: 'Juan Pérez',
    });
    expect(result).toMatchObject({ event_id: 'wa-test-handoff-301-r1', conversation_id: 'wa-test-conversation-612', revision: 1, handoff_id: 301 });
  });

  test('an opportunity-routed handoff carries only crm_opportunity_id (S2)', () => {
    const result = buildHandoffCreatedEvent(opportunityRow(), CONFIG_12);
    expectValid(result.body);
    const { data } = parse(result);
    expect(data.crm_opportunity_id).toBe(OPPORTUNITY_UUID);
    for (const key of ['crm_seller_id', 'phone', 'name']) expect(data).not.toHaveProperty(key);
  });

  test('area claims is a complaint for claims; any other area is commercial sales (S1)', () => {
    expect(parse(buildHandoffCreatedEvent(sellerRow({ area: 'claims', motivo: 'complaint', prioridad: 'urgente' }), CONFIG_12)).data)
      .toMatchObject({ kind: 'complaint', area: 'claims', reason: 'complaint', priority: 'urgente' });
    for (const area of ['sales', 'management', 'finance', 'post_sale', 'scheduling', '']) {
      expect(parse(buildHandoffCreatedEvent(sellerRow({ area }), CONFIG_12)).data).toMatchObject({ kind: 'commercial', area: 'sales' });
    }
  });

  test('the revision is the routing attempt: same handoff_id, new event_id', () => {
    const result = buildHandoffCreatedEvent(sellerRow({ revision: 3 }), CONFIG_12);
    expect(result.event_id).toBe('wa-test-handoff-301-r3');
    expect(parse(result).data.handoff_id).toBe('wa-test-handoff-301');
  });

  test('reason is snake_case: a code is kept, free text falls back to the motive, else bot_handoff', () => {
    const reasonOf = (overrides) => parse(buildHandoffCreatedEvent(sellerRow(overrides), CONFIG_12)).data.reason;
    expect(reasonOf({ escalation_reason: 'human_requested', motivo: 'talk_human' })).toBe('human_requested');
    expect(reasonOf({ escalation_reason: 'El cliente pide humano', motivo: 'talk_human' })).toBe('talk_human');
    expect(reasonOf({ escalation_reason: null, motivo: 'Talk-Human ' })).toBe('talk_human');
    expect(reasonOf({ escalation_reason: null, motivo: '123' })).toBe('bot_handoff');
    expect(reasonOf({ escalation_reason: '', motivo: '' })).toBe('bot_handoff');
    expect(reasonOf({ escalation_reason: null, motivo: 'a'.repeat(80) })).toBe('a'.repeat(64));
    for (const value of ['human_requested', 'talk_human', 'bot_handoff', 'a'.repeat(64)]) {
      expect(value).toMatch(/^[a-z][a-z0-9]*(_[a-z0-9]+)*$/);
    }
  });

  test('the description is nonblank Spanish text without the customer message when there is none', () => {
    const { data } = parse(buildHandoffCreatedEvent(sellerRow({ last_customer_message: '  ', motivo: 'unknown_code' }), CONFIG_12));
    expect(data.description).toBe('Derivación del bot a una persona (unknown_code).');
  });

  test('a long customer message is cut so the description stays within 16,000 characters', () => {
    const { data } = parse(buildHandoffCreatedEvent(sellerRow({ last_customer_message: 'x'.repeat(20000) }), CONFIG_12));
    expect(data.description.length).toBeLessThanOrEqual(16000);
    expect(data.description.startsWith('El cliente pide hablar con una persona.')).toBe(true);
  });

  test('the name is optional and cut to 200 characters', () => {
    expect(parse(buildHandoffCreatedEvent(sellerRow({ customer_name: null }), CONFIG_12)).data).not.toHaveProperty('name');
    expect(parse(buildHandoffCreatedEvent(sellerRow({ customer_name: 'n'.repeat(300) }), CONFIG_12)).data.name).toHaveLength(200);
  });

  test('never both or neither routing key, and only under 1.2 (S4)', () => {
    expect(buildHandoffCreatedEvent(sellerRow({ crm_opportunity_id: OPPORTUNITY_UUID }), CONFIG_12).blocked_reason).toBe('ambiguous_routing');
    expect(buildHandoffCreatedEvent(sellerRow({ crm_seller_id: null }), CONFIG_12).blocked_reason).toBe('not_routed');
    expect(buildHandoffCreatedEvent(sellerRow(), { ...CONFIG_12, protocol_revision: '1.1' }).blocked_reason).toBe('protocol_revision_unsupported');
  });

  test('blocks what the CRM would reject', () => {
    const blocked = (overrides, config = CONFIG_12) => buildHandoffCreatedEvent(sellerRow(overrides), config).blocked_reason;
    expect(blocked({ handoff_id: 0 })).toBe('invalid_handoff_id');
    expect(blocked({ revision: 0 })).toBe('invalid_revision');
    expect(blocked({ conversation_id: null })).toBe('conversation_missing');
    expect(blocked({ crm_seller_id: 'not-a-uuid' })).toBe('invalid_seller_uuid');
    expect(blocked({ crm_seller_id: null, crm_opportunity_id: 'nope' })).toBe('invalid_opportunity_uuid');
    expect(blocked({ phone_number: '123' })).toBe('invalid_phone');
    expect(blocked({ prioridad: 'whenever' })).toBe('invalid_priority');
    expect(blocked({}, { ...CONFIG_12, id_prefix: null })).toBe('id_prefix_missing');
    // An opportunity-routed handoff needs no phone.
    expect(buildHandoffCreatedEvent(opportunityRow({ phone_number: '123' }), CONFIG_12).blocked_reason).toBeNull();
  });
});

describe('classifyCrmResponse for handoff.created', () => {
  const ok = {
    event_id: 'wa-test-handoff-301-r1',
    external_handoff_id: 'ext-1',
    crm_case_id: null,
    crm_opportunity_id: null,
    status: 'pending_association',
    routing_status: 'routed',
  };

  test('a 200 with the result keys is delivered', () => {
    for (const body of [ok, { ...ok, crm_case_id: CASE_UUID, crm_opportunity_id: OPPORTUNITY_UUID, status: 'associated' }]) {
      const result = classifyCrmResponse({ statusCode: 200, body: JSON.stringify(body) }, ok.event_id, 'handoff.created');
      expect(result).toMatchObject({ outcome: 'delivered', error: null, http_status: 200, crm_customer_id: null, crm_opportunity_id: null });
      expect(JSON.parse(result.response_json)).toEqual(body);
    }
  });

  test('a 200 that is not the handoff result shape is parked', () => {
    for (const body of [
      { ...ok, event_id: 'other' },
      { ...ok, external_handoff_id: '' },
      { ...ok, crm_case_id: 'nope' },
      { ...ok, status: 'weird' },
    ]) {
      expect(classifyCrmResponse({ statusCode: 200, body }, ok.event_id, 'handoff.created'))
        .toMatchObject({ outcome: 'parked', error: 'invalid_success_response' });
    }
  });

  test('422 invalid_seller is parked with its code, 503 retries', () => {
    expect(classifyCrmResponse({ statusCode: 422, body: { error: 'invalid_seller' } }, ok.event_id, 'handoff.created'))
      .toMatchObject({ outcome: 'parked', error: 'http_422:invalid_seller' });
    expect(classifyCrmResponse({ statusCode: 503, body: {} }, ok.event_id, 'handoff.created')).toMatchObject({ outcome: 'retry' });
  });
});

describe('Build Handoff Events node', () => {
  test('builds events and blocked rows as one JSON array, ignoring the empty-result item', async () => {
    const out = await runNode('build-handoff-events.js', [
      { json: { success: true } },
      { json: sellerRow() },
      { json: sellerRow({ handoff_id: 302, phone_number: '1' }) },
    ], ENV_HANDOFFS);
    expect(out).toHaveLength(1);
    const events = JSON.parse(out[0].json.events_json);
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({
      handoff_id: 301, revision: 1, event_id: 'wa-test-handoff-301-r1', conversation_id: 'wa-test-conversation-612',
      blocked_reason: null, crm_opportunity_id: null, crm_seller_id: SELLER_UUID,
    });
    expectValid(events[0].body);
    expect(events[1]).toMatchObject({ handoff_id: 302, blocked_reason: 'invalid_phone', body: null });
  });

  test('builds nothing unless the handoff flag is on under 1.2', async () => {
    expect(await runNode('build-handoff-events.js', [{ json: sellerRow() }], ENV_12)).toEqual([]);
    expect(await runNode('build-handoff-events.js', [{ json: sellerRow() }], { ...ENV_HANDOFFS, CRM_EVENTS_PROTOCOL_REVISION: '1.1' })).toEqual([]);
    expect(await runNode('build-handoff-events.js', [{ json: sellerRow() }], {})).toEqual([]);
  });
});

describe('crm-events-dispatcher workflow: handoff stage', () => {
  const workflow = JSON.parse(fs.readFileSync('n8n/workflows/crm-events-dispatcher.json', 'utf8'));
  const node = (name) => workflow.nodes.find((candidateNode) => candidateNode.name === name);

  test('chains Select -> Build -> Insert Handoff Events from the config gate, above delivery', () => {
    expect(workflow.connections['Load CRM Events Config'].main[0].map((link) => link.node)).toContain('Select Handoff Candidates');
    expect(workflow.connections['Select Handoff Candidates'].main[0].map((link) => link.node)).toEqual(['Build Handoff Events']);
    expect(workflow.connections['Build Handoff Events'].main[0].map((link) => link.node)).toEqual(['Insert Handoff Events']);
    expect(node('Select Handoff Candidates').position[1]).toBeLessThan(node('Claim CRM Events').position[1]);
    expect(node('Select Handoff Candidates').parameters.options.queryReplacement).toBe(
      "={{ [String($json.handoffs_enabled), $json.since, $json.enqueue_batch_size, $json.phone_allowlist ?? '', $json.handoff_test_phones ?? '', $json.handoff_test_seller_id ?? ''] }}",
    );
    expect(node('Insert Handoff Events').parameters.options.queryReplacement).toBe('={{ [$json.events_json] }}');
  });
});
