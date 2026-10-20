-- Execute one authorized send_technical_sheet effect (task 3c.29, v3.1 only)
-- from its exact external-operation claim. The effect does not call WhatsApp:
-- it reserves one document message in the outbox (dispatch_phase 'reserved',
-- like the turn reply that 09_commit_v3_turn.sql reserves), keyed by the
-- operation key, so a replay returns the same row and never a second one. The
-- downstream dispatcher sends it through WA - Outbound Messages only after the
-- turn reply was delivered (wa-inbound-downstream-dispatcher/
-- 02_load_v3_technical_sheet_deliveries.sql), and Mark Outbound Sending reads
-- the PDF bytes of this exact file (id + sha256) at send time, so the outbox
-- row never carries the content.
--
-- The message has no text_body and the send has no caption: Evolution echoes
-- the document as a fromMe event whose text is the caption, and an in-flight
-- bot message is matched to its echo by identical text (NULL = NULL as ''),
-- so the echo is never mistaken for a human reply.
--
-- When the sheet is no longer active the row carries
-- error = 'technical_sheet_unavailable' and Normalize V3 Effect Receipt
-- records the effect as failed.
--
-- Params: p1 operation_key, p2 decision_id, p3 payload_digest, p4 claim_token.
WITH target AS MATERIALIZED (
  SELECT operation.*, execution.decision_id, execution.conversation_id,
         conversation.lead_id, conversation.phone_number, number.instance_name,
         decision.output_payload->>'version' AS decision_version
  FROM external_operations operation
  JOIN conversation_turn_executions execution
    ON operation.entity_type = 'conversation_turn_execution'
   AND operation.entity_id = execution.id
  JOIN advisor_decisions decision ON decision.id = execution.advisor_decision_id
  JOIN conversations conversation ON conversation.id = execution.conversation_id
  LEFT JOIN whatsapp_numbers number ON number.id = conversation.source_number_id
  WHERE operation.operation_key = $1::TEXT
    AND operation.operation_type = 'send_technical_sheet'
    AND operation.status = 'processing'
    AND operation.request_payload#>>'{v3,decision_id}' = $2::TEXT
    AND operation.request_payload#>>'{v3,payload_digest}' = $3::TEXT
    AND operation.request_payload#>>'{v3,claim_token}' = $4::TEXT
    AND decision.output_payload->>'version' = 'validated_conversation_decision/v3.1'
  FOR UPDATE OF operation, execution
), sheet AS MATERIALIZED (
  SELECT file.id, file.sku, file.sheet_key, file.variant, file.file_name,
         file.mime_type, file.sha256, file.size_bytes
  FROM target
  JOIN technical_sheet_files file
    ON file.sku = target.request_payload#>>'{payload,technical_sheet,sku}'
   AND 'sheet:' || file.sheet_key = target.request_payload#>>'{payload,technical_sheet,ref}'
  WHERE file.active
), delivery AS MATERIALIZED (
  SELECT 'v3-technical-sheet:' || target.operation_key AS delivery_key
  FROM target
), existing AS MATERIALIZED (
  SELECT message.id, message.idempotency_key, message.raw_payload
  FROM messages message
  JOIN delivery ON delivery.delivery_key = message.idempotency_key
  WHERE message.direction = 'outgoing'
    AND message.message_type = 'document'
    AND message.deleted_at IS NULL
), inserted AS (
  INSERT INTO messages (
    conversation_id, lead_id, direction, sender_type, message_type, delivery_status,
    text_body, raw_payload, provider_instance_name, idempotency_key,
    dispatch_phase, dispatch_token, claimed_at
  )
  SELECT target.conversation_id, target.lead_id, 'outgoing', 'bot', 'document', 'queued',
         NULL,
         jsonb_build_object(
           'number', target.phone_number,
           'mediatype', 'document',
           'mimetype', sheet.mime_type,
           'fileName', sheet.file_name,
           -- Normalize Delivery Result quarantines a failed send of a v3
           -- artifact for reconciliation; the version marks this row as one.
           'version', target.decision_version,
           'decision_id', target.decision_id,
           'operation_key', target.operation_key,
           'technical_sheet', jsonb_build_object(
             'file_id', sheet.id,
             'sku', sheet.sku,
             'sheet_key', sheet.sheet_key,
             'variant', sheet.variant,
             'sha256', sheet.sha256,
             'size_bytes', sheet.size_bytes
           )
         ),
         target.instance_name, delivery.delivery_key, 'reserved', NULL, NULL
  FROM target
  CROSS JOIN sheet
  CROSS JOIN delivery
  WHERE NOT EXISTS (SELECT 1 FROM existing)
  ON CONFLICT (idempotency_key)
    WHERE direction = 'outgoing' AND idempotency_key IS NOT NULL AND deleted_at IS NULL
  DO NOTHING
  RETURNING id, idempotency_key, raw_payload
), fixed AS MATERIALIZED (
  SELECT inserted.* FROM inserted
  UNION ALL
  SELECT existing.* FROM existing
)
SELECT
  target.operation_key,
  target.operation_type,
  $3::TEXT AS payload_digest,
  $4::TEXT AS claim_token,
  fixed.id AS document_message_id,
  CASE WHEN fixed.id IS NULL THEN 'technical_sheet_unavailable' END AS error,
  CASE WHEN fixed.id IS NOT NULL THEN jsonb_build_object(
    'version', 'v3_effect_receipt/v1',
    'operation_key', target.operation_key,
    'payload_digest', $3::TEXT,
    'effect_type', 'send_technical_sheet',
    'status', 'succeeded',
    'document_message_id', fixed.id,
    'delivery_key', fixed.idempotency_key,
    'technical_sheet_file_id', (fixed.raw_payload#>>'{technical_sheet,file_id}')::BIGINT,
    'sha256', fixed.raw_payload#>>'{technical_sheet,sha256}'
  ) END AS v3_effect_receipt
FROM target
LEFT JOIN fixed ON TRUE;
