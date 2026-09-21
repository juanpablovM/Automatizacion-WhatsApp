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
const sourceSql = fs.readFileSync('db/queries/ops/archive-all-contact-context.sql', 'utf8');

integration('global contact context archive in PostgreSQL', () => {
  const client = new pg.Client(connection);
  // Private tables prevent this all-contact operation from touching fixtures of
  // other integration suites. Each actual archive is also rolled back afterward.
  const schema = `archive_contract_${process.pid}_${Date.now()}`;
  let conversationId;
  let leadId;
  let sourceId;
  let ownershipId;
  let handoffId;
  const execute = (scope = 'all', conversations = 3, leads = 1) => client.query(
    sourceSql.replace(/^BEGIN;$/m, '').replace(/^COMMIT;$/m, '')
      .replaceAll(":'reset_scope'", `'${scope}'`)
      .replaceAll(":'expected_non_deleted_conversations'", `'${conversations}'`)
      .replaceAll(":'expected_non_deleted_leads'", `'${leads}'`),
  );
  const snapshot = async () => {
    const result = await client.query(`SELECT
      (SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM conversations t) conversations,
      (SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM leads t) leads,
      (SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM messages t) messages,
      (SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM follow_ups t) follow_ups,
      (SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM handoffs t) handoffs,
      (SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM lead_chat_ownerships t) ownerships,
      (SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM external_operations t) operations,
      (SELECT COUNT(*)::integer FROM audit_logs) audit_count`);
    return result.rows[0];
  };
  const rejectsWithoutChanges = async (pattern, scope = 'all', conversations = 3, leads = 1) => {
    const before = await snapshot();
    await client.query('SAVEPOINT archive_guard');
    await expect(execute(scope, conversations, leads)).rejects.toThrow(pattern);
    await client.query('ROLLBACK TO SAVEPOINT archive_guard');
    expect(await snapshot()).toEqual(before);
  };

  beforeAll(async () => {
    await client.connect();
    await client.query(`CREATE SCHEMA ${schema}; SET search_path TO ${schema}, public`);
    for (const table of ['conversation_statuses', 'lead_statuses', 'whatsapp_numbers',
      'inbound_events', 'conversations', 'leads', 'opportunities', 'handoffs', 'lead_chat_ownerships',
      'follow_ups', 'follow_up_preferences', 'messages', 'external_operations', 'audit_logs']) {
      await client.query(`CREATE TABLE ${schema}.${table} (LIKE public.${table} INCLUDING ALL)`);
    }
    await client.query('INSERT INTO conversation_statuses SELECT * FROM public.conversation_statuses');
    await client.query('INSERT INTO lead_statuses SELECT * FROM public.lead_statuses');
    await client.query(`CREATE TRIGGER enforce_handoff_before_terminal
      BEFORE UPDATE OF conversation_status_id ON conversations FOR EACH ROW
      EXECUTE FUNCTION public.enforce_handoff_before_conversation_terminal()`);
  });
  afterAll(async () => {
    await client.query('ROLLBACK');
    await client.query(`DROP SCHEMA ${schema} CASCADE`);
    await client.end();
  });
  beforeEach(async () => {
    await client.query('BEGIN');
    sourceId = (await client.query(`INSERT INTO whatsapp_numbers (display_name, phone_number, phone_number_id)
      VALUES ('Archive contract', 'synthetic-source', 'synthetic-source-id') RETURNING id`)).rows[0].id;
    leadId = (await client.query(`INSERT INTO leads (phone_number, source_number_id, lead_status_id, clickup_task_id, service, city)
      SELECT 'synthetic-contact', $1, id, 'old-task', 'Old product', 'Old city' FROM lead_statuses LIMIT 1 RETURNING id`, [sourceId])).rows[0].id;
    for (const status of ['waiting_user', 'closed', 'escalation_required']) {
      const row = await client.query(`INSERT INTO conversations (phone_number, source_number_id, lead_id,
        conversation_status_id, current_step, qualification_context, pending_question_key)
        SELECT 'synthetic-contact', $1, $2, id, 'previous_context', '{"quantity":56}', 'previous_context_choice'
        FROM conversation_statuses WHERE code = $3 RETURNING id`, [sourceId, leadId, status]);
      conversationId = row.rows[0].id;
    }
    handoffId = (await client.query(`INSERT INTO handoffs (idempotency_key, conversation_id, phone_number,
      source_number_id, motivo, area, area_label, prioridad, responsable)
      VALUES ('archive-handoff', $1, 'synthetic-contact', $2, 'unknown_quantity', 'sales', 'Sales', 'media', 'Sales') RETURNING id`, [conversationId, sourceId])).rows[0].id;
    ownershipId = (await client.query(`INSERT INTO lead_chat_ownerships (lead_id, clickup_task_id, previous_clickup_status,
      response_due_at, restoration_state) VALUES ($1, 'old-task', 'new', NOW() - INTERVAL '3 hours', 'pending') RETURNING id`, [leadId])).rows[0].id;
    await client.query(`INSERT INTO opportunities (phone_number, source_number_id, conversation_id)
      VALUES ('synthetic-contact', $1, $2)`, [sourceId, conversationId]);
    await client.query(`INSERT INTO follow_ups (idempotency_key, cycle_key, conversation_id, phone_number, motivo,
      step_dia, scheduled_at, estado) VALUES
      ('archive-pending', 'archive-cycle', $1, 'synthetic-contact', 'lead_sin_respuesta', 1, NOW(), 'pending'),
      ('archive-sent', 'archive-cycle', $1, 'synthetic-contact', 'lead_sin_respuesta', 3, NOW(), 'sent')`, [conversationId]);
    await client.query(`INSERT INTO messages (conversation_id, lead_id, direction, sender_type, message_type,
      delivery_status, dispatch_phase, text_body, external_message_id, idempotency_key) VALUES
      ($1, $2, 'incoming', 'customer', 'text', NULL, NULL, 'Old inbound', 'old-inbound', NULL),
      ($1, $2, 'outgoing', 'bot', 'text', 'sent', 'sent', 'Old sent', 'old-sent', 'archive-sent-message'),
      ($1, $2, 'outgoing', 'bot', 'text', 'failed', 'failed', 'Old retry', NULL, 'archive-failed-message'),
      ($1, $2, 'outgoing', 'bot', 'text', 'unknown', 'unknown', 'Ambiguous send', NULL, 'archive-unknown-message')`, [conversationId, leadId]);
    await client.query(`INSERT INTO external_operations (operation_key, operation_type, entity_type, entity_id,
      status, external_id, retry_safe) VALUES
      ('archive-handoff-op', 'handoff_clickup_notification', 'handoff', $1, 'pending', NULL, TRUE),
      ('archive-ownership-op', 'clickup_status_reacquire', 'lead_chat_ownership', $2, 'unknown', NULL, FALSE),
      ('archive-lead-op', 'clickup_create_lead', 'lead', $3, 'succeeded', 'old-task', FALSE)`, [handoffId, ownershipId, leadId]);
  });
  afterEach(async () => { await client.query('ROLLBACK'); });

  test('refuses missing explicit all scope without changing any row', async () => {
    await rejectsWithoutChanges(/reset_scope/, 'selected');
  });
  test('refuses stale expected conversation or lead counts without changing any row', async () => {
    await rejectsWithoutChanges(/counts do not match/, 'all', 217, 108);
  });
  test('refuses historical conversation opt-out without changing any row', async () => {
    await client.query('INSERT INTO follow_up_preferences (conversation_id, opted_out) VALUES ($1, TRUE)', [conversationId]);
    await rejectsWithoutChanges(/stored opt-out/);
  });
  test('refuses historical follow-up opt-out without changing any row', async () => {
    await client.query("UPDATE follow_ups SET estado = 'opted_out' WHERE estado = 'sent'");
    await rejectsWithoutChanges(/stored opt-out/);
  });
  test('refuses queued inbound events without changing any row', async () => {
    await client.query(`INSERT INTO inbound_events (instance_name, event_fingerprint, dedupe_key,
      phone_number, processing_status) VALUES ('archive-contract', 'archive-queued', 'archive-queued', 'synthetic-contact', 'received')`);
    await rejectsWithoutChanges(/queued\/processing/);
  });
  test('refuses outbound in-flight claims without changing any row', async () => {
    await client.query("UPDATE messages SET dispatch_phase = 'sending', delivery_status = 'sending' WHERE dispatch_phase = 'failed'");
    await rejectsWithoutChanges(/in-flight/);
  });
  test('refuses restoration claims without changing any row', async () => {
    await client.query("UPDATE lead_chat_ownerships SET restoration_claim_token = 'active-claim'");
    await rejectsWithoutChanges(/in-flight/);
  });

  test('archives terminal and escalated context without resolving commercial work or deleting messages', async () => {
    const before = await snapshot();
    await execute();
    const after = await snapshot();
    expect(after.conversations).toHaveLength(3);
    for (const row of after.conversations) {
      expect(row.deleted_at).not.toBeNull();
      const old = before.conversations.find((item) => item.id === row.id);
      expect(row.conversation_status_id).toBe(old.conversation_status_id);
      expect(row.qualification_context).toEqual(old.qualification_context);
      expect(row.closed_at).toBe(old.closed_at);
    }
    expect(after.leads[0].deleted_at).not.toBeNull();
    expect(after.leads[0].clickup_task_id).toBe('old-task');
    expect(after.handoffs[0].estado).toBe('pending');
    expect(after.handoffs[0].deleted_at).not.toBeNull();
    expect(after.ownerships[0].deleted_at).not.toBeNull();
    expect(after.ownerships[0].release_reason).toBe('manual');
    expect(after.ownerships[0].restoration_state).toBe('skipped_status_changed');
    expect(after.follow_ups.find((row) => row.idempotency_key === 'archive-pending').estado).toBe('cancelled');
    expect(after.follow_ups.find((row) => row.idempotency_key === 'archive-sent')).toEqual(before.follow_ups.find((row) => row.idempotency_key === 'archive-sent'));
    for (const row of after.messages) {
      const old = before.messages.find((item) => item.id === row.id);
      expect(row.deleted_at).toBeNull();
      expect(row.text_body).toBe(old.text_body);
      if (old.direction === 'incoming' || old.delivery_status === 'sent') expect(row).toEqual(old);
      else {
        expect(row.dispatch_phase).toBe('cancelled');
        expect(row.delivery_status).toBe(old.delivery_status);
      }
    }
    expect(after.operations.find((row) => row.status === 'succeeded')).toEqual(before.operations.find((row) => row.status === 'succeeded'));
    expect(after.operations.filter((row) => row.status !== 'succeeded').every((row) => !row.retry_safe && row.status === 'failed')).toBe(true);
    const receipt = await client.query("SELECT * FROM audit_logs WHERE event_name = 'all_contact_context_archived'");
    expect(receipt.rows).toHaveLength(1);
    expect(receipt.rows[0].after_payload).toMatchObject({ conversations: 3, leads: 1, opportunities: 1,
      handoffs: 1, lead_chat_ownerships: 1, follow_ups_cancelled: 1,
      outbound_dispatches_cancelled: 2, external_operations_cancelled: 2, total_rows_changed: 12 });
    const audit = await client.query("SELECT * FROM audit_logs WHERE event_name = 'contact_context_archived'");
    expect(audit.rows).toHaveLength(12);
    expect(audit.rows.every((row) => row.before_payload.id === row.after_payload.id
      && row.metadata.reset_id === receipt.rows[0].metadata.reset_id)).toBe(true);
  });

  test('preserves historical sent dispatch tokens without treating them as live claims', async () => {
    await client.query("UPDATE messages SET dispatch_token = 'historical-sent-token' WHERE dispatch_phase = 'sent'");
    const before = (await snapshot()).messages.find((row) => row.dispatch_phase === 'sent');
    await execute();
    expect((await snapshot()).messages.find((row) => row.id === before.id)).toEqual(before);
  });

  test('normal LoadState excludes old context and exact old task cannot reacquire ownership', async () => {
    await execute();
    expect((await client.query("SELECT * FROM claim_due_follow_ups(20, '00:00', '23:59', NOW(), 900)")).rows).toEqual([]);
    const sweep = fs.readFileSync('db/queries/n8n/lead-chat-ownership/06_claim_expired_ownerships.sql', 'utf8');
    expect((await client.query(sweep, ['20', '900'])).rows).toEqual([]);
    const handoffClaim = fs.readFileSync('db/queries/n8n/handoff-routing/02_claim_notification.sql', 'utf8');
    expect((await client.query(handoffClaim, ['20', '900'])).rows).toEqual([]);
    const reacquire = fs.readFileSync('db/queries/n8n/lead-chat-ownership/09_claim_clickup_reacquisitions.sql', 'utf8');
    expect((await client.query(reacquire, ['20', '300', '60', '5'])).rows).toEqual([]);
    const event = await client.query(`INSERT INTO inbound_events (instance_name, event_fingerprint, dedupe_key,
      source_number_id, phone_number, processing_status, processing_token)
      VALUES ('archive-contract', 'archive-fresh', 'archive-fresh', $1, 'synthetic-contact', 'processing', 'fresh-token') RETURNING id`, [sourceId]);
    const load = fs.readFileSync('db/queries/n8n/wa-conversation-orchestrator/01_load_active_context.sql', 'utf8');
    const input = ['synthetic-contact', String(sourceId), '', '', 'fresh-message', '', 'text', 'Hola', '{}',
      '', '', '', '', '', '', '', 'archive-contract', String(event.rows[0].id), 'fresh-token'];
    const state = (await client.query(load, input)).rows[0];
    expect(state).toMatchObject({ has_existing_conversation: false, is_recent_conversation: false,
      is_reengagement: false, conversation_id: null, previous_lead_id: null,
      last_known_service: null, last_known_city: null, bot_suppressed: false,
      qualification_context: {}, recent_messages: [] });
    const acquire = fs.readFileSync('db/queries/n8n/lead-chat-ownership/01_acquire_ownership_from_clickup.sql', 'utf8');
    expect((await client.query(acquire, ['old-task', 'new', 'late-history', new Date().toISOString()])).rows[0].outcome).toBe('unknown_task');
    expect((await client.query('SELECT COUNT(*)::integer count FROM external_operations')).rows[0].count).toBe(3);
  });
});
