// =============================================================================
// CRM -> bot message.send (revision 1.2, after 1.2b): feature flag, the closed
// data key set, text rules, the Evolution request and the classification of its
// outcome, and the wiring of the crm-inbound-events workflow. The database side
// (implicit take, exactly-once intent, retries) is covered by
// tests/integration/crm-message-send.postgres.test.js.
// =============================================================================
import crypto from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { describe, expect, test } from 'vitest';

const require = createRequire(import.meta.url);
const fixtureDir = 'tests/fixtures/workflow-nodes/crm-inbound-events';
const {
  readCrmMessageSendConfig,
  verifyCrmInboundRequest,
  buildCrmEvolutionSendRequest,
  classifyCrmEvolutionResult,
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
const BASE_ENV = { CRM_INBOUND_ENABLED: 'true', CRM_INBOUND_HMAC_SECRET: SECRET };
const ENV = { ...BASE_ENV, CRM_INBOUND_MESSAGE_SEND_ENABLED: 'true', CRM_EVENTS_ID_PREFIX: 'dev' };
const NOW_MS = Date.UTC(2026, 10, 18, 15, 0, 0);
const NOW_S = Math.floor(NOW_MS / 1000);
const OPPORTUNITY = '66666666-7777-4888-9999-aaaaaaaaaaaa';
const SELLER = '6f1c2a34-5b6d-4e7f-8a9b-0c1d2e3f4a5b';
const CLIENT_MESSAGE = '0b6f7a1e-2c3d-4e5f-8a9b-1c2d3e4f5a6b';
const TEXT = 'Hola, le escribo de Hormiglass';

const sendEnvelope = (overrides = {}, dataOverrides = {}) => ({
  schema_version: 1,
  protocol_revision: '1.2',
  event_id: 'crm-evt-send-1',
  type: 'message.send',
  occurred_at: '2026-11-18T15:00:00Z',
  data: {
    crm_opportunity_id: OPPORTUNITY,
    crm_seller_id: SELLER,
    client_message_id: CLIENT_MESSAGE,
    ownership_version: 4,
    text: TEXT,
    ...dataOverrides,
  },
  ...overrides,
});

const sign = (raw, timestamp = String(NOW_S), secret = SECRET) => crypto
  .createHmac('sha256', secret)
  .update(Buffer.concat([Buffer.from(`${timestamp}.`, 'ascii'), Buffer.from(raw)]))
  .digest('hex');

const request = (body, { timestamp = String(NOW_S) } = {}) => {
  const raw = Buffer.from(typeof body === 'string' ? body : JSON.stringify(body), 'utf8');
  return { rawBody: raw, headers: { 'x-crm-timestamp': timestamp, 'x-crm-signature': `v1=${sign(raw, timestamp)}` } };
};

const verify = (req, env = ENV, now = NOW_MS) => verifyCrmInboundRequest({ ...req, env, now, crypto });

describe('message.send feature flag', () => {
  test('is off unless CRM_INBOUND_MESSAGE_SEND_ENABLED is exactly "true"', () => {
    expect(readCrmMessageSendConfig({}).enabled).toBe(false);
    expect(readCrmMessageSendConfig({ CRM_INBOUND_MESSAGE_SEND_ENABLED: 'TRUE' }).enabled).toBe(false);
    expect(readCrmMessageSendConfig(ENV)).toEqual({ enabled: true, id_prefix: 'dev', errors: [] });
  });

  test('enabled needs the CRM_EVENTS_ID_PREFIX that message ids are built with', () => {
    expect(readCrmMessageSendConfig({ CRM_INBOUND_MESSAGE_SEND_ENABLED: 'true' }).errors)
      .toEqual(['CRM_EVENTS_ID_PREFIX_missing']);
    expect(readCrmMessageSendConfig({ CRM_INBOUND_MESSAGE_SEND_ENABLED: 'true', CRM_EVENTS_ID_PREFIX: '__PENDIENTE__' }).errors)
      .toEqual(['CRM_EVENTS_ID_PREFIX_missing']);
    expect(readCrmMessageSendConfig({ CRM_INBOUND_MESSAGE_SEND_ENABLED: 'true', CRM_EVENTS_ID_PREFIX: 'Dev-1' }).errors)
      .toEqual(['CRM_EVENTS_ID_PREFIX_invalid']);
  });

  test('off keeps today\'s answer: 400 invalid_event, type not built', () => {
    const result = verify(request(sendEnvelope()), BASE_ENV);
    expect(result).toEqual({ action: 'respond', http_status: 400, response: { error: 'invalid_event', details: expect.arrayContaining(['envelope.type: unsupported']) } });
  });

  test('on with a bad id prefix answers 503 for message.send only', () => {
    const env = { ...ENV, CRM_EVENTS_ID_PREFIX: '' };
    expect(verify(request(sendEnvelope()), env)).toEqual({ action: 'respond', http_status: 503, response: { error: 'receiver_unavailable' } });
    const take = sendEnvelope({ type: 'chat.take', data: { crm_opportunity_id: OPPORTUNITY, crm_seller_id: SELLER, ownership_version: 0 } });
    expect(verify(request(take), env).action).toBe('apply');
  });

  test('the receiver switch still comes first', () => {
    expect(verify(request(sendEnvelope()), { CRM_INBOUND_MESSAGE_SEND_ENABLED: 'true', CRM_EVENTS_ID_PREFIX: 'dev' }))
      .toEqual({ action: 'respond', http_status: 503, response: { error: 'receiver_unavailable' } });
  });
});

describe('message.send validation', () => {
  test('a valid signed message.send becomes a send action with the body hash and trimmed text', () => {
    const req = request(sendEnvelope({}, { text: `  ${TEXT}\n`, crm_seller_id: SELLER.toUpperCase() }));
    expect(verify(req)).toEqual({
      action: 'send',
      event_id: 'crm-evt-send-1',
      event_type: 'message.send',
      body_sha256: crypto.createHash('sha256').update(req.rawBody).digest('hex'),
      crm_opportunity_id: OPPORTUNITY,
      crm_seller_id: SELLER,
      client_message_id: CLIENT_MESSAGE,
      ownership_version: '4',
      text: TEXT,
    });
  });

  test('4,096 characters are accepted, counted as characters, not UTF-16 units', () => {
    expect(verify(request(sendEnvelope({}, { text: 'a'.repeat(4096) }))).action).toBe('send');
    expect(verify(request(sendEnvelope({}, { text: '😀'.repeat(4096) }))).action).toBe('send');
  });

  test.each([
    ['unknown data field', { note: 'x' }, 'data.note: unknown'],
    ['missing text', { text: undefined }, 'data.text'],
    ['empty text', { text: '' }, 'data.text'],
    ['whitespace-only text', { text: ' \n\t ' }, 'data.text'],
    ['text over 4,096 characters', { text: 'a'.repeat(4097) }, 'data.text'],
    ['text with NUL', { text: 'a\u0000b' }, 'data.text'],
    ['text not a string', { text: 42 }, 'data.text'],
    ['missing client_message_id', { client_message_id: undefined }, 'data.client_message_id'],
    ['bad client_message_id', { client_message_id: 'msg-1' }, 'data.client_message_id'],
    ['bad opportunity', { crm_opportunity_id: 'opp' }, 'data.crm_opportunity_id'],
    ['bad seller', { crm_seller_id: null }, 'data.crm_seller_id'],
    ['negative version', { ownership_version: -1 }, 'data.ownership_version'],
    ['string version', { ownership_version: '4' }, 'data.ownership_version'],
  ])('%s answers 400 invalid_event naming the field', (_label, data, detail) => {
    const body = sendEnvelope();
    for (const [key, value] of Object.entries(data)) {
      if (value === undefined) delete body.data[key];
      else body.data[key] = value;
    }
    const result = verify(request(body));
    expect(result).toMatchObject({ action: 'respond', http_status: 400, response: { error: 'invalid_event' } });
    expect(result.response.details).toContain(detail);
  });

  test('chat.take keeps its own closed key set when message.send is on', () => {
    const take = sendEnvelope({ type: 'chat.take' });
    const result = verify(request(take));
    expect(result.response.details).toEqual(expect.arrayContaining(['data.client_message_id: unknown', 'data.text: unknown']));
  });

  test('details name fields, never values', () => {
    const secretText = 'texto-que-no-debe-volver';
    const result = verify(request(sendEnvelope({}, { text: `${secretText}${'x'.repeat(5000)}`, extra: secretText })));
    expect(JSON.stringify(result)).not.toContain(secretText);
  });
});

describe('buildCrmEvolutionSendRequest', () => {
  const EVOLUTION = { EVOLUTION_API_BASE_URL: 'http://evolution:8080/', EVOLUTION_API_KEY: 'evo-key', EVOLUTION_DEFAULT_INSTANCE: 'fallback' };
  const claim = { outbound_id: '7', attempt: 1, phone_number: '56912345678', instance_name: 'wahormiglass', text_body: TEXT };

  test('builds the same sendText request the bot uses', () => {
    expect(buildCrmEvolutionSendRequest(claim, EVOLUTION)).toEqual({
      ok: true,
      url: 'http://evolution:8080/message/sendText/wahormiglass',
      api_key: 'evo-key',
      body: { number: '56912345678', text: TEXT, delay: 0, linkPreview: false },
    });
  });

  test('falls back to EVOLUTION_DEFAULT_INSTANCE', () => {
    expect(buildCrmEvolutionSendRequest({ ...claim, instance_name: null }, EVOLUTION).url)
      .toBe('http://evolution:8080/message/sendText/fallback');
  });

  test.each([
    ['no base url', { ...EVOLUTION, EVOLUTION_API_BASE_URL: '' }, claim],
    ['no api key', { ...EVOLUTION, EVOLUTION_API_KEY: '' }, claim],
    ['no instance', { ...EVOLUTION, EVOLUTION_DEFAULT_INSTANCE: '' }, { ...claim, instance_name: '' }],
    ['no phone', EVOLUTION, { ...claim, phone_number: '' }],
    ['no text', EVOLUTION, { ...claim, text_body: '' }],
  ])('%s is a definite failure, nothing is sent', (_label, env, row) => {
    expect(buildCrmEvolutionSendRequest(row, env)).toMatchObject({ ok: false });
  });
});

describe('classifyCrmEvolutionResult', () => {
  test('2xx is sent with the provider message id', () => {
    expect(classifyCrmEvolutionResult({ statusCode: 201, body: { key: { id: 'BAE5ABC' } } }))
      .toEqual({ outcome: 'sent', provider_message_id: 'BAE5ABC', provider_status: 201, error: null });
    expect(classifyCrmEvolutionResult({ statusCode: 200, body: { data: { key: { id: 'BAE5DEF' } } } }).provider_message_id)
      .toBe('BAE5DEF');
  });

  test('4xx is a definite failure', () => {
    expect(classifyCrmEvolutionResult({ statusCode: 400, body: { message: 'bad number' } }))
      .toMatchObject({ outcome: 'failed', provider_status: 400 });
  });

  test('a disconnected WhatsApp (500 Connection Closed) is a definite failure', () => {
    expect(classifyCrmEvolutionResult({ statusCode: 500, body: { response: { message: ['Error: Connection Closed'] } } }).outcome)
      .toBe('failed');
  });

  test('any other 5xx is an unknown outcome: never resent automatically', () => {
    expect(classifyCrmEvolutionResult({ statusCode: 502, body: {} }).outcome).toBe('unknown');
  });

  test('a refused or unresolved connection is a definite failure', () => {
    expect(classifyCrmEvolutionResult({ error: { code: 'ECONNREFUSED', message: 'connect ECONNREFUSED' } }).outcome).toBe('failed');
    expect(classifyCrmEvolutionResult({ error: { code: 'ENOTFOUND', message: 'getaddrinfo' } }).outcome).toBe('failed');
  });

  test('a timeout or reset is an unknown outcome', () => {
    expect(classifyCrmEvolutionResult({ error: { code: 'ETIMEDOUT', message: 'timeout' } }).outcome).toBe('unknown');
    expect(classifyCrmEvolutionResult({ error: { code: 'ECONNRESET', message: 'socket hang up' } }).outcome).toBe('unknown');
    expect(classifyCrmEvolutionResult({ error: { message: 'something odd' } }).outcome).toBe('unknown');
  });

  test('the stored error is bounded and carries no api key', () => {
    const result = classifyCrmEvolutionResult({ statusCode: 400, body: { message: 'x'.repeat(5000) } });
    expect(result.error.length).toBeLessThanOrEqual(500);
  });
});

describe('Send CRM Message node', () => {
  const EVOLUTION = { ...ENV, EVOLUTION_API_BASE_URL: 'http://evolution:8080', EVOLUTION_API_KEY: 'evo-key' };
  const claim = { send: true, outbound_id: '7', attempt: 2, phone_number: '56912345678', instance_name: 'wahormiglass', text_body: TEXT };

  test('posts once to Evolution and reports a sent outcome for completion', async () => {
    const calls = [];
    const helpers = { httpRequest: async (options) => { calls.push(options); return { statusCode: 201, body: { key: { id: 'BAE5ABC' } } }; } };
    const [out] = await runNode('send-crm-message.js', [{ json: claim }], EVOLUTION, helpers);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      method: 'POST',
      url: 'http://evolution:8080/message/sendText/wahormiglass',
      headers: { apikey: 'evo-key', 'Content-Type': 'application/json' },
      body: { number: '56912345678', text: TEXT, delay: 0, linkPreview: false },
      json: true,
      returnFullResponse: true,
      ignoreHttpStatusErrors: true,
    });
    expect(out.json).toEqual({
      outbound_id: '7', attempt: '2', outcome: 'sent', provider_message_id: 'BAE5ABC',
      provider_status: '201', error: '', id_prefix: 'dev',
    });
    expect(JSON.stringify(out.json)).not.toContain('evo-key');
  });

  test('a thrown request error becomes an outcome, never a node failure', async () => {
    const helpers = { httpRequest: async () => { const error = new Error('connect ECONNREFUSED'); error.code = 'ECONNREFUSED'; throw error; } };
    const [out] = await runNode('send-crm-message.js', [{ json: claim }], EVOLUTION, helpers);
    expect(out.json).toMatchObject({ outcome: 'failed', provider_message_id: '' });
  });

  test('missing Evolution configuration fails without calling it', async () => {
    let called = false;
    const helpers = { httpRequest: async () => { called = true; return {}; } };
    const [out] = await runNode('send-crm-message.js', [{ json: claim }], { ...ENV }, helpers);
    expect(called).toBe(false);
    expect(out.json.outcome).toBe('failed');
  });
});

describe('crm-inbound-events workflow wiring', () => {
  const workflow = JSON.parse(fs.readFileSync('n8n/workflows/crm-inbound-events.json', 'utf8'));
  const node = (name) => workflow.nodes.find((n) => n.name === name);
  const targets = (name, index = 0) => (workflow.connections[name]?.main?.[index] ?? []).map((c) => c.node);

  test('message.send runs claim -> Evolution -> completion before the single Respond node', () => {
    expect(targets('Is Chat Event To Apply', 0)).toEqual(['Apply CRM Chat Event']);
    expect(targets('Is Chat Event To Apply', 1)).toEqual(['Is Message Send To Claim']);
    expect(targets('Is Message Send To Claim', 0)).toEqual(['Claim CRM Message Send']);
    expect(targets('Is Message Send To Claim', 1)).toEqual(['Build CRM Event Response']);
    expect(targets('Claim CRM Message Send')).toEqual(['Should Send CRM Message']);
    expect(targets('Should Send CRM Message', 0)).toEqual(['Send CRM Message']);
    expect(targets('Should Send CRM Message', 1)).toEqual(['Build CRM Event Response']);
    expect(targets('Send CRM Message')).toEqual(['Complete CRM Message Send']);
    expect(targets('Complete CRM Message Send')).toEqual(['Build CRM Event Response']);
    expect(targets('Build CRM Event Response')).toEqual(['Respond CRM Event']);
  });

  test('both database nodes continue on error so a failure answers 503', () => {
    for (const name of ['Claim CRM Message Send', 'Complete CRM Message Send']) {
      expect(node(name)).toMatchObject({ type: 'n8n-nodes-base.postgres', onError: 'continueRegularOutput' });
      expect(node(name).credentials).toEqual(node('Apply CRM Chat Event').credentials);
    }
  });

  test('the IF nodes route on the verified action and the claim result', () => {
    expect(JSON.stringify(node('Is Message Send To Claim').parameters)).toContain("$json.action === 'send'");
    expect(JSON.stringify(node('Should Send CRM Message').parameters)).toContain('$json.send === true');
  });

  test('settings are unchanged: no error workflow, 60 s timeout', () => {
    expect(workflow.settings).toEqual({ executionOrder: 'v1', executionTimeout: 60 });
  });
});

describe('message.send flag wiring', () => {
  test.each(['docker-compose.yml', 'docker-compose.test.yml'])('%s passes the flag to n8n, off by default', (file) => {
    const compose = fs.readFileSync(file, 'utf8');
    expect(compose).toMatch(/CRM_INBOUND_MESSAGE_SEND_ENABLED: \$\{(TEST_)?CRM_INBOUND_MESSAGE_SEND_ENABLED:-false\}/);
  });
});
