// =============================================================================
// Quote correction (owner decision 2026-10-14, conversations 496/497): a
// correction written after the confirmation continues the same conversation
// and updates the same lead. Load Conversation State exposes the lead's task
// and its history, Fix V3 Route reuses the handed_to_sales conversation only
// for a reopened quote, and Persist Lead And Rotation updates the existing
// lead of a reused conversation instead of keeping the stale requirement.
// Every test runs inside a transaction that is rolled back.
// =============================================================================
import fs from 'node:fs';
import { createRequire } from 'node:module';
import pg from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'vitest';

const require = createRequire(import.meta.url);
const { evaluateConversationStep } = require('../fixtures/workflow-nodes/wa-conversation-orchestrator/evaluate-conversation-step.js');

const integration = process.env.TEST_PG_INTEGRATION === '1' ? describe : describe.skip;
const connection = {
  host: process.env.TEST_PGHOST || '127.0.0.1',
  port: Number(process.env.TEST_PGPORT || 55433),
  database: process.env.TEST_PGDATABASE || 'testdb',
  user: process.env.TEST_PGUSER || 'test',
  password: process.env.TEST_PGPASSWORD || 'test',
};
const orchestratorSql = (name) => fs.readFileSync(`db/queries/n8n/wa-conversation-orchestrator/${name}.sql`, 'utf8');
const loadSql = orchestratorSql('01_load_active_context');
const routeSql = orchestratorSql('07_route_v3_turn');
const persistLeadNode = JSON.parse(fs.readFileSync('n8n/workflows/crm-lead-creation-and-assignment.json', 'utf8'))
  .nodes.find((node) => node.name === 'Persist Lead And Rotation');
const persistLeadParams = persistLeadNode.parameters.additionalFields.queryParams.split(',').map((name) => name.trim());

integration('a confirmed quote reopened by a correction', () => {
  const client = new pg.Client(connection);
  const phone = '56900000496';
  const context = { line_items: [{ item_id: 'i1', product: 'Bloques', quantity: '50' }], commune: 'Maipú', fulfillment: 'delivery' };
  let sourceId;
  let leadId;
  let conversationId;
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
      VALUES ('Reopen contract', '56900009496', 'pn-reopen', 'reopen-test') RETURNING id`)).rows[0].id;
    conversationId = (await client.query(`INSERT INTO conversations (source_number_id, phone_number,
      conversation_status_id, current_step, qualification_context, started_at)
      SELECT $1, $2, id, 'complete', $3::jsonb, NOW() - INTERVAL '2 minutes'
      FROM conversation_statuses WHERE code = 'handed_to_sales' RETURNING id`,
    [sourceId, phone, JSON.stringify(context)])).rows[0].id;
    leadId = (await client.query(`INSERT INTO leads (source_number_id, source_conversation_id, phone_number,
      lead_status_id, clickup_task_id, clickup_synced_requirement, service, city, requirement, qualification_context)
      SELECT $1, $2, $3, id, '86e3qf426', '• 50 bloques', 'despacho', 'Maipú', '• 50 bloques', $4::jsonb
      FROM lead_statuses WHERE code = 'assigned' RETURNING id`,
    [sourceId, conversationId, phone, JSON.stringify(context)])).rows[0].id;
    await client.query('UPDATE conversations SET lead_id = $2 WHERE id = $1', [conversationId, leadId]);
    for (const [direction, text] of [['incoming', 'Necesito 50 bloques para Maipú'], ['outgoing', 'Te resumo: 50 bloques. ¿Está correcto?'], ['incoming', 'Sí']]) {
      await client.query(`INSERT INTO messages (conversation_id, lead_id, direction, message_type, delivery_status, text_body)
        VALUES ($1, $2, $3, 'text', $4, $5)`, [conversationId, leadId, direction, direction === 'outgoing' ? 'sent' : null, text]);
    }
    await client.query(`INSERT INTO inbound_events (instance_name, event_fingerprint, dedupe_key, source_number_id,
      phone_number, processing_status, created_at)
      VALUES ('reopen-test', 'previous', 'previous', $1, $2, 'processed', NOW() - INTERVAL '1 minute')`, [sourceId, phone]);
  });
  afterEach(async () => { await client.query('ROLLBACK'); });

  const claimEvent = async () => {
    const identity = `reopen-${++eventNumber}`;
    const id = (await client.query(`INSERT INTO inbound_events (instance_name, event_fingerprint, dedupe_key,
      source_number_id, phone_number, queue_key, processing_status, processing_token)
      VALUES ('reopen-test', $1, $1, $2::bigint, $3::text, $2::bigint::text || ':' || $3::text, 'processing', 'reopen-token') RETURNING id`,
    [identity, sourceId, phone])).rows[0].id;
    return { id, identity };
  };
  const load = async (text) => {
    const event = await claimEvent();
    const row = (await client.query(loadSql, [phone, String(sourceId), '', '', event.identity, '', 'text', text, '{}',
      '', '', '', '', '', '', '', 'reopen-test', String(event.id), 'reopen-token'])).rows[0];
    return { event, row };
  };
  const route = (event, requestedConversationId, reopen) => client.query(routeSql, [
    event.id, 'reopen-token', requestedConversationId, sourceId, phone, 'enforce', 'reopen-rule',
    'service', 'text', event.identity, null, 'Perdón, me equivoqué: son 80 bloques, no 50', {}, reopen,
  ]);

  test('loads the open task and the history of a quote handed to sales', async () => {
    const { row } = await load('Perdón, me equivoqué: son 80 bloques, no 50');
    expect(row.lead_clickup_task_id).toBe('86e3qf426');
    expect(row.lead_clickup_status).toBeNull();
    expect(row.recent_messages.map((message) => message.content)).toEqual([
      'Necesito 50 bloques para Maipú', 'Te resumo: 50 bloques. ¿Está correcto?', 'Sí',
    ]);
    const evaluated = evaluateConversationStep(row, {}).json;
    expect(evaluated.reopen_confirmed_quote).toBe(true);
    expect(evaluated.conversation_id).toBe(conversationId);
    expect(evaluated.recent_messages).toHaveLength(3);
  });

  test('loads the closed status of a task so the turn starts a new quote', async () => {
    await client.query("UPDATE leads SET clickup_status = 'cerrada' WHERE id = $1", [leadId]);
    const { row } = await load('Perdón, me equivoqué: son 80 bloques, no 50');
    expect(row.lead_clickup_status).toBe('cerrada');
    expect(evaluateConversationStep(row, { CLICKUP_STATUS_RESOLVED: 'cerrada' }).json.reopen_confirmed_quote).toBe(false);
  });

  test('the route reuses the handed_to_sales conversation of a reopened quote', async () => {
    const { event } = await load('Perdón, me equivoqué: son 80 bloques, no 50');
    const { rows: [routed] } = await route(event, String(conversationId), true);
    expect(routed.route_failure_reason).toBeNull();
    expect(routed.conversation_id).toBe(conversationId);
    expect(routed.lead_id).toBe(leadId);
    expect(routed.qualification_context).toEqual(context);
  });

  test('a re-confirmed reopened quote updates the same lead and keeps its seller', async () => {
    const sellerId = (await client.query(`INSERT INTO sellers (name, clickup_user_id, is_active, sort_order)
      VALUES ('Catherine', '101', TRUE, 1) RETURNING id`)).rows[0].id;
    await client.query('UPDATE leads SET assigned_seller_id = $2 WHERE id = $1', [leadId, sellerId]);
    await client.query("INSERT INTO lead_statuses (code, label, sort_order) VALUES ('qualified_complete', 'Qualified', 2) ON CONFLICT (code) DO NOTHING");
    const corrected = { ...context, line_items: [{ item_id: 'i1', product: 'Bloques', quantity: '80' }] };
    const input = {
      previous_lead_id: '', source_number_id: String(sourceId), external_contact_id: '', whatsapp_name: 'Cliente',
      phone_number: phone, service: 'despacho', city: 'Maipú', requirement: '• 80 bloques',
      lead_status_code: 'qualified_complete', is_qualified: 'true', is_partial: 'false',
      rotation_key: 'whatsapp:default', conversation_id: String(conversationId),
      qualification_context: JSON.stringify(corrected), test_seller_id: '',
    };
    const leadsBefore = Number((await client.query('SELECT COUNT(*) FROM leads')).rows[0].count);
    const { rows: [persisted] } = await client.query(persistLeadNode.parameters.query, persistLeadParams.map((name) => input[name]));
    expect(persisted.lead_id).toBe(leadId);
    expect(persisted.requirement).toBe('• 80 bloques');
    expect(String(persisted.assigned_seller_id)).toBe(String(sellerId));
    expect(Number((await client.query('SELECT COUNT(*) FROM leads')).rows[0].count)).toBe(leadsBefore);
    const { rows: [lead] } = await client.query(
      'SELECT requirement, qualification_context, clickup_task_id, clickup_synced_requirement FROM leads WHERE id = $1', [leadId],
    );
    expect(lead).toEqual({
      requirement: '• 80 bloques', qualification_context: corrected,
      // The task still shows 50 until the ClickUp sync applies the correction.
      clickup_task_id: '86e3qf426', clickup_synced_requirement: '• 50 bloques',
    });
    expect((await client.query('SELECT COUNT(*) FROM lead_assignments WHERE lead_id = $1', [leadId])).rows[0].count).toBe('0');
  });

  test('without the reopen flag the route still opens a new conversation', async () => {
    const { event } = await load('Hola');
    const { rows: [routed] } = await route(event, String(conversationId), false);
    expect(routed.conversation_id).not.toBe(conversationId);
    expect(routed.qualification_context).toEqual({});
  });
});
