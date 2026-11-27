// =============================================================================
// CRM 1.3 backfill builders (U8: S9, S11, S2-S4): the historical decoration of
// lead.qualified (outcome, closed_at), message.new and handoff.created
// (resolved_at), the Build Backfill Events node, and the receiver rules for
// the historical fields. Feature document: odd/tasks/crm-1-3-customer-threads.md.
// Contract: .orca/drops/whatsapp-events-1.3-crm-response.md §5 and
// .orca/drops/whatsapp-events-1.3-crm-closed-history.md §2.
// =============================================================================
import crypto from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { describe, expect, test } from 'vitest';

const require = createRequire(import.meta.url);
const runtimePath = 'tests/fixtures/workflow-nodes/crm-events-dispatcher/crm-events-runtime.js';
const {
  buildLeadQualifiedEvent,
  buildMessageNewEvent,
  buildHandoffCreatedEvent,
} = require(`../../${runtimePath}`);
const { validateCrmEvent } = require('../support/crm-events-validator.js');

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const nodeSource = `${fs.readFileSync(runtimePath, 'utf8')}\n\n${fs.readFileSync(
  'tests/fixtures/workflow-nodes/crm-events-dispatcher/build-backfill-events.js', 'utf8',
)}`;
const requireCrypto = (name) => {
  if (name !== 'crypto') throw new Error(`unexpected require: ${name}`);
  return crypto;
};
const runNode = (items, env) => new AsyncFunction('items', '$env', 'helpers', 'require', nodeSource)(items, env, {}, requireCrypto);

const SELLER_UUID = '6f1c2a34-5b6d-4e7f-8a9b-0c1d2e3f4a5b';
const OPPORTUNITY_UUID = '66666666-7777-4888-9999-aaaaaaaaaaaa';
const ENV_13 = {
  CRM_EVENTS_ENABLED: 'true',
  CRM_EVENTS_URL: 'https://crm.example.test/api/integrations/whatsapp/events',
  CRM_EVENTS_HMAC_SECRET: 'test-crm-secret',
  CRM_EVENTS_SINCE: '2026-11-11T00:00:00Z',
  CRM_EVENTS_PROTOCOL_REVISION: '1.3',
  CRM_EVENTS_ID_PREFIX: 'test',
  CRM_EVENTS_HANDOFFS_ENABLED: 'true',
};
const ENV_12 = { ...ENV_13, CRM_EVENTS_PROTOCOL_REVISION: '1.2' };
const C12 = { protocol_revision: '1.2', id_prefix: 'test' };
const C13 = { protocol_revision: '1.3', id_prefix: 'test' };
const CONTACT = { contact_id: 9, contact_upserted_prefixes: 'test' };
const CLOSED_AT = '2026-10-01T12:30:00Z';

const lead = (overrides = {}) => ({
  lead_id: 42, revision: 1, conversation_id: 7, phone_number: '56912345678', whatsapp_name: 'Juan Pérez',
  service: 'instalacion', city: 'Santiago', requirement: '50 bloques', qualification_context: { commune: 'Ñuñoa' },
  advisor_output_payload: null, source_number_phone: '56223456789', crm_user_id: SELLER_UUID,
  crm_source_hash: 'source-hash-1', ...CONTACT, ...overrides,
});
const message = (overrides = {}) => ({
  message_id: 501, conversation_id: 7, direction: 'incoming', sender_type: 'customer', message_type: 'text',
  text_body: 'Hola', file_name: null, sent_at: '2026-09-12T14:03:22.000Z', crm_user_id: null, ...CONTACT, ...overrides,
});
const handoff = (overrides = {}) => ({
  handoff_id: 77, revision: 1, conversation_id: 7, area: 'sales', motivo: 'Quiere hablar con alguien',
  escalation_reason: 'talk_human', prioridad: 'alta', phone_number: '56912345678',
  crm_opportunity_id: null, crm_seller_id: null, customer_name: 'Ana', last_customer_message: 'Necesito ayuda',
  ...CONTACT, ...overrides,
});
const data = (built) => JSON.parse(built.body).data;

describe('historical lead.qualified (S9, S11)', () => {
  test('won and lost carry historical, outcome and closed_at; the record hash ignores them', () => {
    const live = buildLeadQualifiedEvent(lead(), C13);
    for (const outcome of ['won', 'lost']) {
      const built = buildLeadQualifiedEvent(lead(), C13, { outcome, closed_at: CLOSED_AT });
      expect(built.blocked_reason).toBeNull();
      expect(data(built)).toMatchObject({ historical: true, outcome, closed_at: CLOSED_AT });
      expect(validateCrmEvent(built.body)).toEqual([]);
      expect(built.record_hash).toBe(live.record_hash);
    }
  });

  test('open carries no closed_at', () => {
    const built = buildLeadQualifiedEvent(lead(), C13, { outcome: 'open', closed_at: null });
    expect(data(built)).toMatchObject({ historical: true, outcome: 'open' });
    expect('closed_at' in data(built)).toBe(false);
    expect(validateCrmEvent(built.body)).toEqual([]);
  });

  test('an invalid outcome or closed_at is blocked, never sent', () => {
    expect(buildLeadQualifiedEvent(lead(), C13, { outcome: 'won', closed_at: null }).blocked_reason).toBe('invalid_historical');
    expect(buildLeadQualifiedEvent(lead(), C13, { outcome: 'open', closed_at: CLOSED_AT }).blocked_reason).toBe('invalid_historical');
    expect(buildLeadQualifiedEvent(lead(), C13, { outcome: 'maybe', closed_at: null }).blocked_reason).toBe('invalid_historical');
    expect(buildLeadQualifiedEvent(lead(), C13, { outcome: 'lost', closed_at: '2026-10-01 12:30' }).blocked_reason).toBe('invalid_historical');
  });

  test('historical exists only under 1.3; without it the body is unchanged', () => {
    expect(buildLeadQualifiedEvent(lead(), C12, { outcome: 'won', closed_at: CLOSED_AT }).blocked_reason).toBe('historical_requires_1_3');
    expect(buildLeadQualifiedEvent(lead(), C13, null).body).toBe(buildLeadQualifiedEvent(lead(), C13).body);
  });
});

describe('historical message.new (S9)', () => {
  test('carries historical: true and passes the receiver rules', () => {
    const built = buildMessageNewEvent(message(), C13, { historical: true });
    expect(data(built).historical).toBe(true);
    expect(validateCrmEvent(built.body)).toEqual([]);
    expect(buildMessageNewEvent(message(), C13).body).not.toContain('historical');
  });

  test('is blocked outside 1.3', () => {
    expect(buildMessageNewEvent(message(), C12, { historical: true }).blocked_reason).toBe('historical_requires_1_3');
  });
});

describe('historical handoff.created (S9)', () => {
  test('a resolved handoff carries resolved_at and may have no routing key', () => {
    const built = buildHandoffCreatedEvent(handoff(), C13, { resolved_at: CLOSED_AT });
    expect(built.blocked_reason).toBeNull();
    expect(data(built)).toMatchObject({ historical: true, resolved_at: CLOSED_AT });
    expect('crm_seller_id' in data(built) || 'crm_opportunity_id' in data(built)).toBe(false);
    expect(validateCrmEvent(built.body)).toEqual([]);
  });

  test('an open handoff is a live one: historical without resolved_at and exactly one routing key', () => {
    expect(buildHandoffCreatedEvent(handoff(), C13, { resolved_at: null }).blocked_reason).toBe('not_routed');
    const built = buildHandoffCreatedEvent(handoff({ crm_opportunity_id: OPPORTUNITY_UUID }), C13, { resolved_at: null });
    expect(data(built)).toMatchObject({ historical: true, crm_opportunity_id: OPPORTUNITY_UUID });
    expect('resolved_at' in data(built)).toBe(false);
    expect(validateCrmEvent(built.body)).toEqual([]);
  });

  test('an invalid resolved_at is blocked; outside 1.3 historical is blocked', () => {
    expect(buildHandoffCreatedEvent(handoff(), C13, { resolved_at: 'yesterday' }).blocked_reason).toBe('invalid_historical');
    expect(buildHandoffCreatedEvent(handoff({ crm_seller_id: SELLER_UUID }), C12, { resolved_at: null }).blocked_reason)
      .toBe('historical_requires_1_3');
  });
});

describe('receiver rules for the historical fields', () => {
  const body = (type, dataValue, revision = '1.3') => JSON.stringify({
    schema_version: 1, protocol_revision: revision, event_id: 'wa-test-x-1', type,
    conversation_id: 'wa-test-conversation-7', ...(revision === '1.3' ? { contact_id: 'wa-test-contact-9' } : {}), data: dataValue,
  });
  const leadData = (extra) => ({ ...data(buildLeadQualifiedEvent(lead(), C13)), ...extra });

  test('lead.qualified: outcome needs historical; won/lost need closed_at; open has none', () => {
    expect(validateCrmEvent(body('lead.qualified', leadData({ outcome: 'won', closed_at: CLOSED_AT })))).toContain('data.outcome: only with historical');
    expect(validateCrmEvent(body('lead.qualified', leadData({ historical: true })))).toContain('data.outcome');
    expect(validateCrmEvent(body('lead.qualified', leadData({ historical: true, outcome: 'lost' })))).toContain('data.closed_at');
    expect(validateCrmEvent(body('lead.qualified', leadData({ historical: true, outcome: 'open', closed_at: CLOSED_AT })))).toContain('data.closed_at: not allowed for open');
    expect(validateCrmEvent(body('lead.qualified', leadData({ historical: false, outcome: 'open' })))).toContain('data.historical');
  });

  test('historical is a 1.3 key only', () => {
    const messageData = data(buildMessageNewEvent(message(), C13, { historical: true }));
    expect(validateCrmEvent(body('message.new', messageData, '1.2'))).toContain('data.historical: unknown key');
  });

  test('handoff.created: resolved_at needs historical; without it exactly one routing key', () => {
    const resolved = data(buildHandoffCreatedEvent(handoff(), C13, { resolved_at: CLOSED_AT }));
    const { historical: _h, ...noHistorical } = resolved;
    expect(validateCrmEvent(body('handoff.created', noHistorical))).toContain('data.resolved_at: only with historical');
    const { resolved_at: _r, ...live } = resolved;
    expect(validateCrmEvent(body('handoff.created', live))).toContain('data: exactly one of crm_opportunity_id or crm_seller_id');
  });
});

describe('Build Backfill Events node', () => {
  const rows = [
    { json: { success: true } },
    { json: { kind: 'lead', contact_id: 9, entity_id: 42, payload: { ...lead(), outcome: 'lost', closed_at: CLOSED_AT } } },
    { json: { kind: 'handoff', contact_id: 9, entity_id: 77, payload: { ...handoff(), resolved_at: CLOSED_AT } } },
    { json: { kind: 'message', contact_id: 9, entity_id: 501, payload: message() } },
    { json: { kind: 'holder', contact_id: 9, entity_id: 9, payload: {
      change_id: 31, conversation_id: 7, ownership_version: 2, change_kind: 'taken', source: 'crm', reason: null,
      crm_user_id: SELLER_UUID, contact_version: 6, ...CONTACT,
    } } },
    { json: { kind: 'complete', contact_id: 10, entity_id: 10, payload: {} } },
  ];

  test('builds one array with every kind, under the current prefix', async () => {
    const [out] = await runNode(rows, ENV_13);
    const events = JSON.parse(out.json.events_json);
    expect(events.map((e) => e.kind)).toEqual(['lead', 'handoff', 'message', 'holder', 'complete']);
    for (const event of events.slice(0, 4)) {
      expect(event.blocked_reason).toBeNull();
      expect(event.id_prefix).toBe('test');
      expect(validateCrmEvent(event.body)).toEqual([]);
    }
    expect(events[0]).toMatchObject({ event_type: 'lead.qualified', revision: 1, source_hash: 'source-hash-1', requirement: '50 bloques' });
    expect(JSON.parse(events[0].body).data).toMatchObject({ historical: true, outcome: 'lost', closed_at: CLOSED_AT });
    expect(events[1]).toMatchObject({ event_type: 'handoff.created', routed: false });
    expect(events[3]).toMatchObject({ event_type: 'ownership.taken', contact_version: 6, entity_id: 9 });
    expect(JSON.parse(events[3].body)).toMatchObject({ event_id: 'wa-test-ownership-c9-v6', data: { version: 6 } });
    expect(events[4]).toMatchObject({ kind: 'complete', contact_id: 10, body: null });
  });

  test('does nothing outside 1.3', async () => {
    expect(await runNode(rows, ENV_12)).toEqual([]);
  });
});
