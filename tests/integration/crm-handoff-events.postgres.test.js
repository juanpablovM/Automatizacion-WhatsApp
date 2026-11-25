// =============================================================================
// CRM 1.2d: handoff.created through the dispatcher SQL (migrations 044/045).
// Feature document: odd/tasks/crm-1-2d-contingency-handoffs.md (S1-S4, S7).
// Every test runs inside a transaction that is rolled back, with rows created
// in 2100 and a matching CRM_EVENTS_SINCE so other suites never mix in. Every
// other seller is deactivated inside the transaction, so the rotation sees only
// the sellers a test creates.
// =============================================================================
import fs from 'node:fs';
import { createRequire } from 'node:module';
import pg from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'vitest';

const require = createRequire(import.meta.url);
const {
  buildHandoffCreatedEvent,
  buildMessageNewEvent,
  buildOwnershipEvent,
  classifyCrmResponse,
} = require('../fixtures/workflow-nodes/crm-events-dispatcher/crm-events-runtime.js');
const { validateCrmEvent } = require('../support/crm-events-validator.js');

const enabled = process.env.TEST_PG_INTEGRATION === '1';
const describeIntegration = enabled ? describe : describe.skip;
const connection = {
  host: process.env.TEST_PGHOST || '127.0.0.1',
  port: Number(process.env.TEST_PGPORT || 55433),
  database: process.env.TEST_PGDATABASE || 'testdb',
  user: process.env.TEST_PGUSER || 'test',
  password: process.env.TEST_PGPASSWORD || 'test',
};

const sqlDir = 'db/queries/n8n/crm-events-dispatcher';
const claimSql = fs.readFileSync(`${sqlDir}/03_claim_crm_events.sql`, 'utf8');
const completeSql = fs.readFileSync(`${sqlDir}/04_complete_crm_event.sql`, 'utf8');
const selectMessagesSql = fs.readFileSync(`${sqlDir}/05_select_message_candidates.sql`, 'utf8');
const selectOwnershipSql = fs.readFileSync(`${sqlDir}/07_select_ownership_candidates.sql`, 'utf8');
const selectHandoffsSql = fs.readFileSync(`${sqlDir}/09_select_handoff_candidates.sql`, 'utf8');
const insertHandoffsSql = fs.readFileSync(`${sqlDir}/10_insert_handoff_events.sql`, 'utf8');

const SINCE = '2100-01-01T00:00:00.000Z';
const SELLER_A = 'aaaaaaaa-0000-4000-8000-000000000001';
const SELLER_B = 'bbbbbbbb-0000-4000-8000-000000000002';
const SELLER_TEST = 'cccccccc-0000-4000-8000-000000000003';
const OPPORTUNITY_UUID = '66666666-7777-4888-9999-aaaaaaaaaaaa';
const CASE_UUID = '88888888-9999-4aaa-8bbb-cccccccccccc';
const CONFIG = { protocol_revision: '1.2', id_prefix: 'test', handoffs_enabled: true };

describeIntegration('CRM handoff.created (1.2d)', () => {
  const client = new pg.Client(connection);
  let conversationStatusId;
  let sourceNumberId;
  let sellerA;
  let sellerB;
  let sequence = 0;

  beforeAll(async () => { await client.connect(); });
  afterAll(async () => { await client.end(); });

  const insertSeller = async (name, sortOrder, crmUserId, extra = {}) => (await client.query(
    `INSERT INTO sellers (name, is_active, sort_order, crm_user_id, clickup_user_id)
     VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [name, extra.is_active ?? true, sortOrder, crmUserId, extra.clickup_user_id ?? `cu-${name}`],
  )).rows[0].id;

  beforeEach(async () => {
    await client.query('BEGIN');
    await client.query('UPDATE sellers SET is_active = FALSE');
    ({ rows: [{ id: conversationStatusId }] } = await client.query(
      `INSERT INTO conversation_statuses (code, label, sort_order) VALUES ('open', 'Open', 1)
       ON CONFLICT (code) DO UPDATE SET code = EXCLUDED.code RETURNING id`,
    ));
    ({ rows: [{ id: sourceNumberId }] } = await client.query(
      `INSERT INTO whatsapp_numbers (display_name, phone_number, phone_number_id)
       VALUES ('Ventas', '56223456789', 'crm-handoff-' || gen_random_uuid()) RETURNING id`,
    ));
    sellerA = await insertSeller('A', 1, SELLER_A);
    sellerB = await insertSeller('B', 2, SELLER_B);
  });
  afterEach(async () => { await client.query('ROLLBACK'); });

  const rotationKey = () => `whatsapp:${sourceNumberId}`;
  const rotation = async () => (await client.query(
    'SELECT last_seller_id, next_seller_id FROM assignment_rotations WHERE rotation_key = $1', [rotationKey()],
  )).rows[0];

  const insertConversation = async (phone) => (await client.query(
    `INSERT INTO conversations (phone_number, conversation_status_id, source_number_id)
     VALUES ($1, $2, $3) RETURNING id`,
    [phone, conversationStatusId, sourceNumberId],
  )).rows[0].id;

  const insertCustomerLead = async (phone, name, opportunityId, createdAt) => client.query(
    `INSERT INTO leads (phone_number, whatsapp_name, crm_opportunity_id, lead_status_id, created_at)
     VALUES ($1, $2, $3, (SELECT id FROM lead_statuses ORDER BY id LIMIT 1), $4)`,
    [phone, name, opportunityId, createdAt],
  );

  const newPhone = () => {
    sequence += 1;
    return `5693${String(1000000 + sequence).slice(-7)}`;
  };

  const insertHandoff = async ({ conversationId, phone, area = 'sales', motivo = 'talk_human', prioridad = 'alta', estado = 'pending', createdAt = '2100-01-02T00:00:00Z' }) => {
    sequence += 1;
    return (await client.query(
      `INSERT INTO handoffs (idempotency_key, conversation_id, phone_number, source_number_id, motivo, area, area_label,
                             prioridad, responsable, estado, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, 'Ventas', $7, 'Ejecutiva comercial', $8, $9) RETURNING id`,
      [`crm-handoff-test-${sequence}-${Date.now()}`, conversationId, phone, sourceNumberId, motivo, area, prioridad, estado, createdAt],
    )).rows[0].id;
  };

  const newHandoff = async (options = {}) => {
    const phone = options.phone ?? newPhone();
    const conversationId = options.conversationId ?? await insertConversation(phone);
    const handoffId = await insertHandoff({ ...options, phone, conversationId });
    return { handoffId: String(handoffId), conversationId: String(conversationId), phone };
  };

  // The handoff stage as the workflow chains it: select (routes), build, insert.
  const runHandoffs = async ({ flag = 'true', allowlist = '', testPhones = '', testSeller = '' } = {}) => {
    const { rows: candidates } = await client.query(selectHandoffsSql, [flag, SINCE, '200', allowlist, testPhones, testSeller]);
    const events = candidates.map((row) => {
      const built = buildHandoffCreatedEvent(row, CONFIG);
      return {
        handoff_id: Number(row.handoff_id),
        revision: built.revision ?? Number(row.revision),
        event_id: built.event_id,
        conversation_id: built.conversation_id,
        body: built.body,
        blocked_reason: built.blocked_reason,
        crm_opportunity_id: row.crm_opportunity_id ?? null,
        crm_seller_id: row.crm_seller_id ?? null,
      };
    });
    const { rows: [result] } = await client.query(insertHandoffsSql, [JSON.stringify(events)]);
    return { candidates, events, result };
  };

  const handoffOf = async (handoffId) => (await client.query('SELECT * FROM handoffs WHERE id = $1', [handoffId])).rows[0];
  const eventsOf = async (handoffId) => (await client.query(
    "SELECT * FROM crm_events WHERE handoff_id = $1 AND event_type = 'handoff.created' ORDER BY revision", [handoffId],
  )).rows;
  const claim = async () => (await client.query(claimSql, ['500', '900'])).rows;
  const deliver = async (handoffId, statusCode, responseBody) => {
    const claimed = (await claim()).filter((row) => row.event_type === 'handoff.created');
    const results = [];
    for (const row of claimed) {
      const [event] = (await eventsOf(handoffId)).filter((e) => String(e.id) === String(row.crm_event_id));
      if (!event) continue;
      const classified = classifyCrmResponse({ statusCode, body: JSON.stringify(responseBody(row)) }, row.event_id, row.event_type);
      results.push(...(await client.query(completeSql, [
        String(row.crm_event_id), row.claim_token, classified.outcome,
        String(classified.http_status ?? ''), classified.error ?? '', classified.response_json ?? '',
        classified.crm_customer_id ?? '', classified.crm_opportunity_id ?? '', '30',
      ])).rows);
    }
    return results;
  };
  const okResult = (overrides = {}) => (row) => ({
    event_id: row.event_id, external_handoff_id: `ext-${row.event_id}`, crm_case_id: null, crm_opportunity_id: null,
    status: 'pending_association', routing_status: 'routed', ...overrides,
  });

  describe('routing (S2)', () => {
    test('a customer with an opportunity is routed to it, without touching the rotation', async () => {
      const { handoffId, phone, conversationId } = await newHandoff();
      await insertCustomerLead(phone, 'Old', '11111111-0000-4000-8000-000000000000', '2100-01-01T01:00:00Z');
      await insertCustomerLead(phone, 'Ana', OPPORTUNITY_UUID, '2100-01-01T02:00:00Z');
      await insertCustomerLead(phone, 'Sin oportunidad', null, '2100-01-01T03:00:00Z');
      const { events, result } = await runHandoffs();
      expect(result).toMatchObject({ enqueued: 1, blocked: 0 });
      const handoff = await handoffOf(handoffId);
      expect(handoff).toMatchObject({ crm_opportunity_id: OPPORTUNITY_UUID, crm_routing_seller_id: null, crm_blocked_reason: null });
      const [event] = await eventsOf(handoffId);
      expect(event).toMatchObject({ event_id: `wa-test-handoff-${handoffId}-r1`, revision: 1, status: 'pending', conversation_id: `wa-test-conversation-${conversationId}` });
      expect(event.body).toBe(events[0].body);
      expect(validateCrmEvent(event.body)).toEqual([]);
      const { data } = JSON.parse(event.body);
      expect(data).toMatchObject({ handoff_id: `wa-test-handoff-${handoffId}`, kind: 'commercial', area: 'sales', crm_opportunity_id: OPPORTUNITY_UUID });
      expect(data).not.toHaveProperty('crm_seller_id');
      expect(await rotation()).toBeUndefined();
    });

    test('without an opportunity the lead rotation picks the seller and advances the shared pointer', async () => {
      await insertSeller('NoCrm', 0, null);
      const first = await newHandoff();
      const second = await newHandoff();
      const third = await newHandoff();
      await runHandoffs();
      expect((await handoffOf(first.handoffId)).crm_routing_seller_id).toBe(sellerA);
      expect((await handoffOf(second.handoffId)).crm_routing_seller_id).toBe(sellerB);
      expect((await handoffOf(third.handoffId)).crm_routing_seller_id).toBe(sellerA);
      expect(await rotation()).toEqual({ last_seller_id: sellerA, next_seller_id: sellerB });
      const { data } = JSON.parse((await eventsOf(first.handoffId))[0].body);
      expect(data).toMatchObject({ crm_seller_id: SELLER_A, phone: `+${first.phone}` });
      expect(data).not.toHaveProperty('crm_opportunity_id');
      expect(validateCrmEvent((await eventsOf(first.handoffId))[0].body)).toEqual([]);
    });

    test('starts from the pointer the lead rotation left', async () => {
      await client.query(
        'INSERT INTO assignment_rotations (rotation_key, last_seller_id, next_seller_id) VALUES ($1, $2, $3)',
        [rotationKey(), sellerA, sellerB],
      );
      const { handoffId } = await newHandoff();
      await runHandoffs();
      expect((await handoffOf(handoffId)).crm_routing_seller_id).toBe(sellerB);
      expect(await rotation()).toEqual({ last_seller_id: sellerB, next_seller_id: sellerA });
    });

    test('the name comes from the customer lead when known', async () => {
      const { handoffId, phone } = await newHandoff();
      await insertCustomerLead(phone, 'Ana Díaz', null, '2100-01-01T00:00:00Z');
      await runHandoffs();
      expect(JSON.parse((await eventsOf(handoffId))[0].body).data.name).toBe('Ana Díaz');
    });

    test('the description carries the last customer message sent before the handoff', async () => {
      const { handoffId, conversationId } = await newHandoff();
      await client.query(
        `INSERT INTO messages (conversation_id, direction, sender_type, message_type, text_body, created_at) VALUES
         ($1, 'incoming', 'customer', 'text', 'primero', '2100-01-01T10:00:00Z'),
         ($1, 'incoming', 'customer', 'text', 'quiero una persona', '2100-01-01T11:00:00Z'),
         ($1, 'outgoing', 'bot', 'text', 'te derivo', '2100-01-01T11:30:00Z'),
         ($1, 'incoming', 'customer', 'text', 'después', '2100-01-03T00:00:00Z')`,
        [conversationId],
      );
      await runHandoffs();
      expect(JSON.parse((await eventsOf(handoffId))[0].body).data.description)
        .toBe('El cliente pide hablar con una persona.\n\nÚltimo mensaje del cliente: quiero una persona');
    });

    test('a test phone goes to the test seller and leaves the rotation alone', async () => {
      const testSeller = await insertSeller('Test', 99, SELLER_TEST, { is_active: false });
      const { handoffId, phone } = await newHandoff();
      await runHandoffs({ testPhones: phone, testSeller: String(testSeller) });
      expect((await handoffOf(handoffId)).crm_routing_seller_id).toBe(testSeller);
      expect(JSON.parse((await eventsOf(handoffId))[0].body).data.crm_seller_id).toBe(SELLER_TEST);
      expect(await rotation()).toBeUndefined();
    });

    test('no eligible seller: nothing is routed or sent, and the handoff is marked blocked', async () => {
      await client.query('UPDATE sellers SET crm_user_id = NULL WHERE id = ANY($1)', [[sellerA, sellerB]]);
      const { handoffId } = await newHandoff();
      const { result } = await runHandoffs();
      expect(result.enqueued).toBe(0);
      expect(await handoffOf(handoffId)).toMatchObject({ crm_routing_seller_id: null, crm_opportunity_id: null, crm_blocked_reason: 'no_eligible_seller' });
      expect(await eventsOf(handoffId)).toEqual([]);
    });
  });

  describe('re-escalation (S3)', () => {
    test('a new handoff of a conversation with an open routed one reuses its seller, never the next one', async () => {
      const first = await newHandoff();
      await runHandoffs();
      const second = await newHandoff({ conversationId: first.conversationId, phone: first.phone, createdAt: '2100-01-04T00:00:00Z' });
      const pointer = await rotation();
      await runHandoffs();
      expect((await handoffOf(second.handoffId)).crm_routing_seller_id).toBe(sellerA);
      expect(JSON.parse((await eventsOf(second.handoffId))[0].body).data.crm_seller_id).toBe(SELLER_A);
      expect(await rotation()).toEqual(pointer);
    });

    test('two unrouted open handoffs of one conversation in one pass get the same seller; rotation advances once', async () => {
      const phone = newPhone();
      const conversationId = await insertConversation(phone);
      const first = await insertHandoff({ conversationId, phone, createdAt: '2100-01-02T00:00:00Z' });
      const second = await insertHandoff({ conversationId, phone, createdAt: '2100-01-04T00:00:00Z' });
      await runHandoffs();
      expect((await handoffOf(first)).crm_routing_seller_id).toBe(sellerA);
      expect((await handoffOf(second)).crm_routing_seller_id).toBe(sellerA);
      expect(await rotation()).toEqual({ last_seller_id: sellerA, next_seller_id: sellerB });
    });

    test('a resolved earlier handoff is not reused', async () => {
      const first = await newHandoff();
      await runHandoffs();
      await client.query("UPDATE handoffs SET estado = 'resolved' WHERE id = $1", [first.handoffId]);
      const second = await newHandoff({ conversationId: first.conversationId, phone: first.phone, createdAt: '2100-01-04T00:00:00Z' });
      await runHandoffs();
      expect((await handoffOf(second.handoffId)).crm_routing_seller_id).toBe(sellerB);
    });

    test('reuses the open handoff opportunity too', async () => {
      const first = await newHandoff();
      await client.query('UPDATE handoffs SET crm_opportunity_id = $2 WHERE id = $1', [first.handoffId, OPPORTUNITY_UUID]);
      const second = await newHandoff({ conversationId: first.conversationId, phone: first.phone, createdAt: '2100-01-04T00:00:00Z' });
      await runHandoffs();
      expect(await handoffOf(second.handoffId)).toMatchObject({ crm_opportunity_id: OPPORTUNITY_UUID, crm_routing_seller_id: null });
    });
  });

  describe('kind and area (S1)', () => {
    test('a claims handoff is a complaint for claims', async () => {
      const { handoffId } = await newHandoff({ area: 'claims', motivo: 'complaint', prioridad: 'urgente' });
      await runHandoffs();
      expect(JSON.parse((await eventsOf(handoffId))[0].body).data)
        .toMatchObject({ kind: 'complaint', area: 'claims', reason: 'complaint', priority: 'urgente' });
    });
  });

  describe('candidates (S7)', () => {
    test('nothing while the flag is off', async () => {
      const { handoffId } = await newHandoff();
      const { candidates } = await runHandoffs({ flag: 'false' });
      expect(candidates).toEqual([]);
      expect(await handoffOf(handoffId)).toMatchObject({ crm_routing_seller_id: null });
      expect(await rotation()).toBeUndefined();
    });

    test('only open live handoffs since CRM_EVENTS_SINCE, within the phone allowlist', async () => {
      const kept = await newHandoff();
      const old = await newHandoff({ createdAt: '2099-12-31T00:00:00Z' });
      const resolved = await newHandoff({ estado: 'resolved' });
      const deleted = await newHandoff();
      await client.query('UPDATE handoffs SET deleted_at = NOW() WHERE id = $1', [deleted.handoffId]);
      const other = await newHandoff();
      const { candidates } = await runHandoffs({ allowlist: `${kept.phone},${old.phone},${resolved.phone},${deleted.phone}` });
      expect(candidates.map((row) => String(row.handoff_id))).toEqual([kept.handoffId]);
      for (const skipped of [old, resolved, deleted, other]) expect(await eventsOf(skipped.handoffId)).toEqual([]);
    });

    test('a handoff with an event is not selected again', async () => {
      const { handoffId } = await newHandoff();
      await runHandoffs();
      const { candidates } = await runHandoffs();
      expect(candidates).toEqual([]);
      expect(await eventsOf(handoffId)).toHaveLength(1);
    });

    test('Insert enqueues nothing when the routing in the body is no longer the handoff routing', async () => {
      const { handoffId } = await newHandoff();
      const { rows: candidates } = await client.query(selectHandoffsSql, ['true', SINCE, '200', '', '', '']);
      const built = buildHandoffCreatedEvent(candidates[0], CONFIG);
      await client.query('UPDATE handoffs SET crm_routing_seller_id = $2 WHERE id = $1', [handoffId, sellerB]);
      const { rows: [result] } = await client.query(insertHandoffsSql, [JSON.stringify([{
        handoff_id: Number(handoffId), revision: 1, event_id: built.event_id, conversation_id: built.conversation_id,
        body: built.body, blocked_reason: null, crm_opportunity_id: null, crm_seller_id: candidates[0].crm_seller_id,
      }])]);
      expect(result.enqueued).toBe(0);
      expect(await eventsOf(handoffId)).toEqual([]);
    });

    test('a blocked build records the reason on the handoff; a later event clears it', async () => {
      const { handoffId } = await newHandoff();
      await client.query("UPDATE handoffs SET phone_number = '123' WHERE id = $1", [handoffId]);
      const { result } = await runHandoffs();
      expect(result).toMatchObject({ enqueued: 0, blocked: 1 });
      expect((await handoffOf(handoffId)).crm_blocked_reason).toBe('invalid_phone');
      await client.query("UPDATE handoffs SET phone_number = '56911112222' WHERE id = $1", [handoffId]);
      await runHandoffs();
      expect(await handoffOf(handoffId)).toMatchObject({ crm_blocked_reason: null });
      expect(await eventsOf(handoffId)).toHaveLength(1);
    });
  });

  describe('delivery (S4)', () => {
    test('200 delivers and stores crm_case_id on the handoff', async () => {
      const { handoffId } = await newHandoff({ area: 'claims', motivo: 'complaint' });
      await runHandoffs();
      const [completed] = await deliver(handoffId, 200, okResult({ crm_case_id: CASE_UUID, crm_opportunity_id: OPPORTUNITY_UUID, status: 'associated' }));
      expect(completed).toMatchObject({ status: 'delivered', lead_updated: false });
      expect((await eventsOf(handoffId))[0]).toMatchObject({ status: 'delivered', last_http_status: 200, last_error: null });
      expect(await handoffOf(handoffId)).toMatchObject({ crm_case_id: CASE_UUID, crm_routing_seller_id: sellerA, crm_opportunity_id: null });
    });

    test('200 without a case keeps crm_case_id NULL', async () => {
      const { handoffId } = await newHandoff();
      await runHandoffs();
      await deliver(handoffId, 200, okResult());
      expect((await handoffOf(handoffId)).crm_case_id).toBeNull();
    });

    test('422 invalid_seller parks the event and the next pass sends revision 2, same handoff_id, to the next seller', async () => {
      const { handoffId } = await newHandoff();
      await runHandoffs();
      const [parked] = await deliver(handoffId, 422, () => ({ error: 'invalid_seller' }));
      expect(parked.status).toBe('parked');
      expect(await handoffOf(handoffId)).toMatchObject({ crm_routing_seller_id: null });

      await runHandoffs();
      const events = await eventsOf(handoffId);
      expect(events.map((e) => [e.revision, e.status, e.event_id])).toEqual([
        [1, 'parked', `wa-test-handoff-${handoffId}-r1`],
        [2, 'pending', `wa-test-handoff-${handoffId}-r2`],
      ]);
      const [first, second] = events.map((e) => JSON.parse(e.body).data);
      expect(first).toMatchObject({ handoff_id: `wa-test-handoff-${handoffId}`, crm_seller_id: SELLER_A });
      expect(second).toMatchObject({ handoff_id: `wa-test-handoff-${handoffId}`, crm_seller_id: SELLER_B });
      expect(await handoffOf(handoffId)).toMatchObject({ crm_routing_seller_id: sellerB });
    });

    test('skips sellers already rejected for the handoff and stops once every eligible seller was rejected', async () => {
      const { handoffId } = await newHandoff();
      await runHandoffs();
      await deliver(handoffId, 422, () => ({ error: 'invalid_seller' }));
      await runHandoffs();
      // The pointer is back at A, which was already rejected for this handoff.
      await deliver(handoffId, 422, () => ({ error: 'invalid_seller' }));
      const { result } = await runHandoffs();
      expect(result.enqueued).toBe(0);
      expect((await eventsOf(handoffId)).map((e) => [e.revision, e.status])).toEqual([[1, 'parked'], [2, 'parked']]);
      expect(await handoffOf(handoffId)).toMatchObject({ crm_routing_seller_id: null, crm_blocked_reason: 'no_eligible_seller' });

      // A new eligible seller makes it routable again.
      const sellerC = await insertSeller('C', 3, 'dddddddd-0000-4000-8000-000000000004');
      await runHandoffs();
      expect((await handoffOf(handoffId)).crm_routing_seller_id).toBe(sellerC);
      expect((await eventsOf(handoffId)).map((e) => e.revision)).toEqual([1, 2, 3]);
    });

    test('a 422 rejection of a re-escalation never routes it back to the rejected seller', async () => {
      const first = await newHandoff();
      await runHandoffs();
      await deliver(first.handoffId, 200, okResult());
      const second = await newHandoff({ conversationId: first.conversationId, phone: first.phone, createdAt: '2100-01-04T00:00:00Z' });
      await runHandoffs();
      await deliver(second.handoffId, 422, () => ({ error: 'invalid_seller' }));
      await runHandoffs();
      expect((await handoffOf(second.handoffId)).crm_routing_seller_id).toBe(sellerB);
      expect((await handoffOf(first.handoffId)).crm_routing_seller_id).toBe(sellerA);
    });

    test('other rejections park the event and keep the routing; 503 retries', async () => {
      const { handoffId } = await newHandoff();
      await runHandoffs();
      await deliver(handoffId, 503, () => ({ error: 'receiver_unavailable' }));
      expect((await eventsOf(handoffId))[0]).toMatchObject({ status: 'pending', last_error: 'http_503:receiver_unavailable' });
      await client.query("UPDATE crm_events SET next_attempt_at = NOW() - INTERVAL '1 second' WHERE handoff_id = $1", [handoffId]);
      await deliver(handoffId, 409, () => ({ error: 'identity_conflict' }));
      expect((await eventsOf(handoffId))[0]).toMatchObject({ status: 'parked', last_error: 'http_409:identity_conflict' });
      expect((await handoffOf(handoffId)).crm_routing_seller_id).toBe(sellerA);
      const { candidates } = await runHandoffs();
      expect(candidates).toEqual([]);
    });
  });

  describe('message and ownership gate (S4)', () => {
    test('a delivered handoff.created announces the conversation: earlier messages are backfilled', async () => {
      const { handoffId, conversationId } = await newHandoff();
      const { rows: [message] } = await client.query(
        `INSERT INTO messages (conversation_id, direction, sender_type, message_type, text_body, created_at)
         VALUES ($1, 'incoming', 'customer', 'text', 'hola', '2100-01-01T10:00:00Z') RETURNING id`,
        [conversationId],
      );
      const messageCandidates = async () => (await client.query(selectMessagesSql, ['1.2', SINCE, 'test', '500'])).rows
        .filter((row) => String(row.conversation_id) === conversationId);
      await runHandoffs();
      expect(await messageCandidates()).toEqual([]);
      await deliver(handoffId, 200, okResult());
      const [candidate] = await messageCandidates();
      expect(String(candidate.message_id)).toBe(String(message.id));
      const built = buildMessageNewEvent(candidate, CONFIG);
      expect(built.blocked_reason).toBeNull();
      expect(JSON.parse(built.body).conversation_id).toBe(`wa-test-conversation-${conversationId}`);
    });

    test('a pending or parked handoff.created announces nothing', async () => {
      const { handoffId, conversationId } = await newHandoff();
      await client.query(
        `INSERT INTO messages (conversation_id, direction, sender_type, message_type, text_body, created_at)
         VALUES ($1, 'incoming', 'customer', 'text', 'hola', '2100-01-01T10:00:00Z')`,
        [conversationId],
      );
      await runHandoffs();
      await deliver(handoffId, 422, () => ({ error: 'invalid_seller' }));
      const rows = (await client.query(selectMessagesSql, ['1.2', SINCE, 'test', '500'])).rows
        .filter((row) => String(row.conversation_id) === conversationId);
      expect(rows).toEqual([]);
    });

    test('ownership changes of a handed-off conversation follow the delivered handoff.created', async () => {
      const { handoffId, conversationId } = await newHandoff();
      await client.query(
        `INSERT INTO crm_ownership_changes (conversation_id, ownership_version, change_kind, seller_id, source, changed_at)
         VALUES ($1, 1, 'taken', $2, 'crm', '2100-01-02T01:00:00Z')`,
        [conversationId, sellerA],
      );
      const ownershipCandidates = async () => (await client.query(selectOwnershipSql, ['1.2', SINCE, 'test', '500'])).rows
        .filter((row) => String(row.conversation_id) === conversationId);
      await runHandoffs();
      expect(await ownershipCandidates()).toEqual([]);
      await deliver(handoffId, 200, okResult());
      const [change] = await ownershipCandidates();
      expect(change).toMatchObject({ change_kind: 'taken', crm_user_id: SELLER_A });
      expect(buildOwnershipEvent(change, CONFIG).blocked_reason).toBeNull();
    });
  });
});

// Two dispatcher passes can overlap (2 s schedule, no run lock). Each pass is
// one transaction that routes several handoffs, so the routing locks must be
// taken in one order or two passes deadlock (independent verification P3).
describeIntegration('CRM handoff routing under overlapping passes', () => {
  const first = new pg.Client(connection);
  const second = new pg.Client(connection);
  const created = { sellers: [], numbers: [], conversations: [], handoffs: [] };

  beforeAll(async () => { await first.connect(); await second.connect(); });
  afterAll(async () => {
    await first.query('DELETE FROM handoffs WHERE id = ANY($1)', [created.handoffs]);
    await first.query('DELETE FROM conversations WHERE id = ANY($1)', [created.conversations]);
    await first.query("DELETE FROM assignment_rotations WHERE rotation_key = ANY($1)",
      [created.numbers.map((id) => `whatsapp:${id}`)]);
    await first.query('DELETE FROM sellers WHERE id = ANY($1)', [created.sellers]);
    await first.query('DELETE FROM whatsapp_numbers WHERE id = ANY($1)', [created.numbers]);
    await first.end(); await second.end();
  });

  test('a pass routing a second conversation never deadlocks with a pass re-escalating it', async () => {
    const one = async (sql, params) => (await first.query(sql, params)).rows[0].id;
    const statusId = await one(`INSERT INTO conversation_statuses (code, label, sort_order) VALUES ('open', 'Open', 1)
      ON CONFLICT (code) DO UPDATE SET code = EXCLUDED.code RETURNING id`);
    const numberId = await one(`INSERT INTO whatsapp_numbers (display_name, phone_number, phone_number_id)
      VALUES ('Ventas', '56223456700', 'crm-handoff-race-' || gen_random_uuid()) RETURNING id`);
    created.numbers.push(numberId);
    created.sellers.push(await one(`INSERT INTO sellers (name, is_active, sort_order, crm_user_id, clickup_user_id)
      VALUES ('Race', TRUE, 1, gen_random_uuid(), 'cu-race') RETURNING id`));
    const conversation = async (phone) => {
      const id = await one(`INSERT INTO conversations (phone_number, conversation_status_id, source_number_id)
        VALUES ($1, $2, $3) RETURNING id`, [phone, statusId, numberId]);
      created.conversations.push(id);
      return id;
    };
    const handoff = async (conversationId, phone, createdAt) => {
      const id = await one(`INSERT INTO handoffs (idempotency_key, conversation_id, phone_number, source_number_id,
          motivo, area, area_label, prioridad, responsable, estado, created_at)
        VALUES ('crm-handoff-race-' || gen_random_uuid(), $1, $2, $3, 'talk_human', 'sales', 'Ventas', 'alta',
          'Ejecutiva comercial', 'pending', $4) RETURNING id`, [conversationId, phone, numberId, createdAt]);
      created.handoffs.push(id);
      return id;
    };
    const c5 = await conversation('56990000105');
    const c6 = await conversation('56990000106');
    const h5 = await handoff(c5, '56990000105', '2200-01-07T00:00:00Z');
    const h6 = await handoff(c6, '56990000106', '2200-01-08T00:00:00Z');
    const h7 = await handoff(c6, '56990000106', '2200-01-09T00:00:00Z');

    const route = (client, id) => client.query('SELECT * FROM crm_route_handoff($1)', [id])
      .then(() => 'ok', (error) => error.message);
    await first.query('BEGIN');
    await second.query('BEGIN');
    try {
      expect(await route(first, h5)).toBe('ok');
      const secondPass = route(second, h7);
      await new Promise((resolve) => { setTimeout(resolve, 300); });
      const firstPass = route(first, h6);
      const settledFirst = await Promise.race([firstPass,
        new Promise((resolve) => { setTimeout(() => resolve('still waiting'), 3000); })]);
      expect(settledFirst).toBe('ok');
      await first.query('COMMIT');
      expect(await secondPass).toBe('ok');
      await second.query('COMMIT');
    } finally {
      await first.query('ROLLBACK').catch(() => {});
      await second.query('ROLLBACK').catch(() => {});
    }
  });
});
