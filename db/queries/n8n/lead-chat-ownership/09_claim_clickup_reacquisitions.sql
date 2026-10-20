-- =============================================================================
-- 09_claim_clickup_reacquisitions.sql — Reclama proyecciones tardias a ClickUp.
-- -----------------------------------------------------------------------------
-- Una respuesta humana posterior al vencimiento recupera la autoridad local en
-- 04_register_human_reply.sql y encola `clickup_status_reacquire`. Esta consulta
-- toma esas operaciones sin convertir ClickUp en autoridad: antes de devolver
-- una fila verifica que el ownership asociado siga activo.
--
-- Los claims abandonados y los PUT ambiguos se vuelven a tomar con token nuevo.
-- El dispatcher siempre hace GET antes de PUT, por lo que un intento anterior
-- que si alcanzo ClickUp se reconcilia sin repetir la escritura a ciegas.
--
-- Params:
--   p1 batch_size (default 20)
--   p2 stale_processing_seconds (default 300)
--   p3 retry_delay_seconds (default 60)
--   p4 max_attempts (default 5)
-- =============================================================================
WITH input AS (
  SELECT
    GREATEST(COALESCE(NULLIF($1::text, '')::integer, 20), 1) AS batch_size,
    GREATEST(COALESCE(NULLIF($2::text, '')::integer, 300), 1) AS stale_seconds,
    GREATEST(COALESCE(NULLIF($3::text, '')::integer, 60), 1) AS retry_seconds,
    GREATEST(COALESCE(NULLIF($4::text, '')::integer, 5), 1) AS max_attempts
),
exhausted AS (
  UPDATE external_operations eo
  SET
    status = 'failed',
    completed_at = NOW(),
    last_error = COALESCE(eo.last_error, 'clickup_reacquire_attempts_exhausted'),
    claim_token = NULL,
    retry_safe = FALSE,
    reconciliation_required = FALSE,
    reconciliation_reason = 'clickup_reacquire_attempts_exhausted',
    updated_at = NOW()
  FROM input i
  WHERE eo.operation_type = 'clickup_status_reacquire'
    AND eo.entity_type = 'lead_chat_ownership'
    AND eo.status IN ('pending', 'processing', 'unknown')
    AND eo.attempt_count >= i.max_attempts
    AND (
      eo.locked_at IS NULL
      OR eo.locked_at < NOW() - (i.stale_seconds * INTERVAL '1 second')
    )
  RETURNING eo.id
),
candidates AS MATERIALIZED (
  SELECT eo.id
  FROM external_operations eo
  CROSS JOIN input i
  WHERE eo.operation_type = 'clickup_status_reacquire'
    AND eo.entity_type = 'lead_chat_ownership'
    AND eo.attempt_count < i.max_attempts
    AND (
      (
        eo.status = 'pending'
        AND (
          eo.locked_at IS NULL
          OR eo.locked_at < NOW() - (i.retry_seconds * INTERVAL '1 second')
        )
      )
      OR (
        eo.status IN ('processing', 'unknown')
        AND eo.locked_at IS NOT NULL
        AND eo.locked_at < NOW() - (i.stale_seconds * INTERVAL '1 second')
      )
    )
  ORDER BY eo.created_at, eo.id
  LIMIT (SELECT batch_size FROM input)
  FOR UPDATE OF eo SKIP LOCKED
),
claimed AS (
  UPDATE external_operations eo
  SET
    status = 'processing',
    attempt_count = eo.attempt_count + 1,
    locked_at = NOW(),
    completed_at = NULL,
    last_error = NULL,
    claim_token = gen_random_uuid(),
    reconciliation_required = FALSE,
    reconciliation_reason = NULL,
    retry_safe = FALSE,
    updated_at = NOW()
  FROM candidates c
  WHERE eo.id = c.id
  RETURNING
    eo.id, eo.entity_id, eo.operation_key, eo.attempt_count,
    eo.claim_token, eo.request_payload
),
projected AS (
  SELECT
    c.id AS operation_id,
    c.operation_key,
    c.claim_token AS operation_claim_token,
    c.attempt_count,
    c.entity_id AS ownership_id,
    o.lead_id,
    COALESCE(NULLIF(c.request_payload->>'clickup_task_id', ''), o.clickup_task_id)
      AS clickup_task_id,
    NULLIF(c.request_payload->>'target_status', '') AS target_status,
    (
      o.id IS NOT NULL
      AND o.deleted_at IS NULL
      AND o.released_at IS NULL
    ) AS ownership_active,
    CASE
      WHEN o.id IS NULL OR o.deleted_at IS NOT NULL OR o.released_at IS NOT NULL
        THEN 'ownership_not_active'
      WHEN COALESCE(NULLIF(c.request_payload->>'clickup_task_id', ''), o.clickup_task_id) IS NULL
        THEN 'clickup_task_id_missing'
      WHEN NULLIF(c.request_payload->>'target_status', '') IS NULL
        THEN 'target_status_missing'
      ELSE NULL
    END AS reacquisition_blocker,
    c.request_payload
  FROM claimed c
  LEFT JOIN lead_chat_ownerships o ON o.id = c.entity_id
)
SELECT
  p.*,
  (
    p.ownership_active
    AND p.clickup_task_id IS NOT NULL
    AND p.target_status IS NOT NULL
  ) AS should_dispatch_reacquisition,
  -- La codificacion URL queda en el nodo Code; concatenar un task id crudo en
  -- SQL convertiria '/', espacios u otros caracteres validos en otra ruta.
  NULL::text AS clickup_task_url
FROM projected p
ORDER BY p.operation_id;
