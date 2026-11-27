// =============================================================================
// CRM -> bot 1.3 (customer threads): request validation of chat.take /
// chat.release / message.send keyed by contact_id, contact.opportunity_linked,
// the switch (CRM_EVENTS_PROTOCOL_REVISION=1.3 with the 1.2d identities on),
// 1.2 requests unchanged, and the workflow wiring of the 1.3 branches. The
// database side is covered by tests/integration/crm-inbound-1-3.postgres.test.js.
// Feature document: odd/tasks/crm-1-3-customer-threads.md (S6-S8, S10).
// =============================================================================
import crypto from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { describe, expect, test } from 'vitest';

const require = createRequire(import.meta.url);
const {
  readCrmContactsConfig,
  verifyCrmInboundRequest,
} = require('../fixtures/workflow-nodes/crm-inbound-events/crm-inbound-runtime.js');

const SECRET = 'crm-inbound-test-secret';
const ENV_12 = {
  CRM_INBOUND_ENABLED: 'true',
  CRM_INBOUND_HMAC_SECRET: SECRET,
  CRM_EVENTS_ID_PREFIX: 'dev',
  CRM_INBOUND_MESSAGE_SEND_ENABLED: 'true',
  CRM_INBOUND_HANDOFFS_ENABLED: 'true',
  CRM_EVENTS_PROTOCOL_REVISION: '1.2',
};
const ENV = { ...ENV_12, CRM_EVENTS_PROTOCOL_REVISION: '1.3' };
const NOW_MS = Date.UTC(2026, 10, 27, 15, 0, 0);
const NOW_S = Math.floor(NOW_MS / 1000);
const OPPORTUNITY = '66666666-7777-4888-9999-aaaaaaaaaaaa';
const SELLER = '6f1c2a34-5b6d-4e7f-8a9b-0c1d2e3f4a5b';
const CLIENT_MESSAGE = '0b6f7a1e-2c3d-4e5f-8a9b-1c2d3e4f5a6b';
const CONTACT = 'wa-dev-contact-12';
const CONVERSATION = 'wa-dev-conversation-42';

const envelope = (type, data, overrides = {}) => ({
  schema_version: 1,
  protocol_revision: '1.3',
  event_id: 'crm-evt-1',
  type,
  occurred_at: '2026-11-27T15:00:00Z',
  data,
  ...overrides,
});
const chat = (data = {}, type = 'chat.take', overrides = {}) => envelope(
  type, { crm_seller_id: SELLER, ownership_version: 3, ...data }, overrides,
);
const send = (data = {}, overrides = {}) => envelope('message.send', {
  crm_seller_id: SELLER, client_message_id: CLIENT_MESSAGE, ownership_version: 3, text: '  Hola  ', ...data,
}, overrides);
const link = (data = {}, overrides = {}) => envelope('contact.opportunity_linked', {
  contact_id: CONTACT, crm_opportunity_id: OPPORTUNITY, crm_seller_id: SELLER, ...data,
}, overrides);

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
const identity = (overrides = {}) => ({
  crm_opportunity_id: '', conversation_ref: '', conversation_id: '', contact_ref: '', contact_id: '', id_prefix: 'dev',
  ...overrides,
});

describe('the 1.3 switch', () => {
  test('is on only with CRM_EVENTS_PROTOCOL_REVISION=1.3 and CRM_INBOUND_HANDOFFS_ENABLED=true', () => {
    expect(readCrmContactsConfig(ENV)).toEqual({ enabled: true, id_prefix: 'dev', errors: [] });
    expect(readCrmContactsConfig(ENV_12).enabled).toBe(false);
    expect(readCrmContactsConfig({ ...ENV, CRM_INBOUND_HANDOFFS_ENABLED: 'false' }).enabled).toBe(false);
    expect(readCrmContactsConfig({ ...ENV, CRM_EVENTS_ID_PREFIX: 'Dev-1' }).errors).toEqual(['CRM_EVENTS_ID_PREFIX_invalid']);
  });

  test.each([
    ['chat.take by contact_id', chat({ contact_id: CONTACT })],
    ['message.send by contact_id', send({ contact_id: CONTACT })],
    ['contact.opportunity_linked', link()],
  ])('off: a 1.3 %s answers 400 envelope.protocol_revision, as before', (_name, body) => {
    expect(verify(body, ENV_12)).toEqual(invalid('envelope.protocol_revision'));
  });

  test('on without a valid CRM_EVENTS_ID_PREFIX: the 1.3 paths answer 503', () => {
    const env = { ...ENV, CRM_EVENTS_ID_PREFIX: 'Dev-1' };
    for (const body of [chat({ contact_id: CONTACT }), send({ contact_id: CONTACT }), link()]) {
      expect(verify(body, env)).toEqual({ action: 'respond', http_status: 503, response: { error: 'receiver_unavailable' } });
    }
  });
});

describe('S6: chat actions keyed by customer', () => {
  test.each([
    ['contact_id', { contact_id: CONTACT }, { contact_ref: CONTACT, contact_id: '12' }],
    ['conversation_id', { conversation_id: CONVERSATION }, { conversation_ref: CONVERSATION, conversation_id: '42' }],
    ['crm_opportunity_id', { crm_opportunity_id: OPPORTUNITY.toUpperCase() }, { crm_opportunity_id: OPPORTUNITY }],
  ])('chat.take by %s goes to Apply CRM Contact Event', (_name, data, expected) => {
    const body = chat(data);
    expect(verify(body)).toEqual({
      action: 'apply_contact',
      event_id: 'crm-evt-1',
      event_type: 'chat.take',
      body_sha256: sha(body),
      ...identity(expected),
      crm_seller_id: SELLER,
      ownership_version: '3',
    });
  });

  test('chat.release by contact_id', () => {
    expect(verify(chat({ contact_id: CONTACT }, 'chat.release'))).toMatchObject({
      action: 'apply_contact', event_type: 'chat.release', contact_id: '12',
    });
  });

  test('message.send by contact_id goes to Claim CRM Contact Message Send', () => {
    const body = send({ contact_id: CONTACT });
    expect(verify(body)).toEqual({
      action: 'send_contact',
      event_id: 'crm-evt-1',
      event_type: 'message.send',
      body_sha256: sha(body),
      ...identity({ contact_ref: CONTACT, contact_id: '12' }),
      crm_seller_id: SELLER,
      ownership_version: '3',
      client_message_id: CLIENT_MESSAGE,
      text: 'Hola',
    });
  });

  test.each([
    ['zero', {}],
    ['two (contact_id + conversation_id)', { contact_id: CONTACT, conversation_id: CONVERSATION }],
    ['two (contact_id + crm_opportunity_id)', { contact_id: CONTACT, crm_opportunity_id: OPPORTUNITY }],
    ['three', { contact_id: CONTACT, conversation_id: CONVERSATION, crm_opportunity_id: OPPORTUNITY }],
  ])('%s identities answer 400 invalid_event', (_name, data) => {
    const detail = 'data: exactly one of crm_opportunity_id, conversation_id or contact_id';
    expect(verify(chat(data))).toEqual(invalid(detail));
    expect(verify(chat(data, 'chat.release'))).toEqual(invalid(detail));
    expect(verify(send(data))).toEqual(invalid(detail));
  });

  test.each([
    'wa-dev-contact-0', 'wa-dev-contact-abc', 'contact-12', 'wa-Dev-contact-12', 12,
  ])('a malformed contact_id (%s) answers 400 data.contact_id', (value) => {
    expect(verify(chat({ contact_id: value }))).toEqual(invalid('data.contact_id'));
  });

  test('a contact_id with another prefix is well formed: the database answers 422', () => {
    expect(verify(chat({ contact_id: 'wa-prod-contact-12' }))).toMatchObject({
      action: 'apply_contact', contact_ref: 'wa-prod-contact-12', contact_id: '',
    });
  });

  test('message.send while CRM_INBOUND_MESSAGE_SEND_ENABLED is off answers 400 envelope.type, as in 1.2', () => {
    expect(verify(send({ contact_id: CONTACT }), { ...ENV, CRM_INBOUND_MESSAGE_SEND_ENABLED: 'false' }))
      .toEqual(invalid('envelope.type: unsupported'));
  });

  test('unknown data keys are rejected', () => {
    expect(verify(chat({ contact_id: CONTACT, extra: 1 }))).toEqual(invalid('data.extra: unknown'));
  });
});

describe('S7: contact.opportunity_linked', () => {
  test('goes to Apply CRM Contact Event with the contact, the opportunity and the seller', () => {
    const body = link({ crm_opportunity_id: OPPORTUNITY.toUpperCase() });
    expect(verify(body)).toEqual({
      action: 'apply_contact',
      event_id: 'crm-evt-1',
      event_type: 'contact.opportunity_linked',
      body_sha256: sha(body),
      ...identity({ contact_ref: CONTACT, contact_id: '12', crm_opportunity_id: OPPORTUNITY }),
      crm_seller_id: SELLER,
      ownership_version: '',
    });
  });

  test.each([
    ['contact_id missing', { contact_id: undefined }, 'data.contact_id'],
    ['crm_opportunity_id not a uuid', { crm_opportunity_id: 'opp-1' }, 'data.crm_opportunity_id'],
    ['crm_seller_id missing', { crm_seller_id: undefined }, 'data.crm_seller_id'],
    ['an unknown key', { ownership_version: 1 }, 'data.ownership_version: unknown'],
  ])('%s answers 400', (_name, data, detail) => {
    const body = link(data);
    for (const key of Object.keys(body.data)) if (body.data[key] === undefined) delete body.data[key];
    expect(verify(body)).toEqual(invalid(detail));
  });

  test('is a 1.3 type only: under protocol_revision 1.2 it answers 400 envelope.type', () => {
    expect(verify(link({}, { protocol_revision: '1.2' }))).toEqual(invalid('envelope.type: unsupported'));
  });

  test('passes the same signature and replay-window checks as every event', () => {
    const body = link();
    const raw = Buffer.from(JSON.stringify(body), 'utf8');
    const bad = { rawBody: raw, headers: { 'x-crm-timestamp': String(NOW_S), 'x-crm-signature': `v1=${'0'.repeat(64)}` } };
    expect(verifyCrmInboundRequest({ ...bad, env: ENV, now: NOW_MS, crypto }))
      .toEqual({ action: 'respond', http_status: 401, response: { error: 'unauthorized' } });
    const old = String(NOW_S - 301);
    const stale = { rawBody: raw, headers: { 'x-crm-timestamp': old, 'x-crm-signature': `v1=${sign(raw, old)}` } };
    expect(verifyCrmInboundRequest({ ...stale, env: ENV, now: NOW_MS, crypto }))
      .toEqual({ action: 'respond', http_status: 401, response: { error: 'unauthorized' } });
  });
});

describe('1.2 requests are unchanged with 1.3 on', () => {
  const v12 = { protocol_revision: '1.2' };
  test.each([
    ['chat.take by opportunity', chat({ crm_opportunity_id: OPPORTUNITY }, 'chat.take', v12)],
    ['chat.release by opportunity', chat({ crm_opportunity_id: OPPORTUNITY }, 'chat.release', v12)],
    ['chat.take by conversation', chat({ conversation_id: CONVERSATION }, 'chat.take', v12)],
    ['message.send by opportunity', send({ crm_opportunity_id: OPPORTUNITY }, v12)],
    ['message.send by conversation', send({ conversation_id: CONVERSATION }, v12)],
    ['chat.take by contact_id (not a 1.2 key)', chat({ contact_id: CONTACT }, 'chat.take', v12)],
    ['chat.take with two keys', chat({ crm_opportunity_id: OPPORTUNITY, conversation_id: CONVERSATION }, 'chat.take', v12)],
    ['handoff.resolved', envelope('handoff.resolved', { handoff_id: 'wa-dev-handoff-7', crm_seller_id: SELLER }, v12)],
  ])('%s: the same item as with 1.3 off', (_name, body) => {
    expect(verify(body, ENV)).toEqual(verify(body, ENV_12));
  });

  test('handoff.resolved under 1.3 keeps the 1.2d action', () => {
    const body = envelope('handoff.resolved', { handoff_id: 'wa-dev-handoff-7', crm_seller_id: SELLER });
    expect(verify(body)).toMatchObject({ action: 'apply_handoff', handoff_id: '7' });
  });
});

describe('workflow wiring', () => {
  const workflow = JSON.parse(fs.readFileSync('n8n/workflows/crm-inbound-events.json', 'utf8'));
  const node = (name) => workflow.nodes.find((entry) => entry.name === name);
  const next = (name, output) => (workflow.connections[name]?.main?.[output] ?? []).map((entry) => entry.node);

  test('the 1.3 branches come first after Verify CRM Event; everything else reaches the 1.2 routers', () => {
    expect(next('Verify CRM Event', 0)).toEqual(['Is Contact Event']);
    expect(next('Is Contact Event', 0)).toEqual(['Apply CRM Contact Event']);
    expect(next('Is Contact Event', 1)).toEqual(['Is Contact Message Send']);
    expect(next('Apply CRM Contact Event', 0)).toEqual(['Build CRM Event Response']);
    expect(next('Is Contact Message Send', 0)).toEqual(['Claim CRM Contact Message Send']);
    expect(next('Is Contact Message Send', 1)).toEqual(['Is Chat Event To Apply']);
    expect(next('Is Handoff Event', 1)).toEqual(['Build CRM Event Response']);
    expect(next('Claim CRM Contact Message Send', 0)).toEqual(['Should Send CRM Message']);
  });

  test('the database nodes run the fixture queries, continue on error and pass every column', () => {
    const apply = node('Apply CRM Contact Event');
    expect(apply.parameters.query).toBe(fs.readFileSync('db/queries/n8n/crm-inbound-events/07_apply_crm_contact_event.sql', 'utf8'));
    expect(apply.onError).toBe('continueRegularOutput');
    expect(apply.parameters.options.queryReplacement).toBe(
      '={{ [$json.event_id, $json.body_sha256, $json.event_type, $json.crm_opportunity_id, $json.conversation_ref, '
      + '$json.conversation_id, $json.contact_ref, $json.contact_id, $json.id_prefix, $json.crm_seller_id, $json.ownership_version] }}',
    );
    const claim = node('Claim CRM Contact Message Send');
    expect(claim.parameters.query).toBe(fs.readFileSync('db/queries/n8n/crm-inbound-events/08_claim_crm_contact_message_send.sql', 'utf8'));
    expect(claim.onError).toBe('continueRegularOutput');
    expect(claim.parameters.options.queryReplacement).toBe(
      '={{ [$json.event_id, $json.body_sha256, $json.crm_opportunity_id, $json.conversation_ref, $json.conversation_id, '
      + '$json.contact_ref, $json.contact_id, $json.id_prefix, $json.crm_seller_id, $json.client_message_id, '
      + '$json.ownership_version, $json.text] }}',
    );
    expect(node('Is Contact Event').parameters.conditions.conditions[0].leftValue).toBe("={{ $json.action === 'apply_contact' }}");
    expect(node('Is Contact Message Send').parameters.conditions.conditions[0].leftValue).toBe("={{ $json.action === 'send_contact' }}");
  });
});
