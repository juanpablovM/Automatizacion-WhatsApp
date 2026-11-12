// =============================================================================
// CRM revision 1.2b (migration 040): ownership_version, the bot -> CRM
// ownership.taken / ownership.released outbox stage, and the CRM -> bot
// chat.take / chat.release webhook (crm_inbound_apply_chat_event).
//
// The ClickUp ownership SQL is run UNCHANGED from db/queries/n8n/
// lead-chat-ownership/ to prove that the shared version sequence and the
// CRM-held rows (no ClickUp task) coexist with the ClickUp path.
// Every test runs inside a transaction that is rolled back. NOW() is the
// transaction start, so expiry is simulated by moving response_due_at back.
// =============================================================================
import crypto from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import pg from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'vitest';

const require = createRequire(import.meta.url);
const { buildOwnershipEvent } = require('../fixtures/workflow-nodes/crm-events-dispatcher/crm-events-runtime.js');
const { verifyCrmInboundRequest } = require('../fixtures/workflow-nodes/crm-inbound-events/crm-inbound-runtime.js');
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

const ownershipSql = (file) => fs.readFileSync(`db/queries/n8n/lead-chat-ownership/${file}`, 'utf8');
const acquireSql = ownershipSql('01_acquire_ownership_from_clickup.sql');
const releaseSql = ownershipSql('02_release_ownership_from_clickup.sql');
const humanReplySql = ownershipSql('04_register_human_reply.sql');
const loadStateSql = ownershipSql('05_load_ownership_state.sql');
const claimExpiredSql = ownershipSql('06_claim_expired_ownerships.sql');
const claimReacquisitionsSql = ownershipSql('09_claim_clickup_reacquisitions.sql');
const dispatcherSql = (file) => fs.readFileSync(`db/queries/n8n/crm-events-dispatcher/${file}`, 'utf8');
const selectOwnershipSql = dispatcherSql('07_select_ownership_candidates.sql');
const insertOwnershipSql = dispatcherSql('08_insert_ownership_events.sql');
const claimSql = dispatcherSql('03_claim_crm_events.sql');
const applyChatSql = fs.readFileSync('db/queries/n8n/crm-inbound-events/01_apply_crm_chat_event.sql', 'utf8');

const PREFIX = 'ownb';
const SINCE = '2000-01-01T00:00:00.000Z';
const CONFIG_12 = { protocol_revision: '1.2', id_prefix: PREFIX };
const SELLER_A = '6f1c2a34-5b6d-4e7f-8a9b-0c1d2e3f4a5b';
const SELLER_B = '7a2d3b45-6c7e-4f80-9bac-1d2e3f4a5b6c';
const OPPORTUNITY = '66666666-7777-4888-9999-aaaaaaaaaaaa';
const INBOUND_SECRET = 'crm-inbound-integration-secret';

describeIntegration('CRM revision 1.2b: ownership version, events and chat webhook', () => {
  const client = new pg.Client(connection);
  let leadStatusId;
  let conversationStatusId;
  let sellerA;
  let sellerB;
  let sourceNumberId;
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
    // Other suites may have mapped these UUIDs; the unique index only covers
    // live sellers, so free them inside this rolled-back transaction.
    await client.query('UPDATE sellers SET crm_user_id = NULL WHERE crm_user_id IN ($1, $2)', [SELLER_A, SELLER_B]);
    await client.query('UPDATE leads SET crm_opportunity_id = NULL WHERE crm_opportunity_id = $1', [OPPORTUNITY]);
    ({ rows: [{ id: sellerA }] } = await client.query(
      `INSERT INTO sellers (name, is_active, sort_order, crm_user_id)
       VALUES ('Seller A', TRUE, 90000 + (random() * 9000)::int, $1) RETURNING id`, [SELLER_A],
    ));
    ({ rows: [{ id: sellerB }] } = await client.query(
      `INSERT INTO sellers (name, is_active, sort_order, crm_user_id)
       VALUES ('Seller B', TRUE, 90000 + (random() * 9000)::int, $1) RETURNING id`, [SELLER_B],
    ));
    ({ rows: [{ id: sourceNumberId }] } = await client.query(
      `INSERT INTO whatsapp_numbers (display_name, phone_number, phone_number_id)
       VALUES ('Ventas', '56223456789', 'crm-12b-' || gen_random_uuid()) RETURNING id`,
    ));
  });
  afterEach(async () => { await client.query('ROLLBACK'); });

  const insertLead = async ({ seller = sellerA, opportunity = OPPORTUNITY, conversation = true, customerMessage = false } = {}) => {
    sequence += 1;
    const phone = `5693${String(1000000 + sequence).slice(-7)}`;
    const taskId = `own12b-task-${sequence}-${crypto.randomUUID()}`;
    const { rows: [lead] } = await client.query(
      `INSERT INTO leads (whatsapp_name, phone_number, lead_status_id, assigned_seller_id, source_number_id,
                          clickup_task_id, crm_opportunity_id, channel)
       VALUES ('Ana', $1, $2, $3, $4, $5, $6, 'whatsapp') RETURNING id`,
      [phone, leadStatusId, seller, sourceNumberId, taskId, opportunity],
    );
    let conversationId = null;
    if (conversation) {
      ({ rows: [{ id: conversationId }] } = await client.query(
        `INSERT INTO conversations (lead_id, phone_number, conversation_status_id, source_number_id)
         VALUES ($1, $2, $3, $4) RETURNING id`,
        [lead.id, phone, conversationStatusId, sourceNumberId],
      ));
      if (customerMessage) {
        await client.query(
          `INSERT INTO messages (conversation_id, lead_id, direction, sender_type, message_type, text_body, raw_payload)
           VALUES ($1, $2, 'incoming', 'customer', 'text', 'hola', '{}'::jsonb)`,
          [conversationId, lead.id],
        );
      }
    }
    return { leadId: String(lead.id), conversationId: conversationId && String(conversationId), taskId, phone };
  };

  const announce = async ({ leadId, conversationId }) => client.query(
    `INSERT INTO crm_events (event_id, event_type, conversation_id, lead_id, revision, body, status, delivered_at)
     VALUES ($1, 'lead.qualified', $2, $3, 1, '{}', 'delivered', NOW())`,
    [`wa-${PREFIX}-lead-${leadId}-r1`, `wa-${PREFIX}-conversation-${conversationId}`, leadId],
  );

  const clickupAcquire = (taskId, previousStatus = 'nueva') => client.query(acquireSql, [
    taskId, previousStatus, `hist-${crypto.randomUUID()}`, new Date().toISOString(), 'in progress', 'cotización enviada',
  ]);
  const clickupRelease = (taskId) => client.query(releaseSql, [
    taskId, 'nueva', `hist-${crypto.randomUUID()}`, new Date(Date.now() + 1000).toISOString(),
  ]);
  const versionOf = async (conversationId) => (await client.query(
    'SELECT * FROM crm_conversation_ownership WHERE conversation_id = $1', [conversationId],
  )).rows[0];
  const changesOf = async (conversationId) => (await client.query(
    'SELECT * FROM crm_ownership_changes WHERE conversation_id = $1 ORDER BY ownership_version', [conversationId],
  )).rows;
  const ownershipsOf = async (leadId) => (await client.query(
    'SELECT * FROM lead_chat_ownerships WHERE lead_id = $1 ORDER BY id', [leadId],
  )).rows;
  const botSuppressed = async (leadId) => (await client.query(loadStateSql, [leadId])).rows[0].bot_suppressed;
  const expireActive = (leadId) => client.query(
    `UPDATE lead_chat_ownerships SET response_due_at = NOW() - INTERVAL '1 minute'
     WHERE lead_id = $1 AND released_at IS NULL`, [leadId],
  );

  const applyChat = async ({
    eventId = `crm-evt-${crypto.randomUUID()}`, type = 'chat.take', seller = SELLER_A,
    opportunity = OPPORTUNITY, version = 0, hash = crypto.createHash('sha256').update(eventId).digest('hex'),
  } = {}) => {
    const { rows: [row] } = await client.query(applyChatSql, [eventId, hash, type, opportunity, seller, String(version)]);
    return { ...row, eventId, hash };
  };

  describe('ownership_version from the ClickUp path (ClickUp SQL unchanged)', () => {
    test('a ClickUp acquire and release each advance the version and record the change', async () => {
      const lead = await insertLead();
      await clickupAcquire(lead.taskId);
      expect(await versionOf(lead.conversationId)).toMatchObject({
        ownership_version: '1', owner_kind: 'seller', seller_id: String(sellerA), source: 'clickup', reason: null,
      });
      await clickupRelease(lead.taskId);
      expect(await versionOf(lead.conversationId)).toMatchObject({
        ownership_version: '2', owner_kind: 'bot', seller_id: null, source: 'clickup', reason: 'seller_released',
      });
      expect((await changesOf(lead.conversationId)).map((c) => [c.ownership_version, c.change_kind, c.source, c.reason, c.raw_reason]))
        .toEqual([['1', 'taken', 'clickup', null, null], ['2', 'released', 'clickup', 'seller_released', 'clickup_released']]);
    });

    test('a ClickUp re-delivery of the same take does not advance the version', async () => {
      const lead = await insertLead();
      await clickupAcquire(lead.taskId);
      await clickupAcquire(lead.taskId);
      expect((await versionOf(lead.conversationId)).ownership_version).toBe('1');
    });

    test('SLA expiry from the lease sweeper advances the version with sla_expired', async () => {
      const lead = await insertLead();
      await clickupAcquire(lead.taskId);
      await expireActive(lead.leadId);
      await client.query(claimExpiredSql, ['500', '900']);
      expect(await versionOf(lead.conversationId)).toMatchObject({ ownership_version: '2', reason: 'sla_expired', source: 'bot' });
    });

    test.each([
      ['customer_new_quote', 'customer_new_quote'],
      ['manual', 'seller_released'],
    ])('release_reason %s maps to %s', async (raw, mapped) => {
      const lead = await insertLead();
      await clickupAcquire(lead.taskId);
      await client.query(
        `UPDATE lead_chat_ownerships SET released_at = NOW(), release_reason = $2 WHERE lead_id = $1 AND released_at IS NULL`,
        [lead.leadId, raw],
      );
      const [, released] = await changesOf(lead.conversationId);
      expect(released).toMatchObject({ change_kind: 'released', reason: mapped, raw_reason: raw });
    });

    test('the version is shared by ClickUp and CRM changes and only grows', async () => {
      const lead = await insertLead();
      await clickupAcquire(lead.taskId);
      await clickupRelease(lead.taskId);
      const taken = await applyChat({ version: 2 });
      expect(taken.response).toMatchObject({ result: 'applied', ownership_version: 3 });
      await clickupRelease(lead.taskId);
      expect((await changesOf(lead.conversationId)).map((c) => Number(c.ownership_version))).toEqual([1, 2, 3, 4]);
    });

    test('a lead without a conversation still takes ownership; nothing is versioned', async () => {
      const lead = await insertLead({ conversation: false });
      const { rows: [result] } = await clickupAcquire(lead.taskId);
      expect(result.outcome).toBe('acquired');
      expect((await client.query('SELECT COUNT(*)::int AS n FROM crm_ownership_changes WHERE lead_id = $1', [lead.leadId])).rows[0].n).toBe(0);
    });

    test('a failure inside the tracking trigger never fails the ClickUp write', async () => {
      const lead = await insertLead();
      await client.query('ALTER TABLE crm_ownership_changes ADD CONSTRAINT crm_test_reject_all CHECK (FALSE) NOT VALID');
      const { rows: [result] } = await clickupAcquire(lead.taskId);
      expect(result.outcome).toBe('acquired');
      expect(await botSuppressed(lead.leadId)).toBe(true);
      expect(await versionOf(lead.conversationId)).toBeUndefined();
    });
  });

  describe('chat.take / chat.release (crm_inbound_apply_chat_event)', () => {
    test('take on a bot-owned chat silences the bot like a ClickUp take, without ClickUp columns', async () => {
      const lead = await insertLead({ customerMessage: true });
      const result = await applyChat({ version: 0 });
      expect(result.http_status).toBe(200);
      expect(result.response).toEqual({ event_id: result.eventId, result: 'applied', ownership_version: 1 });
      const [row] = await ownershipsOf(lead.leadId);
      expect(row).toMatchObject({
        clickup_task_id: null, previous_clickup_status: null, acquired_via: 'crm', owner_seller_id: String(sellerA),
        sla_mode: 'standard', restoration_state: 'not_required', released_at: null,
      });
      expect(row.pending_message_id).not.toBeNull();
      expect(new Date(row.response_due_at).getTime()).toBeGreaterThan(Date.now() + 60 * 60 * 1000);
      expect(await botSuppressed(lead.leadId)).toBe(true);
      expect(await versionOf(lead.conversationId)).toMatchObject({ ownership_version: '1', source: 'crm', seller_id: String(sellerA) });
    });

    test('take without a pending customer message holds the chat with no deadline yet', async () => {
      const lead = await insertLead();
      await applyChat();
      const [row] = await ownershipsOf(lead.leadId);
      expect(row.response_due_at).toBeNull();
      expect(await botSuppressed(lead.leadId)).toBe(true);
    });

    test('release by the holder gives the chat back to the bot', async () => {
      const lead = await insertLead();
      await applyChat({ version: 0 });
      const result = await applyChat({ type: 'chat.release', version: 1 });
      expect(result.response).toMatchObject({ result: 'applied', ownership_version: 2 });
      const [row] = await ownershipsOf(lead.leadId);
      expect(row).toMatchObject({ release_reason: 'manual', released_via: 'crm', restoration_state: 'not_required' });
      expect(await botSuppressed(lead.leadId)).toBe(false);
      const [, released] = await changesOf(lead.conversationId);
      expect(released).toMatchObject({ change_kind: 'released', reason: 'seller_released', source: 'crm' });
    });

    test('release when the bot already owns the chat is ignored_stale', async () => {
      const lead = await insertLead();
      const result = await applyChat({ type: 'chat.release', version: 0 });
      expect(result).toMatchObject({ http_status: 200, response: { result: 'ignored_stale', ownership_version: 0 } });
      expect(await ownershipsOf(lead.leadId)).toEqual([]);
    });

    test('a take carrying an older version is ignored_stale and changes nothing', async () => {
      const lead = await insertLead();
      await clickupAcquire(lead.taskId);
      await clickupRelease(lead.taskId);
      const result = await applyChat({ version: 1 });
      expect(result).toMatchObject({ http_status: 200, response: { result: 'ignored_stale', ownership_version: 2 } });
      expect(await botSuppressed(lead.leadId)).toBe(false);
    });

    test('a take on a chat another seller holds is a 409 naming the holder', async () => {
      const lead = await insertLead({ seller: sellerB });
      await clickupAcquire(lead.taskId);
      const result = await applyChat({ seller: SELLER_A, version: 1 });
      expect(result.http_status).toBe(409);
      expect(result.response).toEqual({ error: 'ownership_conflict', holder_crm_seller_id: SELLER_B, ownership_version: 1 });
      expect(await ownershipsOf(lead.leadId)).toHaveLength(1);
    });

    test('a holder without a CRM mapping is reported as null', async () => {
      const { rows: [{ id: unmapped }] } = await client.query(
        `INSERT INTO sellers (name, is_active, sort_order) VALUES ('Unmapped', TRUE, 90000 + (random() * 9000)::int) RETURNING id`,
      );
      const lead = await insertLead({ seller: unmapped });
      await clickupAcquire(lead.taskId);
      const result = await applyChat({ version: 1 });
      expect(result.response).toEqual({ error: 'ownership_conflict', holder_crm_seller_id: null, ownership_version: 1 });
    });

    test('a release by a seller who does not hold the chat is a 409', async () => {
      await insertLead();
      await applyChat({ seller: SELLER_A, version: 0 });
      const result = await applyChat({ type: 'chat.release', seller: SELLER_B, version: 1 });
      expect(result).toMatchObject({ http_status: 409, response: { error: 'ownership_conflict', holder_crm_seller_id: SELLER_A } });
    });

    test('a take by the seller who already holds the chat is applied without a new version', async () => {
      const lead = await insertLead();
      await clickupAcquire(lead.taskId);
      const result = await applyChat({ seller: SELLER_A, version: 1 });
      expect(result.response).toMatchObject({ result: 'applied', ownership_version: 1 });
      expect(await ownershipsOf(lead.leadId)).toHaveLength(1);
    });

    test('a take on a lease whose SLA expired before the sweep releases it as sla_expired first', async () => {
      const lead = await insertLead();
      await clickupAcquire(lead.taskId, 'nueva');
      await expireActive(lead.leadId);
      const result = await applyChat({ seller: SELLER_B, version: 1 });
      expect(result.response).toMatchObject({ result: 'applied', ownership_version: 3 });
      const [expired, crmHeld] = await ownershipsOf(lead.leadId);
      // The ClickUp restoration is left to the lease sweeper's stale-claim branch.
      expect(expired).toMatchObject({ release_reason: 'sla_expired', restoration_state: 'pending' });
      expect(crmHeld).toMatchObject({ acquired_via: 'crm', owner_seller_id: String(sellerB) });
      expect((await changesOf(lead.conversationId)).map((c) => c.reason ?? c.source)).toEqual(['clickup', 'sla_expired', 'crm']);
      const claimed = (await client.query(claimExpiredSql, ['500', '900'])).rows.filter((r) => r.ownership_id === expired.id);
      expect(claimed).toMatchObject([{ restoration_state: 'processing', clickup_task_id: lead.taskId }]);
    });

    test('an unknown opportunity is 422 invalid_opportunity', async () => {
      await insertLead();
      const result = await applyChat({ opportunity: '00000000-0000-4000-8000-000000000000' });
      expect(result).toMatchObject({ http_status: 422, response: { error: 'invalid_opportunity' } });
    });

    test('an unmapped or inactive seller is 422 invalid_seller', async () => {
      await insertLead();
      expect((await applyChat({ seller: '00000000-0000-4000-8000-000000000000' })).response.error).toBe('invalid_seller');
      await client.query('UPDATE sellers SET is_active = FALSE WHERE id = $1', [sellerB]);
      expect((await applyChat({ seller: SELLER_B })).response.error).toBe('invalid_seller');
    });

    test('the same event id with the same bytes returns the stored response and applies once', async () => {
      const lead = await insertLead();
      const first = await applyChat({ eventId: 'crm-evt-dup', version: 0 });
      const again = await applyChat({ eventId: 'crm-evt-dup', hash: first.hash, version: 0 });
      expect(again).toMatchObject({ http_status: first.http_status, response: first.response, replayed: true });
      expect(await ownershipsOf(lead.leadId)).toHaveLength(1);
      expect((await versionOf(lead.conversationId)).ownership_version).toBe('1');
    });

    test('the same event id with different bytes is 409 event_conflict', async () => {
      await insertLead();
      await applyChat({ eventId: 'crm-evt-conflict', version: 0 });
      const other = await applyChat({ eventId: 'crm-evt-conflict', hash: 'f'.repeat(64), version: 0 });
      expect(other).toMatchObject({ http_status: 409, response: { error: 'event_conflict', event_id: 'crm-evt-conflict' } });
    });

    test('a stored rejection is replayed too', async () => {
      await insertLead();
      const first = await applyChat({ eventId: 'crm-evt-422', seller: '00000000-0000-4000-8000-000000000000' });
      const again = await applyChat({ eventId: 'crm-evt-422', hash: first.hash, seller: '00000000-0000-4000-8000-000000000000' });
      expect(again).toMatchObject({ http_status: 422, replayed: true });
    });

    test('a signed request flows from verification to the database; a bad signature never reaches it', async () => {
      const lead = await insertLead();
      const raw = Buffer.from(JSON.stringify({
        schema_version: 1, protocol_revision: '1.2', event_id: 'crm-evt-signed', type: 'chat.take',
        occurred_at: '2026-11-11T15:00:00Z',
        data: { crm_opportunity_id: OPPORTUNITY, crm_seller_id: SELLER_A, ownership_version: 0 },
      }));
      const timestamp = String(Math.floor(Date.now() / 1000));
      const signature = `v1=${crypto.createHmac('sha256', INBOUND_SECRET).update(Buffer.concat([Buffer.from(`${timestamp}.`), raw])).digest('hex')}`;
      const env = { CRM_INBOUND_ENABLED: 'true', CRM_INBOUND_HMAC_SECRET: INBOUND_SECRET };
      const verify = (sig) => verifyCrmInboundRequest({
        rawBody: raw, headers: { 'x-crm-timestamp': timestamp, 'x-crm-signature': sig }, env, now: Date.now(), crypto,
      });
      expect(verify(`v1=${'0'.repeat(64)}`)).toMatchObject({ http_status: 401 });
      const verified = verify(signature);
      const { rows: [row] } = await client.query(applyChatSql, [
        verified.event_id, verified.body_sha256, verified.event_type,
        verified.crm_opportunity_id, verified.crm_seller_id, verified.ownership_version,
      ]);
      expect(row).toMatchObject({ http_status: 200, response: { result: 'applied', ownership_version: 1 } });
      expect(await botSuppressed(lead.leadId)).toBe(true);
    });
  });

  describe('the ClickUp lease scheduler on a CRM-held chat (ClickUp SQL unchanged)', () => {
    test('SLA expiry releases it as sla_expired and queues no ClickUp operation', async () => {
      const lead = await insertLead({ customerMessage: true });
      await applyChat();
      await expireActive(lead.leadId);
      const claimed = (await client.query(claimExpiredSql, ['500', '900'])).rows;
      const [row] = await ownershipsOf(lead.leadId);
      expect(row).toMatchObject({ release_reason: 'sla_expired', clickup_task_id: null });
      expect(claimed.filter((c) => c.ownership_id === row.id)).toMatchObject([{ restoration_state: 'skipped_no_previous_status' }]);
      const ops = await client.query(
        "SELECT COUNT(*)::int AS n FROM external_operations WHERE entity_type = 'lead_chat_ownership' AND entity_id = $1", [row.id],
      );
      expect(ops.rows[0].n).toBe(0);
      expect(await botSuppressed(lead.leadId)).toBe(false);
      expect((await changesOf(lead.conversationId)).map((c) => c.reason)).toEqual([null, 'sla_expired']);
    });

    test('a late seller reply after a CRM release reacquires without a ClickUp task, and the reacquisition is skipped', async () => {
      const lead = await insertLead();
      await applyChat({ version: 0 });
      await applyChat({ type: 'chat.release', version: 1 });
      const { rows: [{ id: messageId }] } = await client.query(
        `INSERT INTO messages (conversation_id, lead_id, direction, sender_type, message_type, text_body, raw_payload)
         VALUES ($1, $2, 'outgoing', 'human', 'text', 'te escribo yo', '{}'::jsonb) RETURNING id`,
        [lead.conversationId, lead.leadId],
      );
      const { rows: [reply] } = await client.query(humanReplySql, [lead.leadId, messageId, null, null, null, 'in progress']);
      expect(reply.outcome).toBe('late_reply_reacquired');
      const rows = await ownershipsOf(lead.leadId);
      expect(rows[1]).toMatchObject({ clickup_task_id: null, released_at: null });
      const claimed = (await client.query(claimReacquisitionsSql, ['500', '300', '60', '5'])).rows
        .filter((r) => r.ownership_id === rows[1].id);
      expect(claimed).toMatchObject([{ should_dispatch_reacquisition: false, reacquisition_blocker: 'clickup_task_id_missing' }]);
      expect((await versionOf(lead.conversationId)).ownership_version).toBe('3');
    });
  });

  describe('ownership outbox stage (dispatcher 07/08)', () => {
    const runOwnershipEnqueue = async (revision = '1.2') => {
      const { rows: candidates } = await client.query(selectOwnershipSql, [revision, SINCE, PREFIX, '500']);
      const events = candidates.map((row) => {
        const built = buildOwnershipEvent(row, { protocol_revision: revision, id_prefix: PREFIX });
        return {
          change_id: Number(row.change_id), event_id: built.event_id, conversation_id: built.conversation_id,
          event_type: built.body ? JSON.parse(built.body).type : null, body: built.body, blocked_reason: built.blocked_reason,
        };
      });
      const { rows: [counts] } = await client.query(insertOwnershipSql, [JSON.stringify(events)]);
      return { candidates, counts };
    };
    const ownershipEventsOf = async (conversationId) => (await client.query(
      `SELECT e.* FROM crm_events e JOIN crm_ownership_changes c ON c.id = e.ownership_change_id
       WHERE c.conversation_id = $1 ORDER BY c.ownership_version`, [conversationId],
    )).rows;

    test('enqueues one valid event per version change once the CRM knows the conversation', async () => {
      const lead = await insertLead();
      await clickupAcquire(lead.taskId);
      await clickupRelease(lead.taskId);
      expect((await runOwnershipEnqueue()).candidates.filter((c) => String(c.conversation_id) === lead.conversationId)).toEqual([]);

      await announce(lead);
      await runOwnershipEnqueue();
      const events = await ownershipEventsOf(lead.conversationId);
      expect(events.map((e) => [e.event_type, e.event_id, e.lead_id, e.revision])).toEqual([
        ['ownership.taken', `wa-${PREFIX}-ownership-${lead.conversationId}-v1`, null, 1],
        ['ownership.released', `wa-${PREFIX}-ownership-${lead.conversationId}-v2`, null, 1],
      ]);
      for (const event of events) expect(validateCrmEvent(event.body)).toEqual([]);
      expect(JSON.parse(events[0].body).data).toEqual({ version: 1, crm_seller_id: SELLER_A, source: 'clickup' });
      expect(JSON.parse(events[1].body).data).toEqual({ version: 2, reason: 'seller_released' });

      await runOwnershipEnqueue();
      expect(await ownershipEventsOf(lead.conversationId)).toHaveLength(2);
      const claimed = (await client.query(claimSql, ['500', '900'])).rows.filter((r) => r.event_type.startsWith('ownership.'));
      expect(claimed.map((r) => r.event_id)).toEqual(expect.arrayContaining(events.map((e) => e.event_id)));
    });

    test('a CRM take is echoed back as ownership.taken with source crm', async () => {
      const lead = await insertLead();
      await announce(lead);
      await applyChat();
      await runOwnershipEnqueue();
      const [event] = await ownershipEventsOf(lead.conversationId);
      expect(JSON.parse(event.body).data).toEqual({ version: 1, crm_seller_id: SELLER_A, source: 'crm' });
    });

    test('under revision 1.1 nothing is selected', async () => {
      const lead = await insertLead();
      await announce(lead);
      await clickupAcquire(lead.taskId);
      const { candidates } = await runOwnershipEnqueue('1.1');
      expect(candidates).toEqual([]);
      expect(await ownershipEventsOf(lead.conversationId)).toEqual([]);
    });

    test('a blocked change is recorded and goes last', async () => {
      const lead = await insertLead();
      await announce(lead);
      await clickupAcquire(lead.taskId);
      const [change] = await changesOf(lead.conversationId);
      const { rows: [counts] } = await client.query(insertOwnershipSql, [JSON.stringify([
        { change_id: Number(change.id), event_id: null, conversation_id: null, event_type: null, body: null, blocked_reason: 'invalid_version' },
      ])]);
      expect(counts).toMatchObject({ enqueued: 0, blocked: 1 });
      expect((await changesOf(lead.conversationId))[0].crm_blocked_reason).toBe('invalid_version');
      await runOwnershipEnqueue();
      expect((await changesOf(lead.conversationId))[0].crm_blocked_reason).toBeNull();
      expect(await ownershipEventsOf(lead.conversationId)).toHaveLength(1);
    });

    test('crm_events refuses an ownership event without its change, and keeps its identity immutable', async () => {
      const lead = await insertLead();
      await expect(client.query('SAVEPOINT s1').then(() => client.query(
        `INSERT INTO crm_events (event_id, event_type, conversation_id, revision, body)
         VALUES ('wa-ownb-x', 'ownership.taken', 'wa-ownb-conversation-1', 1, '{}')`,
      ))).rejects.toThrow(/crm_events_identity_check/);
      await client.query('ROLLBACK TO SAVEPOINT s1');
      await expect(client.query('SAVEPOINT s2').then(() => client.query(
        `INSERT INTO crm_events (event_id, event_type, conversation_id, revision, body)
         VALUES ('wa-ownb-y', 'bogus.type', 'wa-ownb-conversation-1', 1, '{}')`,
      ))).rejects.toThrow(/crm_events_event_type_check/);
      await client.query('ROLLBACK TO SAVEPOINT s2');
      await announce(lead);
      await clickupAcquire(lead.taskId);
      await runOwnershipEnqueue();
      const [event] = await ownershipEventsOf(lead.conversationId);
      await expect(client.query('SAVEPOINT s3').then(() => client.query(
        'UPDATE crm_events SET ownership_change_id = NULL WHERE id = $1', [event.id],
      ))).rejects.toThrow(/immutable/);
      await client.query('ROLLBACK TO SAVEPOINT s3');
    });
  });
});
