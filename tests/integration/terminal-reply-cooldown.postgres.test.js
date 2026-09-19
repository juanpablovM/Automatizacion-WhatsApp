import fs from 'node:fs';
import { createRequire } from 'node:module';
import pg from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'vitest';

const require = createRequire(import.meta.url);
const {
  evaluateConversationStep,
  TERMINAL_REPLY_COOLDOWN_HOURS,
  ESCALATION_ALREADY_REQUIRED_REPLY,
} = require('../fixtures/workflow-nodes/wa-conversation-orchestrator/evaluate-conversation-step.js');

const integration = process.env.TEST_PG_INTEGRATION === '1' ? describe : describe.skip;
const connection = {
  host: process.env.TEST_PGHOST || '127.0.0.1',
  port: Number(process.env.TEST_PGPORT || 55433),
  database: process.env.TEST_PGDATABASE || 'testdb',
  user: process.env.TEST_PGUSER || 'test',
  password: process.env.TEST_PGPASSWORD || 'test',
};
const fixtureRoot = 'tests/fixtures/workflow-nodes/';
const run = (path, row, env = {}) => new Function('items', '$env', fs.readFileSync(fixtureRoot + path, 'utf8'))([{ json: row }], env)[0].json;
const loadSql = fs.readFileSync('db/queries/n8n/wa-conversation-orchestrator/01_load_active_context.sql', 'utf8');

integration('terminal reply cooldown reads its own sent line back from PostgreSQL', () => {
  const client = new pg.Client(connection);
  const phone = `synthetic-cooldown-${process.pid}-${Date.now()}`;
  let sourceId;
  let conversationId;
  let eventNumber = 0;

  beforeAll(async () => { await client.connect(); });
  afterAll(async () => { await client.end(); });

  beforeEach(async () => {
    await client.query('BEGIN');
    sourceId = (await client.query(`INSERT INTO whatsapp_numbers (display_name, phone_number, phone_number_id)
      VALUES ('Cooldown contract', $1, $1) RETURNING id`, [phone])).rows[0].id;
    conversationId = (await client.query(`INSERT INTO conversations (source_number_id, phone_number,
      conversation_status_id, current_step, qualification_context)
      SELECT $1, $2, id, 'escalation', '{}'::jsonb
      FROM conversation_statuses WHERE code = 'escalation_required' RETURNING id`, [sourceId, phone])).rows[0].id;
    await client.query(`INSERT INTO inbound_events (instance_name, event_fingerprint, dedupe_key, source_number_id,
      phone_number, processing_status, created_at)
      VALUES ('cooldown-contract', $1, $1, $2, $3, 'processed', NOW() - INTERVAL '50 minutes')`,
    [`previous-${++eventNumber}-${phone}`, sourceId, phone]);
  });
  afterEach(async () => { await client.query('ROLLBACK'); });

  const sendBotLine = async (text, minutesAgo) => {
    await client.query(`INSERT INTO messages (conversation_id, direction, message_type, delivery_status,
      text_body, created_at)
      VALUES ($1, 'outgoing', 'text', 'sent', $2, NOW() - ($3 || ' minutes')::interval)`,
    [conversationId, text, String(minutesAgo)]);
  };

  const turn = async (text) => {
    const identity = `cooldown-${++eventNumber}-${phone}`;
    const eventId = (await client.query(`INSERT INTO inbound_events (instance_name, event_fingerprint, dedupe_key,
      source_number_id, phone_number, processing_status, processing_token)
      VALUES ('cooldown-contract', $1, $1, $2, $3, 'processing', 'cooldown-token') RETURNING id`,
    [identity, sourceId, phone])).rows[0].id;
    const row = (await client.query(loadSql, [phone, String(sourceId), '', '', identity, '', 'text', text, '{}',
      '', '', '', '', '', '', '', 'cooldown-contract', String(eventId), 'cooldown-token'])).rows[0];
    const evaluated = evaluateConversationStep(row).json;
    const applied = run('wa-conversation-orchestrator/apply-ai-assistance.js', {
      ...evaluated,
      ...Object.fromEntries(Object.entries(evaluated).map(([key, value]) => [key + '_1', value])),
    });
    const prepared = run('wa-conversation-orchestrator/prepare-conversation-output.js', {
      ...applied, conversation_id_1: applied.conversation_id, current_step_1: applied.current_step,
    });
    return { row, evaluated, applied, prepared, dispatched: Boolean(String(prepared.response_text || '').trim()) };
  };

  test('the loader derives the last outgoing line where recent_messages cannot', async () => {
    await sendBotLine(ESCALATION_ALREADY_REQUIRED_REPLY, 50);
    const { row } = await turn('Hola, seguimos disponibles');

    // recent_messages is scoped to active/waiting_user/out_of_flow conversations,
    // so it is empty exactly where the terminal canned lines live. That is why
    // the loader had to be extended instead of reusing it.
    expect(row.recent_messages).toEqual([]);
    expect(row.last_outgoing_text).toBe(ESCALATION_ALREADY_REQUIRED_REPLY);
    expect(Number(row.elapsed_hours_since_last_outbound)).toBeGreaterThan(0.5);
    expect(Number(row.elapsed_hours_since_last_outbound)).toBeLessThan(TERMINAL_REPLY_COOLDOWN_HOURS);
  });

  test('a first terminal reply is sent and the next one inside the cooldown is not', async () => {
    const first = await turn('Hola, seguimos disponibles');
    expect(first.evaluated.response_kind).toBe('escalation_already_required');
    expect(first.dispatched).toBe(true);

    await sendBotLine(first.prepared.response_text, 50);

    const second = await turn('Hola, seguimos disponibles');
    expect(second.evaluated.response_kind).toBe('reply_suppressed');
    expect(second.applied.response_text).toBe('');
    expect(second.prepared.response_text).toBeNull();
    expect(second.dispatched).toBe(false);
    expect(JSON.parse(second.evaluated.metadata_json).reply_suppression_reason).toBe('terminal_reply_cooldown');
  });

  test('the same line older than the cooldown is sent again', async () => {
    await sendBotLine(ESCALATION_ALREADY_REQUIRED_REPLY, (TERMINAL_REPLY_COOLDOWN_HOURS + 1) * 60);
    const result = await turn('Hola, seguimos disponibles');

    expect(result.evaluated.response_kind).toBe('escalation_already_required');
    expect(result.dispatched).toBe(true);
  });

  test('an explicit new request is answered even inside the cooldown', async () => {
    await sendBotLine(ESCALATION_ALREADY_REQUIRED_REPLY, 50);
    const result = await turn('Nueva cotización');

    expect(result.evaluated.response_kind).not.toBe('reply_suppressed');
    expect(result.dispatched).toBe(true);
  });

  test('a contentless inbound is persistable but never answered', async () => {
    const result = await turn('');

    expect(result.evaluated.response_kind).toBe('reply_suppressed');
    expect(JSON.parse(result.evaluated.metadata_json).reply_suppression_reason).toBe('contentless_inbound');
    expect(result.dispatched).toBe(false);
  });
});
