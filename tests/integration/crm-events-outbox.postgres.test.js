// =============================================================================
// CRM outbox (migration 038) and the crm-events-dispatcher SQL.
// Stage A enqueues lead.qualified events with the exact body to send; stage B
// claims, and completes with the claim token. Every test runs inside a
// transaction that is rolled back, and uses leads created in 2100 with a
// matching CRM_EVENTS_SINCE so rows other suites leave behind never qualify.
// =============================================================================
import crypto from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import pg from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'vitest';

const require = createRequire(import.meta.url);
const { buildLeadQualifiedEvent } = require('../fixtures/workflow-nodes/crm-events-dispatcher/crm-events-runtime.js');

const BUILD_CONFIG = { protocol_revision: '1.1', id_prefix: 'test' };

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
const selectSql = fs.readFileSync(`${sqlDir}/01_select_lead_qualified_candidates.sql`, 'utf8');
const insertSql = fs.readFileSync(`${sqlDir}/02_insert_lead_qualified_event.sql`, 'utf8');
const claimSql = fs.readFileSync(`${sqlDir}/03_claim_crm_events.sql`, 'utf8');
const completeSql = fs.readFileSync(`${sqlDir}/04_complete_crm_event.sql`, 'utf8');

const SINCE = '2100-01-01T00:00:00.000Z';
const SELLER_UUID = '6f1c2a34-5b6d-4e7f-8a9b-0c1d2e3f4a5b';
const CUSTOMER_UUID = '11111111-2222-4333-8444-555555555555';
const OPPORTUNITY_UUID = '66666666-7777-4888-9999-aaaaaaaaaaaa';

describeIntegration('CRM outbox', () => {
  const client = new pg.Client(connection);
  let leadStatusId;
  let conversationStatusId;
  let sellerId;
  let sequence = 0;

  beforeAll(async () => { await client.connect(); });
  afterAll(async () => { await client.end(); });

  beforeEach(async () => {
    await client.query('BEGIN');
    ({ rows: [{ id: leadStatusId }] } = await client.query(
      `INSERT INTO lead_statuses (code, label, sort_order) VALUES ('assigned', 'Assigned', 2)
       ON CONFLICT (code) DO UPDATE SET code = EXCLUDED.code RETURNING id`,
    ));
    ({ rows: [{ id: conversationStatusId }] } = await client.query(
      `INSERT INTO conversation_statuses (code, label, sort_order) VALUES ('open', 'Open', 1)
       ON CONFLICT (code) DO UPDATE SET code = EXCLUDED.code RETURNING id`,
    ));
    ({ rows: [{ id: sellerId }] } = await client.query(
      `INSERT INTO sellers (name, is_active, sort_order, crm_user_id)
       VALUES ('CRM Seller', TRUE, 90000 + (random() * 9000)::int, $1) RETURNING id`,
      [SELLER_UUID],
    ));
  });
  afterEach(async () => { await client.query('ROLLBACK'); });

  const insertLead = async ({ requirement = '50 bloques', createdAt = '2100-01-02T00:00:00Z', seller = sellerId } = {}) => {
    sequence += 1;
    const phone = `5691${String(1000000 + sequence).slice(-7)}`;
    const { rows: [lead] } = await client.query(
      `INSERT INTO leads (whatsapp_name, phone_number, service, city, requirement, lead_status_id, assigned_seller_id, created_at)
       VALUES ('Ana', $1, 'instalacion', 'Santiago', $2, $3, $4, $5) RETURNING id`,
      [phone, requirement, leadStatusId, seller, createdAt],
    );
    const { rows: [conversation] } = await client.query(
      'INSERT INTO conversations (lead_id, phone_number, conversation_status_id) VALUES ($1, $2, $3) RETURNING id',
      [lead.id, phone, conversationStatusId],
    );
    await client.query('UPDATE leads SET source_conversation_id = $2 WHERE id = $1', [lead.id, conversation.id]);
    return String(lead.id);
  };

  // Stage A exactly as the workflow chains it: select, build, insert.
  const runEnqueue = async (since = SINCE, batch = 200) => {
    const { rows: candidates } = await client.query(selectSql, [since, String(batch)]);
    const results = [];
    for (const row of candidates) {
      const built = buildLeadQualifiedEvent(row, BUILD_CONFIG);
      const { rows } = await client.query(insertSql, [
        String(row.lead_id), String(built.revision ?? row.revision), built.event_id ?? '', built.conversation_id ?? '',
        built.body ?? '', String(row.requirement ?? ''), built.blocked_reason ?? '',
      ]);
      results.push(...rows);
    }
    return { candidates, results };
  };

  const eventsOf = async (leadId) => (await client.query(
    'SELECT * FROM crm_events WHERE lead_id = $1 ORDER BY revision', [leadId],
  )).rows;
  const leadOf = async (leadId) => (await client.query('SELECT * FROM leads WHERE id = $1', [leadId])).rows[0];

  const claim = async (batch = 200, stale = 900) => (await client.query(claimSql, [String(batch), String(stale)])).rows;
  const complete = async (row, outcome, extra = {}) => (await client.query(completeSql, [
    String(row.crm_event_id), row.claim_token, outcome,
    extra.http_status ?? '', extra.error ?? '', extra.response_json ?? '',
    extra.crm_customer_id ?? '', extra.crm_opportunity_id ?? '', String(extra.retry_delay_seconds ?? ''),
  ])).rows;

  describe('stage A — enqueue', () => {
    test('enqueues revision 1 once; re-running does not duplicate', async () => {
      const leadId = await insertLead();
      await runEnqueue();
      await runEnqueue();
      const events = await eventsOf(leadId);
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        event_id: `wa-test-lead-${leadId}-r1`, event_type: 'lead.qualified', revision: 1, status: 'pending', attempt_count: 0,
      });
      const body = JSON.parse(events[0].body);
      expect(body.data.crm_seller_id).toBe(SELLER_UUID);
      expect(body.data.phone).toMatch(/^\+569/);
      const lead = await leadOf(leadId);
      expect(lead.crm_enqueued_requirement).toBe('50 bloques');
      expect(lead.crm_blocked_reason).toBeNull();
    });

    test('a stale candidate (already enqueued by a concurrent run) inserts nothing', async () => {
      const leadId = await insertLead();
      const { rows: candidates } = await client.query(selectSql, [SINCE, '200']);
      const row = candidates.find((candidate) => String(candidate.lead_id) === leadId);
      const built = buildLeadQualifiedEvent(row, BUILD_CONFIG);
      const args = [leadId, '1', built.event_id, built.conversation_id, built.body, '50 bloques', ''];
      const [first] = (await client.query(insertSql, args)).rows;
      const [second] = (await client.query(insertSql, args)).rows;
      expect(first.enqueued).toBe(true);
      expect(second.enqueued).toBe(false);
      expect(await eventsOf(leadId)).toHaveLength(1);
    });

    test('a requirement correction enqueues revision 2 as a new event', async () => {
      const leadId = await insertLead();
      await runEnqueue();
      await client.query("UPDATE leads SET requirement = '80 bloques' WHERE id = $1", [leadId]);
      await runEnqueue();
      await runEnqueue();
      const events = await eventsOf(leadId);
      expect(events.map((event) => event.event_id)).toEqual([`wa-test-lead-${leadId}-r1`, `wa-test-lead-${leadId}-r2`]);
      expect(JSON.parse(events[1].body).data).toMatchObject({ revision: 2, requirement: '80 bloques' });
      expect(JSON.parse(events[0].body).data.requirement).toBe('50 bloques');
    });

    test('an unmapped seller blocks the lead until it is mapped', async () => {
      const { rows: [{ id: unmapped }] } = await client.query(
        "INSERT INTO sellers (name, is_active, sort_order) VALUES ('Unmapped', TRUE, 90000 + (random() * 9000)::int + 9001) RETURNING id",
      );
      const leadId = await insertLead({ seller: unmapped });
      await runEnqueue();
      expect(await eventsOf(leadId)).toHaveLength(0);
      expect((await leadOf(leadId)).crm_blocked_reason).toBe('seller_not_mapped');

      await client.query('UPDATE sellers SET crm_user_id = $2 WHERE id = $1', [unmapped, '0a0a0a0a-1b1b-4c2c-8d3d-4e4e4e4e4e4e']);
      await runEnqueue();
      const events = await eventsOf(leadId);
      expect(events).toHaveLength(1);
      expect(JSON.parse(events[0].body).data.crm_seller_id).toBe('0a0a0a0a-1b1b-4c2c-8d3d-4e4e4e4e4e4e');
      expect((await leadOf(leadId)).crm_blocked_reason).toBeNull();
    });

    test('a builder rejection blocks the lead without enqueuing', async () => {
      const leadId = await insertLead();
      await client.query("UPDATE leads SET phone_number = '123' WHERE id = $1", [leadId]);
      await runEnqueue();
      expect(await eventsOf(leadId)).toHaveLength(0);
      expect((await leadOf(leadId)).crm_blocked_reason).toBe('invalid_phone');
    });

    test('leads created before CRM_EVENTS_SINCE and leads without a seller are never selected', async () => {
      const old = await insertLead({ createdAt: '2099-12-31T23:59:59Z' });
      const unassigned = await insertLead({ seller: null });
      const fresh = await insertLead();
      const { candidates } = await runEnqueue();
      const ids = candidates.map((row) => String(row.lead_id));
      expect(ids).toContain(fresh);
      expect(ids).not.toContain(old);
      expect(ids).not.toContain(unassigned);
      expect(await eventsOf(old)).toHaveLength(0);
      expect((await leadOf(old)).crm_blocked_reason).toBeNull();
    });

    test('the batch limit bounds one pass', async () => {
      await insertLead();
      await insertLead();
      await insertLead();
      const { candidates } = await runEnqueue(SINCE, 2);
      expect(candidates).toHaveLength(2);
    });
  });

  describe('stage B — claim and complete', () => {
    const enqueueOne = async () => {
      const leadId = await insertLead();
      await runEnqueue();
      return leadId;
    };
    const claimOwn = async (leadId) => {
      const rows = await claim();
      const mine = rows.find((row) => row.event_id === `wa-test-lead-${leadId}-r1`);
      expect(mine, 'event was not claimed').toBeDefined();
      return mine;
    };

    test('claims with a token, increments attempts, and is not claimed twice', async () => {
      const leadId = await enqueueOne();
      const claimed = await claimOwn(leadId);
      expect(claimed.claim_token).toMatch(/^[0-9a-f-]{36}$/);
      expect(claimed.attempt_count).toBe(1);
      expect((await claim()).find((row) => row.event_id === claimed.event_id)).toBeUndefined();
      expect((await eventsOf(leadId))[0].status).toBe('processing');
    });

    test('200 delivers and writes the CRM ids and revision on the lead', async () => {
      const leadId = await enqueueOne();
      const claimed = await claimOwn(leadId);
      const response = JSON.stringify({ event_id: claimed.event_id, crm_customer_id: CUSTOMER_UUID, crm_opportunity_id: OPPORTUNITY_UUID });
      const [result] = await complete(claimed, 'delivered', {
        http_status: '200', response_json: response, crm_customer_id: CUSTOMER_UUID, crm_opportunity_id: OPPORTUNITY_UUID,
      });
      expect(result.status).toBe('delivered');
      const [event] = await eventsOf(leadId);
      expect(event).toMatchObject({ status: 'delivered', last_http_status: 200, claim_token: null });
      expect(event.delivered_at).not.toBeNull();
      expect(event.response).toEqual(JSON.parse(response));
      const lead = await leadOf(leadId);
      expect(lead).toMatchObject({ crm_customer_id: CUSTOMER_UUID, crm_opportunity_id: OPPORTUNITY_UUID, crm_revision: 1 });
    });

    test('a wrong claim token completes nothing', async () => {
      const leadId = await enqueueOne();
      const claimed = await claimOwn(leadId);
      const rows = await complete({ ...claimed, claim_token: crypto.randomUUID() }, 'delivered', {
        http_status: '200', crm_customer_id: CUSTOMER_UUID, crm_opportunity_id: OPPORTUNITY_UUID,
      });
      expect(rows).toHaveLength(0);
      expect((await eventsOf(leadId))[0].status).toBe('processing');
      expect((await leadOf(leadId)).crm_customer_id).toBeNull();
    });

    test('a retry goes back to pending with backoff and keeps the body bytes', async () => {
      const leadId = await enqueueOne();
      const [before] = await eventsOf(leadId);
      const claimed = await claimOwn(leadId);
      expect(claimed.body).toBe(before.body);
      await complete(claimed, 'retry', { http_status: '503', error: 'http_503:receiver_unavailable', retry_delay_seconds: 120 });
      const [event] = await eventsOf(leadId);
      expect(event).toMatchObject({ status: 'pending', last_http_status: 503, last_error: 'http_503:receiver_unavailable', claim_token: null, attempt_count: 1 });
      const { rows: [{ seconds }] } = await client.query(
        'SELECT EXTRACT(EPOCH FROM (next_attempt_at - NOW()))::int AS seconds FROM crm_events WHERE id = $1', [event.id],
      );
      expect(seconds).toBe(120);
      expect(event.body).toBe(before.body);
      // Not due yet: the claim skips it.
      expect((await claim()).find((row) => row.event_id === claimed.event_id)).toBeUndefined();
      // Once due it is claimed again with the identical stored body.
      await client.query("UPDATE crm_events SET next_attempt_at = NOW() - INTERVAL '1 second' WHERE id = $1", [event.id]);
      const again = await claimOwn(leadId);
      expect(again.attempt_count).toBe(2);
      expect(again.body).toBe(before.body);
      expect(again.claim_token).not.toBe(claimed.claim_token);
    });

    test('a non-retryable rejection parks the event', async () => {
      const leadId = await enqueueOne();
      const claimed = await claimOwn(leadId);
      await complete(claimed, 'parked', { http_status: '422', error: 'http_422:ambiguous_customer', response_json: '{"error":"ambiguous_customer"}' });
      const [event] = await eventsOf(leadId);
      expect(event).toMatchObject({ status: 'parked', last_http_status: 422, last_error: 'http_422:ambiguous_customer' });
      expect((await claim()).find((row) => row.event_id === claimed.event_id)).toBeUndefined();
      expect((await leadOf(leadId)).crm_customer_id).toBeNull();
    });

    test('a stale processing row is reclaimed with a new token; the old token is dead', async () => {
      const leadId = await enqueueOne();
      const claimed = await claimOwn(leadId);
      await client.query("UPDATE crm_events SET locked_at = NOW() - INTERVAL '1 hour' WHERE event_id = $1", [claimed.event_id]);
      const reclaimed = await claimOwn(leadId);
      expect(reclaimed.claim_token).not.toBe(claimed.claim_token);
      expect(reclaimed.body).toBe(claimed.body);
      expect(await complete(claimed, 'delivered', { http_status: '200' })).toHaveLength(0);
      expect(await complete(reclaimed, 'parked', { http_status: '401', error: 'http_401:unauthorized' })).toHaveLength(1);
    });

    test('an older revision delivered late does not overwrite a newer one', async () => {
      const leadId = await enqueueOne();
      await client.query("UPDATE leads SET requirement = '80 bloques' WHERE id = $1", [leadId]);
      await runEnqueue();
      const claimed = await claim();
      const r1 = claimed.find((row) => row.event_id === `wa-test-lead-${leadId}-r1`);
      const r2 = claimed.find((row) => row.event_id === `wa-test-lead-${leadId}-r2`);
      await complete(r2, 'delivered', { http_status: '200', crm_customer_id: CUSTOMER_UUID, crm_opportunity_id: OPPORTUNITY_UUID });
      await complete(r1, 'delivered', { http_status: '200', crm_customer_id: CUSTOMER_UUID, crm_opportunity_id: '99999999-7777-4888-9999-aaaaaaaaaaaa' });
      expect(await leadOf(leadId)).toMatchObject({ crm_revision: 2, crm_opportunity_id: OPPORTUNITY_UUID });
    });

    test('the stored body can never be rewritten', async () => {
      const leadId = await enqueueOne();
      await client.query('SAVEPOINT immutable');
      await expect(client.query("UPDATE crm_events SET body = '{}' WHERE lead_id = $1", [leadId])).rejects.toThrow(/immutable/);
      await client.query('ROLLBACK TO SAVEPOINT immutable');
    });
  });
});
