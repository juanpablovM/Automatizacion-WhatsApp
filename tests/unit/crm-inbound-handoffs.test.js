// =============================================================================
// CRM -> bot 1.2d (contingency handoffs): the CRM_INBOUND_HANDOFFS_ENABLED
// flag, the conversation_id identity of chat.take / chat.release /
// message.send, the handoff.acknowledged / handoff.resolved envelopes and the
// workflow wiring of their branches. The database side (conversation
// resolution, ownership, closure transitions, inbox) is covered by
// tests/integration/crm-inbound-handoffs.postgres.test.js.
// Feature document: odd/tasks/crm-1-2d-contingency-handoffs.md (S5-S7).
// =============================================================================
import crypto from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { describe, expect, test } from 'vitest';

const require = createRequire(import.meta.url);
const {
  readCrmHandoffsConfig,
  verifyCrmInboundRequest,
} = require('../fixtures/workflow-nodes/crm-inbound-events/crm-inbound-runtime.js');

const SECRET = 'crm-inbound-test-secret';
const BASE_ENV = { CRM_INBOUND_ENABLED: 'true', CRM_INBOUND_HMAC_SECRET: SECRET, CRM_EVENTS_ID_PREFIX: 'dev' };
const SEND_ENV = { ...BASE_ENV, CRM_INBOUND_MESSAGE_SEND_ENABLED: 'true' };
const ENV = { ...SEND_ENV, CRM_INBOUND_HANDOFFS_ENABLED: 'true' };
const NOW_MS = Date.UTC(2026, 10, 25, 15, 0, 0);
const NOW_S = Math.floor(NOW_MS / 1000);
const OPPORTUNITY = '66666666-7777-4888-9999-aaaaaaaaaaaa';
const SELLER = '6f1c2a34-5b6d-4e7f-8a9b-0c1d2e3f4a5b';
const CLIENT_MESSAGE = '0b6f7a1e-2c3d-4e5f-8a9b-1c2d3e4f5a6b';
const CONVERSATION = 'wa-dev-conversation-42';
const HANDOFF = 'wa-dev-handoff-7';

const envelope = (type, data, overrides = {}) => ({
  schema_version: 1,
  protocol_revision: '1.2',
  event_id: 'crm-evt-1',
  type,
  occurred_at: '2026-11-25T15:00:00Z',
  data,
  ...overrides,
});
const chat = (data = {}, type = 'chat.take') => envelope(type, { crm_seller_id: SELLER, ownership_version: 3, ...data });
const send = (data = {}) => envelope('message.send', {
  crm_seller_id: SELLER, client_message_id: CLIENT_MESSAGE, ownership_version: 3, text: '  Hola  ', ...data,
});
const closure = (type = 'handoff.acknowledged', data = {}) => envelope(type, { handoff_id: HANDOFF, crm_seller_id: SELLER, ...data });

const sign = (raw, timestamp = String(NOW_S)) => crypto
  .createHmac('sha256', SECRET)
  .update(Buffer.concat([Buffer.from(`${timestamp}.`, 'ascii'), Buffer.from(raw)]))
  .digest('hex');
const request = (body) => {
  const raw = Buffer.from(JSON.stringify(body), 'utf8');
  return { rawBody: raw, headers: { 'x-crm-timestamp': String(NOW_S), 'x-crm-signature': `v1=${sign(raw)}` } };
};
const sha = (body) => crypto.createHash('sha256').update(Buffer.from(JSON.stringify(body), 'utf8')).digest('hex');
const verify = (body, env = ENV) => verifyCrmInboundRequest({ ...request(body), env, now: NOW_MS, crypto });
const invalid = (detail) => ({
  action: 'respond', http_status: 400, response: { error: 'invalid_event', details: expect.arrayContaining([detail]) },
});

describe('CRM_INBOUND_HANDOFFS_ENABLED', () => {
  test('is off unless exactly "true", and on needs a valid CRM_EVENTS_ID_PREFIX', () => {
    expect(readCrmHandoffsConfig({}).enabled).toBe(false);
    expect(readCrmHandoffsConfig({ CRM_INBOUND_HANDOFFS_ENABLED: 'TRUE' }).enabled).toBe(false);
    expect(readCrmHandoffsConfig(ENV)).toEqual({ enabled: true, id_prefix: 'dev', errors: [] });
    expect(readCrmHandoffsConfig({ CRM_INBOUND_HANDOFFS_ENABLED: 'true' }).errors).toEqual(['CRM_EVENTS_ID_PREFIX_missing']);
    expect(readCrmHandoffsConfig({ CRM_INBOUND_HANDOFFS_ENABLED: 'true', CRM_EVENTS_ID_PREFIX: 'Dev-1' }).errors)
      .toEqual(['CRM_EVENTS_ID_PREFIX_invalid']);
  });

  test.each([
    ['chat.take with conversation_id', chat({ conversation_id: CONVERSATION })],
    ['chat.release with conversation_id', chat({ conversation_id: CONVERSATION }, 'chat.release')],
    ['message.send with conversation_id', send({ conversation_id: CONVERSATION })],
    ['handoff.acknowledged', closure('handoff.acknowledged')],
    ['handoff.resolved', closure('handoff.resolved')],
  ])('off: %s answers exactly what it answers today', (_name, body) => {
    const off = verify(body, SEND_ENV);
    expect(off.http_status).toBe(400);
    expect(off.response.error).toBe('invalid_event');
    // The same details the receiver gave before the flag existed.
    expect(verify(body, { ...SEND_ENV, CRM_INBOUND_HANDOFFS_ENABLED: 'false' })).toEqual(off);
  });

  test('off: the opportunity identity is unchanged', () => {
    expect(verify(chat({ crm_opportunity_id: OPPORTUNITY }), SEND_ENV).action).toBe('apply');
    expect(verify(send({ crm_opportunity_id: OPPORTUNITY }), SEND_ENV).action).toBe('send');
  });

  test('on with a bad prefix answers 503 for the 1.2d paths only', () => {
    const env = { ...ENV, CRM_EVENTS_ID_PREFIX: 'Bad-Prefix', CRM_INBOUND_MESSAGE_SEND_ENABLED: 'false' };
    expect(verify(chat({ conversation_id: CONVERSATION }), env))
      .toEqual({ action: 'respond', http_status: 503, response: { error: 'receiver_unavailable' } });
    expect(verify(closure(), env))
      .toEqual({ action: 'respond', http_status: 503, response: { error: 'receiver_unavailable' } });
    expect(verify(chat({ crm_opportunity_id: OPPORTUNITY }), env).action).toBe('apply');
  });
});

describe('conversation_id identity (S5)', () => {
  test('chat.take with conversation_id becomes apply_conversation', () => {
    const body = chat({ conversation_id: CONVERSATION });
    expect(verify(body)).toEqual({
      action: 'apply_conversation',
      event_id: 'crm-evt-1',
      event_type: 'chat.take',
      body_sha256: sha(body),
      conversation_ref: CONVERSATION,
      conversation_id: '42',
      crm_seller_id: SELLER,
      ownership_version: '3',
    });
  });

  test('chat.release with conversation_id becomes apply_conversation', () => {
    expect(verify(chat({ conversation_id: CONVERSATION }, 'chat.release')))
      .toMatchObject({ action: 'apply_conversation', event_type: 'chat.release', conversation_id: '42' });
  });

  test('message.send with conversation_id becomes send_conversation with the trimmed text', () => {
    const body = send({ conversation_id: CONVERSATION });
    expect(verify(body)).toEqual({
      action: 'send_conversation',
      event_id: 'crm-evt-1',
      event_type: 'message.send',
      body_sha256: sha(body),
      conversation_ref: CONVERSATION,
      conversation_id: '42',
      crm_seller_id: SELLER,
      client_message_id: CLIENT_MESSAGE,
      ownership_version: '3',
      text: 'Hola',
    });
  });

  test('message.send with conversation_id still needs CRM_INBOUND_MESSAGE_SEND_ENABLED', () => {
    expect(verify(send({ conversation_id: CONVERSATION }), { ...ENV, CRM_INBOUND_MESSAGE_SEND_ENABLED: 'false' }))
      .toEqual(invalid('envelope.type: unsupported'));
  });

  test('the opportunity identity keeps its actions when the flag is on', () => {
    expect(verify(chat({ crm_opportunity_id: OPPORTUNITY }))).toMatchObject({ action: 'apply', crm_opportunity_id: OPPORTUNITY });
    expect(verify(send({ crm_opportunity_id: OPPORTUNITY }))).toMatchObject({ action: 'send', crm_opportunity_id: OPPORTUNITY });
  });

  test.each([
    ['chat.take', (data) => chat(data)],
    ['chat.release', (data) => chat(data, 'chat.release')],
    ['message.send', (data) => send(data)],
  ])('%s with both identities or neither is 400 invalid_event', (_type, build) => {
    const detail = 'data: exactly one of crm_opportunity_id or conversation_id';
    expect(verify(build({ crm_opportunity_id: OPPORTUNITY, conversation_id: CONVERSATION }))).toEqual(invalid(detail));
    expect(verify(build({}))).toEqual(invalid(detail));
  });

  test.each([
    'wa-dev-conversation-0', 'wa-dev-conversation-01', 'wa-dev-conversation-x', 'wa-Dev-conversation-1',
    'dev-conversation-1', 'wa-dev-conversation-1234567890123456789', 42, '',
  ])('a malformed conversation_id (%s) is 400', (value) => {
    expect(verify(chat({ conversation_id: value }))).toEqual(invalid('data.conversation_id'));
  });

  test('another prefix is well formed but not ours: passed on with no conversation id', () => {
    expect(verify(chat({ conversation_id: 'wa-prod-conversation-42' })))
      .toMatchObject({ action: 'apply_conversation', conversation_ref: 'wa-prod-conversation-42', conversation_id: '' });
  });
});

describe('handoff.acknowledged / handoff.resolved (S6)', () => {
  test.each(['handoff.acknowledged', 'handoff.resolved'])('%s becomes apply_handoff', (type) => {
    const body = closure(type, { crm_seller_id: SELLER.toUpperCase() });
    expect(verify(body)).toEqual({
      action: 'apply_handoff',
      event_id: 'crm-evt-1',
      event_type: type,
      body_sha256: sha(body),
      handoff_ref: HANDOFF,
      handoff_id: '7',
      crm_seller_id: SELLER,
    });
  });

  test('data is exactly {handoff_id, crm_seller_id}', () => {
    expect(verify(closure('handoff.resolved', { note: 'x' }))).toEqual(invalid('data.note: unknown'));
    expect(verify(envelope('handoff.resolved', { handoff_id: HANDOFF }))).toEqual(invalid('data.crm_seller_id'));
    expect(verify(envelope('handoff.resolved', { crm_seller_id: SELLER }))).toEqual(invalid('data.handoff_id'));
    expect(verify(closure('handoff.resolved', { crm_seller_id: 'not-a-uuid' }))).toEqual(invalid('data.crm_seller_id'));
    expect(verify(closure('handoff.resolved', { handoff_id: 7 }))).toEqual(invalid('data.handoff_id'));
  });

  test.each(['wa-prod-handoff-7', 'wa-dev-handoff-07', 'wa-dev-handoff-abc', 'handoff-7'])(
    'an id that is not ours or unparsable (%s) is passed on with no handoff id (422 in the database)',
    (value) => {
      expect(verify(closure('handoff.resolved', { handoff_id: value })))
        .toMatchObject({ action: 'apply_handoff', handoff_ref: value, handoff_id: '' });
    },
  );
});

describe('crm-inbound-events 1.2d wiring', () => {
  const workflow = JSON.parse(fs.readFileSync('n8n/workflows/crm-inbound-events.json', 'utf8'));
  const node = (name) => workflow.nodes.find((n) => n.name === name);
  const targets = (name, index = 0) => (workflow.connections[name]?.main?.[index] ?? []).map((c) => c.node);

  test('the 1.2d branches hang off the message.send router and end in the single Respond node', () => {
    expect(targets('Is Message Send To Claim', 1)).toEqual(['Is Conversation Chat Event']);
    expect(targets('Is Conversation Chat Event', 0)).toEqual(['Apply CRM Conversation Chat Event']);
    expect(targets('Is Conversation Chat Event', 1)).toEqual(['Is Conversation Message Send']);
    expect(targets('Apply CRM Conversation Chat Event')).toEqual(['Build CRM Event Response']);
    expect(targets('Is Conversation Message Send', 0)).toEqual(['Claim CRM Conversation Message Send']);
    expect(targets('Is Conversation Message Send', 1)).toEqual(['Is Handoff Event']);
    expect(targets('Claim CRM Conversation Message Send')).toEqual(['Should Send CRM Message']);
    expect(targets('Is Handoff Event', 0)).toEqual(['Apply CRM Handoff Event']);
    expect(targets('Is Handoff Event', 1)).toEqual(['Build CRM Event Response']);
    expect(targets('Apply CRM Handoff Event')).toEqual(['Build CRM Event Response']);
  });

  test('the IF nodes route on the verified action', () => {
    expect(JSON.stringify(node('Is Conversation Chat Event').parameters)).toContain("$json.action === 'apply_conversation'");
    expect(JSON.stringify(node('Is Conversation Message Send').parameters)).toContain("$json.action === 'send_conversation'");
    expect(JSON.stringify(node('Is Handoff Event').parameters)).toContain("$json.action === 'apply_handoff'");
  });

  test('the new database nodes continue on error (503) with the same credentials', () => {
    for (const name of ['Apply CRM Conversation Chat Event', 'Claim CRM Conversation Message Send', 'Apply CRM Handoff Event']) {
      expect(node(name)).toMatchObject({ type: 'n8n-nodes-base.postgres', onError: 'continueRegularOutput' });
      expect(node(name).credentials).toEqual(node('Apply CRM Chat Event').credentials);
      expect(node(name).parameters.options.queryBatching).toBe('transaction');
    }
  });

  test('node ids are unique', () => {
    const ids = workflow.nodes.map((n) => n.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
