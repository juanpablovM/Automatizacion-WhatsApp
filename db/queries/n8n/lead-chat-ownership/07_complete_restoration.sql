-- =============================================================================
-- 07_complete_restoration.sql — Cierre de la restauracion en ClickUp.
-- -----------------------------------------------------------------------------
-- Cierra el claim que abrio 06_claim_expired_ownerships.sql despues de intentar
-- devolver la tarea a su estado previo. Es proyeccion operativa pura: la
-- propiedad interna ya se libero en el claim, asi que ningun desenlace de esta
-- consulta reabre el lease ni vuelve a callar a la IA.
--
-- Autorizacion por token: solo escribe si `restoration_claim_token` coincide
-- con el que se entrego. Un worker rezagado que revive con un token viejo
-- recibe 'claim_mismatch' y no pisa el resultado del claim vigente. El token se
-- consume al completar (queda NULL), de modo que reenviar el mismo resultado
-- tambien devuelve 'claim_mismatch' en vez de contar dos veces.
--
-- Desenlaces de p3 y su proyeccion en external_operations:
--   'succeeded'              -> operacion 'succeeded' (la tarea volvio a su
--                               estado previo)
--   'skipped_status_changed' -> operacion 'succeeded': alguien movio la tarea
--                               mientras tanto, restaurar habria pisado una
--                               decision humana; no intentarlo ES el resultado
--                               correcto, no una falla que reintentar
--   'failed'                 -> operacion 'failed', con last_error visible
-- Un p3 fuera de ese dominio lo rechaza el CHECK chk_lead_chat_ownerships_
-- restoration_state de la migracion 018: se prefiere fallar ruidosamente antes
-- que degradarlo en silencio a 'failed' y perder el bug del llamador.
--
-- Devuelve siempre exactamente una fila.
--
-- Params:
--   p1 ownership_id (bigint), p2 restoration_claim_token (text),
--   p3 result ('succeeded' | 'failed' | 'skipped_status_changed'),
--   p4 error_text (text), p5 observed_clickup_status (text)
-- =============================================================================
WITH input AS (
  SELECT
    NULLIF($1::text, '')::bigint AS ownership_id,
    NULLIF($2::text, '') AS claim_token,
    NULLIF($3::text, '') AS requested_state,
    NULLIF($4::text, '') AS error_text,
    NULLIF($5::text, '') AS observed_clickup_status
),
target AS MATERIALIZED (
  SELECT o.id, o.restoration_claim_token, o.restoration_state
  FROM lead_chat_ownerships o
  CROSS JOIN input i
  WHERE o.id = i.ownership_id
    AND o.deleted_at IS NULL
  FOR UPDATE OF o
),
classified AS (
  SELECT
    t.id AS ownership_id,
    t.restoration_state AS before_state,
    CASE
      WHEN i.claim_token IS NOT NULL
       AND t.restoration_claim_token IS NOT NULL
       AND t.restoration_claim_token = i.claim_token THEN 'completed'
      ELSE 'claim_mismatch'
    END AS outcome
  FROM target t
  CROSS JOIN input i
),
applied AS (
  UPDATE lead_chat_ownerships o
  SET
    restoration_state = i.requested_state,
    restoration_completed_at = NOW(),
    restoration_error = CASE
      WHEN i.requested_state = 'succeeded' THEN NULL
      ELSE i.error_text
    END,
    -- El token se consume: un reenvio del mismo resultado ya no autoriza.
    restoration_claim_token = NULL,
    updated_at = NOW()
  FROM classified c
  CROSS JOIN input i
  WHERE o.id = c.ownership_id
    AND c.outcome = 'completed'
  RETURNING o.id, o.restoration_state, o.restoration_completed_at, o.restoration_error
),
operation_update AS (
  UPDATE external_operations eo
  SET
    status = CASE WHEN a.restoration_state = 'failed' THEN 'failed' ELSE 'succeeded' END,
    completed_at = NOW(),
    last_error = CASE
      WHEN a.restoration_state = 'failed' THEN COALESCE(a.restoration_error, 'unspecified')
      ELSE NULL
    END,
    response_payload = jsonb_build_object(
      'restoration_state', a.restoration_state,
      'observed_clickup_status', (SELECT observed_clickup_status FROM input)
    ),
    claim_token = NULL,
    updated_at = NOW()
  FROM applied a
  WHERE eo.operation_type = 'clickup_status_restore'
    AND eo.entity_type = 'lead_chat_ownership'
    AND eo.entity_id = a.id
  RETURNING eo.id, eo.entity_id, eo.status
),
audit_entry AS (
  INSERT INTO audit_logs (
    event_name, entity_type, entity_id, actor_type, actor_id,
    result, before_payload, after_payload, metadata
  )
  SELECT
    'lead_chat_ownership_restoration',
    'lead_chat_ownership',
    c.ownership_id,
    'system',
    'ops-lead-chat-ownership-restoration',
    c.outcome,
    jsonb_build_object('restoration_state', c.before_state),
    jsonb_build_object('restoration_state', COALESCE(a.restoration_state, c.before_state)),
    jsonb_build_object(
      'requested_state', (SELECT requested_state FROM input),
      'observed_clickup_status', (SELECT observed_clickup_status FROM input),
      'error_text', (SELECT error_text FROM input),
      'operation_id', (SELECT id FROM operation_update LIMIT 1)
    )
  FROM classified c
  LEFT JOIN applied a ON a.id = c.ownership_id
  RETURNING 1
)
SELECT
  c.ownership_id,
  COALESCE(a.restoration_state, c.before_state) AS restoration_state,
  a.restoration_completed_at,
  (SELECT status FROM operation_update LIMIT 1) AS operation_status,
  c.outcome
FROM classified c
LEFT JOIN applied a ON a.id = c.ownership_id

UNION ALL

SELECT
  NULL::bigint AS ownership_id,
  NULL::text AS restoration_state,
  NULL::timestamptz AS restoration_completed_at,
  NULL::text AS operation_status,
  'unknown_ownership' AS outcome
WHERE NOT EXISTS (SELECT 1 FROM classified);
