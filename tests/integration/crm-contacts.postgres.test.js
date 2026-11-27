// =============================================================================
// CRM 1.3 contact identity (migration 053): one crm_contacts row per customer
// and WhatsApp line, (source_number_id, phone_number).
// Feature document: odd/tasks/crm-1-3-customer-threads.md (U1, S2).
// Every test runs inside a transaction that is rolled back.
// =============================================================================
import fs from 'node:fs';
import pg from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'vitest';

const enabled = process.env.TEST_PG_INTEGRATION === '1';
const describeIntegration = enabled ? describe : describe.skip;
const connection = {
  host: process.env.TEST_PGHOST || '127.0.0.1',
  port: Number(process.env.TEST_PGPORT || 55433),
  database: process.env.TEST_PGDATABASE || 'testdb',
  user: process.env.TEST_PGUSER || 'test',
  password: process.env.TEST_PGPASSWORD || 'test',
};

describeIntegration('CRM 1.3 contacts (migration 053)', () => {
  const client = new pg.Client(connection);
  let conversationStatusId;
  let leadStatusId;
  let sourceNumberId;
  let sequence = 0;

  beforeAll(async () => { await client.connect(); });
  afterAll(async () => { await client.end(); });

  const newSource = async () => {
    sequence += 1;
    return (await client.query(
      `INSERT INTO whatsapp_numbers (display_name, phone_number, phone_number_id)
       VALUES ('Ventas', $1, 'crm-contacts-' || gen_random_uuid()) RETURNING id`,
      [`5622${String(1000000 + sequence).slice(-7)}`],
    )).rows[0].id;
  };

  beforeEach(async () => {
    await client.query('BEGIN');
    ({ rows: [{ id: conversationStatusId }] } = await client.query(
      `INSERT INTO conversation_statuses (code, label, sort_order) VALUES ('open', 'Open', 1)
       ON CONFLICT (code) DO UPDATE SET code = EXCLUDED.code RETURNING id`,
    ));
    ({ rows: [{ id: leadStatusId }] } = await client.query('SELECT id FROM lead_statuses ORDER BY id LIMIT 1'));
    sourceNumberId = await newSource();
  });
  afterEach(async () => { await client.query('ROLLBACK'); });

  const newPhone = () => {
    sequence += 1;
    return `5697${String(1000000 + sequence).slice(-7)}`;
  };

  const insertConversation = async (phone, { source = sourceNumberId, createdAt = '2100-01-10T00:00:00Z' } = {}) => (await client.query(
    `INSERT INTO conversations (phone_number, conversation_status_id, source_number_id, created_at)
     VALUES ($1, $2, $3, $4) RETURNING id`,
    [phone, conversationStatusId, source, createdAt],
  )).rows[0].id;

  const insertLead = async (phone, { source = sourceNumberId, createdAt = '2100-01-10T00:00:00Z' } = {}) => (await client.query(
    `INSERT INTO leads (phone_number, source_number_id, lead_status_id, created_at)
     VALUES ($1, $2, $3, $4) RETURNING id`,
    [phone, source, leadStatusId, createdAt],
  )).rows[0].id;

  const insertHandoff = async (phone, conversationId, { source = sourceNumberId, createdAt = '2100-01-10T00:00:00Z' } = {}) => {
    sequence += 1;
    return (await client.query(
      `INSERT INTO handoffs (idempotency_key, conversation_id, phone_number, source_number_id, motivo, area, area_label,
                             prioridad, responsable, estado, created_at)
       VALUES ($1, $2, $3, $4, 'talk_human', 'sales', 'Ventas', 'alta', 'Ejecutiva comercial', 'pending', $5) RETURNING id`,
      [`crm-contacts-${sequence}-${Date.now()}`, conversationId, phone, source, createdAt],
    )).rows[0].id;
  };

  const contactsOf = async (source = sourceNumberId) => (await client.query(
    'SELECT id::text, phone_number FROM crm_contacts WHERE source_number_id = $1 ORDER BY id', [source],
  )).rows;

  const tryQuery = async (sql, params = []) => {
    await client.query('SAVEPOINT attempt');
    try {
      await client.query(sql, params);
      await client.query('RELEASE SAVEPOINT attempt');
      return null;
    } catch (error) {
      await client.query('ROLLBACK TO SAVEPOINT attempt');
      return error;
    }
  };

  test('the seed creates one contact per (source number, phone), earliest first activity first, and re-runs as a no-op', async () => {
    const [phoneA, phoneB, phoneC, phoneD] = [newPhone(), newPhone(), newPhone(), newPhone()];
    // A: conversation on day 5 and a lead on day 9 (two rows, one contact).
    await insertConversation(phoneA, { createdAt: '2100-01-05T00:00:00Z' });
    await insertLead(phoneA, { createdAt: '2100-01-09T00:00:00Z' });
    // B: only a lead, on day 1.
    await insertLead(phoneB, { createdAt: '2100-01-01T00:00:00Z' });
    // C: a conversation on day 8 whose handoff is dated day 3.
    const conversationC = await insertConversation(phoneC, { createdAt: '2100-01-08T00:00:00Z' });
    await insertHandoff(phoneC, conversationC, { createdAt: '2100-01-03T00:00:00Z' });
    // D: a lead without a source number is never a contact.
    await insertLead(phoneD, { source: null, createdAt: '2100-01-02T00:00:00Z' });

    // Forget what the trigger created and rebuild it the way the migration does.
    await client.query('DELETE FROM crm_contacts WHERE source_number_id = $1', [sourceNumberId]);
    const { rows: [{ inserted }] } = await client.query('SELECT crm_contacts_seed() AS inserted');
    expect(Number(inserted)).toBeGreaterThanOrEqual(3);

    const contacts = await contactsOf();
    expect(contacts.map((c) => c.phone_number)).toEqual([phoneB, phoneC, phoneA]);
    expect((await client.query('SELECT count(*)::int AS n FROM crm_contacts WHERE phone_number = $1', [phoneD])).rows[0].n).toBe(0);

    const { rows: [{ inserted: again }] } = await client.query('SELECT crm_contacts_seed() AS inserted');
    expect(Number(again)).toBe(0);
    expect(await contactsOf()).toEqual(contacts);
  });

  test('a (source number, phone) pair is unique; the same phone on another line is another contact', async () => {
    const phone = newPhone();
    await insertConversation(phone);
    expect(await tryQuery(
      'INSERT INTO crm_contacts (source_number_id, phone_number) VALUES ($1, $2)', [sourceNumberId, phone],
    )).toMatchObject({ message: expect.stringMatching(/crm_contacts_source_phone_key/) });

    const otherSource = await newSource();
    await insertConversation(phone, { source: otherSource });
    const [mine] = await contactsOf();
    const [other] = await contactsOf(otherSource);
    expect(mine.phone_number).toBe(phone);
    expect(other.phone_number).toBe(phone);
    expect(other.id).not.toBe(mine.id);
  });

  test('inserting a conversation, a lead or a handoff with a new pair creates its contact once', async () => {
    const [phoneConversation, phoneLead, phoneHandoff] = [newPhone(), newPhone(), newPhone()];
    const conversationId = await insertConversation(phoneConversation);
    expect((await contactsOf()).map((c) => c.phone_number)).toEqual([phoneConversation]);

    await insertLead(phoneLead);
    expect((await contactsOf()).map((c) => c.phone_number)).toEqual([phoneConversation, phoneLead]);

    await insertHandoff(phoneHandoff, conversationId);
    expect((await contactsOf()).map((c) => c.phone_number)).toEqual([phoneConversation, phoneLead, phoneHandoff]);

    // The same customer again: no new contact.
    await insertConversation(phoneConversation);
    await insertLead(phoneConversation);
    await insertHandoff(phoneConversation, conversationId);
    expect(await contactsOf()).toHaveLength(3);
  });

  test('a row without a source number creates no contact, and setting it later does', async () => {
    const phone = newPhone();
    const leadId = await insertLead(phone, { source: null });
    expect((await client.query('SELECT count(*)::int AS n FROM crm_contacts WHERE phone_number = $1', [phone])).rows[0].n).toBe(0);

    await client.query('UPDATE leads SET source_number_id = $1 WHERE id = $2', [sourceNumberId, leadId]);
    expect((await contactsOf()).map((c) => c.phone_number)).toEqual([phone]);
  });

  test('the contact trigger never fails the insert that fired it', async () => {
    const phone = newPhone();
    // Make every contact insert for this phone fail inside the trigger.
    await client.query(`ALTER TABLE crm_contacts ADD CONSTRAINT crm_contacts_test_refuse CHECK (phone_number <> '${phone}')`);
    const conversationId = await insertConversation(phone);
    const leadId = await insertLead(phone);
    const handoffId = await insertHandoff(phone, conversationId);
    expect(conversationId).toBeTruthy();
    expect(leadId).toBeTruthy();
    expect(handoffId).toBeTruthy();
    expect(await contactsOf()).toEqual([]);
  });

  test('crm_contact_ref returns the contact id, or NULL for an unknown or incomplete pair', async () => {
    const phone = newPhone();
    await insertConversation(phone);
    const [contact] = await contactsOf();
    const ref = async (source, p) => (await client.query('SELECT crm_contact_ref($1, $2)::text AS id', [source, p])).rows[0].id;
    expect(await ref(sourceNumberId, phone)).toBe(contact.id);
    expect(await ref(sourceNumberId, newPhone())).toBeNull();
    expect(await ref(null, phone)).toBeNull();
    expect(await ref(sourceNumberId, null)).toBeNull();
  });

  test('removing a WhatsApp line with no CRM events removes its contacts (test cleanups keep working)', async () => {
    const otherSource = await newSource();
    await insertConversation(newPhone(), { source: otherSource });
    await client.query('DELETE FROM conversations WHERE source_number_id = $1', [otherSource]);
    expect(await tryQuery('DELETE FROM whatsapp_numbers WHERE id = $1', [otherSource])).toBeNull();
    expect(await contactsOf(otherSource)).toEqual([]);
  });

  // Independent verification of U1 (B1): the seed must run after the triggers
  // exist, or a bot write committed between the two never gets a contact.
  test('053 creates the triggers before it seeds', () => {
    const sql = fs.readFileSync('infra/postgres/migrations/053_crm_contacts.sql', 'utf8');
    const lastTrigger = sql.lastIndexOf('CREATE TRIGGER trg_crm_track_contact');
    const seedCall = sql.lastIndexOf('SELECT crm_contacts_seed();');
    expect(lastTrigger).toBeGreaterThan(-1);
    expect(seedCall).toBeGreaterThan(lastTrigger);
  });

  // A2: a pair left without a contact (skipped trigger + the other writer
  // rolled back) gets one when a reader asks for it.
  test('crm_contact_ensure creates a missing contact once and returns it', async () => {
    const phone = newPhone();
    await client.query('ALTER TABLE conversations DISABLE TRIGGER trg_crm_track_contact');
    await insertConversation(phone);
    await client.query('ALTER TABLE conversations ENABLE TRIGGER trg_crm_track_contact');
    expect((await client.query('SELECT crm_contact_ref($1, $2) AS id', [sourceNumberId, phone])).rows[0].id).toBeNull();
    const first = (await client.query('SELECT crm_contact_ensure($1, $2) AS id', [sourceNumberId, phone])).rows[0].id;
    const second = (await client.query('SELECT crm_contact_ensure($1, $2) AS id', [sourceNumberId, phone])).rows[0].id;
    expect(first).not.toBeNull();
    expect(second).toBe(first);
    expect((await client.query('SELECT crm_contact_ensure(NULL, $1) AS id', [phone])).rows[0].id).toBeNull();
  });
});
