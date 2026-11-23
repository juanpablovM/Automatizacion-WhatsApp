// =============================================================================
// A returning customer stays on the same CRM opportunity (owner rule
// 2026-11-23, migration 043): "a la misma oportunidad si es que no ha querido
// iniciar una nueva cotización". Both creation points (Fix V3 Route and Persist
// Conversation State) link a new conversation to the one it continues, unless
// the customer asked for a new quote. Every test runs inside a transaction that
// is rolled back.
// =============================================================================
import fs from 'node:fs';
import pg from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'vitest';

const integration = process.env.TEST_PG_INTEGRATION === '1' ? describe : describe.skip;
const connection = {
  host: process.env.TEST_PGHOST || '127.0.0.1',
  port: Number(process.env.TEST_PGPORT || 55433),
  database: process.env.TEST_PGDATABASE || 'testdb',
  user: process.env.TEST_PGUSER || 'test',
  password: process.env.TEST_PGPASSWORD || 'test',
};
const orchestratorSql = (name) => fs.readFileSync(`db/queries/n8n/wa-conversation-orchestrator/${name}.sql`, 'utf8');
const routeSql = orchestratorSql('07_route_v3_turn');
const persistSql = orchestratorSql('07_persist_conversation_state');

integration('conversation continuation', () => {
  const client = new pg.Client(connection);
  const phone = '56900000543';
  let sourceId;
  let handedId;
  let leadId;
  let eventNumber = 0;

  beforeAll(async () => { await client.connect(); });
  afterAll(async () => { await client.end(); });
  beforeEach(async () => {
    await client.query('BEGIN');
    await client.query(`INSERT INTO conversation_statuses (code, label, sort_order) VALUES
      ('active', 'Active', 1), ('waiting_user', 'Waiting', 2), ('handed_to_sales', 'Handed', 3)
      ON CONFLICT (code) DO NOTHING`);
    await client.query(`INSERT INTO lead_statuses (code, label, sort_order) VALUES ('assigned', 'Assigned', 1)
      ON CONFLICT (code) DO NOTHING`);
    sourceId = (await client.query(`INSERT INTO whatsapp_numbers (display_name, phone_number, phone_number_id, instance_name)
      VALUES ('Continuation', '56900009543', 'pn-continuation', 'continuation-test') RETURNING id`)).rows[0].id;
    handedId = (await client.query(`INSERT INTO conversations (source_number_id, phone_number,
      conversation_status_id, current_step, started_at)
      SELECT $1, $2, id, 'complete', NOW() - INTERVAL '3 days'
      FROM conversation_statuses WHERE code = 'handed_to_sales' RETURNING id`, [sourceId, phone])).rows[0].id;
    leadId = (await client.query(`INSERT INTO leads (source_number_id, source_conversation_id, phone_number, lead_status_id)
      SELECT $1, $2, $3, id FROM lead_statuses WHERE code = 'assigned' RETURNING id`,
    [sourceId, handedId, phone])).rows[0].id;
    await client.query('UPDATE conversations SET lead_id = $2 WHERE id = $1', [handedId, leadId]);
  });
  afterEach(async () => { await client.query('ROLLBACK'); });

  const claimEvent = async () => {
    const identity = `continuation-${++eventNumber}`;
    // One processing event per queue: the previous turn of this contact is done.
    await client.query(`UPDATE inbound_events SET processing_status = 'processed'
      WHERE instance_name = 'continuation-test' AND processing_status = 'processing'`);
    const id = (await client.query(`INSERT INTO inbound_events (instance_name, event_fingerprint, dedupe_key,
      source_number_id, phone_number, queue_key, processing_status, processing_token)
      VALUES ('continuation-test', $1, $1, $2::bigint, $3::text, $2::bigint::text || ':' || $3::text, 'processing', 'continuation-token')
      RETURNING id`, [identity, sourceId, phone])).rows[0].id;
    return { id, identity };
  };
  const linkOf = async (conversationId) => (await client.query(
    'SELECT continues_conversation_id FROM conversations WHERE id = $1', [conversationId],
  )).rows[0].continues_conversation_id;

  // Fix V3 Route as the workflow calls it; $15 is customer_chose_new_quote.
  const route = async (choseNewQuote) => {
    const event = await claimEvent();
    const { rows: [routed] } = await client.query(routeSql, [
      event.id, 'continuation-token', String(handedId), sourceId, phone, 'enforce', 'continuation-rule',
      'service', 'text', event.identity, null, 'Hola de nuevo', {}, false, choseNewQuote,
    ]);
    expect(routed.route_failure_reason).toBeNull();
    expect(routed.conversation_id).not.toBe(handedId);
    return routed.conversation_id;
  };

  // Persist Conversation State creating a new conversation (reset turn); the
  // customer's choice travels in the audit metadata ($23).
  const persistNew = async (metadata) => {
    const event = await claimEvent();
    const values = [
      null, phone, sourceId, 'city', null,
      `continuation-incoming-${event.id}`, null, 'text', 'Hola de nuevo', '{}',
      null, null, null, null, null, null, null,
      'waiting_user', 'conversation_state_evaluated', 'waiting_user',
      '{}', '{}', JSON.stringify(metadata), true, false, true,
      null, null, null, null, null, null, null, null, null, null,
      0, '[]', '{}', '{}', null, null, false, '[]',
      null, null, null, '{}', null, null, null, '[]', '{}', null,
      event.id, 'continuation-token', '{}', null,
    ];
    expect(values).toHaveLength(58);
    const { rows } = await client.query(persistSql, values);
    expect(rows).toHaveLength(1);
    expect(rows[0].conversation_id).not.toBe(handedId);
    return rows[0].conversation_id;
  };

  describe('Fix V3 Route', () => {
    test('links the new conversation to the handed one when the customer did not ask for a new quote', async () => {
      expect(String(await linkOf(await route(false)))).toBe(String(handedId));
    });

    test('leaves it unlinked when the customer asked for a new quote', async () => {
      expect(await linkOf(await route(true))).toBeNull();
    });

    test('a later lead-less conversation still points at the conversation that holds the lead', async () => {
      const first = await route(false);
      await client.query(`UPDATE conversations SET conversation_status_id = (SELECT id FROM conversation_statuses WHERE code = 'handed_to_sales')
        WHERE id = $1`, [first]);
      await client.query("UPDATE conversation_turn_executions SET state = 'delivered' WHERE conversation_id = $1", [first]);
      const event = await claimEvent();
      const { rows: [routed] } = await client.query(routeSql, [
        event.id, 'continuation-token', String(first), sourceId, phone, 'enforce', 'continuation-rule',
        'service', 'text', event.identity, null, 'Sigo aquí', {}, false, false,
      ]);
      expect(routed.conversation_id).not.toBe(first);
      expect(String(await linkOf(routed.conversation_id))).toBe(String(handedId));
    });
  });

  describe('Persist Conversation State', () => {
    test('links the new conversation when the metadata does not say the customer chose a new quote', async () => {
      expect(String(await linkOf(await persistNew({ response_kind: 'new_request_started' })))).toBe(String(handedId));
    });

    test('leaves it unlinked when the customer chose a new quote', async () => {
      expect(await linkOf(await persistNew({ response_kind: 'quote_followup_new_quote', customer_chose_new_quote: true }))).toBeNull();
    });
  });

  test('a first contact has nothing to continue', async () => {
    await client.query('UPDATE conversations SET deleted_at = NOW() WHERE id = $1', [handedId]);
    expect(await linkOf(await route(false))).toBeNull();
  });
});
