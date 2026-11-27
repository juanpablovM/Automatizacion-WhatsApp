// =============================================================================
// CRM 1.3 per-contact ownership counter (U6: S8, contract §4.4; migration
// 056). crm_contacts.ownership_version is one counter per contact, seeded
// above the highest per-conversation version of any of its conversations;
// every tracked take/release advances both the conversation's version (1.2,
// unchanged) and the contact's, and stores contact_id + contact_version on
// the change. Under 1.3 ownership.* carry the contact counter as data.version
// and an event id unique per contact version; 1.2 bodies are unchanged.
// Feature document: odd/tasks/crm-1-3-customer-threads.md. Every test runs in
// a transaction that is rolled back; rows live in 2100 with a matching SINCE.
// =============================================================================
import fs from 'node:fs';
import { createRequire } from 'node:module';
import pg from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'vitest';

const require = createRequire(import.meta.url);
const {
  buildOwnershipEvent,
  buildContactUpsertedEvent,
  isCrmEventDeferred,
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

const sql = (file) => fs.readFileSync(`db/queries/n8n/crm-events-dispatcher/${file}`, 'utf8');
const selectOwnershipSql = sql('07_select_ownership_candidates.sql');
const insertOwnershipSql = sql('08_insert_ownership_events.sql');
const selectContactsSql = sql('11_select_contact_candidates.sql');
const insertContactsSql = sql('12_insert_contact_events.sql');

const SINCE = '2100-01-01T00:00:00.000Z';
const SELLER_UUID = '6f1c2a34-5b6d-4e7f-8a9b-0c1d2e3f4a5b';
const config = (revision, prefix = 'test') => ({ protocol_revision: revision, id_prefix: prefix });
const C12 = config('1.2');
const C13 = config('1.3');

describeIntegration('CRM 1.3 per-contact ownership counter', () => {
  const client = new pg.Client(connection);
  let conversationStatusId;
  let sellerId;
  let sourceNumberId;
  let sequence = 0;

  beforeAll(async () => { await client.connect(); });
  afterAll(async () => { await client.end(); });

  beforeEach(async () => {
    await client.query('BEGIN');
    ({ rows: [{ id: conversationStatusId }] } = await client.query(
      `INSERT INTO conversation_statuses (code, label, sort_order) VALUES ('open', 'Open', 1)
       ON CONFLICT (code) DO UPDATE SET code = EXCLUDED.code RETURNING id`,
    ));
    await client.query('UPDATE sellers SET crm_user_id = NULL WHERE crm_user_id = $1', [SELLER_UUID]);
    ({ rows: [{ id: sellerId }] } = await client.query(
      `INSERT INTO sellers (name, is_active, sort_order, crm_user_id)
       VALUES ('CRM Seller', TRUE, 90000 + (random() * 9000)::int, $1) RETURNING id`, [SELLER_UUID],
    ));
    ({ rows: [{ id: sourceNumberId }] } = await client.query(
      `INSERT INTO whatsapp_numbers (display_name, phone_number, phone_number_id)
       VALUES ('Ventas', '56223456789', 'crm-13o-' || gen_random_uuid()) RETURNING id`,
    ));
  });
  afterEach(async () => { await client.query('ROLLBACK'); });

  const nextPhone = () => {
    sequence += 1;
    return `5694${String(1000000 + sequence).slice(-7)}`;
  };

  const conversation = async (phone) => {
    const { rows: [row] } = await client.query(
      `INSERT INTO conversations (phone_number, conversation_status_id, source_number_id, created_at)
       VALUES ($1, $2, $3, '2100-01-02T00:00:00Z') RETURNING id`,
      [phone, conversationStatusId, sourceNumberId],
    );
    return String(row.id);
  };
  const contactOf = async (phone) => String((await client.query(
    'SELECT crm_contact_ref($1, $2) AS id', [sourceNumberId, phone],
  )).rows[0].id);
  const contactCounter = async (contactId) => Number((await client.query(
    'SELECT ownership_version FROM crm_contacts WHERE id = $1', [contactId],
  )).rows[0].ownership_version);
  const conversationVersion = async (conversationId) => Number((await client.query(
    'SELECT ownership_version FROM crm_conversation_ownership WHERE conversation_id = $1', [conversationId],
  )).rows[0]?.ownership_version ?? 0);
  const changesOf = async (conversationId) => (await client.query(
    'SELECT * FROM crm_ownership_changes WHERE conversation_id = $1 ORDER BY ownership_version', [conversationId],
  )).rows;

  // Conversation-keyed CRM take / release through the tracking trigger; the
  // change is moved into the test window (changed_at defaults to NOW()).
  const take = async (conversationId) => {
    await client.query(
      `INSERT INTO lead_chat_ownerships (conversation_id, acquired_via, owner_seller_id) VALUES ($1, 'crm', $2)`,
      [conversationId, sellerId],
    );
    await client.query(`UPDATE crm_ownership_changes SET changed_at = '2100-01-03T00:00:00Z' WHERE conversation_id = $1`, [conversationId]);
  };
  const release = async (conversationId) => {
    await client.query(
      `UPDATE lead_chat_ownerships SET released_at = NOW(), release_reason = 'sla_expired'
       WHERE conversation_id = $1 AND released_at IS NULL`, [conversationId],
    );
    await client.query(`UPDATE crm_ownership_changes SET changed_at = '2100-01-03T00:00:00Z' WHERE conversation_id = $1`, [conversationId]);
  };

  const runContacts = async (cfg = C13) => {
    const { rows } = await client.query(selectContactsSql, [cfg.protocol_revision, SINCE, cfg.id_prefix, '', '500']);
    const events = rows.map((row) => {
      const built = buildContactUpsertedEvent(row, cfg);
      return { contact_id: Number(row.contact_id), revision: built.revision ?? Number(row.revision), event_id: built.event_id, body: built.body, blocked_reason: built.blocked_reason };
    });
    await client.query(insertContactsSql, [JSON.stringify(events)]);
  };
  const runOwnership = async (cfg = C13) => {
    const { rows: candidates } = await client.query(selectOwnershipSql, [cfg.protocol_revision, SINCE, cfg.id_prefix, '500']);
    const events = candidates.map((row) => ({ row, built: buildOwnershipEvent(row, cfg) }))
      .filter(({ built }) => !isCrmEventDeferred(built))
      .map(({ row, built }) => ({ change_id: Number(row.change_id), event_id: built.event_id, conversation_id: built.conversation_id, event_type: built.body ? JSON.parse(built.body).type : null, body: built.body, blocked_reason: built.blocked_reason }));
    await client.query(insertOwnershipSql, [JSON.stringify(events)]);
    return candidates;
  };
  const ownershipEvents = async (where, params) => (await client.query(
    `SELECT * FROM crm_events WHERE event_type IN ('ownership.taken', 'ownership.released') AND ${where} ORDER BY id`, params,
  )).rows;

  describe('migration 056: the contact counter', () => {
    test('the seed puts each contact at the highest per-conversation version of its conversations', async () => {
      const phone = nextPhone();
      const a = await conversation(phone);
      const b = await conversation(phone);
      const contactId = await contactOf(phone);
      await client.query(
        `INSERT INTO crm_conversation_ownership (conversation_id, ownership_version) VALUES ($1, 3), ($2, 5)`, [a, b],
      );
      await client.query('UPDATE crm_contacts SET ownership_version = 0 WHERE id = $1', [contactId]);
      await client.query('SELECT crm_contacts_seed_ownership_version()');
      expect(await contactCounter(contactId)).toBe(5);
      // Never lowers a counter already above.
      await client.query('UPDATE crm_contacts SET ownership_version = 9 WHERE id = $1', [contactId]);
      await client.query('SELECT crm_contacts_seed_ownership_version()');
      expect(await contactCounter(contactId)).toBe(9);
    });

    test('every take and release advances both counters and stores contact_id + contact_version', async () => {
      const phone = nextPhone();
      const a = await conversation(phone);
      const b = await conversation(phone);
      const contactId = await contactOf(phone);
      await take(a);
      await release(a);
      await take(b);
      expect([await conversationVersion(a), await conversationVersion(b), await contactCounter(contactId)]).toEqual([2, 1, 3]);
      const rows = [...await changesOf(a), ...await changesOf(b)]
        .map((ch) => [String(ch.conversation_id), Number(ch.ownership_version), String(ch.contact_id), Number(ch.contact_version)]);
      expect(rows).toEqual([[a, 1, contactId, 1], [a, 2, contactId, 2], [b, 1, contactId, 3]]);
    });

    test('a contact counter below a conversation version (contact created later) still starts above it', async () => {
      const phone = nextPhone();
      const a = await conversation(phone);
      const b = await conversation(phone);
      const contactId = await contactOf(phone);
      await client.query(`INSERT INTO crm_conversation_ownership (conversation_id, ownership_version) VALUES ($1, 4)`, [a]);
      await client.query('UPDATE crm_contacts SET ownership_version = 0 WHERE id = $1', [contactId]);
      await take(b);
      expect(await conversationVersion(b)).toBe(1);
      expect(await contactCounter(contactId)).toBe(5);
    });

    test('a conversation without a source number keeps its per-conversation version and no contact', async () => {
      const { rows: [{ id }] } = await client.query(
        `INSERT INTO conversations (phone_number, conversation_status_id, created_at)
         VALUES ($1, $2, '2100-01-02T00:00:00Z') RETURNING id`, [nextPhone(), conversationStatusId],
      );
      await take(String(id));
      const [change] = await changesOf(String(id));
      expect(Number(change.ownership_version)).toBe(1);
      expect(change.contact_id).toBeNull();
      expect(change.contact_version).toBeNull();
    });
  });

  describe('dispatcher', () => {
    test('1.3 ownership events carry the contact counter and an id unique per contact version', async () => {
      const phone = nextPhone();
      const a = await conversation(phone);
      const b = await conversation(phone);
      const contactId = await contactOf(phone);
      await take(a);
      await take(b);
      await runContacts();
      await runOwnership();
      const events = await ownershipEvents('contact_id = $1', [contactId]);
      expect(events.map((event) => event.event_id)).toEqual([
        `wa-test-ownership-c${contactId}-v1`, `wa-test-ownership-c${contactId}-v2`,
      ]);
      const bodies = events.map((event) => JSON.parse(event.body));
      expect(bodies.map((body) => [body.conversation_id, body.data.version])).toEqual([
        [`wa-test-conversation-${a}`, 1], [`wa-test-conversation-${b}`, 2],
      ]);
      expect(bodies[0]).toEqual({
        schema_version: 1, protocol_revision: '1.3', event_id: `wa-test-ownership-c${contactId}-v1`, type: 'ownership.taken',
        conversation_id: `wa-test-conversation-${a}`, contact_id: `wa-test-contact-${contactId}`,
        data: { version: 1, crm_seller_id: SELLER_UUID, source: 'crm' },
      });
      for (const event of events) expect(validateCrmEvent(event.body)).toEqual([]);
    });

    test('a change without a contact counter (before 056) is not sent under 1.3, and is under 1.2', async () => {
      const phone = nextPhone();
      const a = await conversation(phone);
      const { rows: [{ id: changeId }] } = await client.query(
        `INSERT INTO crm_ownership_changes (conversation_id, ownership_version, change_kind, seller_id, source, changed_at)
         VALUES ($1, 1, 'taken', $2, 'crm', '2100-01-03T00:00:00Z') RETURNING id`, [a, sellerId],
      );
      await runContacts();
      const under13 = await runOwnership();
      expect(under13.map((row) => String(row.change_id))).not.toContain(String(changeId));
    });

    test('1.2 ownership bodies keep the per-conversation version and id', async () => {
      const phone = nextPhone();
      const a = await conversation(phone);
      const { rows: [{ id: handoffId }] } = await client.query(
        `INSERT INTO handoffs (idempotency_key, conversation_id, phone_number, source_number_id, motivo, area, area_label,
                               prioridad, responsable, estado, created_at)
         VALUES ('crm-13o-' || gen_random_uuid(), $1, $2, $3, 'talk_human', 'sales', 'Ventas', 'alta', 'Ejecutiva comercial', 'pending', '2100-01-03T00:00:00Z')
         RETURNING id`, [a, phone, sourceNumberId],
      );
      // Announced under 1.2 by a delivered handoff.created (1.2d).
      await client.query(
        `INSERT INTO crm_events (event_id, event_type, conversation_id, revision, body, status, handoff_id)
         VALUES ('wa-test-handoff-' || $1::text || '-r1', 'handoff.created', 'wa-test-conversation-' || $2::text, 1, '{}', 'delivered', $1::bigint)`,
        [handoffId, a],
      );
      await take(a);
      await release(a);
      await runOwnership(C12);
      const events = await ownershipEvents('conversation_id = $1', [`wa-test-conversation-${a}`]);
      expect(events.map((event) => event.body)).toEqual([
        JSON.stringify({ schema_version: 1, protocol_revision: '1.2', event_id: `wa-test-ownership-${a}-v1`, type: 'ownership.taken', conversation_id: `wa-test-conversation-${a}`, data: { version: 1, crm_seller_id: SELLER_UUID, source: 'crm' } }),
        JSON.stringify({ schema_version: 1, protocol_revision: '1.2', event_id: `wa-test-ownership-${a}-v2`, type: 'ownership.released', conversation_id: `wa-test-conversation-${a}`, data: { version: 2, reason: 'sla_expired' } }),
      ]);
      for (const event of events) expect(event.contact_id).toBeNull();
    });
  });
});
