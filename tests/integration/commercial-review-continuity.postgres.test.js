import fs from 'node:fs';
import { createRequire } from 'node:module';
import pg from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'vitest';
const require = createRequire(import.meta.url);
const { evaluateConversationStep } = require('../fixtures/workflow-nodes/wa-conversation-orchestrator/evaluate-conversation-step.js');
const integration = process.env.TEST_PG_INTEGRATION === '1' ? describe : describe.skip;
const connection = { host: process.env.TEST_PGHOST || '127.0.0.1', port: Number(process.env.TEST_PGPORT || 55433),
  database: process.env.TEST_PGDATABASE || 'testdb', user: process.env.TEST_PGUSER || 'test', password: process.env.TEST_PGPASSWORD || 'test' };
const fixtureRoot = 'tests/fixtures/workflow-nodes/';
const run = (path, row, env = {}) => new Function('items', '$env', fs.readFileSync(fixtureRoot + path, 'utf8'))([{ json: row }], env)[0].json;
const loadSql = fs.readFileSync('db/queries/n8n/wa-conversation-orchestrator/01_load_active_context.sql', 'utf8');

integration('commercial review and address retry through persisted PostgreSQL state', () => {
  const client = new pg.Client(connection);
  const phone = `synthetic-review-${process.pid}-${Date.now()}`;
  let sourceId;
  let conversationId;
  let leadId;
  let eventNumber = 0;
  const context = { product: 'Pastelones', quantity: '100 unidades', commune: 'Vitacura', modality: 'delivery' };
  beforeAll(async () => { await client.connect(); });
  afterAll(async () => { await client.end(); });
  beforeEach(async () => {
    await client.query('BEGIN');
    sourceId = (await client.query(`INSERT INTO whatsapp_numbers (display_name, phone_number, phone_number_id)
      VALUES ('Review contract', $1, $1) RETURNING id`, [phone])).rows[0].id;
    leadId = (await client.query(`INSERT INTO leads (source_number_id, phone_number, lead_status_id,
      clickup_task_id, service, city, requirement)
      SELECT $1, $2, id, $3, 'Pastelones', 'Vitacura', '100 pastelones con despacho'
      FROM lead_statuses LIMIT 1 RETURNING id`, [sourceId, phone, `task-${phone}`])).rows[0].id;
    conversationId = (await client.query(`INSERT INTO conversations (source_number_id, phone_number, lead_id,
      conversation_status_id, current_step, qualification_context, pending_question_key)
      SELECT $1, $2, $3, id, 'confirm', $4::jsonb, 'address'
      FROM conversation_statuses WHERE code = 'waiting_user' RETURNING id`, [sourceId, phone, leadId, JSON.stringify(context)])).rows[0].id;
    await client.query(`INSERT INTO audit_logs (event_name, entity_type, entity_id, actor_type, result, after_payload, metadata)
      VALUES ('conversation_state_evaluated', 'conversation', $1, 'system', 'waiting_user', $2::jsonb,
      '{"pending_question_key":"address","commercial_question_retry":0}')`, [conversationId,
      JSON.stringify({ service: 'Pastelones', city: 'Vitacura', requirement: '100 pastelones con despacho', current_step: 'confirm' })]);
    await client.query(`INSERT INTO inbound_events (instance_name, event_fingerprint, dedupe_key, source_number_id,
      phone_number, processing_status, created_at)
      VALUES ('review-contract', $1, $1, $2, $3, 'processed', NOW() - INTERVAL '5 minutes')`, [`previous-${++eventNumber}-${phone}`, sourceId, phone]);
  });
  afterEach(async () => { await client.query('ROLLBACK'); });

  const turn = async (text, model = {}) => {
    const identity = `review-${++eventNumber}-${phone}`;
    const eventId = (await client.query(`INSERT INTO inbound_events (instance_name, event_fingerprint, dedupe_key,
      source_number_id, phone_number, processing_status, processing_token)
      VALUES ('review-contract', $1, $1, $2, $3, 'processing', 'review-token') RETURNING id`, [identity, sourceId, phone])).rows[0].id;
    const row = (await client.query(loadSql, [phone, String(sourceId), '', '', identity, '', 'text', text, '{}',
      '', '', '', '', '', '', '', 'review-contract', String(eventId), 'review-token'])).rows[0];
    const evaluated = evaluateConversationStep(row).json;
    const built = run('ai-lead-qualification-assistant/build-ai-request.js', evaluated, {
      AI_PROVIDER: 'google', AI_DIRECT_API_KEY: 'synthetic-key', AI_DIRECT_API_MODEL: 'synthetic-model',
    });
    const normalized = run('ai-lead-qualification-assistant/normalize-ai-result.js', {
      ...built, ai_context: { ...built.ai_context, message_current: text, current_step: evaluated.current_step,
        pending_question_key: evaluated.pending_question_key, existing_fields: { service: evaluated.service, city: evaluated.city, requirement: evaluated.requirement } },
      ai_status_code: 200, ai_response: { choices: [{ message: { content: JSON.stringify({ intent: 'quote_request', confidence: .95, ...model }) } }] },
    });
    const output = run('wa-conversation-orchestrator/apply-ai-assistance.js', { ...evaluated, ...normalized,
      // n8n Merge suffixes carry the authoritative deterministic branch.
      ...Object.fromEntries(Object.entries(evaluated).map(([key, value]) => [key + '_1', value])) });
    return { row, evaluated, built, output, eventId };
  };
  const persistTurn = async ({ output, eventId }) => {
    // Store the actual emitted context and audit payload, then let the next
    // LoadState query reconstruct retry facts. No retry metadata is injected.
    await client.query(`UPDATE conversations SET qualification_context = $2::jsonb,
      pending_question_key = $3, current_step = $4 WHERE id = $1`, [conversationId,
      JSON.stringify(output.qualification_context), output.pending_question_key, output.current_step]);
    await client.query(`INSERT INTO audit_logs (event_name, entity_type, entity_id, actor_type, result,
      after_payload, metadata) VALUES ('conversation_state_evaluated', 'conversation', $1,
      'system', 'waiting_user', $2::jsonb, $3::jsonb)`, [conversationId, output.after_payload_json, output.metadata_json]);
    await client.query("UPDATE inbound_events SET processing_status = 'processed', processing_token = NULL WHERE id = $1", [eventId]);
  };
  const setHandedToSales = async () => {
    await client.query(`UPDATE conversations SET conversation_status_id = (SELECT id FROM conversation_statuses
      WHERE code = 'handed_to_sales'), current_step = 'complete', pending_question_key = NULL WHERE id = $1`, [conversationId]);
  };

  test('successive literal communes clarify street and number then use the persisted bounded handoff', async () => {
    for (let expectedRetry = 1; expectedRetry <= 3; expectedRetry++) {
      const current = await turn('Vitacura', { field_updates: { commune: 'Vitacura' } });
      expect(current.row.previous_commercial_question_retry).toBe(expectedRetry - 1);
      expect(JSON.parse(current.output.metadata_json).commercial_question_retry).toBe(expectedRetry);
      expect(current.output.qualification_context.address).toBeUndefined();
      expect(current.output.should_create_lead).toBe(false);
      if (expectedRetry < 3) {
        expect(current.output.response_text).toContain('Ya tengo Vitacura');
        expect(current.output.response_text).toContain('calle y número');
      } else expect(current.output.should_escalate).toBe(true);
      await persistTurn(current);
    }
  });
  test('a genuine current street address clears the persisted retry and advances to access', async () => {
    await client.query(`UPDATE audit_logs SET metadata = '{"pending_question_key":"address","commercial_question_retry":2}'
      WHERE entity_type = 'conversation' AND entity_id = $1`, [conversationId]);
    const current = await turn('Calle Prueba 100', { field_updates: { address: 'Calle Prueba 100' } });
    expect(current.output.qualification_context.address).toBe('Calle Prueba 100');
    expect(current.output.pending_question_key).toBe('access_restrictions');
    expect(current.output.should_escalate).toBe(false);
    expect(JSON.parse(current.output.metadata_json).commercial_question_retry).toBe(0);
  });
  test('recent quote acknowledgment keeps exact lead and conversation with no new effects', async () => {
    await setHandedToSales();
    const current = await turn('Hola');
    expect(current.row.has_active_conversation).toBe(false);
    expect(current.built.ai_skipped).toBe(true);
    expect(current.output).toMatchObject({ conversation_id: conversationId, lead_id: leadId,
      reset_conversation_lead: false, should_create_lead: false, should_escalate: false,
      conversation_status_code: 'handed_to_sales', response_kind: 'commercial_review_pending' });
    expect(current.output.qualification_context).toEqual(context);
    expect(run('wa-inbound-downstream-dispatcher/ensure-early-opportunity.js', current.output).opportunity_write).toBe(false);
    expect(current.output.response_text).toContain('pendiente de revisión');
    await persistTurn(current);
    expect((await client.query('SELECT lead_id FROM conversations WHERE id = $1', [conversationId])).rows[0].lead_id).toBe(leadId);
  });
  test('an acquired human lease stays silent without clearing the registered quote', async () => {
    await setHandedToSales();
    await client.query(`INSERT INTO lead_chat_ownerships (lead_id, clickup_task_id, response_due_at)
      VALUES ($1, $2, NOW() + INTERVAL '2 hours')`, [leadId, `task-${phone}`]);
    const current = await turn('Hola');
    expect(current.row.bot_suppressed).toBe(true);
    expect(current.built.ai_skipped).toBe(true);
    expect(current.output.conversation_id).toBe(conversationId);
    expect(current.output.qualification_context).toEqual(context);
    expect(current.output.response_text).toBe('');
    expect(current.output.reset_conversation_lead).toBe(false);
  });
  test('expired ownership follows the existing arbitration path rather than indefinite pending review', async () => {
    await setHandedToSales();
    await client.query(`INSERT INTO lead_chat_ownerships (lead_id, clickup_task_id, response_due_at)
      VALUES ($1, $2, NOW() - INTERVAL '1 minute')`, [leadId, `task-${phone}`]);
    const current = await turn('Hola');
    expect(current.row.human_arbitration_required).toBe(true);
    expect(current.output.human_arbitration_required).toBe(true);
    expect(current.output.response_kind).not.toBe('commercial_review_pending');
  });
});
