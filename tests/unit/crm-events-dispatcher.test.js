// =============================================================================
// CRM events sender (contract 1.1): body builder, signature, response
// classification, backoff and the n8n Code nodes of crm-events-dispatcher.
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
  normalizeCrmPhone,
  isValidCrmId,
  signCrmRequest,
  classifyCrmResponse,
  retryDelaySeconds,
  isClaimedCrmEvent,
} = require(`../fixtures/workflow-nodes/crm-events-dispatcher/crm-events-runtime.js`);

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
const SECRET = 'test-crm-secret';

const ENABLED_ENV = {
  CRM_EVENTS_ENABLED: 'true',
  CRM_EVENTS_URL: 'https://crm.example.test/api/integrations/whatsapp/events',
  CRM_EVENTS_HMAC_SECRET: SECRET,
  CRM_EVENTS_SINCE: '2026-11-11T00:00:00Z',
  CRM_EVENTS_PROTOCOL_REVISION: '1.1',
  CRM_EVENTS_ID_PREFIX: 'test',
};

const BUILD_CONFIG = { protocol_revision: '1.1', id_prefix: 'test' };

const candidate = (overrides = {}) => ({
  lead_id: 42,
  revision: 1,
  conversation_id: 7,
  phone_number: '56912345678',
  whatsapp_name: 'Juan Pérez',
  service: 'instalacion',
  city: 'Santiago',
  requirement: '50 bloques de hormigón',
  qualification_context: {},
  crm_user_id: SELLER_UUID,
  ...overrides,
});

describe('readCrmEventsConfig', () => {
  test('is disabled unless CRM_EVENTS_ENABLED is exactly "true"', () => {
    for (const value of [undefined, '', 'false', 'TRUE', '1', '__PENDIENTE__']) {
      expect(readCrmEventsConfig({ ...ENABLED_ENV, CRM_EVENTS_ENABLED: value }).enabled).toBe(false);
    }
  });

  test('accepts a complete configuration and defaults the protocol revision to 1.1', () => {
    const config = readCrmEventsConfig({ ...ENABLED_ENV, CRM_EVENTS_PROTOCOL_REVISION: '' });
    expect(config.enabled).toBe(true);
    expect(config.errors).toEqual([]);
    expect(config.protocol_revision).toBe('1.1');
    expect(config.since).toBe('2026-11-11T00:00:00.000Z');
    expect(config.enqueue_batch_size).toBe(20);
    expect(config.deliver_batch_size).toBe(20);
    expect(config.stale_seconds).toBe(900);
  });

  test('treats __PENDIENTE__ and blanks as not configured, naming only the variables', () => {
    const config = readCrmEventsConfig({
      CRM_EVENTS_ENABLED: 'true',
      CRM_EVENTS_URL: '__PENDIENTE__',
      CRM_EVENTS_HMAC_SECRET: '__PENDIENTE__',
      CRM_EVENTS_SINCE: '',
    });
    expect(config.errors).toEqual([
      'CRM_EVENTS_URL_missing',
      'CRM_EVENTS_HMAC_SECRET_missing',
      'CRM_EVENTS_SINCE_missing',
      'CRM_EVENTS_ID_PREFIX_missing',
    ]);
    expect(JSON.stringify(config)).not.toContain(SECRET);
  });

  test('requires CRM_EVENTS_ID_PREFIX when enabled and exposes it as id_prefix', () => {
    expect(readCrmEventsConfig(ENABLED_ENV).id_prefix).toBe('test');
    for (const value of [undefined, '', '  ', '__PENDIENTE__']) {
      const config = readCrmEventsConfig({ ...ENABLED_ENV, CRM_EVENTS_ID_PREFIX: value });
      expect(config.errors).toEqual(['CRM_EVENTS_ID_PREFIX_missing']);
      expect(config.id_prefix).toBeNull();
    }
  });

  test('rejects an id prefix that is not 1-16 lowercase letters or digits', () => {
    for (const value of ['Prod', 'pr-od', 'pr_od', 'a'.repeat(17), 'pród', 'pr od']) {
      const config = readCrmEventsConfig({ ...ENABLED_ENV, CRM_EVENTS_ID_PREFIX: value });
      expect(config.errors).toEqual(['CRM_EVENTS_ID_PREFIX_invalid']);
      expect(config.id_prefix).toBeNull();
    }
    expect(readCrmEventsConfig({ ...ENABLED_ENV, CRM_EVENTS_ID_PREFIX: 'a'.repeat(16) }).errors).toEqual([]);
    expect(readCrmEventsConfig({ ...ENABLED_ENV, CRM_EVENTS_ID_PREFIX: 'dev2' }).id_prefix).toBe('dev2');
  });

  test('does not require the id prefix while disabled', () => {
    const config = readCrmEventsConfig({ CRM_EVENTS_ENABLED: 'false' });
    expect(config.enabled).toBe(false);
    expect(config.errors).toEqual([]);
  });

  test('rejects an unsupported protocol revision, an invalid URL and an invalid since', () => {
    const config = readCrmEventsConfig({
      ...ENABLED_ENV,
      CRM_EVENTS_URL: 'ftp://crm.example.test/x',
      CRM_EVENTS_SINCE: 'yesterday',
      CRM_EVENTS_PROTOCOL_REVISION: '1.3',
    });
    expect(config.errors).toEqual([
      'CRM_EVENTS_URL_invalid',
      'CRM_EVENTS_SINCE_invalid',
      'CRM_EVENTS_PROTOCOL_REVISION_unsupported:1.3',
    ]);
  });

  test('never exposes the secret in the returned configuration', () => {
    expect(JSON.stringify(readCrmEventsConfig(ENABLED_ENV))).not.toContain(SECRET);
  });
});

describe('normalizeCrmPhone and isValidCrmId', () => {
  test('prefixes stored digits with + and enforces 8–15 digits with a nonzero first digit', () => {
    expect(normalizeCrmPhone('56912345678')).toBe('+56912345678');
    expect(normalizeCrmPhone('+56 9 1234 5678')).toBe('+56912345678');
    expect(normalizeCrmPhone('12345678')).toBe('+12345678');
    expect(normalizeCrmPhone('1234567')).toBeNull();
    expect(normalizeCrmPhone('1234567890123456')).toBeNull();
    expect(normalizeCrmPhone('0912345678')).toBeNull();
    expect(normalizeCrmPhone('')).toBeNull();
    expect(normalizeCrmPhone(null)).toBeNull();
  });

  test('accepts 1–128 ASCII ids that start alphanumeric and use only . _ : -', () => {
    expect(isValidCrmId('wa-test-lead-42-r1')).toBe(true);
    expect(isValidCrmId('a')).toBe(true);
    expect(isValidCrmId('a'.repeat(128))).toBe(true);
    expect(isValidCrmId('a'.repeat(129))).toBe(false);
    expect(isValidCrmId('-lead')).toBe(false);
    expect(isValidCrmId('lead 1')).toBe(false);
    expect(isValidCrmId('leadñ')).toBe(false);
    expect(isValidCrmId('')).toBe(false);
  });
});

describe('buildLeadQualifiedEvent', () => {
  test('builds the exact envelope and data key set, in contract order', () => {
    const result = buildLeadQualifiedEvent(candidate(), BUILD_CONFIG);
    expect(result.blocked_reason).toBeNull();
    const parsed = JSON.parse(result.body);
    expect(Object.keys(parsed)).toEqual(['schema_version', 'protocol_revision', 'event_id', 'type', 'conversation_id', 'data']);
    expect(Object.keys(parsed.data)).toEqual(['lead_id', 'revision', 'phone', 'name', 'crm_seller_id', 'title', 'requirement']);
    expect(parsed).toEqual({
      schema_version: 1,
      protocol_revision: '1.1',
      event_id: 'wa-test-lead-42-r1',
      type: 'lead.qualified',
      conversation_id: 'wa-test-conversation-7',
      data: {
        lead_id: 'wa-test-lead-42',
        revision: 1,
        phone: '+56912345678',
        name: 'Juan Pérez',
        crm_seller_id: SELLER_UUID,
        title: 'Juan Pérez - instalacion - Santiago',
        requirement: '50 bloques de hormigón',
      },
    });
    expect(result.event_id).toBe('wa-test-lead-42-r1');
    expect(result.conversation_id).toBe('wa-test-conversation-7');
    expect(result.revision).toBe(1);
    expect(result.body).toBe(JSON.stringify(parsed));
  });

  test('every id carries the environment prefix', () => {
    const result = buildLeadQualifiedEvent(candidate(), { ...BUILD_CONFIG, id_prefix: 'prod' });
    const parsed = JSON.parse(result.body);
    expect(result.event_id).toBe('wa-prod-lead-42-r1');
    expect(result.conversation_id).toBe('wa-prod-conversation-7');
    expect(parsed.event_id).toBe('wa-prod-lead-42-r1');
    expect(parsed.conversation_id).toBe('wa-prod-conversation-7');
    expect(parsed.data.lead_id).toBe('wa-prod-lead-42');
  });

  test('two environments produce different ids for the same local lead', () => {
    const test = buildLeadQualifiedEvent(candidate(), { ...BUILD_CONFIG, id_prefix: 'test' });
    const prod = buildLeadQualifiedEvent(candidate(), { ...BUILD_CONFIG, id_prefix: 'prod' });
    expect(test.event_id).not.toBe(prod.event_id);
    expect(test.conversation_id).not.toBe(prod.conversation_id);
    expect(JSON.parse(test.body).data.lead_id).not.toBe(JSON.parse(prod.body).data.lead_id);
  });

  test('blocks when the id prefix is missing or invalid', () => {
    for (const idPrefix of [undefined, null, '', 'Prod', 'a'.repeat(17), 'pr-od']) {
      const blocked = buildLeadQualifiedEvent(candidate(), { protocol_revision: '1.1', id_prefix: idPrefix });
      expect(blocked).toMatchObject({ blocked_reason: 'id_prefix_missing', event_id: null, body: null });
    }
  });

  test('a correction carries the higher revision in event_id and data', () => {
    const parsed = JSON.parse(buildLeadQualifiedEvent(candidate({ revision: 3 }), BUILD_CONFIG).body);
    expect(parsed.event_id).toBe('wa-test-lead-42-r3');
    expect(parsed.data.revision).toBe(3);
  });

  test('sends rut only when the qualification holds a nonblank company_rut of at most 32 chars', () => {
    const withRut = JSON.parse(buildLeadQualifiedEvent(candidate({
      qualification_context: { company_rut: ' 76.123.456-7 ', rut: '11.111.111-1' },
    }), BUILD_CONFIG).body);
    expect(Object.keys(withRut.data)).toEqual(['lead_id', 'revision', 'phone', 'name', 'rut', 'crm_seller_id', 'title', 'requirement']);
    expect(withRut.data.rut).toBe('76.123.456-7');

    for (const qualification of [{}, { company_rut: '   ' }, { rut: '11.111.111-1' }, { company_rut: 'x'.repeat(33) }]) {
      const parsed = JSON.parse(buildLeadQualifiedEvent(candidate({ qualification_context: qualification }), BUILD_CONFIG).body);
      expect(parsed.data).not.toHaveProperty('rut');
    }
  });

  test('accepts the qualification context as a JSON string', () => {
    const parsed = JSON.parse(buildLeadQualifiedEvent(candidate({
      qualification_context: JSON.stringify({ company_rut: '76.123.456-7' }),
    }), BUILD_CONFIG).body);
    expect(parsed.data.rut).toBe('76.123.456-7');
  });

  test('falls back for a blank name, service, city and requirement', () => {
    const parsed = JSON.parse(buildLeadQualifiedEvent(candidate({
      whatsapp_name: '  ', service: null, city: '', requirement: null,
    }), BUILD_CONFIG).body);
    expect(parsed.data.name).toBe('Cliente WhatsApp');
    expect(parsed.data.title).toBe('Cliente WhatsApp - Sin Servicio - Sin Ciudad');
    expect(parsed.data.requirement).toBe('Sin requerimiento informado');
  });

  test('titles a factory pickup without a city as "retiro en fábrica"', () => {
    for (const overrides of [
      { service: 'retiro', city: null },
      { city: null, qualification_context: { modality: 'pickup' } },
      { city: null, qualification_context: { service_scope: 'material', fulfillment: 'pickup' } },
    ]) {
      const parsed = JSON.parse(buildLeadQualifiedEvent(candidate(overrides), BUILD_CONFIG).body);
      expect(parsed.data.title).toBe('Juan Pérez - retiro en fábrica');
    }
    const withCity = JSON.parse(buildLeadQualifiedEvent(candidate({ service: 'retiro', city: 'Talca' }), BUILD_CONFIG).body);
    expect(withCity.data.title).toBe('Juan Pérez - retiro - Talca');
  });

  test('caps name and title at 200 and requirement at 16,000 without splitting a surrogate pair', () => {
    const parsed = JSON.parse(buildLeadQualifiedEvent(candidate({
      whatsapp_name: `${'n'.repeat(199)}😀tail`,
      service: 's'.repeat(300),
      requirement: 'r'.repeat(20000),
    }), BUILD_CONFIG).body);
    expect(parsed.data.name).toBe('n'.repeat(199));
    expect(parsed.data.title.length).toBeLessThanOrEqual(200);
    expect(parsed.data.requirement.length).toBe(16000);
  });

  test('keeps the UTF-8 body within 65,536 bytes by shortening the requirement', () => {
    const result = buildLeadQualifiedEvent(candidate({ requirement: '\u0001'.repeat(16000) }), BUILD_CONFIG);
    expect(result.blocked_reason).toBeNull();
    expect(Buffer.byteLength(result.body, 'utf8')).toBeLessThanOrEqual(65536);
    expect(JSON.parse(result.body).data.requirement.length).toBeGreaterThan(0);
  });

  test('blocks instead of building an event the CRM would reject', () => {
    expect(buildLeadQualifiedEvent(candidate({ phone_number: '123' }), BUILD_CONFIG).blocked_reason).toBe('invalid_phone');
    expect(buildLeadQualifiedEvent(candidate({ crm_user_id: null }), BUILD_CONFIG).blocked_reason).toBe('seller_not_mapped');
    expect(buildLeadQualifiedEvent(candidate({ crm_user_id: 'not-a-uuid' }), BUILD_CONFIG).blocked_reason).toBe('invalid_seller_uuid');
    expect(buildLeadQualifiedEvent(candidate({ conversation_id: null }), BUILD_CONFIG).blocked_reason).toBe('conversation_missing');
    expect(buildLeadQualifiedEvent(candidate({ revision: 0 }), BUILD_CONFIG).blocked_reason).toBe('invalid_revision');
    const blocked = buildLeadQualifiedEvent(candidate({ phone_number: '123' }), BUILD_CONFIG);
    expect(blocked.body).toBeNull();
    expect(blocked.event_id).toBeNull();
  });
});

describe('signCrmRequest', () => {
  test('signs the ASCII timestamp, a dot and the raw body bytes', () => {
    const body = '{"a":"ñ"}';
    const timestamp = '1762819200';
    const expected = crypto.createHmac('sha256', SECRET)
      .update(Buffer.concat([Buffer.from(`${timestamp}.`, 'ascii'), Buffer.from(body, 'utf8')]))
      .digest('hex');
    const headers = signCrmRequest(body, SECRET, timestamp, crypto);
    expect(headers).toEqual({
      'X-WhatsApp-Timestamp': '1762819200',
      'X-WhatsApp-Signature': `v1=${expected}`,
    });
  });

  test('matches a fixed known vector', () => {
    // HMAC-SHA256("key", "1700000000.{}")
    const known = crypto.createHmac('sha256', 'key').update('1700000000.{}').digest('hex');
    expect(signCrmRequest('{}', 'key', 1700000000, crypto)['X-WhatsApp-Signature']).toBe(`v1=${known}`);
    expect(known).toMatch(/^[0-9a-f]{64}$/);
  });

  test('requires a 10-digit unix-seconds timestamp', () => {
    expect(() => signCrmRequest('{}', 'key', '170000000', crypto)).toThrow(/timestamp/);
    expect(() => signCrmRequest('{}', 'key', 1700000000123, crypto)).toThrow(/timestamp/);
  });
});

describe('classifyCrmResponse', () => {
  const okBody = { event_id: 'wa-test-lead-42-r1', crm_customer_id: CUSTOMER_UUID, crm_opportunity_id: OPPORTUNITY_UUID };

  test('a 200 with the matching result is delivered', () => {
    const outcome = classifyCrmResponse({ statusCode: 200, body: JSON.stringify(okBody) }, 'wa-test-lead-42-r1');
    expect(outcome).toMatchObject({
      outcome: 'delivered',
      http_status: 200,
      crm_customer_id: CUSTOMER_UUID,
      crm_opportunity_id: OPPORTUNITY_UUID,
      error: null,
    });
    expect(JSON.parse(outcome.response_json)).toEqual(okBody);
  });

  test('a 200 with a malformed or mismatched result is parked for reconciliation', () => {
    expect(classifyCrmResponse({ statusCode: 200, body: 'not json' }, 'wa-test-lead-42-r1')).toMatchObject({ outcome: 'parked', error: 'invalid_success_response' });
    expect(classifyCrmResponse({ statusCode: 200, body: { ...okBody, event_id: 'other' } }, 'wa-test-lead-42-r1')).toMatchObject({ outcome: 'parked', error: 'invalid_success_response' });
    expect(classifyCrmResponse({ statusCode: 200, body: { ...okBody, crm_customer_id: 'x' } }, 'wa-test-lead-42-r1')).toMatchObject({ outcome: 'parked' });
  });

  test.each([
    [400, 'invalid_event'],
    [401, 'unauthorized'],
    [409, 'event_conflict'],
    [409, 'identity_conflict'],
    [409, 'revision_conflict'],
    [413, 'payload_too_large'],
    [422, 'rut_required'],
    [422, 'invalid_seller'],
    [422, 'ambiguous_customer'],
    [422, 'invalid_opportunity'],
  ])('%i %s is parked without retry', (statusCode, code) => {
    const outcome = classifyCrmResponse({ statusCode, body: JSON.stringify({ error: code }) }, 'wa-test-lead-42-r1');
    expect(outcome.outcome).toBe('parked');
    expect(outcome.http_status).toBe(statusCode);
    expect(outcome.error).toBe(`http_${statusCode}:${code}`);
  });

  test.each([
    [503, 'receiver_unavailable'],
    [503, 'persistence_unavailable'],
    [502, null],
    [504, null],
    [500, null],
    [429, null],
    [408, null],
  ])('%i %s is retried', (statusCode, code) => {
    const body = code ? { error: code } : '<html>bad gateway</html>';
    const outcome = classifyCrmResponse({ statusCode, body }, 'wa-test-lead-42-r1');
    expect(outcome.outcome).toBe('retry');
    expect(outcome.error).toBe(`http_${statusCode}${code ? `:${code}` : ''}`);
  });

  test('a network error or timeout is retried', () => {
    const outcome = classifyCrmResponse({ error: new Error('ETIMEDOUT') }, 'wa-test-lead-42-r1');
    expect(outcome).toMatchObject({ outcome: 'retry', http_status: null, error: 'network_error:ETIMEDOUT' });
  });

  test('an unexpected status is parked', () => {
    expect(classifyCrmResponse({ statusCode: 404, body: '' }, 'x').outcome).toBe('parked');
    expect(classifyCrmResponse({ statusCode: 201, body: okBody }, 'x').outcome).toBe('parked');
  });

  test('never stores an oversized error body', () => {
    const outcome = classifyCrmResponse({ statusCode: 400, body: { error: 'invalid_event', detail: 'x'.repeat(20000) } }, 'x');
    expect(outcome.response_json === null || outcome.response_json.length <= 8192).toBe(true);
  });
});

describe('retryDelaySeconds', () => {
  test('grows exponentially from the base, capped, plus at most 20% jitter', () => {
    const settings = { base_seconds: 30, cap_seconds: 3600 };
    expect(retryDelaySeconds(1, settings, () => 0)).toBe(30);
    expect(retryDelaySeconds(2, settings, () => 0)).toBe(60);
    expect(retryDelaySeconds(5, settings, () => 0)).toBe(480);
    expect(retryDelaySeconds(30, settings, () => 0)).toBe(3600);
    expect(retryDelaySeconds(1, settings, () => 0.999999)).toBe(35);
    expect(retryDelaySeconds(30, settings, () => 0.999999)).toBe(4319);
    for (let attempt = 1; attempt <= 40; attempt += 1) {
      const delay = retryDelaySeconds(attempt, settings);
      const floor = Math.min(3600, 30 * 2 ** (attempt - 1));
      expect(delay).toBeGreaterThanOrEqual(floor);
      expect(delay).toBeLessThanOrEqual(Math.floor(floor * 1.2));
      expect(Number.isInteger(delay)).toBe(true);
    }
  });
});

describe('isClaimedCrmEvent', () => {
  test('ignores the { success: true } item n8n emits for an empty claim', () => {
    expect(isClaimedCrmEvent({ success: true })).toBe(false);
    expect(isClaimedCrmEvent({ crm_event_id: 1, claim_token: 'abc', body: '{}', event_id: 'e' })).toBe(true);
    expect(isClaimedCrmEvent({ crm_event_id: 1, claim_token: '', body: '{}', event_id: 'e' })).toBe(false);
  });
});

describe('Load CRM Events Config node', () => {
  test('returns no items while disabled', async () => {
    expect(await runNode('load-crm-events-config.js', [{ json: {} }], {})).toEqual([]);
  });

  test('fails the execution on misconfiguration, naming variables but never the secret', async () => {
    await expect(runNode('load-crm-events-config.js', [{ json: {} }], {
      ...ENABLED_ENV, CRM_EVENTS_PROTOCOL_REVISION: '2.0',
    })).rejects.toThrow(/CRM_EVENTS_PROTOCOL_REVISION_unsupported:2\.0/);
    await expect(runNode('load-crm-events-config.js', [{ json: {} }], {
      ...ENABLED_ENV, CRM_EVENTS_URL: '__PENDIENTE__',
    })).rejects.toThrow(/CRM_EVENTS_URL_missing/);
  });

  test('emits one configuration item when enabled', async () => {
    const out = await runNode('load-crm-events-config.js', [{ json: {} }], ENABLED_ENV);
    expect(out).toHaveLength(1);
    expect(out[0].json).toMatchObject({ since: '2026-11-11T00:00:00.000Z', enqueue_batch_size: 20 });
    expect(JSON.stringify(out)).not.toContain(SECRET);
  });
});

describe('Build Lead Qualified Events node', () => {
  test('builds events and blocked rows, ignoring the empty-result item', async () => {
    const out = await runNode('build-lead-qualified-events.js', [
      { json: { success: true } },
      { json: candidate() },
      { json: candidate({ lead_id: 43, phone_number: '1' }) },
    ], ENABLED_ENV);
    expect(out).toHaveLength(2);
    expect(out[0].json).toMatchObject({ lead_id: 42, revision: 1, event_id: 'wa-test-lead-42-r1', blocked_reason: null, requirement_snapshot: '50 bloques de hormigón' });
    expect(typeof out[0].json.body).toBe('string');
    expect(out[1].json).toMatchObject({ lead_id: 43, blocked_reason: 'invalid_phone', body: null });
  });

  test('the requirement snapshot is the raw stored requirement, not the fallback', async () => {
    const out = await runNode('build-lead-qualified-events.js', [{ json: candidate({ requirement: null }) }], ENABLED_ENV);
    expect(out[0].json.requirement_snapshot).toBe('');
  });

  test('builds nothing while disabled', async () => {
    expect(await runNode('build-lead-qualified-events.js', [{ json: candidate() }], {})).toEqual([]);
  });
});

describe('Deliver CRM Events node', () => {
  const claimed = (overrides = {}) => ({
    crm_event_id: 9,
    event_id: 'wa-test-lead-42-r1',
    claim_token: 'f7d1b8a2-0000-4000-8000-000000000001',
    attempt_count: 1,
    body: buildLeadQualifiedEvent(candidate(), BUILD_CONFIG).body,
    ...overrides,
  });

  test('POSTs the stored body string byte for byte with a fresh signature', async () => {
    const calls = [];
    const httpRequest = async (options) => {
      calls.push(options);
      return { statusCode: 200, body: JSON.stringify({ event_id: 'wa-test-lead-42-r1', crm_customer_id: CUSTOMER_UUID, crm_opportunity_id: OPPORTUNITY_UUID }) };
    };
    const item = claimed();
    const before = Math.floor(Date.now() / 1000);
    const out = await runNode('deliver-crm-events.js', [{ json: { success: true } }, { json: item }], ENABLED_ENV, { httpRequest });

    expect(calls).toHaveLength(1);
    const [request] = calls;
    expect(request.method).toBe('POST');
    expect(request.url).toBe(ENABLED_ENV.CRM_EVENTS_URL);
    expect(request.body).toBe(item.body);
    expect(request.json).toBe(false);
    expect(request.headers['Content-Type']).toBe('application/json');
    const timestamp = request.headers['X-WhatsApp-Timestamp'];
    expect(timestamp).toMatch(/^\d{10}$/);
    expect(Number(timestamp)).toBeGreaterThanOrEqual(before);
    const expected = crypto.createHmac('sha256', SECRET).update(`${timestamp}.${item.body}`, 'utf8').digest('hex');
    expect(request.headers['X-WhatsApp-Signature']).toBe(`v1=${expected}`);

    expect(out).toHaveLength(1);
    expect(out[0].json).toMatchObject({
      crm_event_id: 9,
      claim_token: item.claim_token,
      delivery_outcome: 'delivered',
      http_status: 200,
      crm_customer_id: CUSTOMER_UUID,
      crm_opportunity_id: OPPORTUNITY_UUID,
      retry_delay_seconds: null,
    });
    expect(JSON.stringify(out)).not.toContain(SECRET);
    expect(out[0].json).not.toHaveProperty('body');
  });

  test('schedules a retry with backoff on 503 and parks once attempts are exhausted', async () => {
    const httpRequest = async () => ({ statusCode: 503, body: JSON.stringify({ error: 'receiver_unavailable' }) });
    const [retry] = await runNode('deliver-crm-events.js', [{ json: claimed({ attempt_count: 2 }) }], ENABLED_ENV, { httpRequest });
    expect(retry.json.delivery_outcome).toBe('retry');
    expect(retry.json.retry_delay_seconds).toBeGreaterThanOrEqual(60);
    expect(retry.json.retry_delay_seconds).toBeLessThanOrEqual(72);

    const [parked] = await runNode('deliver-crm-events.js', [{ json: claimed({ attempt_count: 20 }) }], ENABLED_ENV, { httpRequest });
    expect(parked.json.delivery_outcome).toBe('parked');
    expect(parked.json.delivery_error).toBe('max_attempts_exhausted:http_503:receiver_unavailable');
  });

  test('a thrown transport error becomes a retry without leaking request details', async () => {
    const httpRequest = async () => { throw new Error('connect ECONNREFUSED'); };
    const [out] = await runNode('deliver-crm-events.js', [{ json: claimed() }], ENABLED_ENV, { httpRequest });
    expect(out.json.delivery_outcome).toBe('retry');
    expect(out.json.delivery_error).toBe('network_error:connect ECONNREFUSED');
  });

  test('sends nothing while disabled or misconfigured', async () => {
    const httpRequest = async () => { throw new Error('must not be called'); };
    expect(await runNode('deliver-crm-events.js', [{ json: claimed() }], {}, { httpRequest })).toEqual([]);
    await expect(runNode('deliver-crm-events.js', [{ json: claimed() }], { ...ENABLED_ENV, CRM_EVENTS_HMAC_SECRET: '' }, { httpRequest }))
      .rejects.toThrow(/CRM_EVENTS_HMAC_SECRET_missing/);
  });
});
