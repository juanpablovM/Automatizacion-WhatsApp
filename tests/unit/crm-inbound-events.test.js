// =============================================================================
// CRM -> bot webhook (revision 1.2b): signature, size, envelope and data
// validation of POST /webhook/crm-events, and the response shaping of the
// crm-inbound-events workflow. The database side (idempotency inbox, take and
// release) is covered by tests/integration/crm-ownership-1-2b.postgres.test.js.
// =============================================================================
import crypto from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { describe, expect, test } from 'vitest';

const require = createRequire(import.meta.url);
const fixtureDir = 'tests/fixtures/workflow-nodes/crm-inbound-events';
const {
  readCrmInboundConfig,
  verifyCrmInboundRequest,
  shapeCrmInboundResponse,
} = require('../fixtures/workflow-nodes/crm-inbound-events/crm-inbound-runtime.js');

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const runtime = fs.readFileSync(`${fixtureDir}/crm-inbound-runtime.js`, 'utf8');
const nodeSource = (fixture) => `${runtime}\n\n${fs.readFileSync(`${fixtureDir}/${fixture}`, 'utf8')}`;
const requireCrypto = (name) => {
  if (name !== 'crypto') throw new Error(`unexpected require: ${name}`);
  return crypto;
};
const runNode = (fixture, items, env = {}, helpers = {}) =>
  new AsyncFunction('items', '$env', 'helpers', 'require', nodeSource(fixture))(items, env, helpers, requireCrypto);

const SECRET = 'crm-inbound-test-secret';
const ENV = { CRM_INBOUND_ENABLED: 'true', CRM_INBOUND_HMAC_SECRET: SECRET };
const NOW_MS = Date.UTC(2026, 10, 11, 15, 0, 0);
const NOW_S = Math.floor(NOW_MS / 1000);
const OPPORTUNITY = '66666666-7777-4888-9999-aaaaaaaaaaaa';
const SELLER = '6f1c2a34-5b6d-4e7f-8a9b-0c1d2e3f4a5b';

const envelope = (overrides = {}, dataOverrides = {}) => ({
  schema_version: 1,
  protocol_revision: '1.2',
  event_id: 'crm-evt-1',
  type: 'chat.take',
  occurred_at: '2026-11-11T15:00:00Z',
  data: { crm_opportunity_id: OPPORTUNITY, crm_seller_id: SELLER, ownership_version: 0, ...dataOverrides },
  ...overrides,
});

const sign = (raw, timestamp = String(NOW_S), secret = SECRET) => crypto
  .createHmac('sha256', secret)
  .update(Buffer.concat([Buffer.from(`${timestamp}.`, 'ascii'), Buffer.from(raw)]))
  .digest('hex');

const request = (body, { timestamp = String(NOW_S), signature, headers = {} } = {}) => {
  const raw = Buffer.isBuffer(body) ? body : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body), 'utf8');
  return {
    rawBody: raw,
    headers: {
      'x-crm-timestamp': timestamp,
      'x-crm-signature': signature ?? `v1=${sign(raw, timestamp)}`,
      ...headers,
    },
  };
};

const verify = (req, env = ENV, now = NOW_MS) => verifyCrmInboundRequest({ ...req, env, now, crypto });

describe('CRM inbound config', () => {
  test('is disabled unless CRM_INBOUND_ENABLED is exactly "true"', () => {
    expect(readCrmInboundConfig({}).enabled).toBe(false);
    expect(readCrmInboundConfig({ CRM_INBOUND_ENABLED: 'TRUE' }).enabled).toBe(false);
    expect(readCrmInboundConfig(ENV)).toEqual({ enabled: true, errors: [] });
  });

  test('a missing or placeholder secret is a configuration error, never echoed', () => {
    const config = readCrmInboundConfig({ CRM_INBOUND_ENABLED: 'true', CRM_INBOUND_HMAC_SECRET: '__PENDIENTE__' });
    expect(config.errors).toEqual(['CRM_INBOUND_HMAC_SECRET_missing']);
    expect(JSON.stringify(config)).not.toContain('PENDIENTE');
  });

  test('the outbound secret is never accepted as the inbound one', () => {
    const config = readCrmInboundConfig({ ...ENV, CRM_EVENTS_HMAC_SECRET: SECRET });
    expect(config.errors).toEqual(['CRM_INBOUND_HMAC_SECRET_reused']);
  });
});

describe('verifyCrmInboundRequest', () => {
  test('a valid signed chat.take becomes an apply action with the body hash', () => {
    const req = request(envelope());
    const result = verify(req);
    expect(result).toEqual({
      action: 'apply',
      event_id: 'crm-evt-1',
      event_type: 'chat.take',
      body_sha256: crypto.createHash('sha256').update(req.rawBody).digest('hex'),
      crm_opportunity_id: OPPORTUNITY,
      crm_seller_id: SELLER,
      ownership_version: '0',
    });
  });

  test('chat.release is accepted with the same data shape', () => {
    const result = verify(request(envelope({ type: 'chat.release' }, { ownership_version: 7 })));
    expect(result).toMatchObject({ action: 'apply', event_type: 'chat.release', ownership_version: '7' });
  });

  test('uuids are normalized to lowercase', () => {
    const result = verify(request(envelope({}, { crm_seller_id: SELLER.toUpperCase() })));
    expect(result.crm_seller_id).toBe(SELLER);
  });

  test('disabled answers 503 receiver_unavailable before anything else', () => {
    const result = verify(request(envelope()), {});
    expect(result).toEqual({ action: 'respond', http_status: 503, response: { error: 'receiver_unavailable' } });
  });

  test('enabled without a secret answers 503 and never names the secret value', () => {
    const result = verify(request(envelope()), { CRM_INBOUND_ENABLED: 'true' });
    expect(result).toEqual({ action: 'respond', http_status: 503, response: { error: 'receiver_unavailable' } });
  });

  test('a body over 65,536 bytes answers 413 payload_too_large', () => {
    const big = Buffer.alloc(65537, 0x20);
    const result = verify(request(big));
    expect(result).toEqual({ action: 'respond', http_status: 413, response: { error: 'payload_too_large' } });
  });

  test('a body of exactly 65,536 bytes is not rejected for size', () => {
    const base = JSON.stringify(envelope());
    const padded = base + ' '.repeat(65536 - Buffer.byteLength(base));
    const result = verify(request(padded));
    expect(result.action).toBe('apply');
  });

  test.each([
    ['missing signature', { signature: '' }],
    ['wrong scheme', { signature: `v2=${'a'.repeat(64)}` }],
    ['uppercase hex', { signature: `v1=${'A'.repeat(64)}` }],
    ['wrong secret', { signature: `v1=${sign(Buffer.from(JSON.stringify(envelope())), String(NOW_S), 'other')}` }],
    ['missing timestamp', { timestamp: '' }],
    ['non-10-digit timestamp', { timestamp: `${NOW_S}000` }],
    ['stale timestamp', { timestamp: String(NOW_S - 301) }],
    ['future timestamp', { timestamp: String(NOW_S + 301) }],
  ])('%s answers 401 unauthorized', (_label, options) => {
    const result = verify(request(envelope(), options));
    expect(result).toEqual({ action: 'respond', http_status: 401, response: { error: 'unauthorized' } });
  });

  test('a timestamp exactly 300 s away is accepted', () => {
    expect(verify(request(envelope(), { timestamp: String(NOW_S - 300) })).action).toBe('apply');
    expect(verify(request(envelope(), { timestamp: String(NOW_S + 300) })).action).toBe('apply');
  });

  test('the signature covers the raw bytes, not a re-serialization', () => {
    const raw = `{"schema_version":1,  "protocol_revision":"1.2","event_id":"crm-evt-1","type":"chat.take","occurred_at":"2026-11-11T15:00:00Z","data":{"crm_opportunity_id":"${OPPORTUNITY}","crm_seller_id":"${SELLER}","ownership_version":0}}`;
    expect(verify(request(raw)).action).toBe('apply');
    const reserialized = JSON.stringify(JSON.parse(raw));
    expect(verify(request(raw, { signature: `v1=${sign(Buffer.from(reserialized))}` })).http_status).toBe(401);
  });

  test('a signed body that is not JSON answers 400 invalid_event', () => {
    const result = verify(request('not json'));
    expect(result).toMatchObject({ action: 'respond', http_status: 400, response: { error: 'invalid_event' } });
  });

  test('invalid UTF-8 answers 400 invalid_event', () => {
    const result = verify(request(Buffer.from([0x7b, 0xff, 0x7d])));
    expect(result).toMatchObject({ http_status: 400, response: { error: 'invalid_event' } });
  });

  test.each([
    ['unknown top-level field', envelope({ extra: true })],
    ['missing occurred_at', (() => { const e = envelope(); delete e.occurred_at; return e; })()],
    ['schema_version 2', envelope({ schema_version: 2 })],
    ['protocol_revision 1.1', envelope({ protocol_revision: '1.1' })],
    ['bad event_id', envelope({ event_id: '-starts-with-dash' })],
    ['event_id too long', envelope({ event_id: `a${'b'.repeat(128)}` })],
    ['occurred_at with offset', envelope({ occurred_at: '2026-11-11T12:00:00-03:00' })],
    ['occurred_at not a date', envelope({ occurred_at: '2026-13-41T00:00:00Z' })],
    ['data not an object', envelope({ data: [] })],
    ['unknown data field', envelope({}, { note: 'x' })],
    ['missing crm_seller_id', (() => { const e = envelope(); delete e.data.crm_seller_id; return e; })()],
    ['bad opportunity uuid', envelope({}, { crm_opportunity_id: 'opp-1' })],
    ['bad seller uuid', envelope({}, { crm_seller_id: null })],
    ['negative version', envelope({}, { ownership_version: -1 })],
    ['fractional version', envelope({}, { ownership_version: 1.5 })],
    ['string version', envelope({}, { ownership_version: '1' })],
    ['unsafe integer version', envelope({}, { ownership_version: 2 ** 53 })],
    ['body is an array', [envelope()]],
  ])('%s answers 400 invalid_event', (_label, body) => {
    const result = verify(request(body));
    expect(result).toMatchObject({ action: 'respond', http_status: 400, response: { error: 'invalid_event' } });
  });

  test.each([
    'opportunity.quote_sent', 'opportunity.closed', 'opportunity.reopened',
    'handoff.acknowledged', 'handoff.resolved', 'message.send', 'chat.unknown',
  ])('type %s is not implemented yet and answers 400 invalid_event', (type) => {
    const result = verify(request(envelope({ type })));
    expect(result).toMatchObject({ http_status: 400, response: { error: 'invalid_event' } });
  });

  test('nothing in any result carries the secret or the raw body', () => {
    const req = request(envelope());
    for (const result of [verify(req), verify(request('not json')), verify(req, {})]) {
      const text = JSON.stringify(result);
      expect(text).not.toContain(SECRET);
      expect(text).not.toContain('schema_version');
    }
  });
});

describe('shapeCrmInboundResponse', () => {
  test('passes a validation response through', () => {
    expect(shapeCrmInboundResponse({ action: 'respond', http_status: 401, response: { error: 'unauthorized' } }))
      .toEqual({ http_status: 401, response_body: { error: 'unauthorized' } });
  });

  test('passes a database result through', () => {
    const row = { http_status: 200, response: { event_id: 'e', result: 'applied', ownership_version: 3 }, replayed: false };
    expect(shapeCrmInboundResponse(row)).toEqual({ http_status: 200, response_body: row.response });
  });

  test('parses a database response that arrives as text', () => {
    const row = { http_status: 409, response: '{"error":"event_conflict","event_id":"e"}' };
    expect(shapeCrmInboundResponse(row)).toEqual({ http_status: 409, response_body: { error: 'event_conflict', event_id: 'e' } });
  });

  test('a database failure answers 503 so the CRM retries', () => {
    expect(shapeCrmInboundResponse({ error: 'connection refused' }))
      .toEqual({ http_status: 503, response_body: { error: 'receiver_unavailable' } });
    expect(shapeCrmInboundResponse({})).toEqual({ http_status: 503, response_body: { error: 'receiver_unavailable' } });
  });
});

describe('Verify CRM Event node', () => {
  const binaryOf = (raw) => ({ data: { data: raw.toString('base64'), mimeType: 'application/json' } });
  // The node checks the timestamp against the real clock.
  const liveRequest = () => request(envelope(), { timestamp: String(Math.floor(Date.now() / 1000)) });

  test('reads the raw bytes from the webhook binary property', async () => {
    const req = liveRequest();
    const [out] = await runNode('verify-crm-inbound-event.js', [
      { json: { headers: req.headers, body: JSON.parse(req.rawBody.toString()) }, binary: binaryOf(req.rawBody) },
    ], ENV);
    expect(out.json).toMatchObject({ action: 'apply', event_id: 'crm-evt-1' });
    expect(out.binary).toBeUndefined();
  });

  test('reads filesystem-mode binary through helpers.getBinaryDataBuffer', async () => {
    const req = liveRequest();
    const helpers = { getBinaryDataBuffer: async (index, property) => (index === 0 && property === 'data' ? req.rawBody : null) };
    const [out] = await runNode('verify-crm-inbound-event.js', [
      { json: { headers: req.headers }, binary: { data: { id: 'filesystem-v2:abc', mimeType: 'application/json' } } },
    ], ENV, helpers);
    expect(out.json.action).toBe('apply');
  });

  test('without raw bytes it refuses to verify a re-serialized body', async () => {
    const req = liveRequest();
    const [out] = await runNode('verify-crm-inbound-event.js', [
      { json: { headers: req.headers, body: JSON.parse(req.rawBody.toString()) } },
    ], ENV);
    expect(out.json).toEqual({ action: 'respond', http_status: 401, response: { error: 'unauthorized' } });
  });

  test('uses Date.now for the timestamp window', async () => {
    const timestamp = String(Math.floor(Date.now() / 1000));
    const req = request(envelope(), { timestamp });
    const [out] = await runNode('verify-crm-inbound-event.js', [
      { json: { headers: req.headers }, binary: binaryOf(req.rawBody) },
    ], ENV);
    expect(out.json.action).toBe('apply');
  });
});

describe('Build CRM Event Response node', () => {
  test('shapes one item for the Respond node', async () => {
    const [out] = await runNode('build-crm-inbound-response.js', [
      { json: { http_status: 200, response: { event_id: 'e', result: 'ignored_stale', ownership_version: 4 } } },
    ]);
    expect(out.json).toEqual({ http_status: 200, response_body: { event_id: 'e', result: 'ignored_stale', ownership_version: 4 } });
  });
});
