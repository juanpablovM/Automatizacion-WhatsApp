// Task 3c.29: a send_technical_sheet effect, end to end in Postgres with a
// SYNTHETIC PDF: the saga reserves one document message (SQL 19) and receipts
// it (SQL 12), the dispatcher releases it only after the turn reply was
// delivered (dispatcher SQL 02), WA - Outbound Messages claims it by its key
// and Mark Outbound Sending (SQL 05) builds the sendMedia body with the exact
// bytes; the next turn's load query (SQL 01) marks the sheet as sent, and a
// committed offer becomes the pending technical_sheet_offer.
import fs from 'node:fs';
import { createHash } from 'node:crypto';
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
const orchestrator = (name) => fs.readFileSync(`db/queries/n8n/wa-conversation-orchestrator/${name}.sql`, 'utf8');
const sha256 = (value) => createHash('sha256').update(value).digest('hex');

const INSTANCE = 'sheet-test';
const SOURCE_PHONE = '15550007777';
const CUSTOMER_PHONE = '15550007001';
const SKU = 'demo-int-effect';
const SHEET_REF = `sheet:${SKU}`;
const PDF = Buffer.from('%PDF-1.4\n% synthetic integration sheet\n%%EOF\n');

describeIntegration('v3.1 send_technical_sheet effect and document delivery', () => {
  const client = new pg.Client(connection);
  const routeSql = orchestrator('07_route_v3_turn');
  const persistAuthoritySql = orchestrator('16_persist_v3_turn_authority');
  const prepareEffectSql = orchestrator('11_prepare_v3_effect');
  const recordEffectSql = orchestrator('12_record_v3_effect_result');
  const commitSql = orchestrator('09_commit_v3_turn');
  const persistSheetSql = orchestrator('19_persist_v3_technical_sheet_effect');
  const loadSql = orchestrator('01_load_active_context');
  const loadDeliveriesSql = fs.readFileSync('db/queries/n8n/wa-inbound-downstream-dispatcher/02_load_v3_technical_sheet_deliveries.sql', 'utf8');
  const recordDeliverySql = fs.readFileSync('db/queries/n8n/wa-inbound-downstream-dispatcher/01_record_v3_delivery_result.sql', 'utf8');
  const authorizeSendSql = fs.readFileSync('db/queries/n8n/wa-outbound-messages/05_authorize_outbound_send.sql', 'utf8');
  const persistDeliverySql = fs.readFileSync('db/queries/n8n/wa-outbound-messages/04_persist_delivery_result.sql', 'utf8');
  let sourceNumberId;
  let activeStatusId;
  let conversation;
  let fileId;
  let sequence = 0;

  const cleanup = async () => {
    const sources = `SELECT id FROM whatsapp_numbers WHERE instance_name = '${INSTANCE}'`;
    await client.query(`
      BEGIN;
      DELETE FROM external_operations operation USING conversation_turn_executions execution, conversations conversation
      WHERE operation.entity_type = 'conversation_turn_execution' AND operation.entity_id = execution.id
        AND execution.conversation_id = conversation.id AND conversation.source_number_id IN (${sources});
      DELETE FROM audit_logs audit USING conversation_turn_executions execution, conversations conversation
      WHERE audit.entity_type = 'conversation_turn_execution' AND audit.entity_id = execution.id
        AND execution.conversation_id = conversation.id AND conversation.source_number_id IN (${sources});
      DELETE FROM audit_logs audit USING messages message, conversations conversation
      WHERE audit.entity_type = 'message' AND audit.entity_id = message.id
        AND message.conversation_id = conversation.id AND conversation.source_number_id IN (${sources});
      DELETE FROM conversation_turn_executions execution USING conversations conversation
      WHERE execution.conversation_id = conversation.id AND conversation.source_number_id IN (${sources});
      DELETE FROM advisor_decisions decision USING conversations conversation
      WHERE decision.conversation_id = conversation.id AND conversation.source_number_id IN (${sources});
      DELETE FROM messages message USING conversations conversation
      WHERE message.conversation_id = conversation.id AND conversation.source_number_id IN (${sources});
      DELETE FROM inbound_events WHERE instance_name = '${INSTANCE}';
      DELETE FROM conversations WHERE source_number_id IN (${sources});
      DELETE FROM whatsapp_numbers WHERE instance_name = '${INSTANCE}';
      DELETE FROM technical_sheet_files WHERE sku = '${SKU}';
      DELETE FROM catalog_items WHERE sku = '${SKU}';
      COMMIT;
    `);
  };

  const seedEvent = async (suffix) => {
    const token = `sheet-token-${suffix}`;
    // One event in flight per contact (uq_inbound_events_processing_queue).
    await client.query(
      "UPDATE inbound_events SET processing_status = 'processed' WHERE instance_name = $1 AND processing_status = 'processing'",
      [INSTANCE],
    );
    const { rows } = await client.query(`
      INSERT INTO inbound_events (
        instance_name, external_message_id, event_fingerprint, dedupe_key,
        source_number_id, phone_number, queue_key, event_type, normalized_event,
        should_process, processing_status, processing_token, processing_phase
      ) VALUES ($1, $2, $2, $2, $3::bigint, $4::text, $3::bigint::text || ':' || $4::text, 'messages.upsert', 'message',
                TRUE, 'processing', $5, 'orchestrating')
      RETURNING id
    `, [INSTANCE, `sheet-event-${suffix}`, sourceNumberId, conversation.phone_number, token]);
    return { inboundEventId: rows[0].id, token };
  };

  const sheetCommand = (suffix) => {
    const payload = {
      conversation_id: String(conversation.id),
      turn_id: suffix,
      reason_observation_ids: [],
      technical_sheet: { ref: SHEET_REF, sku: SKU, variant: null },
    };
    return {
      type: 'send_technical_sheet',
      operation_key: `sheet-op-${suffix}`,
      payload,
      payload_digest: `sheet-digest-${suffix}`,
      required_before_reply: true,
    };
  };

  const seedTurn = async ({
    effectCommands = [], primaryRequest = null, replyText = 'Te dejo la ficha técnica de *Producto Demo* 👇', contractVersion = 'v3.1',
  } = {}) => {
    sequence += 1;
    const suffix = `turn-${sequence}`;
    const event = await seedEvent(suffix);
    const decisionId = `sheet-decision-${suffix}`;
    const deliveryKey = `sheet-delivery-${suffix}`;
    const policy = {
      version: `ai_prd_turn_policy/${contractVersion}`,
      policy_digest: `sheet-policy-${suffix}`,
      turn: { id: String(event.inboundEventId), conversation_id: String(conversation.id) },
    };
    const decision = {
      version: `validated_conversation_decision/${contractVersion}`,
      decision_id: decisionId,
      turn_id: String(event.inboundEventId),
      conversation_id: String(conversation.id),
      conversation_revision_expected: 0,
      expected_snapshot_digest: `sheet-snapshot-${suffix}`,
      policy_digest: policy.policy_digest,
      proposal_digest: `sheet-proposal-${suffix}`,
      reply: { text: replyText, sha256: sha256(replyText), delivery_key: deliveryKey, primary_request: primaryRequest },
      state_mutations: [],
      effect_commands: effectCommands,
    };
    const routed = await client.query(routeSql, [
      event.inboundEventId, event.token, conversation.id, sourceNumberId, conversation.phone_number,
      'enforce', 'sheet-test-rule', 'service', 'text', `message-${event.inboundEventId}`, null,
      'mándame la ficha', { source: 'integration-test' },
    ]);
    expect(routed.rows[0]).toMatchObject({ route_acquired: true });
    const prepared = await client.query(persistAuthoritySql, [
      event.inboundEventId, event.token, conversation.id, sourceNumberId, conversation.phone_number,
      'text', `message-${event.inboundEventId}`, 'mándame la ficha', { source: 'integration-test' }, 'service',
      decisionId, policy,
      { version: `ai_conversation_proposal/${contractVersion}`, policy_digest: policy.policy_digest },
      { version: `conversation_validation_result/${contractVersion}`, valid: true, policy_digest: policy.policy_digest, proposal_digest: decision.proposal_digest, errors: [] },
      decision, 'integration-provider', 'integration-model', `sheet-decision-digest-${suffix}`,
    ]);
    expect(prepared.rows[0].decision_matches).toBe(true);
    return { ...event, decisionId, deliveryKey, snapshotDigest: decision.expected_snapshot_digest, replyText };
  };

  const executeSheetEffect = async (turn, command) => {
    const claimed = await client.query(prepareEffectSql, [
      turn.decisionId, command.operation_key, command.type, command.payload, command.payload_digest,
    ]);
    expect(claimed.rows[0]).toMatchObject({ should_execute: true });
    const workflow = JSON.parse(fs.readFileSync('n8n/workflows/wa-conversation-orchestrator.json', 'utf8'));
    const bindings = workflow.nodes.find((node) => node.name === 'Persist V3 Technical Sheet Effect')
      .parameters.additionalFields.queryParams.split(',');
    const execute = () => client.query(persistSheetSql, bindings.map((name) => claimed.rows[0][name]));
    return { claimed: claimed.rows[0], execute };
  };

  const newConversation = async (phoneNumber) => (await client.query(`
    INSERT INTO conversations (source_number_id, phone_number, conversation_status_id, current_step, qualification_context)
    VALUES ($1, $2, $3, 'qualification', '{}'::jsonb) RETURNING id, phone_number
  `, [sourceNumberId, phoneNumber, activeStatusId])).rows[0];

  const loadRow = async (event, text = 'sí', phone = CUSTOMER_PHONE) => (await client.query(loadSql, [
    phone, String(sourceNumberId), 'Cliente Ficha', '', `sheet-load-${event.inboundEventId}`, '',
    'text', text, '{}', '', '', '', '', '', '', '', INSTANCE, String(event.inboundEventId), event.token,
  ])).rows[0];

  beforeAll(async () => {
    await client.connect();
    await cleanup();
    sourceNumberId = (await client.query(`
      INSERT INTO whatsapp_numbers (display_name, phone_number, phone_number_id, instance_name, is_active)
      VALUES ('sheet tests', $1, 'pn-sheet-test', $2, TRUE) RETURNING id
    `, [SOURCE_PHONE, INSTANCE])).rows[0].id;
    activeStatusId = (await client.query("SELECT id FROM conversation_statuses WHERE code = 'active'")).rows[0].id;
    conversation = await newConversation(CUSTOMER_PHONE);
    await client.query(
      "INSERT INTO catalog_items (sku, name, item_type, is_active) VALUES ($1, 'Producto Demo Ficha', 'product', TRUE)",
      [SKU],
    );
    fileId = (await client.query(`
      INSERT INTO technical_sheet_files (sku, sheet_key, variant, covers_variants, file_name, content, sha256, size_bytes)
      VALUES ($1, $1, NULL, ARRAY['Variante Demo'], 'ficha-demo-int-effect.pdf', $2, $3, $4) RETURNING id
    `, [SKU, PDF, sha256(PDF), PDF.length])).rows[0].id;
  });

  afterAll(async () => {
    await cleanup();
    await client.end();
  });

  test('reserves one document, receipts it, and sends it only after the reply was delivered', async () => {
    const command = sheetCommand('a');
    const turn = await seedTurn({ effectCommands: [command] });
    const { claimed, execute } = await executeSheetEffect(turn, command);

    const first = await execute();
    const replay = await execute();
    expect(first.rows[0].error).toBeNull();
    expect(replay.rows[0].document_message_id).toBe(first.rows[0].document_message_id);
    const receipt = first.rows[0].v3_effect_receipt;
    expect(receipt).toMatchObject({
      version: 'v3_effect_receipt/v1', effect_type: 'send_technical_sheet', status: 'succeeded',
      delivery_key: `v3-technical-sheet:${command.operation_key}`, sha256: sha256(PDF),
    });
    expect(String(receipt.technical_sheet_file_id)).toBe(String(fileId));
    const reserved = (await client.query('SELECT * FROM messages WHERE idempotency_key = $1', [receipt.delivery_key])).rows;
    expect(reserved).toHaveLength(1);
    expect(reserved[0]).toMatchObject({
      message_type: 'document', sender_type: 'bot', direction: 'outgoing', text_body: null,
      dispatch_phase: 'reserved', provider_instance_name: INSTANCE,
    });
    expect(reserved[0].raw_payload).toMatchObject({
      number: CUSTOMER_PHONE, mediatype: 'document', mimetype: 'application/pdf', fileName: 'ficha-demo-int-effect.pdf',
      version: 'validated_conversation_decision/v3.1', decision_id: turn.decisionId,
      technical_sheet: { sku: SKU, sheet_key: SKU, sha256: sha256(PDF) },
    });
    expect(JSON.stringify(reserved[0].raw_payload)).not.toContain(PDF.toString('base64'));

    const forged = await client.query(recordEffectSql, [
      command.operation_key, command.payload_digest, claimed.claim_token, 'succeeded',
      { ...receipt, delivery_key: 'v3-technical-sheet:other' }, String(receipt.document_message_id), null,
    ]);
    expect(forged.rows).toHaveLength(0);
    const recorded = await client.query(recordEffectSql, [
      command.operation_key, command.payload_digest, claimed.claim_token, 'succeeded',
      receipt, String(receipt.document_message_id), null,
    ]);
    expect(recorded.rows[0]).toMatchObject({ execution_state: 'ready_to_commit' });

    const committed = await client.query(commitSql, [turn.decisionId, turn.token, turn.snapshotDigest]);
    expect(committed.rows[0]).toMatchObject({ state: 'delivery_pending' });
    expect((await client.query(loadDeliveriesSql, [turn.decisionId])).rows).toEqual([]);

    // The reply is delivered first.
    const replyClaim = await client.query('SELECT * FROM claim_outbound_message($1,$2,$3,$4,$5,$6,$7,$8,$9)', [
      conversation.id, null, 'text', turn.replyText, {}, 'v3_advisor_reply', INSTANCE, turn.deliveryKey, 300,
    ]);
    const replyMessageId = replyClaim.rows[0].id;
    await client.query(persistDeliverySql, [replyMessageId, 'sent', 'wamid-reply-a', 'evolution_outbound_delivery', 'sent', '{}', '{}', 'sent', false, null]);
    const delivered = await client.query(recordDeliverySql, [turn.decisionId, replyMessageId, 'sent', 'wamid-reply-a', turn.deliveryKey]);
    expect(delivered.rows[0]).toMatchObject({ state: 'delivered' });

    const deliveries = (await client.query(loadDeliveriesSql, [turn.decisionId])).rows;
    expect(deliveries).toEqual([expect.objectContaining({
      document_message_id: reserved[0].id, delivery_key: receipt.delivery_key, message_type: 'document',
      phone_number: CUSTOMER_PHONE, instance_name: INSTANCE, response_kind: 'technical_sheet',
    })]);

    // WA - Outbound Messages: claim by key, authorize, send, persist.
    const claimArgs = [conversation.id, null, 'document', null, {}, 'technical_sheet', INSTANCE, receipt.delivery_key, 300];
    const docClaim = await client.query('SELECT * FROM claim_outbound_message($1,$2,$3,$4,$5,$6,$7,$8,$9)', claimArgs);
    expect(docClaim.rows[0]).toMatchObject({ id: reserved[0].id, should_send: true, dispatch_phase: 'claimed', message_type: 'document' });
    const authorized = await client.query(authorizeSendSql, [docClaim.rows[0].id, docClaim.rows[0].dispatch_token, 'technical_sheet']);
    expect(authorized.rows[0]).toMatchObject({ should_send: true, human_control_cancelled: false, message_type: 'document' });
    expect(authorized.rows[0].outbound_body).toEqual({
      number: CUSTOMER_PHONE, mediatype: 'document', mimetype: 'application/pdf',
      fileName: 'ficha-demo-int-effect.pdf', media: PDF.toString('base64'),
    });
    await client.query(persistDeliverySql, [reserved[0].id, 'sent', 'wamid-doc-a', 'evolution_outbound_delivery', 'sent', '{}', '{}', 'sent', false, null]);
    const replayClaim = await client.query('SELECT * FROM claim_outbound_message($1,$2,$3,$4,$5,$6,$7,$8,$9)', claimArgs);
    expect(replayClaim.rows[0]).toMatchObject({ already_sent: true, should_send: false });

    // The next turn sees the sheet, marked as sent.
    const next = await seedEvent('load-after-send');
    const row = await loadRow(next, 'gracias');
    expect(row.v3_grounding.technical_sheets_sent).toEqual([SHEET_REF]);
    expect(row.v3_grounding.catalog).toContainEqual({
      ref: `product:${SKU}`, concept: 'product', value: 'Producto Demo Ficha',
      technical_sheet_files: [{ ref: SHEET_REF, variant: null, covers: ['Variante Demo'] }],
    });
    await client.query("UPDATE inbound_events SET processing_status = 'processed' WHERE id = $1", [next.inboundEventId]);
  });

  test('a committed offer becomes the pending technical_sheet_offer the next turn reads', async () => {
    const turn = await seedTurn({
      replyText: '👉 ¿Te mando la ficha técnica del *Producto Demo Ficha*?',
      primaryRequest: { goal_id: 'technical_sheet_offer', item_ref: SHEET_REF },
    });
    const committed = await client.query(commitSql, [turn.decisionId, turn.token, turn.snapshotDigest]);
    expect(committed.rows[0]).toMatchObject({ pending_question_key: 'technical_sheet_offer' });
    const next = await seedEvent('load-after-offer');
    const row = await loadRow(next);
    expect(row.pending_question_key).toBe('technical_sheet_offer');
    expect(row.v3_grounding.technical_sheet_offer_ref).toBe(SHEET_REF);
    await client.query("UPDATE inbound_events SET processing_status = 'processed' WHERE id = $1", [next.inboundEventId]);
  });

  describe('task 3c.30: the answered offer is no longer pending', () => {
    const deliverReply = async (turn) => {
      const claim = await client.query('SELECT * FROM claim_outbound_message($1,$2,$3,$4,$5,$6,$7,$8,$9)', [
        conversation.id, null, 'text', turn.replyText, {}, 'v3_advisor_reply', INSTANCE, turn.deliveryKey, 300,
      ]);
      const messageId = claim.rows[0].id;
      await client.query(persistDeliverySql, [messageId, 'sent', `wamid-${turn.decisionId}`, 'evolution_outbound_delivery', 'sent', '{}', '{}', 'sent', false, null]);
      const delivered = await client.query(recordDeliverySql, [turn.decisionId, messageId, 'sent', `wamid-${turn.decisionId}`, turn.deliveryKey]);
      expect(delivered.rows[0]).toMatchObject({ state: 'delivered' });
    };

    const offerTurn = async () => {
      const turn = await seedTurn({
        replyText: '👉 ¿Te mando la ficha técnica del *Producto Demo Ficha*?',
        primaryRequest: { goal_id: 'technical_sheet_offer', item_ref: SHEET_REF },
      });
      const committed = await client.query(commitSql, [turn.decisionId, turn.token, turn.snapshotDigest]);
      expect(committed.rows[0]).toMatchObject({ pending_question_key: 'technical_sheet_offer', current_step: 'technical_sheet_offer' });
      await deliverReply(turn);
    };

    const persisted = async () => (await client.query(
      'SELECT pending_question_key, current_step FROM conversations WHERE id = $1', [conversation.id],
    )).rows[0];

    test('sending the offered sheet clears the pending offer', async () => {
      conversation = await newConversation('15550007011');
      await offerTurn();
      const command = sheetCommand('accept');
      const turn = await seedTurn({ effectCommands: [command] });
      const { claimed, execute } = await executeSheetEffect(turn, command);
      const receipt = (await execute()).rows[0].v3_effect_receipt;
      await client.query(recordEffectSql, [
        command.operation_key, command.payload_digest, claimed.claim_token, 'succeeded',
        receipt, String(receipt.document_message_id), null,
      ]);
      const committed = await client.query(commitSql, [turn.decisionId, turn.token, turn.snapshotDigest]);
      expect(committed.rows[0]).toMatchObject({ pending_question_key: null, current_step: 'service' });
      expect(await persisted()).toEqual({ pending_question_key: null, current_step: 'service' });

      await deliverReply(turn);
      const next = await seedEvent('load-after-accept');
      const row = await loadRow(next, 'mándamela', conversation.phone_number);
      expect(String(row.conversation_id)).toBe(String(conversation.id));
      expect(row.pending_question_key).toBeNull();
      expect(row.v3_grounding.technical_sheet_offer_ref).toBeUndefined();
      await client.query("UPDATE inbound_events SET processing_status = 'processed' WHERE id = $1", [next.inboundEventId]);
    });

    test('a turn that answers the offer without sending it (declined) clears it too', async () => {
      conversation = await newConversation('15550007012');
      await offerTurn();
      const turn = await seedTurn({ replyText: 'Perfecto, quedo atento a lo que necesites 🙂' });
      const committed = await client.query(commitSql, [turn.decisionId, turn.token, turn.snapshotDigest]);
      expect(committed.rows[0]).toMatchObject({ pending_question_key: null, current_step: 'service' });
      expect(await persisted()).toEqual({ pending_question_key: null, current_step: 'service' });
    });

    test('a new primary_request in the answering turn wins', async () => {
      conversation = await newConversation('15550007013');
      await offerTurn();
      const command = sheetCommand('accept-and-ask');
      const turn = await seedTurn({ effectCommands: [command], primaryRequest: { goal_id: 'city' } });
      const { claimed, execute } = await executeSheetEffect(turn, command);
      const receipt = (await execute()).rows[0].v3_effect_receipt;
      await client.query(recordEffectSql, [
        command.operation_key, command.payload_digest, claimed.claim_token, 'succeeded',
        receipt, String(receipt.document_message_id), null,
      ]);
      await client.query(commitSql, [turn.decisionId, turn.token, turn.snapshotDigest]);
      expect(await persisted()).toEqual({ pending_question_key: 'city', current_step: 'city' });
    });

    test('a turn that re-asks the offer keeps it pending', async () => {
      conversation = await newConversation('15550007014');
      await offerTurn();
      await offerTurn();
      expect(await persisted()).toEqual({ pending_question_key: 'technical_sheet_offer', current_step: 'technical_sheet_offer' });
    });

    test('a turn without a primary_request leaves any other pending question untouched', async () => {
      conversation = await newConversation('15550007015');
      await client.query(
        "UPDATE conversations SET pending_question_key = 'city', current_step = 'city' WHERE id = $1", [conversation.id],
      );
      const turn = await seedTurn({ replyText: 'Claro, te cuento 🙂' });
      await client.query(commitSql, [turn.decisionId, turn.token, turn.snapshotDigest]);
      expect(await persisted()).toEqual({ pending_question_key: 'city', current_step: 'city' });
    });
  });

  test('a retired sheet is never reserved, and a reserved one whose file was retired is cancelled, not sent', async () => {
    // The offer turn above is still delivery_pending on the first conversation.
    conversation = await newConversation('15550007004');
    const command = sheetCommand('retired');
    const turn = await seedTurn({ effectCommands: [command] });
    const { execute } = await executeSheetEffect(turn, command);
    const reserved = (await execute()).rows[0];
    expect(reserved.error).toBeNull();

    await client.query('UPDATE technical_sheet_files SET active = FALSE WHERE id = $1', [fileId]);
    const reservedConversation = conversation;
    // The first turn is still open on its conversation; the next one needs its own.
    conversation = await newConversation('15550007002');
    const unavailableCommand = sheetCommand('retired-2');
    const unavailableTurn = await seedTurn({ effectCommands: [unavailableCommand] });
    const unavailable = await (await executeSheetEffect(unavailableTurn, unavailableCommand)).execute();
    expect(unavailable.rows[0]).toMatchObject({ error: 'technical_sheet_unavailable', document_message_id: null, v3_effect_receipt: null });

    const docClaim = await client.query('SELECT * FROM claim_outbound_message($1,$2,$3,$4,$5,$6,$7,$8,$9)', [
      reservedConversation.id, null, 'document', null, {}, 'technical_sheet', INSTANCE, reserved.v3_effect_receipt.delivery_key, 300,
    ]);
    const authorized = await client.query(authorizeSendSql, [docClaim.rows[0].id, docClaim.rows[0].dispatch_token, 'technical_sheet']);
    expect(authorized.rows[0]).toMatchObject({ should_send: false, human_control_cancelled: false, dispatch_phase: 'cancelled' });
    const message = (await client.query('SELECT reconciliation_reason FROM messages WHERE id = $1', [docClaim.rows[0].id])).rows[0];
    expect(message.reconciliation_reason).toBe('technical_sheet_unavailable');
    await client.query('UPDATE technical_sheet_files SET active = TRUE WHERE id = $1', [fileId]);
  });

  test('a v3 decision can never claim the effect', async () => {
    const command = sheetCommand('v3');
    conversation = await newConversation('15550007003');
    const turn = await seedTurn({ effectCommands: [command], contractVersion: 'v3' });
    const claimed = await client.query(prepareEffectSql, [
      turn.decisionId, command.operation_key, command.type, command.payload, command.payload_digest,
    ]);
    expect(claimed.rows).toHaveLength(0);
  });
});
