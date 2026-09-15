-- =============================================================================
-- 04_register_human_reply.sql — Registra evidencia humana y arbitra el SLA.
-- -----------------------------------------------------------------------------
-- Una respuesta humana a tiempo satisface el mensaje pendiente y conserva la
-- propiedad. Una respuesta tardia GANA la carrera: vuelve a adquirir la
-- propiedad local y encola una proyeccion durable para devolver ClickUp al
-- estado de adquisicion. Si el barrido ya libero la fila, crea una adquisicion
-- nueva; nunca resucita la fila vieja porque su restauracion puede estar en
-- vuelo con otro worker.
--
-- Los parametros de inbox son opcionales para conservar el uso del SQL como
-- contrato de dominio en pruebas. Cuando llegan, completar el evento y cambiar
-- el ownership ocurren en la misma transaccion.
--
-- Params:
--   $1 lead_id, $2 message_id, $3 replied_at,
--   $4 inbound_event_id (nullable), $5 processing_token (nullable),
--   $6 clickup_acquisition_status (default 'in progress')
-- =============================================================================
WITH input AS (
  SELECT
    NULLIF($1::text, '')::bigint AS lead_id,
    NULLIF($2::text, '')::bigint AS message_id,
    COALESCE(NULLIF($3::text, '')::timestamptz, NOW()) AS replied_at,
    NULLIF($4::text, '')::bigint AS inbound_event_id,
    NULLIF($5::text, '') AS processing_token,
    -- CLICKUP_STATUS_ACKNOWLEDGED is a comma-separated matching list in this
    -- project. A PUT needs one real ClickUp label, never the whole list.
    COALESCE(NULLIF(BTRIM(SPLIT_PART($6::text, ',', 1)), ''), 'in progress')
      AS acquisition_status
),
authority_lock AS MATERIALIZED (
  SELECT pg_advisory_xact_lock(hashtextextended(
    'chat-authority:' || l.source_number_id::text || ':' || l.phone_number,
    0
  )) AS acquired
  FROM leads l
  CROSS JOIN input i
  WHERE l.id = i.lead_id
    AND l.deleted_at IS NULL
),
projection AS MATERIALIZED (
  SELECT o.*
  FROM lead_chat_ownerships o
  CROSS JOIN input i
  CROSS JOIN authority_lock
  WHERE o.lead_id = i.lead_id
    AND o.deleted_at IS NULL
  ORDER BY o.id DESC
  LIMIT 1
  FOR UPDATE OF o
),
classified AS (
  SELECT
    p.id AS previous_ownership_id,
    p.lead_id,
    p.clickup_task_id,
    p.previous_clickup_status,
    p.released_at,
    p.response_due_at,
    CASE
      WHEN p.released_at IS NULL
       AND (p.response_due_at IS NULL OR p.response_due_at > NOW())
        THEN 'reply_registered'
      ELSE 'late_reply_reacquired'
    END AS outcome
  FROM projection p
),
cancelled_old_restoration AS (
  UPDATE lead_chat_ownerships o
  SET
    restoration_state = CASE
      WHEN o.restoration_state IN ('pending', 'processing') THEN 'skipped_status_changed'
      ELSE o.restoration_state
    END,
    restoration_claim_token = NULL,
    restoration_completed_at = CASE
      WHEN o.restoration_state IN ('pending', 'processing') THEN NOW()
      ELSE o.restoration_completed_at
    END,
    restoration_error = CASE
      WHEN o.restoration_state IN ('pending', 'processing')
        THEN 'superseded_by_late_human_reply'
      ELSE o.restoration_error
    END,
    updated_at = NOW()
  FROM classified c
  WHERE o.id = c.previous_ownership_id
    AND c.outcome = 'late_reply_reacquired'
    AND c.released_at IS NOT NULL
  RETURNING o.id
),
cancelled_old_operation AS (
  UPDATE external_operations eo
  SET
    status = 'failed',
    completed_at = NOW(),
    last_error = 'superseded_by_late_human_reply',
    claim_token = NULL,
    updated_at = NOW()
  FROM classified c
  WHERE eo.operation_type = 'clickup_status_restore'
    AND eo.entity_type = 'lead_chat_ownership'
    AND eo.entity_id = c.previous_ownership_id
    AND eo.status IN ('pending', 'processing', 'unknown')
    AND c.outcome = 'late_reply_reacquired'
    AND c.released_at IS NOT NULL
  RETURNING eo.id
),
updated_active AS (
  UPDATE lead_chat_ownerships o
  SET
    pending_message_id = NULL,
    pending_message_at = NULL,
    response_due_at = NULL,
    last_human_message_id = i.message_id,
    last_human_reply_at = i.replied_at,
    acquired_at = CASE
      WHEN c.outcome = 'late_reply_reacquired' THEN i.replied_at
      ELSE o.acquired_at
    END,
    restoration_state = 'not_required',
    restoration_claim_token = NULL,
    restoration_claimed_at = NULL,
    restoration_completed_at = NULL,
    restoration_error = NULL,
    updated_at = NOW()
  FROM classified c
  CROSS JOIN input i
  WHERE o.id = c.previous_ownership_id
    AND c.released_at IS NULL
  RETURNING o.id, o.lead_id, o.clickup_task_id, o.last_human_message_id,
            o.last_human_reply_at, o.response_due_at
),
inserted_reacquisition AS (
  INSERT INTO lead_chat_ownerships (
    lead_id, clickup_task_id, previous_clickup_status, acquired_at,
    last_human_message_id, last_human_reply_at
  )
  SELECT
    c.lead_id, c.clickup_task_id, c.previous_clickup_status, i.replied_at,
    i.message_id, i.replied_at
  FROM classified c
  CROSS JOIN input i
  WHERE c.outcome = 'late_reply_reacquired'
    AND c.released_at IS NOT NULL
  ON CONFLICT (lead_id) WHERE released_at IS NULL AND deleted_at IS NULL
  DO UPDATE SET
    last_human_message_id = EXCLUDED.last_human_message_id,
    last_human_reply_at = EXCLUDED.last_human_reply_at,
    pending_message_id = NULL,
    pending_message_at = NULL,
    response_due_at = NULL,
    updated_at = NOW()
  RETURNING id, lead_id, clickup_task_id, last_human_message_id,
            last_human_reply_at, response_due_at
),
applied AS (
  SELECT * FROM updated_active
  UNION ALL
  SELECT * FROM inserted_reacquisition
),
reacquire_operation AS (
  INSERT INTO external_operations (
    operation_key, operation_type, entity_type, entity_id, status,
    request_payload
  )
  SELECT
    'clickup-status-reacquire:message:' || i.message_id::text,
    'clickup_status_reacquire',
    'lead_chat_ownership',
    a.id,
    'pending',
    jsonb_build_object(
      'ownership_id', a.id,
      'lead_id', a.lead_id,
      'clickup_task_id', a.clickup_task_id,
      'target_status', i.acquisition_status,
      'human_message_id', i.message_id
    )
  FROM applied a
  CROSS JOIN input i
  JOIN classified c ON c.lead_id = a.lead_id
  WHERE c.outcome = 'late_reply_reacquired'
  ON CONFLICT (operation_key) DO NOTHING
  RETURNING id, operation_key
),
event_completion AS (
  UPDATE inbound_events ie
  SET
    processing_status = 'processed',
    processing_phase = 'completed',
    processed_at = NOW(),
    processing_token = NULL,
    failure_reason = NULL,
    updated_at = NOW()
  FROM input i
  WHERE i.inbound_event_id IS NOT NULL
    AND i.processing_token IS NOT NULL
    AND ie.id = i.inbound_event_id
    AND ie.processing_status = 'processing'
    AND ie.processing_token = i.processing_token
  RETURNING ie.id
),
audit_entry AS (
  INSERT INTO audit_logs (
    event_name, entity_type, entity_id, actor_type, actor_id,
    result, before_payload, after_payload, metadata
  )
  SELECT
    'lead_chat_human_reply',
    'lead_chat_ownership',
    a.id,
    'human',
    i.message_id::text,
    c.outcome,
    jsonb_build_object(
      'previous_ownership_id', c.previous_ownership_id,
      'response_due_at', c.response_due_at,
      'released_at', c.released_at
    ),
    jsonb_build_object(
      'ownership_id', a.id,
      'bot_suppressed', TRUE,
      'last_human_message_id', a.last_human_message_id
    ),
    jsonb_build_object(
      'clickup_reacquire_required', c.outcome = 'late_reply_reacquired',
      'clickup_reacquire_operation_key', (
        SELECT operation_key FROM reacquire_operation LIMIT 1
      ),
      'inbound_event_id', i.inbound_event_id
    )
  FROM applied a
  JOIN classified c ON c.lead_id = a.lead_id
  CROSS JOIN input i
  RETURNING id
)
SELECT
  a.id AS ownership_id,
  TRUE AS bot_suppressed,
  a.response_due_at,
  a.last_human_message_id,
  a.last_human_reply_at,
  c.outcome,
  (c.outcome = 'late_reply_reacquired') AS clickup_reacquire_required,
  (SELECT operation_key FROM reacquire_operation LIMIT 1) AS clickup_reacquire_operation_key,
  i.inbound_event_id,
  TRUE AS own_message_handled
FROM applied a
JOIN classified c ON c.lead_id = a.lead_id
CROSS JOIN input i

UNION ALL

SELECT
  NULL::bigint,
  FALSE,
  NULL::timestamptz,
  NULL::bigint,
  NULL::timestamptz,
  'no_active_ownership',
  FALSE,
  NULL::text,
  i.inbound_event_id,
  TRUE
FROM input i
WHERE NOT EXISTS (SELECT 1 FROM classified);
