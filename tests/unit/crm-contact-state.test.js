// =============================================================================
// CRM 1.3 contact.state builder (U5: S4, S2, S10): the body shape, progress
// from the stored qualification context through the bot's own policy builder,
// stage normalization, blocked rows, the Build Contact State Events node and
// the response classes. Feature document: odd/tasks/crm-1-3-customer-threads.md.
// Every body is checked against the contact.state rules of the CRM contract
// (crm-response §3), mirrored below until the shared receiver model has them.
// =============================================================================
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { describe, expect, test } from 'vitest';

const require = createRequire(import.meta.url);
const {
  buildContactStateEvent,
  contactStateProgress,
  contactStateStage,
  contactStatePolicyVersion,
} = require('../fixtures/workflow-nodes/crm-events-dispatcher/contact-state-runtime.js');
const { classifyCrmResponse } = require('../fixtures/workflow-nodes/crm-events-dispatcher/crm-events-runtime.js');

// The node as n8n runs it: the runtimes of its manifest entry, then the node.
const NODE_RUNTIMES = [
  'crm-events-dispatcher/crm-events-runtime.js',
  'shared/v3-line-items.js',
  'shared/v3-policy-builder.js',
  'crm-events-dispatcher/contact-state-runtime.js',
];
const fixture = (rel) => fs.readFileSync(`tests/fixtures/workflow-nodes/${rel}`, 'utf8');
const nodeSource = [...NODE_RUNTIMES, 'crm-events-dispatcher/build-contact-state-events.js'].map(fixture).join('\n\n');
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const runNode = (items, env) => new AsyncFunction('items', '$env', 'require', nodeSource)(items, env, () => {
  throw new Error('unexpected require');
});

const ENV_13 = {
  CRM_EVENTS_ENABLED: 'true',
  CRM_EVENTS_URL: 'https://crm.example.test/api/integrations/whatsapp/events',
  CRM_EVENTS_HMAC_SECRET: 'test-crm-secret',
  CRM_EVENTS_SINCE: '2026-11-11T00:00:00Z',
  CRM_EVENTS_PROTOCOL_REVISION: '1.3',
  CRM_EVENTS_ID_PREFIX: 'test',
  AI_PRD_V3_LINE_ITEMS: 'enabled',
};
const ENV_12 = { ...ENV_13, CRM_EVENTS_PROTOCOL_REVISION: '1.2' };
const CONFIG_13 = { protocol_revision: '1.3', id_prefix: 'test' };

const STATES = ['ready_to_quote', 'handed_off', 'seller_held', 'qualifying', 'idle'];
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const CHANGED_AT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
// contact.state per crm-response §3 (to add to tests/support/crm-events-validator.js).
const validateContactState = (body) => {
  const errors = [];
  const event = JSON.parse(body);
  if (JSON.stringify(Object.keys(event)) !== JSON.stringify(['schema_version', 'protocol_revision', 'event_id', 'type', 'contact_id', 'data'])) errors.push('envelope keys');
  if (event.schema_version !== 1 || event.protocol_revision !== '1.3' || event.type !== 'contact.state') errors.push('envelope');
  if (!ID.test(event.event_id) || !ID.test(event.contact_id)) errors.push('ids');
  const { data } = event;
  if (JSON.stringify(Object.keys(data)) !== JSON.stringify(['state_version', 'state', 'progress', 'stage', 'conversation_id', 'changed_at'])) errors.push('data keys');
  if (!(Number.isInteger(data.state_version) && data.state_version >= 1)) errors.push('data.state_version');
  if (!STATES.includes(data.state)) errors.push('data.state');
  if (!(Number.isInteger(data.progress) && data.progress >= 0 && data.progress <= 100)) errors.push('data.progress');
  if (!(data.stage === null || (typeof data.stage === 'string' && /^[a-z][a-z0-9_]{0,63}$/.test(data.stage)))) errors.push('data.stage');
  if (data.state === 'idle' ? data.conversation_id !== null : !(typeof data.conversation_id === 'string' && ID.test(data.conversation_id))) errors.push('data.conversation_id');
  if (!(typeof data.changed_at === 'string' && CHANGED_AT.test(data.changed_at))) errors.push('data.changed_at');
  return errors;
};

const VARIANT_CATALOG = [{
  ref: 'product:bloques', concept: 'product', value: 'Bloques de Hormigón',
  technical_sheet: { variants: [{ name: 'Bloque 14' }, { name: 'Bloque 19' }] },
}];
const row = (overrides = {}) => ({
  contact_id: 9,
  phone_number: '56912345678',
  state: 'qualifying',
  state_version: 1,
  conversation_id: 700,
  latest_status_code: 'active',
  pending_question_key: 'quantity',
  qualification_context: { product: 'Adoquín', service_scope: 'material' },
  catalog: [],
  input_hash: 'hash-1',
  observed_at: '2100-01-02T03:04:05Z',
  ...overrides,
});

describe('contactStateStage', () => {
  test('normalizes the persisted pending question like the policy builder', () => {
    expect(contactStateStage('confirm')).toBe('final_confirmation');
    expect(contactStateStage(' quantity ')).toBe('quantity');
    expect(contactStateStage('')).toBeNull();
    expect(contactStateStage(null)).toBeNull();
  });
  test('an id that is not snake_case or is over 64 characters is sent as null', () => {
    expect(contactStateStage('Quantity')).toBeNull();
    expect(contactStateStage(`a${'b'.repeat(64)}`)).toBeNull();
  });
});

describe('contactStatePolicyVersion', () => {
  test('follows AI_PRD_V3_LINE_ITEMS like Compile V3 Turn Policy', () => {
    expect(contactStatePolicyVersion({ AI_PRD_V3_LINE_ITEMS: 'enabled' }, '569')).toBe('v3.1');
    expect(contactStatePolicyVersion({}, '569')).toBe('v3');
    expect(contactStatePolicyVersion({ AI_PRD_V3_LINE_ITEMS: 'bogus' }, '569')).toBe('v3');
    const canary = { AI_PRD_V3_LINE_ITEMS: 'canary', AI_PRD_V3_LINE_ITEMS_CANARY_PHONES: '+56 9 1234 5678' };
    expect(contactStatePolicyVersion(canary, '56912345678')).toBe('v3.1');
    expect(contactStatePolicyVersion(canary, '56900000000')).toBe('v3');
  });
});

describe('contactStateProgress', () => {
  test('answered required questions over required questions of the request (v3.1)', () => {
    // material: required service_scope, fulfillment, line_items.
    expect(contactStateProgress(row({ qualification_context: {} }), 'v3.1')).toBe(0);
    expect(contactStateProgress(row({ qualification_context: { service_scope: 'material' } }), 'v3.1')).toBe(33);
    expect(contactStateProgress(row({ qualification_context: { product: 'Adoquín', quantity: '120 m2', service_scope: 'material' } }), 'v3.1')).toBe(66);
    expect(contactStateProgress(row({ qualification_context: { product: 'Adoquín', quantity: '120 m2', service_scope: 'material', fulfillment: 'pickup' } }), 'v3.1')).toBe(100);
  });
  test('a quantity without a unit and a missing variant do not resolve the items', () => {
    const base = { service_scope: 'material', fulfillment: 'pickup' };
    expect(contactStateProgress(row({ qualification_context: { ...base, product: 'Adoquín', quantity: '120' } }), 'v3.1')).toBe(66);
    const blocks = { ...base, product: 'Bloques de Hormigón', quantity: '100 unidades' };
    expect(contactStateProgress(row({ qualification_context: blocks, catalog: VARIANT_CATALOG }), 'v3.1')).toBe(66);
    expect(contactStateProgress(row({ qualification_context: { ...base, line_items: [{ item_id: 'li_1', product: 'Bloques de Hormigón', quantity: '100 unidades', variant: 'Bloque 14' }] }, catalog: VARIANT_CATALOG }), 'v3.1')).toBe(100);
  });
  test('delivery adds commune, address and access restrictions', () => {
    const context = { product: 'Adoquín', quantity: '120 m2', service_scope: 'material', fulfillment: 'delivery', commune: 'Ñuñoa' };
    // 6 required, 4 answered.
    expect(contactStateProgress(row({ qualification_context: context }), 'v3.1')).toBe(66);
  });
  test('v3 counts product and quantity as separate questions', () => {
    expect(contactStateProgress(row({ qualification_context: { product: 'Adoquín', service_scope: 'material' } }), 'v3')).toBe(50);
  });
  test('ready_to_quote is 100; idle with no request in progress is 0', () => {
    expect(contactStateProgress(row({ state: 'ready_to_quote', qualification_context: {} }), 'v3.1')).toBe(100);
    expect(contactStateProgress(row({ state: 'idle', latest_status_code: 'closed', qualification_context: { service_scope: 'material' } }), 'v3.1')).toBe(0);
    expect(contactStateProgress(row({ state: 'idle', conversation_id: null, latest_status_code: null, qualification_context: null }), 'v3.1')).toBe(0);
    expect(contactStateProgress(row({ state: 'idle', latest_status_code: 'inactive_timeout', qualification_context: { service_scope: 'material' } }), 'v3.1')).toBe(33);
  });
  test('accepts the context as a JSON string (as the Postgres node may return it)', () => {
    expect(contactStateProgress(row({ qualification_context: JSON.stringify({ service_scope: 'material' }) }), 'v3.1')).toBe(33);
  });
});

describe('buildContactStateEvent', () => {
  test('builds the exact contract body, keys in contract order', () => {
    const built = buildContactStateEvent(row({ pending_question_key: 'confirm' }), CONFIG_13, 'v3.1');
    expect(built).toMatchObject({ blocked_reason: null, contact_id: 9, id_prefix: 'test', state_version: 1, input_hash: 'hash-1', event_id: 'wa-test-contact-9-state-1' });
    expect(built.body).toBe(JSON.stringify({
      schema_version: 1,
      protocol_revision: '1.3',
      event_id: 'wa-test-contact-9-state-1',
      type: 'contact.state',
      contact_id: 'wa-test-contact-9',
      data: { state_version: 1, state: 'qualifying', progress: 33, stage: 'final_confirmation', conversation_id: 'wa-test-conversation-700', changed_at: '2100-01-02T03:04:05Z' },
    }));
    expect(validateContactState(built.body)).toEqual([]);
    expect(JSON.parse(built.body)).not.toHaveProperty('conversation_id');
  });
  test('idle carries no conversation and no stage', () => {
    const built = buildContactStateEvent(row({ state: 'idle', latest_status_code: 'closed', state_version: 4 }), CONFIG_13, 'v3.1');
    expect(JSON.parse(built.body).data).toEqual({ state_version: 4, state: 'idle', progress: 0, stage: null, conversation_id: null, changed_at: '2100-01-02T03:04:05Z' });
    expect(validateContactState(built.body)).toEqual([]);
  });
  test('every state builds a valid body', () => {
    for (const state of STATES) {
      const built = buildContactStateEvent(row({ state }), CONFIG_13, 'v3.1');
      expect(built.blocked_reason).toBeNull();
      expect(validateContactState(built.body)).toEqual([]);
    }
  });
  test('blocks rows it cannot build, with a reason and no body', () => {
    expect(buildContactStateEvent(row({ state: 'busy' }), CONFIG_13, 'v3.1')).toMatchObject({ blocked_reason: 'invalid_state', body: null, event_id: null });
    expect(buildContactStateEvent(row({ state_version: 0 }), CONFIG_13, 'v3.1').blocked_reason).toBe('invalid_state_version');
    expect(buildContactStateEvent(row({ observed_at: '2100-01-02' }), CONFIG_13, 'v3.1').blocked_reason).toBe('invalid_changed_at');
    expect(buildContactStateEvent(row(), { protocol_revision: '1.3', id_prefix: '' }, 'v3.1').blocked_reason).toBe('id_prefix_missing');
    expect(buildContactStateEvent(row(), { protocol_revision: '1.2', id_prefix: 'test' }, 'v3.1').blocked_reason).toBe('protocol_revision_unsupported');
    expect(buildContactStateEvent(row({ contact_id: null }), CONFIG_13, 'v3.1').blocked_reason).toBe('invalid_contact_id');
  });
});

describe('Build Contact State Events node', () => {
  test('emits one events_json item with the built rows, skipping the empty Postgres item', async () => {
    const [out] = await runNode([{ json: { success: true } }, { json: row() }, { json: row({ contact_id: 10, state: 'busy' }) }], ENV_13);
    const events = JSON.parse(out.json.events_json);
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({ contact_id: 9, id_prefix: 'test', state_version: 1, input_hash: 'hash-1', event_id: 'wa-test-contact-9-state-1', blocked_reason: null });
    expect(JSON.parse(events[0].body).data.progress).toBe(33);
    expect(events[1]).toMatchObject({ contact_id: 10, id_prefix: 'test', blocked_reason: 'invalid_state', body: null });
  });
  test('is a no-op under 1.2, when disabled or misconfigured, and with no rows', async () => {
    expect(await runNode([{ json: row() }], ENV_12)).toEqual([]);
    expect(await runNode([{ json: row() }], { ...ENV_13, CRM_EVENTS_ENABLED: 'false' })).toEqual([]);
    expect(await runNode([{ json: row() }], { ...ENV_13, CRM_EVENTS_ID_PREFIX: '' })).toEqual([]);
    expect(await runNode([{ json: { success: true } }], ENV_13)).toEqual([]);
  });
});

describe('contact.state responses (classified with contact.*)', () => {
  test.each(['applied', 'ignored_stale', 'duplicate'])('200 %s is delivered', (result) => {
    const classified = classifyCrmResponse({ statusCode: 200, body: JSON.stringify({ event_id: 'e1', result }) }, 'e1', 'contact.state');
    expect(classified).toMatchObject({ outcome: 'delivered', error: null });
  });
  test('a 200 with another result or event id is parked; 503 retries', () => {
    expect(classifyCrmResponse({ statusCode: 200, body: '{"event_id":"e1","result":"created"}' }, 'e1', 'contact.state').outcome).toBe('parked');
    expect(classifyCrmResponse({ statusCode: 200, body: '{"event_id":"e2","result":"applied"}' }, 'e1', 'contact.state').outcome).toBe('parked');
    expect(classifyCrmResponse({ statusCode: 503, body: '{}' }, 'e1', 'contact.state').outcome).toBe('retry');
  });
});
