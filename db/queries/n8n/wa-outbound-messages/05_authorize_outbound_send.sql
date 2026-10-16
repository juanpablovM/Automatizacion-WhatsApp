WITH target AS MATERIALIZED (
  SELECT
    m.id,
    m.conversation_id,
    m.lead_id,
    m.message_type,
    m.delivery_status,
    m.text_body,
    m.raw_payload,
    m.provider_instance_name,
    m.idempotency_key,
    m.external_message_id,
    m.dispatch_token,
    m.dispatch_phase,
    c.source_number_id,
    c.phone_number
  FROM messages m
  JOIN conversations c ON c.id = m.conversation_id
  WHERE m.id = NULLIF($1::text, '')::bigint
    AND m.dispatch_phase = 'claimed'
    AND m.dispatch_token = NULLIF($2::text, '')
    AND m.deleted_at IS NULL
  FOR UPDATE OF m
),
contact_lock AS (
  SELECT pg_advisory_xact_lock(hashtextextended(
    'chat-authority:' || t.source_number_id::text || ':' || t.phone_number,
    0
  ))
  FROM target t
),
latest_lead AS (
  SELECT l.id
  FROM leads l
  JOIN target t
    ON t.source_number_id = l.source_number_id
   AND t.phone_number = l.phone_number
  CROSS JOIN contact_lock
  WHERE l.deleted_at IS NULL
  ORDER BY l.created_at DESC, l.id DESC
  LIMIT 1
),
ownership_authority AS (
  SELECT EXISTS (
    SELECT 1
    FROM lead_chat_ownerships o
    JOIN latest_lead l ON l.id = o.lead_id
    WHERE o.deleted_at IS NULL
      AND o.released_at IS NULL
      AND (o.response_due_at IS NULL OR o.response_due_at > NOW())
      -- Migration 037: the quote follow-up notice is the one bot message a
      -- seller-owned chat admits, and only while its alert claim is live and
      -- the seller has not replied since. Every other reply stays held.
      AND NOT COALESCE(
        $3::text = 'quote_followup_notice'
        AND o.sla_mode = 'quote_followup'
        AND o.quote_alert_state = 'processing'
        AND (o.last_human_reply_at IS NULL OR o.last_human_reply_at < o.quote_alert_claimed_at),
        FALSE
      )
  ) AS bot_suppressed
),
-- La cola del contacto admite un unico evento en vuelo (indice parcial unico
-- uq_inbound_events_processing_queue). Una respuesta humana que llega mientras
-- se procesa el mensaje del cliente queda en 'received' y no alcanza a
-- registrar su ownership antes de esta autorizacion. Mirar solo el ownership
-- deja a la demora de arbitraje esperando una señal que la propia cola bloquea,
-- y el cliente termina recibiendo dos respuestas.
--
-- La clasificacion replica la de 08_persist_own_message_from_evolution.sql a
-- proposito: si esta consulta y aquella discrepan, el bot se cancela por un eco
-- o envia pese a un humano. Solo cuenta lo que alli seria 'human_reply'.
pending_human_reply AS (
  SELECT EXISTS (
    SELECT 1
    FROM inbound_events ie
    JOIN target t
      ON t.source_number_id = ie.source_number_id
     AND t.phone_number = ie.phone_number
    CROSS JOIN contact_lock
    WHERE ie.should_process = TRUE
      AND ie.processing_status IN ('received', 'processing')
      AND COALESCE((ie.normalized_payload->>'is_from_me')::boolean, FALSE) = TRUE
      -- Sin external_message_id no hay evidencia para clasificar; alli es
      -- 'missing_external_message_id', nunca una respuesta humana.
      AND NULLIF(ie.external_message_id, '') IS NOT NULL
      -- Eco confirmado de un mensaje que el bot ya envio.
      AND NOT EXISTS (
        SELECT 1
        FROM messages bm
        WHERE bm.external_message_id = ie.external_message_id
          AND bm.sender_type = 'bot'
          AND bm.deleted_at IS NULL
      )
      -- Eco de OTRO envio del bot todavia en vuelo. El candidato de esta misma
      -- autorizacion queda excluido a proposito (pm.id <> t.id): todavia no
      -- salio, asi que ningun eco suyo puede existir, y contarlo dejaria pasar
      -- justamente la respuesta humana que hay que respetar.
      AND NOT EXISTS (
        SELECT 1
        FROM messages pm
        JOIN conversations pc ON pc.id = pm.conversation_id
        WHERE pm.id <> t.id
          AND pm.direction = 'outgoing'
          AND pm.sender_type = 'bot'
          AND pm.external_message_id IS NULL
          AND pm.dispatch_phase IN ('claimed', 'sending', 'unknown')
          AND pm.deleted_at IS NULL
          AND pc.source_number_id = t.source_number_id
          AND pc.phone_number = t.phone_number
          AND COALESCE(pm.text_body, '') = COALESCE(ie.normalized_payload->>'text_body', '')
          AND pm.updated_at >= NOW() - INTERVAL '5 minutes'
      )
  ) AS human_reply_pending
),
-- Task 3c.29: a technical-sheet document (reserved by
-- 19_persist_v3_technical_sheet_effect.sql) is sent only with the exact file it
-- reserved (id + sha256) and only while that file is active; otherwise it is
-- cancelled as technical_sheet_unavailable. The bytes are read here, at
-- authorization time, and never stored in messages. Base64 without line
-- breaks is what Evolution accepts as media.
document_media AS (
  SELECT
    file.mime_type,
    file.file_name,
    translate(encode(file.content, 'base64'), E'\n', '') AS media
  FROM target t
  JOIN technical_sheet_files file
    ON t.message_type = 'document'
   AND file.id::TEXT = t.raw_payload#>>'{technical_sheet,file_id}'
   AND file.sha256 = t.raw_payload#>>'{technical_sheet,sha256}'
   AND file.active
),
authority AS (
  SELECT
    oa.bot_suppressed,
    phr.human_reply_pending,
    (oa.bot_suppressed OR phr.human_reply_pending) AS hold_bot,
    (t.message_type = 'document' AND NOT EXISTS (SELECT 1 FROM document_media)) AS document_unavailable
  FROM ownership_authority oa
  CROSS JOIN pending_human_reply phr
  CROSS JOIN target t
),
authorized AS (
  UPDATE messages m
  SET
    dispatch_phase = 'sending',
    delivery_status = 'sending',
    attempt_started_at = NOW(),
    updated_at = NOW()
  FROM target t
  CROSS JOIN authority a
  WHERE m.id = t.id
    AND a.hold_bot = FALSE
    AND a.document_unavailable = FALSE
  RETURNING m.*
),
cancelled AS (
  UPDATE messages m
  SET
    dispatch_phase = 'cancelled',
    delivery_status = 'cancelled',
    reconciliation_required = FALSE,
    -- Distinguir la causa: un ownership vigente es control humano declarado;
    -- una respuesta humana encolada es la carrera que esta consulta evita.
    reconciliation_reason = CASE
      WHEN a.bot_suppressed THEN 'human_control_active'
      WHEN a.human_reply_pending THEN 'human_reply_pending'
      ELSE 'technical_sheet_unavailable'
    END,
    dispatch_token = NULL,
    updated_at = NOW()
  FROM target t
  CROSS JOIN authority a
  WHERE m.id = t.id
    AND (a.hold_bot = TRUE OR a.document_unavailable = TRUE)
  RETURNING m.*
),
result AS (
  SELECT a.*, TRUE AS should_send, FALSE AS human_control_cancelled
  FROM authorized a
  UNION ALL
  SELECT c.*, FALSE AS should_send,
         c.reconciliation_reason IN ('human_control_active', 'human_reply_pending') AS human_control_cancelled
  FROM cancelled c
)
SELECT
  r.id,
  r.conversation_id,
  r.lead_id,
  r.message_type,
  r.delivery_status,
  r.text_body,
  r.raw_payload,
  r.provider_instance_name AS instance_name,
  r.idempotency_key,
  r.raw_payload->>'number' AS phone_number,
  CASE
    WHEN r.message_type = 'document' THEN jsonb_build_object(
      'number', r.raw_payload->>'number',
      'mediatype', 'document',
      'mimetype', dm.mime_type,
      'fileName', dm.file_name,
      'media', dm.media
    )
    ELSE r.raw_payload
  END AS outbound_body,
  FALSE AS already_sent,
  r.should_send,
  r.external_message_id,
  $3::text AS response_kind,
  r.dispatch_token,
  r.dispatch_phase,
  r.human_control_cancelled
FROM result r
LEFT JOIN document_media dm ON r.should_send;
