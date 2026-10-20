import fs from 'node:fs';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';

// Quote follow-up chat ownership (migration 037, owner decision 2026-10-16):
// once the quote was sent the seller keeps the chat with no expiry, the bot
// alerts once per unanswered streak, and a customer who accepts the new-quote
// offer releases the ownership without touching the old ClickUp task.

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
const ownershipQuery = (file) => read(`db/queries/n8n/lead-chat-ownership/${file}`);

const QUOTE_STATUSES = 'cotización enviada,seguimiento';
const MINUTE = 60 * 1000;

describeIntegration('lead chat ownership: quote follow-up mode', () => {
  const client = new pg.Client(connection);
  const acquireSql = ownershipQuery('01_acquire_ownership_from_clickup.sql');
  const customerMessageSql = ownershipQuery('03_register_customer_message.sql');
  const humanReplySql = ownershipQuery('04_register_human_reply.sql');
  const claimExpiredSql = ownershipQuery('06_claim_expired_ownerships.sql');
  const claimAlertsSql = ownershipQuery('11_claim_quote_followup_alerts.sql');
  const completeAlertSql = ownershipQuery('12_complete_quote_followup_alert.sql');
  const authorizeSql = read('db/queries/n8n/wa-outbound-messages/05_authorize_outbound_send.sql');
  const loadContextSql = read('db/queries/n8n/wa-conversation-orchestrator/01_load_active_context.sql');
  const persistSql = read('db/queries/n8n/wa-conversation-orchestrator/07_persist_conversation_state.sql');

  const suffix = `${process.pid}${Date.now()}`.slice(-8);
  const leadIds = [];
  const conversationIds = [];
  const inboundEventIds = [];
  let sourceNumberId;
  let sellerId;
  let draftStatusId;
  let activeStatusId;
  let sequence = 0;

  const acquire = (taskId, previousStatus, historyId, eventAt, newStatus, quoteStatuses = QUOTE_STATUSES) =>
    client.query(acquireSql, [taskId, previousStatus, historyId, eventAt, newStatus, quoteStatuses]);
  const claimAlerts = (slaMinutes = 30, realertHours = 24, staleSeconds = 900) =>
    client.query(claimAlertsSql, [50, slaMinutes, realertHours, staleSeconds]);
  const completeAlert = (ownershipId, token, result, error = null, commentOutcome = 'posted') =>
    client.query(completeAlertSql, [ownershipId, token, result, error, commentOutcome]);
  const ago = (minutes) => new Date(Date.now() - minutes * MINUTE).toISOString();

  const seedLead = async ({ clickupStatus = 'cotización enviada' } = {}) => {
    sequence += 1;
    const phoneNumber = `5699${suffix}${String(sequence).padStart(2, '0')}`;
    const taskId = `qf-task-${suffix}-${sequence}`;
    const lead = await client.query(`
      INSERT INTO leads (source_number_id, phone_number, whatsapp_name, lead_status_id,
        clickup_task_id, clickup_status, assigned_seller_id, channel)
      VALUES ($1, $2, 'Cliente Prueba', $3, $4, $5, $6, 'whatsapp')
      RETURNING id
    `, [sourceNumberId, phoneNumber, draftStatusId, taskId, clickupStatus, sellerId]);
    const leadId = lead.rows[0].id;
    leadIds.push(leadId);
    const conversation = await client.query(`
      INSERT INTO conversations (lead_id, source_number_id, phone_number, conversation_status_id,
        started_at, last_message_at)
      VALUES ($1, $2, $3, $4, NOW() - INTERVAL '3 hours', NOW())
      RETURNING id
    `, [leadId, sourceNumberId, phoneNumber, activeStatusId]);
    conversationIds.push(conversation.rows[0].id);
    return { leadId, taskId, phoneNumber, conversationId: conversation.rows[0].id };
  };

  const seedMessage = async (lead, senderType, createdAt, text = `${senderType} message`) => {
    const { rows } = await client.query(`
      INSERT INTO messages (conversation_id, lead_id, direction, message_type, sender_type,
        text_body, created_at)
      VALUES ($1, $2, $3, 'text', $4, $5, $6)
      RETURNING id
    `, [lead.conversationId, lead.leadId, senderType === 'customer' ? 'incoming' : 'outgoing',
      senderType, text, createdAt]);
    return rows[0].id;
  };

  const ownershipOf = async (leadId) => (await client.query(`
    SELECT * FROM lead_chat_ownerships WHERE lead_id = $1 AND deleted_at IS NULL
    ORDER BY id DESC LIMIT 1
  `, [leadId])).rows[0];

  // A quote follow-up ownership acquired two hours ago.
  const seedQuoteOwnership = async (overrides = {}) => {
    const lead = await seedLead(overrides);
    const acquired = await acquire(lead.taskId, 'en atención', `qf-hist-${lead.taskId}`, ago(120), 'cotización enviada');
    expect(acquired.rows[0].outcome).toBe('acquired');
    return { ...lead, ownershipId: acquired.rows[0].ownership_id };
  };

  const alertFor = (rows, ownershipId) => rows.find((row) => row.ownership_id === ownershipId);

  const seedInboundEvent = async (lead) => {
    const token = `qf-token-${suffix}-${++sequence}`;
    const { rows } = await client.query(`
      INSERT INTO inbound_events (instance_name, event_fingerprint, dedupe_key, source_number_id,
        phone_number, processing_status, processing_token)
      VALUES ('qf-test', $1, $1, $2, $3, 'processing', $4)
      RETURNING id
    `, [`qf-event-${suffix}-${sequence}`, sourceNumberId, lead.phoneNumber, token]);
    inboundEventIds.push(rows[0].id);
    return { id: rows[0].id, token };
  };

  beforeAll(async () => {
    await client.connect();
    sourceNumberId = (await client.query(`
      INSERT INTO whatsapp_numbers (display_name, phone_number, phone_number_id, is_active)
      VALUES ($1, $2, $3, TRUE) RETURNING id
    `, [`qf-${suffix}`, `5698${suffix}`, `pn-qf-${suffix}`])).rows[0].id;
    sellerId = (await client.query(`
      INSERT INTO sellers (name, clickup_user_id, is_active, sort_order)
      VALUES ('Juan Pablo (Pruebas)', $1, TRUE, 900) RETURNING id
    `, [`9${suffix}`])).rows[0].id;
    draftStatusId = (await client.query("SELECT id FROM lead_statuses WHERE code = 'draft'")).rows[0].id;
    activeStatusId = (await client.query("SELECT id FROM conversation_statuses WHERE code = 'active'")).rows[0].id;
  });

  afterAll(async () => {
    const ownerships = (await client.query(
      'SELECT id FROM lead_chat_ownerships WHERE lead_id = ANY($1::bigint[])', [leadIds],
    )).rows.map((row) => row.id);
    await client.query(`DELETE FROM audit_logs WHERE entity_type = 'lead_chat_ownership'
      AND entity_id = ANY($1::bigint[])`, [ownerships]);
    await client.query(`DELETE FROM external_operations WHERE entity_type = 'lead_chat_ownership'
      AND entity_id = ANY($1::bigint[])`, [ownerships]);
    await client.query('DELETE FROM lead_chat_ownerships WHERE id = ANY($1::bigint[])', [ownerships]);
    const conversations = (await client.query(
      'SELECT id FROM conversations WHERE source_number_id = $1', [sourceNumberId],
    )).rows.map((row) => row.id);
    await client.query('DELETE FROM audit_logs WHERE entity_type = $1 AND entity_id = ANY($2::bigint[])',
      ['conversation', conversations]);
    await client.query('DELETE FROM messages WHERE conversation_id = ANY($1::bigint[])', [conversations]);
    await client.query('DELETE FROM inbound_events WHERE source_number_id = $1', [sourceNumberId]);
    await client.query('DELETE FROM conversations WHERE id = ANY($1::bigint[])', [conversations]);
    await client.query('DELETE FROM leads WHERE id = ANY($1::bigint[])', [leadIds]);
    await client.query('DELETE FROM sellers WHERE id = $1', [sellerId]);
    await client.query('DELETE FROM whatsapp_numbers WHERE id = $1', [sourceNumberId]);
    await client.end();
  });

  describe('ownership mode from the ClickUp status', () => {
    test('a quote-sent status owns the chat with no deadline, even with a prior customer message', async () => {
      const lead = await seedLead();
      await seedMessage(lead, 'customer', ago(10));
      const eventAt = ago(5);
      const acquired = await acquire(lead.taskId, 'en atención', `h-${lead.taskId}`, eventAt, 'Cotización Enviada');
      expect(acquired.rows[0].outcome).toBe('acquired');

      const row = await ownershipOf(lead.leadId);
      expect(row.sla_mode).toBe('quote_followup');
      expect(row.response_due_at).toBeNull();
      expect(row.quote_followup_since.toISOString()).toBe(eventAt);
    });

    test('en atención keeps the standard two-hour deadline', async () => {
      const lead = await seedLead({ clickupStatus: 'en atención' });
      await seedMessage(lead, 'customer', ago(10));
      const eventAt = ago(5);
      await acquire(lead.taskId, 'nueva', `h-${lead.taskId}`, eventAt, 'en atención');

      const row = await ownershipOf(lead.leadId);
      expect(row.sla_mode).toBe('standard');
      expect(row.quote_followup_since).toBeNull();
      expect(row.response_due_at.getTime()).toBe(new Date(eventAt).getTime() + 2 * 60 * MINUTE);
    });

    test('moving en atención -> cotización enviada drops the deadline; moving back restores it', async () => {
      const lead = await seedLead({ clickupStatus: 'en atención' });
      await acquire(lead.taskId, 'nueva', `h1-${lead.taskId}`, ago(50), 'en atención');
      const messageId = await seedMessage(lead, 'customer', ago(40));
      await client.query(customerMessageSql, [lead.leadId, messageId, ago(40), 2]);
      const before = await ownershipOf(lead.leadId);
      expect(before.response_due_at).not.toBeNull();

      const sentAt = ago(30);
      await acquire(lead.taskId, 'en atención', `h2-${lead.taskId}`, sentAt, 'cotización enviada');
      const quoted = await ownershipOf(lead.leadId);
      expect(quoted.id).toBe(before.id);
      expect(quoted.sla_mode).toBe('quote_followup');
      expect(quoted.response_due_at).toBeNull();
      expect(quoted.quote_followup_since.toISOString()).toBe(sentAt);
      expect(quoted.previous_clickup_status).toBe('nueva');

      // seguimiento is still the same mode and keeps its original start.
      await acquire(lead.taskId, 'cotización enviada', `h3-${lead.taskId}`, ago(20), 'seguimiento');
      const followed = await ownershipOf(lead.leadId);
      expect(followed.sla_mode).toBe('quote_followup');
      expect(followed.quote_followup_since.toISOString()).toBe(sentAt);

      const backAt = ago(10);
      await acquire(lead.taskId, 'seguimiento', `h4-${lead.taskId}`, backAt, 'en atención');
      const back = await ownershipOf(lead.leadId);
      expect(back.sla_mode).toBe('standard');
      expect(back.quote_followup_since).toBeNull();
      expect(back.response_due_at.getTime()).toBe(new Date(backAt).getTime() + 2 * 60 * MINUTE);
    });

    test('the quote-sent list is configuration', async () => {
      const lead = await seedLead();
      await acquire(lead.taskId, 'en atención', `h-${lead.taskId}`, ago(5), 'cotización enviada', 'otra cosa');
      expect((await ownershipOf(lead.leadId)).sla_mode).toBe('standard');
    });

    test('a customer message never starts a deadline in quote follow-up mode', async () => {
      const owned = await seedQuoteOwnership();
      const messageId = await seedMessage(owned, 'customer', ago(1));
      const registered = await client.query(customerMessageSql, [owned.leadId, messageId, ago(1), 2]);
      expect(registered.rows[0].bot_suppressed).toBe(true);
      expect(registered.rows[0].response_due_at).toBeNull();
      const row = await ownershipOf(owned.leadId);
      expect(row.pending_message_id).toBe(messageId);
      expect(row.response_due_at).toBeNull();
    });

    test('the lease sweep never releases or restores a quote follow-up ownership', async () => {
      const owned = await seedQuoteOwnership();
      await seedMessage(owned, 'customer', ago(300));
      const claimed = await client.query(claimExpiredSql, [100, 900]);
      expect(claimed.rows.map((row) => row.ownership_id)).not.toContain(owned.ownershipId);
      expect((await ownershipOf(owned.leadId)).released_at).toBeNull();
    });
  });

  describe('11/12: one alert per unanswered streak', () => {
    test('nothing is claimed before the customer waited the SLA', async () => {
      const owned = await seedQuoteOwnership();
      await seedMessage(owned, 'customer', ago(29));
      expect(alertFor((await claimAlerts()).rows, owned.ownershipId)).toBeUndefined();
    });

    test('claims the first unanswered message with everything the notice and the comment need', async () => {
      const owned = await seedQuoteOwnership();
      // Before the quote was sent: the seller's to handle, never an alert.
      await seedMessage(owned, 'customer', ago(150), 'antes de la cotización');
      const firstId = await seedMessage(owned, 'customer', ago(45), 'Hola, una consulta');
      await seedMessage(owned, 'customer', ago(40), '¿Me pueden responder?');

      const alert = alertFor((await claimAlerts()).rows, owned.ownershipId);
      expect(alert).toMatchObject({
        lead_id: owned.leadId,
        clickup_task_id: owned.taskId,
        clickup_status: 'cotización enviada',
        seller_name: 'Juan Pablo (Pruebas)',
        seller_clickup_user_id: `9${suffix}`,
        conversation_id: owned.conversationId,
        phone_number: owned.phoneNumber,
        quote_alert_message_id: firstId,
        customer_messages: ['Hola, una consulta', '¿Me pueden responder?'],
      });
      expect(alert.quote_alert_claim_token).toBeTruthy();
      expect(Number(alert.waiting_minutes)).toBe(45);

      const row = await ownershipOf(owned.leadId);
      expect(row.quote_alert_state).toBe('processing');
      expect(row.quote_alert_attempt_count).toBe(1);

      // A live claim is not claimed twice.
      expect(alertFor((await claimAlerts()).rows, owned.ownershipId)).toBeUndefined();
    });

    test('a completed alert does not repeat for the same streak, nor for new messages within the re-alert window', async () => {
      const owned = await seedQuoteOwnership();
      await seedMessage(owned, 'customer', ago(60));
      const alert = alertFor((await claimAlerts()).rows, owned.ownershipId);

      const stale = await completeAlert(owned.ownershipId, 'wrong-token', 'sent');
      expect(stale.rows[0].outcome).toBe('claim_mismatch');
      const done = await completeAlert(owned.ownershipId, alert.quote_alert_claim_token, 'sent');
      expect(done.rows[0].outcome).toBe('completed');
      const row = await ownershipOf(owned.leadId);
      expect(row).toMatchObject({ quote_alert_state: 'completed', quote_alert_result: 'sent', quote_alert_claim_token: null });
      expect(row.quote_alerted_at).not.toBeNull();
      expect(row.released_at).toBeNull();

      // The customer keeps writing after the notice: no new alert within 24 h.
      await client.query(`UPDATE lead_chat_ownerships SET quote_alerted_at = NOW() - INTERVAL '3 hours' WHERE id = $1`,
        [owned.ownershipId]);
      const laterId = await seedMessage(owned, 'customer', ago(40));
      expect(alertFor((await claimAlerts()).rows, owned.ownershipId)).toBeUndefined();

      // After the re-alert window a still-unanswered customer can be alerted again.
      const again = alertFor((await claimAlerts(30, 2)).rows, owned.ownershipId);
      expect(again.quote_alert_message_id).toBe(laterId);
    });

    test('a seller reply ends the streak and the next unanswered message starts a new one', async () => {
      const owned = await seedQuoteOwnership();
      await seedMessage(owned, 'customer', ago(90));
      const first = alertFor((await claimAlerts()).rows, owned.ownershipId);
      await completeAlert(owned.ownershipId, first.quote_alert_claim_token, 'sent');
      await client.query(`UPDATE lead_chat_ownerships SET quote_alerted_at = NOW() - INTERVAL '85 minutes' WHERE id = $1`,
        [owned.ownershipId]);

      const replyId = await seedMessage(owned, 'human', ago(80));
      const reply = await client.query(humanReplySql, [owned.leadId, replyId, ago(80), null, null, 'en atención']);
      expect(reply.rows[0].outcome).toBe('reply_registered');
      expect(alertFor((await claimAlerts()).rows, owned.ownershipId)).toBeUndefined();

      const nextId = await seedMessage(owned, 'customer', ago(35), 'Otra pregunta');
      const second = alertFor((await claimAlerts()).rows, owned.ownershipId);
      expect(second.quote_alert_message_id).toBe(nextId);
      expect(second.customer_messages).toEqual(['Otra pregunta']);
    });

    test('an abandoned claim is reclaimed for the same streak after the stale window', async () => {
      const owned = await seedQuoteOwnership();
      const messageId = await seedMessage(owned, 'customer', ago(60));
      const first = alertFor((await claimAlerts()).rows, owned.ownershipId);
      await client.query(`UPDATE lead_chat_ownerships SET quote_alert_claimed_at = NOW() - INTERVAL '20 minutes' WHERE id = $1`,
        [owned.ownershipId]);
      const second = alertFor((await claimAlerts()).rows, owned.ownershipId);
      expect(second.quote_alert_message_id).toBe(messageId);
      expect(second.quote_alert_claim_token).not.toBe(first.quote_alert_claim_token);
      expect((await completeAlert(owned.ownershipId, first.quote_alert_claim_token, 'sent')).rows[0].outcome)
        .toBe('claim_mismatch');
    });

    test('a standard ownership is never alerted', async () => {
      const lead = await seedLead({ clickupStatus: 'en atención' });
      await acquire(lead.taskId, 'nueva', `h-${lead.taskId}`, ago(120), 'en atención');
      await seedMessage(lead, 'customer', ago(60));
      const ownership = await ownershipOf(lead.leadId);
      expect(alertFor((await claimAlerts()).rows, ownership.id)).toBeUndefined();
    });
  });

  describe('outbound authority for the notice', () => {
    const seedClaimedMessage = async (lead, token) => (await client.query(`
      INSERT INTO messages (conversation_id, lead_id, direction, sender_type, message_type,
        delivery_status, text_body, raw_payload, idempotency_key, dispatch_phase, dispatch_token, claimed_at)
      VALUES ($1, $2, 'outgoing', 'bot', 'text', 'queued', 'aviso',
        jsonb_build_object('number', $3::text, 'text', 'aviso'), $4, 'claimed', $4, NOW())
      RETURNING id
    `, [lead.conversationId, lead.leadId, lead.phoneNumber, token])).rows[0].id;

    test('the notice of a live alert claim passes the seller ownership; any other reply does not', async () => {
      const owned = await seedQuoteOwnership();
      await seedMessage(owned, 'customer', ago(60));
      alertFor((await claimAlerts()).rows, owned.ownershipId);

      const noticeToken = `qf-notice-${suffix}-${owned.ownershipId}`;
      const notice = await client.query(authorizeSql,
        [await seedClaimedMessage(owned, noticeToken), noticeToken, 'quote_followup_notice']);
      expect(notice.rows[0].should_send).toBe(true);

      const replyToken = `qf-question-${suffix}-${owned.ownershipId}`;
      const question = await client.query(authorizeSql,
        [await seedClaimedMessage(owned, replyToken), replyToken, 'question']);
      expect(question.rows[0].should_send).toBe(false);
      expect(question.rows[0].human_control_cancelled).toBe(true);
    });

    test('without a live alert claim the notice kind is held like any bot reply', async () => {
      const owned = await seedQuoteOwnership();
      const token = `qf-late-${suffix}-${owned.ownershipId}`;
      const notice = await client.query(authorizeSql,
        [await seedClaimedMessage(owned, token), token, 'quote_followup_notice']);
      expect(notice.rows[0].should_send).toBe(false);
    });
  });

  describe('the new-quote offer', () => {
    const loadContext = (lead, event) => client.query(loadContextSql, [
      lead.phoneNumber, sourceNumberId, 'Cliente Prueba', null, `qf-in-${event.id}`, null, 'text', 'sí', '{}',
      null, null, null, null, null, null, null, 'qf-test', event.id, event.token,
    ]);

    const alertedOwnership = async () => {
      const owned = await seedQuoteOwnership();
      await seedMessage(owned, 'customer', ago(60));
      const alert = alertFor((await claimAlerts()).rows, owned.ownershipId);
      await completeAlert(owned.ownershipId, alert.quote_alert_claim_token, 'sent');
      await seedMessage(owned, 'bot', ago(0), 'aviso enviado');
      return owned;
    };

    test('is pending right after the notice and is answered by the next customer message', async () => {
      const owned = await alertedOwnership();
      const pending = (await loadContext(owned, await seedInboundEvent(owned))).rows[0];
      expect(pending.bot_suppressed).toBe(true);
      expect(pending.quote_followup_offer_pending).toBe(true);

      await client.query(`UPDATE lead_chat_ownerships SET quote_alerted_at = NOW() - INTERVAL '1 minute' WHERE id = $1`,
        [owned.ownershipId]);
      await seedMessage(owned, 'customer', ago(0), '¿y cuándo llega?');
      const answered = (await loadContext(owned, await seedInboundEvent(owned))).rows[0];
      expect(answered.quote_followup_offer_pending).toBe(false);
    });

    test('is not pending after a failed notice', async () => {
      const owned = await seedQuoteOwnership();
      await seedMessage(owned, 'customer', ago(60));
      const alert = alertFor((await claimAlerts()).rows, owned.ownershipId);
      await completeAlert(owned.ownershipId, alert.quote_alert_claim_token, 'failed', 'outbound_failed');
      const context = (await loadContext(owned, await seedInboundEvent(owned))).rows[0];
      expect(context.quote_followup_offer_pending).toBe(false);
    });

    const persistTurn = (lead, event, { metadata, reset }) => {
      const values = [
        reset ? null : lead.conversationId, lead.phoneNumber, sourceNumberId, 'city', null,
        `qf-incoming-${event.id}`, null, 'text', 'sí', '{}',
        null, null, null, null, null, null, null,
        'waiting_user', 'conversation_state_evaluated', 'waiting_user',
        '{}', '{}', JSON.stringify(metadata), reset, false, true,
        null, null, null, null, null, null, null, null, null, null,
        0, '[]', '{}', '{}', null, null, false, '[]',
        null, null, null, '{}', null, null, null, '[]', '{}', null,
        event.id, event.token, '{}', lead.leadId,
      ];
      expect(values).toHaveLength(58);
      return client.query(persistSql, values);
    };

    test('a yes releases the ownership as customer_new_quote and starts a new conversation', async () => {
      const owned = await alertedOwnership();
      const persisted = await persistTurn(owned, await seedInboundEvent(owned), {
        reset: true,
        metadata: { response_kind: 'quote_followup_new_quote', release_quote_followup_ownership: true },
      });
      expect(persisted.rows).toHaveLength(1);
      expect(persisted.rows[0].conversation_id).not.toBe(owned.conversationId);

      const row = await ownershipOf(owned.leadId);
      expect(row.released_at).not.toBeNull();
      expect(row.release_reason).toBe('customer_new_quote');
      expect(row.restoration_state).toBe('not_required');
      const lead = (await client.query('SELECT clickup_status FROM leads WHERE id = $1', [owned.leadId])).rows[0];
      expect(lead.clickup_status).toBe('cotización enviada');

      // The bot may now answer the new quote.
      const context = (await loadContext(owned, await seedInboundEvent(owned))).rows[0];
      expect(context.bot_suppressed).toBe(false);
      expect(context.human_arbitration_required).toBe(false);
    });

    test('a silent turn keeps the ownership and records the pending message without a deadline', async () => {
      const owned = await alertedOwnership();
      await persistTurn(owned, await seedInboundEvent(owned), {
        reset: false, metadata: { response_kind: 'human_control_suppressed' },
      });
      const row = await ownershipOf(owned.leadId);
      expect(row.released_at).toBeNull();
      expect(row.pending_message_id).not.toBeNull();
      expect(row.response_due_at).toBeNull();
    });

    test('a seller reply after the customer took a new quote takes the chat back without moving the old task', async () => {
      const owned = await alertedOwnership();
      await persistTurn(owned, await seedInboundEvent(owned), {
        reset: true,
        metadata: { response_kind: 'quote_followup_new_quote', release_quote_followup_ownership: true },
      });
      const replyId = await seedMessage(owned, 'human', ago(0));
      const reply = await client.query(humanReplySql, [owned.leadId, replyId, ago(0), null, null, 'en atención']);
      expect(reply.rows[0].outcome).toBe('late_reply_reacquired');

      const row = await ownershipOf(owned.leadId);
      expect(row.released_at).toBeNull();
      expect(row.sla_mode).toBe('quote_followup');
      const operations = await client.query(`
        SELECT 1 FROM external_operations
        WHERE operation_type = 'clickup_status_reacquire' AND entity_id = $1
      `, [row.id]);
      expect(operations.rows).toHaveLength(0);
    });
  });
});
