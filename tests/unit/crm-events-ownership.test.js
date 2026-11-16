// =============================================================================
// CRM events sender, revision 1.2b: ownership.taken and ownership.released.
// Every built body is checked against the local mirror of the CRM validator
// (tests/support/crm-events-validator.js), which mirrors the live CRM dev rules:
//   taken    data keys only {version, crm_seller_id (uuid|null, required), source}
//   released data keys only {version, reason}
// =============================================================================
import crypto from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { describe, expect, test } from 'vitest';

const require = createRequire(import.meta.url);
const runtimePath = 'tests/fixtures/workflow-nodes/crm-events-dispatcher/crm-events-runtime.js';
const {
  buildOwnershipEvent,
  classifyCrmResponse,
} = require('../fixtures/workflow-nodes/crm-events-dispatcher/crm-events-runtime.js');
const { validateCrmEvent } = require('../support/crm-events-validator.js');

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const runtime = fs.readFileSync(runtimePath, 'utf8');
const nodeSource = (fixture) => `${runtime}\n\n${fs.readFileSync(`tests/fixtures/workflow-nodes/crm-events-dispatcher/${fixture}`, 'utf8')}`;
const runNode = (fixture, items, env = {}) =>
  new AsyncFunction('items', '$env', 'helpers', 'require', nodeSource(fixture))(items, env, {}, () => crypto);

const SELLER_UUID = '6f1c2a34-5b6d-4e7f-8a9b-0c1d2e3f4a5b';
const CONFIG_12 = { protocol_revision: '1.2', id_prefix: 'test' };
const ENV_12 = {
  CRM_EVENTS_ENABLED: 'true',
  CRM_EVENTS_URL: 'https://crm.example.test/api/integrations/whatsapp/events',
  CRM_EVENTS_HMAC_SECRET: 'test-crm-secret',
  CRM_EVENTS_SINCE: '2026-11-11T00:00:00Z',
  CRM_EVENTS_PROTOCOL_REVISION: '1.2',
  CRM_EVENTS_ID_PREFIX: 'test',
};

const takenRow = (overrides = {}) => ({
  change_id: 11, conversation_id: 7, ownership_version: 3, change_kind: 'taken',
  crm_user_id: SELLER_UUID, source: 'clickup', reason: null, ...overrides,
});
const releasedRow = (overrides = {}) => ({
  change_id: 12, conversation_id: 7, ownership_version: 4, change_kind: 'released',
  crm_user_id: null, source: 'bot', reason: 'sla_expired', ...overrides,
});

describe('buildOwnershipEvent', () => {
  test('ownership.taken carries exactly version, crm_seller_id and source', () => {
    const built = buildOwnershipEvent(takenRow(), CONFIG_12);
    expect(built).toMatchObject({
      blocked_reason: null, change_id: 11,
      event_id: 'wa-test-ownership-7-v3', conversation_id: 'wa-test-conversation-7',
    });
    expect(validateCrmEvent(built.body)).toEqual([]);
    expect(JSON.parse(built.body)).toEqual({
      schema_version: 1,
      protocol_revision: '1.2',
      event_id: 'wa-test-ownership-7-v3',
      type: 'ownership.taken',
      conversation_id: 'wa-test-conversation-7',
      data: { version: 3, crm_seller_id: SELLER_UUID, source: 'clickup' },
    });
  });

  test('an unmapped seller sends crm_seller_id null, never omits the key', () => {
    const built = buildOwnershipEvent(takenRow({ crm_user_id: null, source: 'crm' }), CONFIG_12);
    const { data } = JSON.parse(built.body);
    expect(data).toEqual({ version: 3, crm_seller_id: null, source: 'crm' });
    expect(validateCrmEvent(built.body)).toEqual([]);
  });

  test('ownership.released carries exactly version and reason', () => {
    const built = buildOwnershipEvent(releasedRow(), CONFIG_12);
    expect(JSON.parse(built.body)).toMatchObject({
      type: 'ownership.released', event_id: 'wa-test-ownership-7-v4',
      data: { version: 4, reason: 'sla_expired' },
    });
    expect(Object.keys(JSON.parse(built.body).data)).toEqual(['version', 'reason']);
    expect(validateCrmEvent(built.body)).toEqual([]);
  });

  test.each(['seller_released', 'sla_expired', 'customer_new_quote', 'opportunity_closed'])(
    'release reason %s passes the validator', (reason) => {
      expect(validateCrmEvent(buildOwnershipEvent(releasedRow({ reason }), CONFIG_12).body)).toEqual([]);
    },
  );

  test('the body is byte-stable for the same change', () => {
    expect(buildOwnershipEvent(takenRow(), CONFIG_12).body).toBe(buildOwnershipEvent(takenRow(), CONFIG_12).body);
  });

  test('a bigint version arriving as text is sent as an integer', () => {
    const { data } = JSON.parse(buildOwnershipEvent(takenRow({ ownership_version: '42' }), CONFIG_12).body);
    expect(data.version).toBe(42);
  });

  test.each([
    ['protocol 1.1', takenRow(), { protocol_revision: '1.1', id_prefix: 'test' }, 'protocol_revision_unsupported'],
    ['version 0', takenRow({ ownership_version: 0 }), CONFIG_12, 'invalid_version'],
    ['version over int32', takenRow({ ownership_version: 2147483648 }), CONFIG_12, 'invalid_version'],
    ['unknown kind', takenRow({ change_kind: 'moved' }), CONFIG_12, 'invalid_change_kind'],
    ['taken from bot', takenRow({ source: 'bot' }), CONFIG_12, 'invalid_source'],
    ['released without reason', releasedRow({ reason: null }), CONFIG_12, 'invalid_reason'],
    ['released with unknown reason', releasedRow({ reason: 'manual' }), CONFIG_12, 'invalid_reason'],
    ['missing conversation', takenRow({ conversation_id: null }), CONFIG_12, 'conversation_missing'],
    ['bad seller uuid', takenRow({ crm_user_id: 'not-a-uuid' }), CONFIG_12, 'invalid_seller_uuid'],
    ['missing prefix', takenRow(), { protocol_revision: '1.2' }, 'id_prefix_missing'],
  ])('%s is blocked', (_label, row, config, reason) => {
    expect(buildOwnershipEvent(row, config)).toMatchObject({ blocked_reason: reason, body: null, event_id: null });
  });
});

describe('classifyCrmResponse for ownership events', () => {
  const ok = (body) => ({ statusCode: 200, body: JSON.stringify(body) });

  test('a 200 echoing the event id is delivered, stale versions included', () => {
    const eventId = 'wa-test-ownership-7-v3';
    for (const type of ['ownership.taken', 'ownership.released']) {
      expect(classifyCrmResponse(ok({ event_id: eventId, ownership_version: 3, owner: 'seller' }), eventId, type))
        .toMatchObject({ outcome: 'delivered', error: null, crm_customer_id: null, crm_opportunity_id: null });
      expect(classifyCrmResponse(ok({ event_id: eventId, ownership_version: 9, owner: 'bot' }), eventId, type).outcome)
        .toBe('delivered');
    }
  });

  test('a 200 for another event id is parked', () => {
    expect(classifyCrmResponse(ok({ event_id: 'other', ownership_version: 3 }), 'wa-test-ownership-7-v3', 'ownership.taken'))
      .toMatchObject({ outcome: 'parked', error: 'invalid_success_response' });
  });

  test('503 retries and 400 parks, as for every other event', () => {
    expect(classifyCrmResponse({ statusCode: 503, body: '{}' }, 'e', 'ownership.released').outcome).toBe('retry');
    expect(classifyCrmResponse({ statusCode: 400, body: '{"error":"invalid_event"}' }, 'e', 'ownership.released'))
      .toMatchObject({ outcome: 'parked', error: 'http_400:invalid_event' });
  });
});

describe('Build Ownership Events node', () => {
  test('under 1.2 emits one item with every candidate', async () => {
    const out = await runNode('build-ownership-events.js', [
      { json: takenRow() }, { json: releasedRow() }, { json: { success: true } },
    ], ENV_12);
    expect(out).toHaveLength(1);
    const events = JSON.parse(out[0].json.events_json);
    expect(events.map((e) => [e.change_id, e.event_id, e.blocked_reason])).toEqual([
      [11, 'wa-test-ownership-7-v3', null],
      [12, 'wa-test-ownership-7-v4', null],
    ]);
  });

  test('under 1.1 emits nothing', async () => {
    const out = await runNode('build-ownership-events.js', [{ json: takenRow() }], { ...ENV_12, CRM_EVENTS_PROTOCOL_REVISION: '1.1' });
    expect(out).toEqual([]);
  });

  test('an empty claim emits nothing', async () => {
    expect(await runNode('build-ownership-events.js', [{ json: { success: true } }], ENV_12)).toEqual([]);
  });
});
