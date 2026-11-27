// Independent verification of U4-U6 (A3, S8): a transaction that releases the
// leases of two contacts in descending id order must never deadlock with the
// dispatcher stages that lock contact rows (12, 14). If the ownership trigger
// lost that deadlock it would store the release without its contact counter,
// and under 1.3 that release would never reach the CRM. The stages take the
// contact lock with SKIP LOCKED, so they never wait and no cycle can form.
import fs from 'node:fs';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';

const enabled = process.env.TEST_PG_INTEGRATION === '1';
const connection = {
  host: process.env.TEST_PGHOST || '127.0.0.1',
  port: Number(process.env.TEST_PGPORT || 55433),
  database: process.env.TEST_PGDATABASE || 'testdb',
  user: process.env.TEST_PGUSER || 'test',
  password: process.env.TEST_PGPASSWORD || 'test',
};
const sql = (name) => fs.readFileSync(`db/queries/n8n/crm-events-dispatcher/${name}`, 'utf8');

describe.skipIf(!enabled)('contact row locks: dispatcher vs multi-contact releases', () => {
  const admin = new pg.Client(connection);
  const releaser = new pg.Client(connection);
  const stage = new pg.Client(connection);
  let sourceId;
  let sellerId;

  beforeAll(async () => {
    await Promise.all([admin.connect(), releaser.connect(), stage.connect()]);
    const suffix = String(Date.now()).slice(-8);
    sourceId = (await admin.query(
      `INSERT INTO whatsapp_numbers (display_name, phone_number, phone_number_id, instance_name)
       VALUES ('lock-race', $1, $2, $3) RETURNING id`, [`5622${suffix}`, `lock-race-${suffix}`, `lock-race-${suffix}`])).rows[0].id;
    sellerId = (await admin.query(
      `INSERT INTO sellers (name, is_active, sort_order) VALUES ('lock-race', TRUE, 999) RETURNING id`)).rows[0].id;
  });
  afterAll(async () => {
    await admin.query('DELETE FROM crm_contact_state_marks WHERE contact_id IN (SELECT id FROM crm_contacts WHERE source_number_id = $1)', [sourceId]);
    await admin.query('DELETE FROM crm_ownership_changes WHERE conversation_id IN (SELECT id FROM conversations WHERE source_number_id = $1)', [sourceId]);
    await admin.query('DELETE FROM lead_chat_ownerships WHERE conversation_id IN (SELECT id FROM conversations WHERE source_number_id = $1)', [sourceId]);
    await admin.query('DELETE FROM crm_conversation_ownership WHERE conversation_id IN (SELECT id FROM conversations WHERE source_number_id = $1)', [sourceId]);
    await admin.query('DELETE FROM conversations WHERE source_number_id = $1', [sourceId]);
    await admin.query('DELETE FROM crm_contacts WHERE source_number_id = $1', [sourceId]);
    await admin.query('DELETE FROM whatsapp_numbers WHERE id = $1', [sourceId]);
    await admin.query('DELETE FROM sellers WHERE id = $1', [sellerId]);
    await Promise.all([admin.end(), releaser.end(), stage.end()]);
  });

  const holdTwo = async (tag) => {
    const status = (await admin.query(`SELECT id FROM conversation_statuses WHERE code = 'active'`)).rows[0].id;
    const seller = sellerId;
    const out = [];
    for (const n of [1, 2]) {
      const phone = `569${tag}${n}`;
      const conversation = (await admin.query(
        'INSERT INTO conversations (phone_number, conversation_status_id, source_number_id) VALUES ($1, $2, $3) RETURNING id',
        [phone, status, sourceId])).rows[0].id;
      const lease = (await admin.query(
        `INSERT INTO lead_chat_ownerships (conversation_id, acquired_via, owner_seller_id) VALUES ($1, 'crm', $2) RETURNING id`,
        [conversation, seller])).rows[0].id;
      const contact = Number((await admin.query('SELECT crm_contact_ensure($1, $2) AS id', [sourceId, phone])).rows[0].id);
      out.push({ conversation, lease, contact });
    }
    return out;
  };

  const race = async (stageSql, input) => {
    const [low, high] = await holdTwo(String(Date.now()).slice(-6));
    await releaser.query('BEGIN');
    // The releaser is the preferred deadlock victim: the worst case for S8.
    await releaser.query(`SET LOCAL deadlock_timeout = '50ms'`);
    await stage.query(`SET deadlock_timeout = '5s'`);
    await releaser.query(`UPDATE lead_chat_ownerships SET released_at = NOW(), release_reason = 'sla_expired' WHERE id = $1`, [high.lease]);
    const pending = stage.query(stageSql, [JSON.stringify(input([low.contact, high.contact]))]).then(() => 'ok', (e) => e.code);
    await new Promise((resolve) => setTimeout(resolve, 300));
    let released = 'ok';
    try {
      await releaser.query(`UPDATE lead_chat_ownerships SET released_at = NOW(), release_reason = 'sla_expired' WHERE id = $1`, [low.lease]);
      await releaser.query('COMMIT');
    } catch (error) { released = error.code; await releaser.query('ROLLBACK'); }
    const staged = await pending;
    const { rows } = await admin.query(
      `SELECT contact_id, contact_version FROM crm_ownership_changes
       WHERE change_kind = 'released' AND conversation_id = ANY($1)`, [[low.conversation, high.conversation]]);
    return { released, staged, rows };
  };

  test('stage 14 (contact.state) never costs a release its contact counter', async () => {
    const { released, staged, rows } = await race(sql('14_insert_contact_state_events.sql'), (ids) => ids.map((id) => ({
      contact_id: id, id_prefix: 'test', input_hash: 'h', state_version: 1, event_id: null, body: null, blocked_reason: 'probe',
    })));
    expect(released).toBe('ok');
    expect(staged).toBe('ok');
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.contact_id !== null && row.contact_version !== null)).toBe(true);
  });

  test('stage 12 (contact.upserted) never costs a release its contact counter', async () => {
    const { released, staged, rows } = await race(sql('12_insert_contact_events.sql'), (ids) => ids.map((id) => ({
      contact_id: id, revision: 1, event_id: null, body: null, blocked_reason: 'probe',
    })));
    expect(released).toBe('ok');
    expect(staged).toBe('ok');
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.contact_id !== null && row.contact_version !== null)).toBe(true);
  });
});
