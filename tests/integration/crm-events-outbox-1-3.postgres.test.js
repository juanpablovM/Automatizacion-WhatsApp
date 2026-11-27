// =============================================================================
// CRM 1.3 outbox schema (migration 054): contact.* events, nullable
// conversation_id only for them, and the delivery epoch (id_prefix) in every
// per-entity unique so a new CRM_EVENTS_ID_PREFIX can resend history.
// Feature document: odd/tasks/crm-1-3-customer-threads.md (U2, S2, S9).
// Every test runs inside a transaction that is rolled back.
// =============================================================================
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

describeIntegration('CRM 1.3 outbox (migration 054)', () => {
  const client = new pg.Client(connection);
  let sourceNumberId;
  let conversationId;
  let leadId;
  let messageId;
  let handoffId;
  let changeId;
  let contactId;
  let phone;
  let sequence = 0;

  beforeAll(async () => { await client.connect(); });
  afterAll(async () => { await client.end(); });

  beforeEach(async () => {
    await client.query('BEGIN');
    sequence += 1;
    phone = `5698${String(1000000 + sequence).slice(-7)}`;
    const { rows: [{ id: statusId }] } = await client.query(
      `INSERT INTO conversation_statuses (code, label, sort_order) VALUES ('open', 'Open', 1)
       ON CONFLICT (code) DO UPDATE SET code = EXCLUDED.code RETURNING id`,
    );
    ({ rows: [{ id: sourceNumberId }] } = await client.query(
      `INSERT INTO whatsapp_numbers (display_name, phone_number, phone_number_id)
       VALUES ('Ventas', $1, 'crm-outbox-13-' || gen_random_uuid()) RETURNING id`,
      [`5621${String(1000000 + sequence).slice(-7)}`],
    ));
    ({ rows: [{ id: conversationId }] } = await client.query(
      `INSERT INTO conversations (phone_number, conversation_status_id, source_number_id)
       VALUES ($1, $2, $3) RETURNING id`, [phone, statusId, sourceNumberId],
    ));
    ({ rows: [{ id: leadId }] } = await client.query(
      `INSERT INTO leads (phone_number, source_number_id, lead_status_id)
       VALUES ($1, $2, (SELECT id FROM lead_statuses ORDER BY id LIMIT 1)) RETURNING id`, [phone, sourceNumberId],
    ));
    ({ rows: [{ id: messageId }] } = await client.query(
      `INSERT INTO messages (conversation_id, direction, sender_type, message_type, text_body)
       VALUES ($1, 'incoming', 'customer', 'text', 'hola') RETURNING id`, [conversationId],
    ));
    ({ rows: [{ id: handoffId }] } = await client.query(
      `INSERT INTO handoffs (idempotency_key, conversation_id, phone_number, source_number_id, motivo, area, area_label,
                             prioridad, responsable, estado)
       VALUES ($1, $2, $3, $4, 'talk_human', 'sales', 'Ventas', 'alta', 'Ejecutiva comercial', 'pending') RETURNING id`,
      [`crm-outbox-13-${sequence}-${Date.now()}`, conversationId, phone, sourceNumberId],
    ));
    ({ rows: [{ id: changeId }] } = await client.query(
      `INSERT INTO crm_ownership_changes (conversation_id, ownership_version, change_kind, source)
       VALUES ($1, 1, 'taken', 'crm') RETURNING id`, [conversationId],
    ));
    ({ rows: [{ id: contactId }] } = await client.query(
      'SELECT crm_contact_ref($1, $2) AS id', [sourceNumberId, phone],
    ));
  });
  afterEach(async () => { await client.query('ROLLBACK'); });

  const tryQuery = async (sql, params = []) => {
    await client.query('SAVEPOINT attempt');
    try {
      const result = await client.query(sql, params);
      await client.query('RELEASE SAVEPOINT attempt');
      return result.rows;
    } catch (error) {
      await client.query('ROLLBACK TO SAVEPOINT attempt');
      return error;
    }
  };

  const conversationRef = (prefix = 'test') => `wa-${prefix}-conversation-${conversationId}`;

  const insertContactEvent = (eventId, { type = 'contact.upserted', contact = contactId, conversation = null, revision = 1 } = {}) => tryQuery(
    `INSERT INTO crm_events (event_id, event_type, conversation_id, contact_id, revision, body)
     VALUES ($1, $2, $3, $4, $5, '{}') RETURNING id, id_prefix`,
    [eventId, type, conversation, contact, revision],
  );

  describe('contact.* identity', () => {
    test('contact.upserted and contact.state carry a contact and no conversation', async () => {
      expect(contactId).not.toBeNull();
      const upserted = await insertContactEvent(`wa-test-contact-${contactId}-r1`);
      expect(upserted).toEqual([expect.objectContaining({ id_prefix: 'test' })]);
      const state = await insertContactEvent(`wa-test-contact-${contactId}-s1`, { type: 'contact.state' });
      expect(state).toEqual([expect.objectContaining({ id_prefix: 'test' })]);
    });

    test('a contact.* event without contact_id, or with a conversation_id, is refused', async () => {
      expect(await insertContactEvent('wa-test-contact-x-r1', { contact: null }))
        .toMatchObject({ message: expect.stringMatching(/crm_events_identity_check/) });
      expect(await insertContactEvent('wa-test-contact-y-r1', { conversation: conversationRef() }))
        .toMatchObject({ message: expect.stringMatching(/crm_events_identity_check/) });
      expect(await insertContactEvent('wa-test-contact-z-s1', { type: 'contact.state', contact: null }))
        .toMatchObject({ message: expect.stringMatching(/crm_events_identity_check/) });
    });

    test('every 1.1/1.2 type still requires its conversation_id; unknown types stay refused', async () => {
      const cases = [
        ['lead.qualified', 'lead_id', leadId],
        ['message.new', 'message_id', messageId],
        ['ownership.taken', 'ownership_change_id', changeId],
        ['ownership.released', 'ownership_change_id', changeId],
        ['handoff.created', 'handoff_id', handoffId],
      ];
      for (const [type, column, value] of cases) {
        expect(await tryQuery(
          `INSERT INTO crm_events (event_id, event_type, conversation_id, ${column}, revision, body)
           VALUES ($1, $2, NULL, $3, 1, '{}')`, [`wa-test-${type}-null-conversation`, type, value],
        )).toMatchObject({ message: expect.stringMatching(/crm_events_identity_check/) });
      }
      expect(await tryQuery(
        `INSERT INTO crm_events (event_id, event_type, conversation_id, contact_id, revision, body)
         VALUES ('wa-test-bogus', 'contact.deleted', NULL, $1, 1, '{}')`, [contactId],
      )).toMatchObject({ message: expect.stringMatching(/crm_events_event_type_check/) });
    });

    test('a 1.3 event of an existing type may also carry its contact_id', async () => {
      expect(await tryQuery(
        `INSERT INTO crm_events (event_id, event_type, conversation_id, message_id, contact_id, revision, body)
         VALUES ($1, 'message.new', $2, $3, $4, 1, '{}') RETURNING id`,
        [`wa-test-message-${messageId}-e1`, conversationRef(), messageId, contactId],
      )).toHaveLength(1);
    });

    test('contact_id and id_prefix never change', async () => {
      const [{ id }] = await insertContactEvent(`wa-test-contact-${contactId}-r1`);
      expect(await tryQuery('UPDATE crm_events SET contact_id = NULL WHERE id = $1', [id]))
        .toMatchObject({ message: expect.stringMatching(/immutable/) });
      expect(await tryQuery("UPDATE crm_events SET id_prefix = 'prod' WHERE id = $1", [id]))
        .toMatchObject({ message: expect.stringMatching(/immutable/) });
      expect(await tryQuery("UPDATE crm_events SET status = 'delivered', delivered_at = NOW() WHERE id = $1", [id]))
        .toEqual([]);
    });

    test('a contact referenced by an event blocks removing its WhatsApp line', async () => {
      await insertContactEvent(`wa-test-contact-${contactId}-r1`);
      expect(await tryQuery('DELETE FROM whatsapp_numbers WHERE id = $1', [sourceNumberId]))
        .toBeInstanceOf(Error);
    });
  });

  describe('delivery epoch (id_prefix)', () => {
    test('id_prefix is derived from event_id; a mismatching explicit value is refused', async () => {
      const rows = await tryQuery(
        `INSERT INTO crm_events (event_id, event_type, conversation_id, lead_id, revision, body)
         VALUES ($1, 'lead.qualified', $2, $3, 1, '{}') RETURNING id_prefix`,
        [`wa-dev7-lead-${leadId}-r1`, conversationRef('dev7'), leadId],
      );
      expect(rows).toEqual([{ id_prefix: 'dev7' }]);
      expect(await tryQuery(
        `INSERT INTO crm_events (event_id, event_type, conversation_id, lead_id, revision, body, id_prefix)
         VALUES ($1, 'lead.qualified', $2, $3, 2, '{}', 'prod') RETURNING id_prefix`,
        [`wa-dev7-lead-${leadId}-r2`, conversationRef('dev7'), leadId],
      )).toMatchObject({ message: expect.stringMatching(/crm_events_id_prefix_check/) });
      // An id outside the wa-<prefix>- shape keeps working with an empty prefix.
      expect(await tryQuery(
        `INSERT INTO crm_events (event_id, event_type, conversation_id, message_id, revision, body)
         VALUES ('x-legacy', 'message.new', 'c', $1, 1, '{}') RETURNING id_prefix`, [messageId],
      )).toEqual([{ id_prefix: '' }]);
    });

    const entityCases = () => [
      {
        name: 'lead.qualified (lead_id, event_type, revision)',
        constraint: /crm_events_lead_type_revision_key/,
        insert: (prefix, n) => tryQuery(
          `INSERT INTO crm_events (event_id, event_type, conversation_id, lead_id, revision, body)
           VALUES ($1, 'lead.qualified', $2, $3, 1, '{}') RETURNING id`,
          [`wa-${prefix}-lead-${leadId}-r1-${n}`, conversationRef(prefix), leadId],
        ),
      },
      {
        name: 'message.new (message_id, event_type)',
        constraint: /crm_events_message_type_key/,
        insert: (prefix, n) => tryQuery(
          `INSERT INTO crm_events (event_id, event_type, conversation_id, message_id, revision, body)
           VALUES ($1, 'message.new', $2, $3, 1, '{}') RETURNING id`,
          [`wa-${prefix}-message-${messageId}-e${n}`, conversationRef(prefix), messageId],
        ),
      },
      {
        name: 'ownership.taken (ownership_change_id)',
        constraint: /crm_events_ownership_change_key/,
        insert: (prefix, n) => tryQuery(
          `INSERT INTO crm_events (event_id, event_type, conversation_id, ownership_change_id, revision, body)
           VALUES ($1, 'ownership.taken', $2, $3, 1, '{}') RETURNING id`,
          [`wa-${prefix}-ownership-${conversationId}-v1-${n}`, conversationRef(prefix), changeId],
        ),
      },
      {
        name: 'handoff.created (handoff_id, revision)',
        constraint: /crm_events_handoff_revision_key/,
        insert: (prefix, n) => tryQuery(
          `INSERT INTO crm_events (event_id, event_type, conversation_id, handoff_id, revision, body)
           VALUES ($1, 'handoff.created', $2, $3, 1, '{}') RETURNING id`,
          [`wa-${prefix}-handoff-${handoffId}-r1-${n}`, conversationRef(prefix), handoffId],
        ),
      },
      {
        name: 'contact.upserted (contact_id, event_type, revision)',
        constraint: /crm_events_contact_type_revision_key/,
        insert: (prefix, n) => insertContactEvent(`wa-${prefix}-contact-${contactId}-r1-${n}`),
      },
    ];

    test.each([0, 1, 2, 3, 4])('the same entity twice under one prefix is refused, under a new prefix accepted (case %i)', async (index) => {
      const entity = entityCases()[index];
      expect(await entity.insert('test', 1)).toHaveLength(1);
      expect(await entity.insert('test', 2)).toMatchObject({ message: expect.stringMatching(entity.constraint) });
      expect(await entity.insert('prod', 1)).toHaveLength(1);
      expect(await entity.insert('prod', 2)).toMatchObject({ message: expect.stringMatching(entity.constraint) });
    });
  });
});
