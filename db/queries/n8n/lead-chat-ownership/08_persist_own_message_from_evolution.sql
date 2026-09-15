-- =============================================================================
-- 08_persist_own_message_from_evolution.sql — Clasifica un MESSAGES_UPSERT
-- saliente de Evolution y persiste solamente evidencia humana.
-- -----------------------------------------------------------------------------
-- `fromMe` significa "salio de la cuenta", no "lo escribio una persona". La
-- unica evidencia confiable disponible es external_message_id:
--   - si ya pertenece a messages.sender_type='bot', este evento es el eco del
--     envio automatizado y no se duplica;
--   - si todavia hay un bot outbound sin id para el mismo contacto y texto,
--     vuelve el evento a `received`; el recovery lo correlaciona en otro tick
--     y no adivina que fue humano mientras el proveedor sigue ambiguo;
--   - si no existe, se persiste como outgoing/human en la conversacion mas
--     reciente del contacto;
--   - si colisiona con customer, se falla visiblemente en vez de atribuirlo.
--
-- La consulta conserva el CAS del inbox durable. Un worker viejo no puede
-- persistir el evento si ya perdio processing_token. El eco queda completado
-- aqui; la respuesta humana queda en state_persisted y la completa
-- 04_register_human_reply.sql en la misma ruta, despues de aplicar el SLA.
--
-- Params:
--   $1 inbound_event_id, $2 processing_token, $3 source_number_id,
--   $4 phone_number, $5 external_message_id, $6 external_timestamp,
--   $7 message_type, $8 text_body, $9 raw_payload_json, $10 instance_name
-- =============================================================================
WITH input AS (
  SELECT
    NULLIF($1::text, '')::bigint AS inbound_event_id,
    NULLIF($2::text, '') AS processing_token,
    NULLIF($3::text, '')::bigint AS source_number_id,
    NULLIF($4::text, '') AS phone_number,
    NULLIF($5::text, '') AS external_message_id,
    NULLIF($6::text, '') AS external_timestamp_raw,
    COALESCE(NULLIF($7::text, ''), 'unknown') AS message_type,
    NULLIF($8::text, '') AS text_body,
    COALESCE(NULLIF($9::text, '')::jsonb, '{}'::jsonb) AS raw_payload,
    NULLIF($10::text, '') AS instance_name
),
claimed_event AS MATERIALIZED (
  SELECT ie.id, ie.received_at
  FROM inbound_events ie
  CROSS JOIN input i
  WHERE ie.id = i.inbound_event_id
    AND ie.processing_status = 'processing'
    AND ie.processing_token = i.processing_token
  FOR UPDATE OF ie
),
existing_message AS MATERIALIZED (
  SELECT m.id, m.conversation_id, m.lead_id, m.sender_type
  FROM messages m
  CROSS JOIN input i
  WHERE i.external_message_id IS NOT NULL
    AND m.external_message_id = i.external_message_id
    AND m.deleted_at IS NULL
  LIMIT 1
),
pending_bot_echo AS MATERIALIZED (
  SELECT m.id
  FROM messages m
  JOIN conversations c ON c.id = m.conversation_id
  CROSS JOIN input i
  WHERE NOT EXISTS (SELECT 1 FROM existing_message)
    AND m.sender_type = 'bot'
    AND m.direction = 'outgoing'
    AND m.external_message_id IS NULL
    AND m.dispatch_phase IN ('claimed', 'sending', 'unknown')
    AND m.deleted_at IS NULL
    AND c.source_number_id = i.source_number_id
    AND c.phone_number = i.phone_number
    AND COALESCE(m.text_body, '') = COALESCE(i.text_body, '')
    AND m.updated_at >= NOW() - INTERVAL '5 minutes'
  ORDER BY m.updated_at DESC, m.id DESC
  LIMIT 1
),
ownership_context AS (
  SELECT o.lead_id
  FROM lead_chat_ownerships o
  JOIN leads l ON l.id = o.lead_id AND l.deleted_at IS NULL
  CROSS JOIN input i
  WHERE o.deleted_at IS NULL
    AND l.source_number_id = i.source_number_id
    AND l.phone_number = i.phone_number
  ORDER BY o.id DESC
  LIMIT 1
),
lead_context AS (
  SELECT COALESCE(
    (SELECT lead_id FROM ownership_context),
    (
      SELECT l.id
      FROM leads l
      CROSS JOIN input i
      WHERE l.deleted_at IS NULL
        AND l.source_number_id = i.source_number_id
        AND l.phone_number = i.phone_number
      ORDER BY l.id DESC
      LIMIT 1
    )
  ) AS lead_id
),
conversation_context AS (
  SELECT c.id AS conversation_id
  FROM conversations c
  CROSS JOIN input i
  WHERE c.deleted_at IS NULL
    AND c.source_number_id = i.source_number_id
    AND c.phone_number = i.phone_number
  ORDER BY c.last_message_at DESC, c.id DESC
  LIMIT 1
),
inserted_human AS (
  INSERT INTO messages (
    conversation_id, lead_id, direction, sender_type, message_type,
    external_message_id, external_timestamp, delivery_status, text_body,
    raw_payload, provider_instance_name, inbound_event_id
  )
  SELECT
    cc.conversation_id,
    lc.lead_id,
    'outgoing',
    'human',
    i.message_type,
    i.external_message_id,
    CASE
      WHEN i.external_timestamp_raw ~ '^\d+(\.\d+)?$'
        THEN to_timestamp(i.external_timestamp_raw::numeric)
      WHEN i.external_timestamp_raw IS NOT NULL
        THEN i.external_timestamp_raw::timestamptz
      ELSE ce.received_at
    END,
    'sent',
    i.text_body,
    i.raw_payload,
    i.instance_name,
    i.inbound_event_id
  FROM input i
  JOIN claimed_event ce ON TRUE
  JOIN conversation_context cc ON TRUE
  CROSS JOIN lead_context lc
  WHERE i.external_message_id IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM existing_message)
    AND NOT EXISTS (SELECT 1 FROM pending_bot_echo)
  ON CONFLICT (external_message_id) WHERE external_message_id IS NOT NULL
  DO NOTHING
  RETURNING id, conversation_id, lead_id, sender_type, created_at
),
resolved_message AS (
  SELECT id, conversation_id, lead_id, sender_type, NULL::timestamptz AS created_at
  FROM existing_message
  UNION ALL
  SELECT id, conversation_id, lead_id, sender_type, created_at
  FROM inserted_human
  LIMIT 1
),
classified AS (
  SELECT
    ce.id AS inbound_event_id,
    rm.id AS message_id,
    rm.conversation_id,
    COALESCE(rm.lead_id, lc.lead_id) AS lead_id,
    COALESCE(rm.created_at, ce.received_at) AS replied_at,
    CASE
      WHEN i.external_message_id IS NULL THEN 'missing_external_message_id'
      WHEN rm.sender_type = 'bot' THEN 'bot_echo'
      WHEN rm.sender_type = 'human' THEN 'human_reply'
      WHEN rm.id IS NOT NULL THEN 'external_message_id_collision'
      WHEN EXISTS (SELECT 1 FROM pending_bot_echo) THEN 'bot_echo_pending'
      WHEN NOT EXISTS (SELECT 1 FROM conversation_context) THEN 'conversation_not_found'
      ELSE 'human_reply_not_persisted'
    END AS own_message_kind
  FROM input i
  JOIN claimed_event ce ON TRUE
  CROSS JOIN lead_context lc
  LEFT JOIN resolved_message rm ON TRUE
),
conversation_touch AS (
  UPDATE conversations c
  SET last_message_at = GREATEST(c.last_message_at, cl.replied_at),
      updated_at = NOW()
  FROM classified cl
  WHERE cl.own_message_kind = 'human_reply'
    AND c.id = cl.conversation_id
  RETURNING c.id
),
event_update AS (
  UPDATE inbound_events ie
  SET
    processing_status = CASE
      WHEN cl.own_message_kind = 'bot_echo' THEN 'processed'
      WHEN cl.own_message_kind = 'human_reply' THEN 'processing'
      WHEN cl.own_message_kind = 'bot_echo_pending' THEN 'received'
      ELSE 'failed'
    END,
    processing_phase = CASE
      WHEN cl.own_message_kind = 'bot_echo' THEN 'completed'
      WHEN cl.own_message_kind = 'human_reply' THEN 'state_persisted'
      WHEN cl.own_message_kind = 'bot_echo_pending' THEN 'queued'
      ELSE ie.processing_phase
    END,
    processed_at = CASE WHEN cl.own_message_kind = 'bot_echo' THEN NOW() ELSE ie.processed_at END,
    failed_at = CASE
      WHEN cl.own_message_kind NOT IN ('bot_echo', 'human_reply', 'bot_echo_pending') THEN NOW()
      ELSE ie.failed_at
    END,
    failure_reason = CASE
      WHEN cl.own_message_kind IN ('bot_echo', 'human_reply') THEN NULL
      WHEN cl.own_message_kind = 'bot_echo_pending' THEN 'own_message_bot_echo_pending'
      ELSE 'own_message_' || cl.own_message_kind
    END,
    processing_started_at = CASE
      WHEN cl.own_message_kind = 'bot_echo_pending' THEN NULL
      ELSE ie.processing_started_at
    END,
    processing_token = CASE WHEN cl.own_message_kind = 'human_reply' THEN ie.processing_token ELSE NULL END,
    normalized_payload = jsonb_set(
      COALESCE(ie.normalized_payload, '{}'::jsonb),
      '{sender_type}',
      to_jsonb(CASE WHEN cl.own_message_kind = 'bot_echo' THEN 'bot' ELSE 'human' END::text),
      TRUE
    ),
    updated_at = NOW()
  FROM classified cl
  WHERE ie.id = cl.inbound_event_id
  RETURNING ie.id
),
audit_entry AS (
  INSERT INTO audit_logs (
    event_name, entity_type, entity_id, actor_type, actor_id, result, metadata
  )
  SELECT
    'evolution_own_message_classified',
    CASE WHEN cl.message_id IS NULL THEN 'inbound_event' ELSE 'message' END,
    COALESCE(cl.message_id, cl.inbound_event_id),
    'system',
    'wa-inbound-entry',
    cl.own_message_kind,
    jsonb_build_object(
      'inbound_event_id', cl.inbound_event_id,
      'external_message_id', (SELECT external_message_id FROM input),
      'lead_id', cl.lead_id,
      'conversation_id', cl.conversation_id
    )
  FROM classified cl
  RETURNING id
)
SELECT
  cl.inbound_event_id,
  (SELECT processing_token FROM input) AS processing_token,
  cl.message_id,
  cl.conversation_id,
  cl.lead_id,
  cl.replied_at,
  cl.own_message_kind,
  (cl.own_message_kind = 'bot_echo') AS own_message_handled
FROM classified cl

UNION ALL

SELECT
  (SELECT inbound_event_id FROM input),
  (SELECT processing_token FROM input),
  NULL::bigint,
  NULL::bigint,
  NULL::bigint,
  NULL::timestamptz,
  'claim_mismatch',
  TRUE
WHERE NOT EXISTS (SELECT 1 FROM classified);
