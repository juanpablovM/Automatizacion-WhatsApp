// =============================================================================
// CRM 1.2d (migration 047): lock order between a lead created for a handed-off
// conversation (Persist Lead And Rotation, whose leads trigger adopts the
// conversation-keyed lease under the chat-authority lock) and the completion
// of a CRM message.send on the same conversation. Both take the conversation
// row and chat-authority in the same order, so neither ends in a deadlock.
//
// Committed data and separate clients (a deadlock needs real concurrency);
// every row is removed afterwards.
// Feature document: odd/tasks/crm-1-2d-contingency-handoffs.md (S8).
// =============================================================================
import crypto from 'node:crypto';
import fs from 'node:fs';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';

const enabled = process.env.TEST_PG_INTEGRATION === '1';
const describeIntegration = enabled ? describe : describe.skip;
const connection = {
  host: process.env.TEST_PGHOST || '127.0.0.1',
  port: Number(process.env.TEST_PGPORT || 55433),
  database: process.env.TEST_PGDATABASE || 'testdb',
  user: process.env.TEST_PGUSER || 'test',
  password: process.env.TEST_PGPASSWORD || 'test',
};

const read = (file) => fs.readFileSync(file, 'utf8');
const claimSendSql = read('db/queries/n8n/crm-inbound-events/05_claim_crm_conversation_message_send.sql');
const completeSendSql = read('db/queries/n8n/crm-inbound-events/03_complete_crm_message_send.sql');
const persistLeadSql = JSON.parse(read('n8n/workflows/crm-lead-creation-and-assignment.json'))
  .nodes.find((node) => node.name === 'Persist Lead And Rotation').parameters.query;
const hash = (value) => crypto.createHash('sha256').update(value).digest('hex');
const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

describeIntegration('CRM 1.2d conversation ownership lock order (migration 047)', () => {
  const setup = new pg.Client(connection);
  const seller = crypto.randomUUID();
  const rotationKey = `locks-rotation-${crypto.randomUUID()}`;
  const created = {};

  beforeAll(async () => { await setup.connect(); });
  afterAll(async () => {
    const q = (sql, params) => setup.query(sql, params);
    if (created.conversationId) {
      await q('DELETE FROM crm_outbound_messages WHERE conversation_id = $1', [created.conversationId]);
      await q('DELETE FROM crm_inbound_events WHERE conversation_id = $1 OR event_id LIKE $2', [created.conversationId, `${created.eventId}%`]);
      await q('DELETE FROM crm_events WHERE handoff_id = $1', [created.handoffId]);
      await q('DELETE FROM handoffs WHERE id = $1', [created.handoffId]);
      await q('DELETE FROM lead_chat_ownerships WHERE conversation_id = $1 OR lead_id IN (SELECT id FROM leads WHERE source_conversation_id = $1)', [created.conversationId]);
      await q('DELETE FROM crm_ownership_changes WHERE conversation_id = $1', [created.conversationId]);
      await q('DELETE FROM crm_conversation_ownership WHERE conversation_id = $1', [created.conversationId]);
      await q('DELETE FROM lead_assignments WHERE lead_id IN (SELECT id FROM leads WHERE source_conversation_id = $1)', [created.conversationId]);
      await q('DELETE FROM audit_logs WHERE metadata->>\'conversation_id\' = $1::text', [created.conversationId]);
      await q('DELETE FROM messages WHERE conversation_id = $1', [created.conversationId]);
      await q('UPDATE conversations SET lead_id = NULL WHERE id = $1', [created.conversationId]);
      await q('DELETE FROM leads WHERE source_conversation_id = $1', [created.conversationId]);
      await q('DELETE FROM conversations WHERE id = $1', [created.conversationId]);
      await q('DELETE FROM assignment_rotations WHERE rotation_key = $1', [rotationKey]);
      await q('DELETE FROM whatsapp_numbers WHERE id = $1', [created.sourceNumberId]);
    }
    await q('UPDATE sellers SET deleted_at = NOW(), crm_user_id = NULL, is_active = FALSE WHERE id = $1', [created.sellerId]);
    await setup.end();
  });

  test('lead creation and message.send completion racing on one conversation both commit', async () => {
    const q = async (sql, params) => (await setup.query(sql, params)).rows;
    [{ id: created.sellerId }] = await q(
      `INSERT INTO sellers (name, is_active, sort_order, crm_user_id, clickup_user_id)
       VALUES ('Locks', TRUE, 95000 + (random() * 4000)::int, $1::uuid, 'cu-locks-' || $1::text) RETURNING id`, [seller],
    );
    await q(`INSERT INTO lead_statuses (code, label, sort_order) VALUES ('assigned', 'Assigned', 2) ON CONFLICT (code) DO NOTHING`);
    [{ id: created.sourceNumberId }] = await q(
      `INSERT INTO whatsapp_numbers (display_name, phone_number, phone_number_id, instance_name)
       VALUES ('Locks', '562' || (random() * 1e8)::int, 'pn-' || gen_random_uuid(), 'locks-' || gen_random_uuid()) RETURNING id`,
    );
    const phone = `5694${String(Math.floor(Math.random() * 1e7)).padStart(7, '0')}`;
    [{ id: created.conversationId }] = await q(
      `INSERT INTO conversations (phone_number, conversation_status_id, source_number_id, started_at, last_message_at)
       VALUES ($1, (SELECT id FROM conversation_statuses WHERE code = 'escalation_required'), $2, NOW(), NOW()) RETURNING id`,
      [phone, created.sourceNumberId],
    );
    const conversationId = String(created.conversationId);
    await q(
      `INSERT INTO messages (conversation_id, direction, sender_type, message_type, text_body, raw_payload)
       VALUES ($1, 'incoming', 'customer', 'text', 'hola', '{}')`, [conversationId],
    );
    [{ id: created.handoffId }] = await q(
      `INSERT INTO handoffs (idempotency_key, conversation_id, phone_number, motivo, area, area_label, prioridad,
                             responsable, estado, notified_at, crm_routing_seller_id)
       VALUES ('locks-' || gen_random_uuid(), $1, $2, 'human_request', 'sales', 'Ventas', 'alta', 'Ventas', 'notified',
               NOW(), $3) RETURNING id`, [conversationId, phone, created.sellerId],
    );
    const ref = `wa-locks-conversation-${conversationId}`;
    await q(
      `INSERT INTO crm_events (event_id, event_type, conversation_id, handoff_id, revision, body, status, delivered_at)
       VALUES ($1, 'handoff.created', $2, $3, 1, '{}', 'delivered', NOW())`,
      [`wa-locks-handoff-${created.handoffId}-r1`, ref, created.handoffId],
    );
    created.eventId = `crm-evt-${crypto.randomUUID()}`;
    const clientMessageId = crypto.randomUUID();
    const [claimed] = await q(claimSendSql, [
      created.eventId, hash(created.eventId + clientMessageId), ref, conversationId, seller, clientMessageId, '0', 'Hola desde el CRM',
    ]);
    expect(claimed.send).toBe(true);

    const providerId = `PROV${crypto.randomUUID().slice(0, 8)}`;
    const echo = new pg.Client(connection);
    const lead = new pg.Client(connection);
    const completion = new pg.Client(connection);
    await Promise.all([echo.connect(), lead.connect(), completion.connect()]);
    try {
      // The seller's fromMe echo of the CRM send, stored with the same provider id.
      await echo.query('BEGIN');
      await echo.query(
        `INSERT INTO messages (conversation_id, direction, sender_type, message_type, external_message_id,
                               delivery_status, text_body, raw_payload)
         VALUES ($1, 'outgoing', 'human', 'text', $2, 'sent', 'Hola desde el CRM', '{}')`, [conversationId, providerId],
      );
      await completion.query('BEGIN');
      const completed = completion.query(completeSendSql, [
        String(claimed.outbound_id), String(claimed.attempt), 'sent', providerId, '201', '', 'locks',
      ]).then(async (r) => { await completion.query('COMMIT'); return r.rows[0]; },
        async (error) => { await completion.query('ROLLBACK'); throw error; });
      await sleep(300);
      await lead.query('BEGIN');
      const persisted = lead.query(persistLeadSql, [
        '', String(created.sourceNumberId), '', 'Ana', phone, 'cierre', 'Santiago', 'cotizar', 'qualified_complete',
        'true', 'false', rotationKey, conversationId, '{}', '',
      ]).then(async (r) => { await lead.query('COMMIT'); return r.rows[0]; },
        async (error) => { await lead.query('ROLLBACK'); throw error; });
      await sleep(300);
      await echo.query('COMMIT');

      const [leadResult, completionResult] = await Promise.allSettled([persisted, completed]);
      expect(leadResult).toMatchObject({ status: 'fulfilled' });
      expect(completionResult).toMatchObject({ status: 'fulfilled', value: { http_status: 200 } });
      expect(leadResult.value.lead_id).not.toBeNull();
      const live = await q(
        `SELECT lead_id, conversation_id FROM lead_chat_ownerships
         WHERE (conversation_id = $1 OR lead_id = $2) AND released_at IS NULL AND deleted_at IS NULL`,
        [conversationId, leadResult.value.lead_id],
      );
      expect(live).toEqual([{ lead_id: String(leadResult.value.lead_id), conversation_id: null }]);
    } finally {
      await Promise.all([echo.end(), lead.end(), completion.end()]);
    }
  });
});
