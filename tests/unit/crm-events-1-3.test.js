// =============================================================================
// CRM events sender, contract revision 1.3 (customer threads): the envelope
// with a root contact_id on every builder, contact.upserted, the contact.*
// and historical lead.qualified responses, and the receiver rules.
// Feature document: odd/tasks/crm-1-3-customer-threads.md (U3: S2, S3, S10).
// Every 1.3 body is checked against the local mirror of the CRM validator.
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
  buildOwnershipEvent,
  buildHandoffCreatedEvent,
  buildContactUpsertedEvent,
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
const runNode = (fixture, items, env = {}) =>
  new AsyncFunction('items', '$env', 'helpers', 'require', nodeSource(fixture))(items, env, {}, requireCrypto);

const SELLER_UUID = '6f1c2a34-5b6d-4e7f-8a9b-0c1d2e3f4a5b';
const OPPORTUNITY_UUID = '66666666-7777-4888-9999-aaaaaaaaaaaa';

const ENV_12 = {
  CRM_EVENTS_ENABLED: 'true',
  CRM_EVENTS_URL: 'https://crm.example.test/api/integrations/whatsapp/events',
  CRM_EVENTS_HMAC_SECRET: 'test-crm-secret',
  CRM_EVENTS_SINCE: '2026-11-11T00:00:00Z',
  CRM_EVENTS_PROTOCOL_REVISION: '1.2',
  CRM_EVENTS_ID_PREFIX: 'test',
};
const ENV_13 = { ...ENV_12, CRM_EVENTS_PROTOCOL_REVISION: '1.3' };
const CONFIG_11 = { protocol_revision: '1.1', id_prefix: 'test' };
const CONFIG_12 = { protocol_revision: '1.2', id_prefix: 'test' };
const CONFIG_13 = { protocol_revision: '1.3', id_prefix: 'test' };

// The contact columns every 1.3 select returns: the contact and the id
// prefixes it already has a contact.upserted event in.
const CONTACT = { contact_id: 9, contact_upserted_prefixes: 'test' };

const lead = (overrides = {}) => ({
  lead_id: 42,
  revision: 1,
  conversation_id: 7,
  phone_number: '56912345678',
  whatsapp_name: 'Juan Pérez',
  service: 'instalacion',
  city: 'Santiago',
  requirement: '50 bloques de hormigón',
  qualification_context: { commune: 'Ñuñoa', invoice_required: true, line_items: [{ product: 'Adoquín', quantity: '120 m2' }] },
  advisor_output_payload: { lead_class: 'A', executive_summary: 'Cliente listo' },
  source_number_phone: '56223456789',
  crm_user_id: SELLER_UUID,
  crm_source_hash: 'source-hash-1',
  ...CONTACT,
  ...overrides,
});
const message = (overrides = {}) => ({
  message_id: 501, conversation_id: 7, direction: 'incoming', sender_type: 'customer', message_type: 'text',
  text_body: 'Hola', file_name: null, sent_at: '2026-11-12T14:03:22.000Z', crm_user_id: null, ...CONTACT, ...overrides,
});
const ownership = (overrides = {}) => ({
  change_id: 31, conversation_id: 7, ownership_version: 2, change_kind: 'taken', source: 'crm', reason: null,
  crm_user_id: SELLER_UUID, ...CONTACT, ...overrides,
});
const handoff = (overrides = {}) => ({
  handoff_id: 77, revision: 1, conversation_id: 7, area: 'sales', motivo: 'Quiere hablar con alguien',
  escalation_reason: 'talk_human', prioridad: 'alta', phone_number: '56912345678',
  crm_opportunity_id: null, crm_seller_id: SELLER_UUID, customer_name: 'Ana', last_customer_message: 'Necesito ayuda',
  ...CONTACT, ...overrides,
});
const contact = (overrides = {}) => ({ contact_id: 9, revision: 1, phone_number: '56912345678', name: 'Juan Pérez', ...overrides });

const parsed = (built) => JSON.parse(built.body);
const withoutContact = (row) => {
  const { contact_id: _id, contact_upserted_prefixes: _prefixes, ...rest } = row;
  return rest;
};

describe('readCrmEventsConfig: revision 1.3 behind the flag (S10)', () => {
  test('accepts 1.3 and keeps 1.1 the default', () => {
    expect(readCrmEventsConfig(ENV_13)).toMatchObject({ errors: [], protocol_revision: '1.3', deliver_batch_size: 100 });
    expect(readCrmEventsConfig({ ...ENV_12, CRM_EVENTS_PROTOCOL_REVISION: '' }).protocol_revision).toBe('1.1');
  });

  test('still rejects an unknown revision', () => {
    expect(readCrmEventsConfig({ ...ENV_12, CRM_EVENTS_PROTOCOL_REVISION: '1.4' }).errors)
      .toEqual(['CRM_EVENTS_PROTOCOL_REVISION_unsupported:1.4']);
  });

  test('handoff.created stays available under 1.3 when its flag is on', () => {
    expect(readCrmEventsConfig({ ...ENV_13, CRM_EVENTS_HANDOFFS_ENABLED: 'true' }).handoffs_enabled).toBe(true);
    expect(readCrmEventsConfig(ENV_13).handoffs_enabled).toBe(false);
  });
});

describe('1.3 envelope: protocol_revision "1.3" and a root contact_id (S2)', () => {
  const cases = [
    ['lead.qualified', () => buildLeadQualifiedEvent(lead(), CONFIG_13)],
    ['message.new', () => buildMessageNewEvent(message(), CONFIG_13)],
    ['ownership.taken', () => buildOwnershipEvent(ownership(), CONFIG_13)],
    ['ownership.released', () => buildOwnershipEvent(ownership({ change_kind: 'released', reason: 'seller_released', source: null }), CONFIG_13)],
    ['handoff.created', () => buildHandoffCreatedEvent(handoff(), CONFIG_13)],
  ];

  test.each(cases)('%s carries contact_id and conversation_id and passes the 1.3 validator', (type, build) => {
    const built = build();
    expect(built.blocked_reason).toBeNull();
    const body = parsed(built);
    expect(body).toMatchObject({
      schema_version: 1, protocol_revision: '1.3', type,
      conversation_id: 'wa-test-conversation-7', contact_id: 'wa-test-contact-9',
    });
    expect(Object.keys(body)).toEqual(['schema_version', 'protocol_revision', 'event_id', 'type', 'conversation_id', 'contact_id', 'data']);
    expect(validateCrmEvent(built.body)).toEqual([]);
  });

  test.each(cases)('%s under 1.3 differs from 1.2 only in protocol_revision and contact_id', (_type, build) => {
    const built13 = parsed(build());
    const config12Body = (() => {
      const { protocol_revision: _r, contact_id: _c, ...rest } = built13;
      return rest;
    })();
    expect(config12Body.data).toBeDefined();
    // Rebuild the same row under 1.2 and compare everything else.
    const rebuilt = {
      'lead.qualified': () => buildLeadQualifiedEvent(lead(), CONFIG_12),
      'message.new': () => buildMessageNewEvent(message(), CONFIG_12),
      'ownership.taken': () => buildOwnershipEvent(ownership(), CONFIG_12),
      'ownership.released': () => buildOwnershipEvent(ownership({ change_kind: 'released', reason: 'seller_released', source: null }), CONFIG_12),
      'handoff.created': () => buildHandoffCreatedEvent(handoff(), CONFIG_12),
    }[built13.type]();
    const { protocol_revision: revision12, ...rest12 } = parsed(rebuilt);
    expect(revision12).toBe('1.2');
    expect(rest12).toEqual(config12Body);
  });

  test('lead.qualified under 1.3 keeps the 1.2 record and record hash', () => {
    const built13 = buildLeadQualifiedEvent(lead(), CONFIG_13);
    const built12 = buildLeadQualifiedEvent(lead(), CONFIG_12);
    expect(built13.record_hash).toBe(built12.record_hash);
    expect(parsed(built13).data).toMatchObject({ commune: 'Ñuñoa', tax_document: 'factura', ai_summary: { lead_class: 'A' } });
  });

  test('a row without a contact is blocked as contact_missing under 1.3', () => {
    expect(buildLeadQualifiedEvent(lead({ contact_id: null }), CONFIG_13)).toMatchObject({ blocked_reason: 'contact_missing', body: null });
    expect(buildMessageNewEvent(message({ contact_id: null }), CONFIG_13)).toMatchObject({ blocked_reason: 'contact_missing', body: null });
    expect(buildOwnershipEvent(ownership({ contact_id: 0 }), CONFIG_13)).toMatchObject({ blocked_reason: 'contact_missing', body: null });
    expect(buildHandoffCreatedEvent(handoff({ contact_id: 'x' }), CONFIG_13)).toMatchObject({ blocked_reason: 'contact_missing', body: null });
  });

  test('ordering rule: a contact without contact.upserted in this prefix defers the event', () => {
    for (const prefixes of [null, '', 'prod', 'prod,other']) {
      expect(buildLeadQualifiedEvent(lead({ contact_upserted_prefixes: prefixes }), CONFIG_13).blocked_reason).toBe('contact_not_upserted');
      expect(buildMessageNewEvent(message({ contact_upserted_prefixes: prefixes }), CONFIG_13).blocked_reason).toBe('contact_not_upserted');
      expect(buildOwnershipEvent(ownership({ contact_upserted_prefixes: prefixes }), CONFIG_13).blocked_reason).toBe('contact_not_upserted');
      expect(buildHandoffCreatedEvent(handoff({ contact_upserted_prefixes: prefixes }), CONFIG_13).blocked_reason).toBe('contact_not_upserted');
    }
    expect(buildLeadQualifiedEvent(lead({ contact_upserted_prefixes: 'prod,test' }), CONFIG_13).blocked_reason).toBeNull();
  });
});

describe('1.1 and 1.2 bodies are unchanged by the contact columns', () => {
  test('1.1 lead.qualified ignores contact columns', () => {
    expect(buildLeadQualifiedEvent(lead(), CONFIG_11)).toEqual(buildLeadQualifiedEvent(withoutContact(lead()), CONFIG_11));
    expect(parsed(buildLeadQualifiedEvent(lead(), CONFIG_11)).protocol_revision).toBe('1.1');
  });

  test('1.2 bodies ignore contact columns and carry no contact_id', () => {
    const pairs = [
      [buildLeadQualifiedEvent, lead()],
      [buildMessageNewEvent, message()],
      [buildOwnershipEvent, ownership()],
      [buildHandoffCreatedEvent, handoff()],
    ];
    for (const [build, row] of pairs) {
      const withContact = build(row, CONFIG_12);
      expect(withContact).toEqual(build(withoutContact(row), CONFIG_12));
      expect(parsed(withContact)).not.toHaveProperty('contact_id');
      expect(parsed(withContact).protocol_revision).toBe('1.2');
      expect(validateCrmEvent(withContact.body)).toEqual([]);
    }
  });

  test('message.new, ownership and handoff stay unsupported under 1.1', () => {
    expect(buildMessageNewEvent(message(), CONFIG_11).blocked_reason).toBe('protocol_revision_unsupported');
    expect(buildOwnershipEvent(ownership(), CONFIG_11).blocked_reason).toBe('protocol_revision_unsupported');
    expect(buildHandoffCreatedEvent(handoff(), CONFIG_11).blocked_reason).toBe('protocol_revision_unsupported');
  });
});

describe('contact.upserted (S3)', () => {
  test('builds the exact contract body, with no conversation_id', () => {
    const built = buildContactUpsertedEvent(contact(), CONFIG_13);
    expect(built).toMatchObject({ blocked_reason: null, contact_id: 9, revision: 1, event_id: 'wa-test-contact-9-r1' });
    expect(built.body).toBe(JSON.stringify({
      schema_version: 1,
      protocol_revision: '1.3',
      event_id: 'wa-test-contact-9-r1',
      type: 'contact.upserted',
      contact_id: 'wa-test-contact-9',
      data: { revision: 1, phone: '+56912345678', name: 'Juan Pérez' },
    }));
    expect(validateCrmEvent(built.body)).toEqual([]);
  });

  test('name is null when unknown or blank, and cut to 200 characters', () => {
    expect(parsed(buildContactUpsertedEvent(contact({ name: null }), CONFIG_13)).data.name).toBeNull();
    expect(parsed(buildContactUpsertedEvent(contact({ name: '   ' }), CONFIG_13)).data.name).toBeNull();
    const long = parsed(buildContactUpsertedEvent(contact({ name: 'x'.repeat(250) }), CONFIG_13));
    expect(long.data.name).toHaveLength(200);
    expect(validateCrmEvent(long)).toEqual([]);
  });

  test('a later revision gets its own event id', () => {
    expect(buildContactUpsertedEvent(contact({ revision: 3 }), CONFIG_13).event_id).toBe('wa-test-contact-9-r3');
  });

  test('blocks what the CRM would reject', () => {
    expect(buildContactUpsertedEvent(contact({ phone_number: '123' }), CONFIG_13).blocked_reason).toBe('invalid_phone');
    expect(buildContactUpsertedEvent(contact({ revision: 0 }), CONFIG_13).blocked_reason).toBe('invalid_revision');
    expect(buildContactUpsertedEvent(contact({ contact_id: null }), CONFIG_13).blocked_reason).toBe('invalid_contact_id');
    expect(buildContactUpsertedEvent(contact(), { protocol_revision: '1.3' }).blocked_reason).toBe('id_prefix_missing');
  });

  test('exists only under 1.3', () => {
    expect(buildContactUpsertedEvent(contact(), CONFIG_12).blocked_reason).toBe('protocol_revision_unsupported');
    expect(buildContactUpsertedEvent(contact(), CONFIG_11).blocked_reason).toBe('protocol_revision_unsupported');
  });
});

describe('Build nodes under 1.3', () => {
  test('Build Contact Events emits one JSON array under 1.3 and nothing under 1.2', async () => {
    const [out] = await runNode('build-contact-events.js', [{ json: { success: true } }, { json: contact() }, { json: contact({ contact_id: 10, phone_number: '1' }) }], ENV_13);
    const events = JSON.parse(out.json.events_json);
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({ contact_id: 9, revision: 1, event_id: 'wa-test-contact-9-r1', blocked_reason: null });
    expect(events[1]).toMatchObject({ contact_id: 10, blocked_reason: 'invalid_phone', body: null });
    expect(await runNode('build-contact-events.js', [{ json: contact() }], ENV_12)).toEqual([]);
  });

  test('every build node drops (never blocks) a row whose contact is not upserted yet', async () => {
    const notUpserted = { contact_upserted_prefixes: null };
    expect(await runNode('build-lead-qualified-events.js', [{ json: lead(notUpserted) }], ENV_13)).toEqual([]);
    expect(await runNode('build-message-events.js', [{ json: message(notUpserted) }], ENV_13)).toEqual([]);
    expect(await runNode('build-ownership-events.js', [{ json: ownership(notUpserted) }], ENV_13)).toEqual([]);
    expect(await runNode('build-handoff-events.js', [{ json: handoff(notUpserted) }], { ...ENV_13, CRM_EVENTS_HANDOFFS_ENABLED: 'true' })).toEqual([]);
  });

  test('message, ownership and handoff nodes run under 1.3 and lead keeps the source hash', async () => {
    const [leadOut] = await runNode('build-lead-qualified-events.js', [{ json: lead() }], ENV_13);
    expect(leadOut.json).toMatchObject({ source_hash: 'source-hash-1', blocked_reason: null });
    expect(JSON.parse(leadOut.json.body).contact_id).toBe('wa-test-contact-9');
    const [messageOut] = await runNode('build-message-events.js', [{ json: message() }], ENV_13);
    expect(JSON.parse(messageOut.json.events_json)[0].body).toContain('"contact_id":"wa-test-contact-9"');
    const [ownershipOut] = await runNode('build-ownership-events.js', [{ json: ownership() }], ENV_13);
    expect(JSON.parse(ownershipOut.json.events_json)[0]).toMatchObject({ event_type: 'ownership.taken', blocked_reason: null });
    const [handoffOut] = await runNode('build-handoff-events.js', [{ json: handoff() }], { ...ENV_13, CRM_EVENTS_HANDOFFS_ENABLED: 'true' });
    expect(JSON.parse(handoffOut.json.events_json)[0]).toMatchObject({ handoff_id: 77, blocked_reason: null });
  });
});

describe('responses (S3, closed history)', () => {
  const ok = (body) => ({ statusCode: 200, body: JSON.stringify(body) });
  const EVENT = 'wa-test-contact-9-r1';

  test.each(['applied', 'ignored_stale', 'duplicate'])('contact.upserted 200 %s is delivered', (result) => {
    expect(classifyCrmResponse(ok({ event_id: EVENT, result }), EVENT, 'contact.upserted'))
      .toMatchObject({ outcome: 'delivered', error: null, crm_customer_id: null, crm_opportunity_id: null });
    expect(classifyCrmResponse(ok({ event_id: EVENT, result }), EVENT, 'contact.state').outcome).toBe('delivered');
  });

  test('a contact.* 200 with another shape is parked', () => {
    expect(classifyCrmResponse(ok({ event_id: EVENT, result: 'created' }), EVENT, 'contact.upserted'))
      .toMatchObject({ outcome: 'parked', error: 'invalid_success_response' });
    expect(classifyCrmResponse(ok({ event_id: 'other', result: 'applied' }), EVENT, 'contact.upserted').outcome).toBe('parked');
    expect(classifyCrmResponse(ok({ result: 'applied' }), EVENT, 'contact.upserted').outcome).toBe('parked');
  });

  test('a contact.* rejection keeps the existing classes', () => {
    expect(classifyCrmResponse({ statusCode: 409, body: '{"error":"conflict"}' }, EVENT, 'contact.upserted'))
      .toMatchObject({ outcome: 'parked', error: 'http_409:conflict' });
    expect(classifyCrmResponse({ statusCode: 503, body: '' }, EVENT, 'contact.upserted').outcome).toBe('retry');
  });

  test('a historical lead.qualified (null ids) is delivered and writes no ids', () => {
    const lead13 = 'wa-test-lead-42-r1';
    expect(classifyCrmResponse(ok({ event_id: lead13, status: 'historical', crm_customer_id: null, crm_opportunity_id: null }), lead13, 'lead.qualified'))
      .toMatchObject({ outcome: 'delivered', error: null, crm_customer_id: null, crm_opportunity_id: null });
  });

  test('historical with ids, or null ids without historical, is parked', () => {
    const lead13 = 'wa-test-lead-42-r1';
    expect(classifyCrmResponse(ok({ event_id: lead13, status: 'historical', crm_customer_id: SELLER_UUID, crm_opportunity_id: OPPORTUNITY_UUID }), lead13).outcome)
      .toBe('parked');
    expect(classifyCrmResponse(ok({ event_id: lead13, status: 'created', crm_customer_id: null, crm_opportunity_id: null }), lead13).outcome)
      .toBe('parked');
  });
});

describe('receiver model, revision 1.3 (S2)', () => {
  const lead13 = () => parsed(buildLeadQualifiedEvent(lead(), CONFIG_13));
  const upserted = () => parsed(buildContactUpsertedEvent(contact(), CONFIG_13));

  test('contact_id is required on every 1.3 event', () => {
    const { contact_id: _c, ...body } = lead13();
    expect(validateCrmEvent(body)).toContain('envelope.contact_id: missing');
    const { contact_id: _d, ...contactBody } = upserted();
    expect(validateCrmEvent(contactBody)).toContain('envelope.contact_id: missing');
  });

  test('contact_id is an unknown key before 1.3', () => {
    const body = { ...parsed(buildLeadQualifiedEvent(lead(), CONFIG_12)), contact_id: 'wa-test-contact-9' };
    expect(validateCrmEvent(body)).toContain('envelope.contact_id: unknown key');
  });

  test('conversation_id is required on conversation events and absent on contact.*', () => {
    const { conversation_id: _c, ...body } = lead13();
    expect(validateCrmEvent(body)).toContain('envelope.conversation_id: missing');
    expect(validateCrmEvent({ ...upserted(), conversation_id: 'wa-test-conversation-7' }))
      .toContain('envelope.conversation_id: not allowed on contact.upserted');
  });

  test('contact.upserted requires 1.3 and the exact data shape', () => {
    expect(validateCrmEvent({ ...upserted(), protocol_revision: '1.2' })).toContain('contact.upserted requires protocol_revision 1.3');
    expect(validateCrmEvent({ ...upserted(), data: { revision: 0, phone: '912', extra: 1 } }))
      .toEqual(expect.arrayContaining(['data.extra: unknown key', 'data.revision', 'data.phone']));
    expect(validateCrmEvent({ ...upserted(), data: { revision: 1, phone: '+56912345678', name: 'x'.repeat(201) } })).toContain('data.name');
    expect(validateCrmEvent({ ...upserted(), data: { revision: 1, phone: '+56912345678' } })).toEqual([]);
  });

  test('1.1 and 1.2 events keep their rules', () => {
    expect(validateCrmEvent(buildLeadQualifiedEvent(lead(), CONFIG_11).body)).toEqual([]);
    expect(validateCrmEvent(buildMessageNewEvent(message(), CONFIG_12).body)).toEqual([]);
    const { conversation_id: _c, ...noConversation } = parsed(buildMessageNewEvent(message(), CONFIG_12));
    expect(validateCrmEvent(noConversation)).toContain('envelope.conversation_id: missing');
  });
});

describe('dispatcher workflow wiring for contact.upserted', () => {
  const workflow = JSON.parse(fs.readFileSync('n8n/workflows/crm-events-dispatcher.json', 'utf8'));
  const node = (name) => workflow.nodes.find((candidate) => candidate.name === name);

  test('the contact stage runs first in the pass and before delivery', () => {
    const contactY = node('Select Contact Candidates').position[1];
    for (const name of ['Select Lead Qualified Candidates', 'Select Message Candidates', 'Select Ownership Candidates', 'Select Handoff Candidates', 'Claim CRM Events']) {
      expect(node(name).position[1]).toBeGreaterThan(contactY);
    }
    expect(workflow.connections['Load CRM Events Config'].main[0].map((link) => link.node)).toContain('Select Contact Candidates');
    expect(workflow.connections['Select Contact Candidates'].main[0][0].node).toBe('Build Contact Events');
    expect(workflow.connections['Build Contact Events'].main[0][0].node).toBe('Insert Contact Events');
  });

  test('passes revision, since, prefix, allowlist and batch size to the contact select', () => {
    expect(node('Select Contact Candidates').parameters.options.queryReplacement).toBe(
      "={{ [$json.protocol_revision, $json.since, $json.id_prefix, $json.phone_allowlist ?? '', $json.message_batch_size] }}",
    );
    expect(node('Insert Contact Events').parameters.options.queryReplacement).toBe('={{ [$json.events_json] }}');
  });
});
