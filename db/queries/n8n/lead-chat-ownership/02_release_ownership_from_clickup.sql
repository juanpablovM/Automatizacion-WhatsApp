-- =============================================================================
-- 02_release_ownership_from_clickup.sql — Liberacion por transicion de ClickUp.
-- -----------------------------------------------------------------------------
-- Contracara de 01_acquire_ownership_from_clickup.sql: la tarea sale de
-- 'in progress' (a 'complete' o a cualquier otro estado) y el vendedor deja de
-- ser dueño del chat. La IA vuelve a poder responder en cuanto esta fila queda
-- con released_at.
--
-- restoration_state queda en 'not_required': aqui el operador movio la tarea a
-- proposito, asi que no hay estado previo que restaurar. La restauracion solo
-- aplica al vencimiento del SLA, donde el sistema movio la tarea sin que nadie
-- lo pidiera (06_claim_expired_ownerships.sql).
--
-- Mismos guards de identidad que la adquisicion: `already_applied` para la
-- reentrega exacta del mismo history_id y `stale_event` para el evento cuyo
-- history_event_at es anterior al ya proyectado. Un evento viejo no puede
-- liberar una propiedad que una adquisicion mas nueva acaba de tomar.
--
-- Idempotencia: solo el desenlace 'released' escribe. 'already_applied',
-- 'stale_event' y 'no_active_ownership' no tocan la fila ni auditan un rechazo
-- falso. El pendiente y el plazo se conservan como evidencia de por que el
-- lease existia; el predicado de propiedad ya los ignora porque released_at
-- deja de ser NULL.
--
-- Devuelve siempre exactamente una fila. 'unknown_task' es entrada invalida,
-- no error de servidor.
--
-- Params:
--   p1 clickup_task_id (text), p2 new_status (text, estado destino de la
--   transicion), p3 history_id (text), p4 history_event_at (timestamptz)
-- =============================================================================
WITH input AS (
  SELECT
    NULLIF($1::text, '') AS clickup_task_id,
    NULLIF($2::text, '') AS new_status,
    NULLIF($3::text, '') AS history_id,
    NULLIF($4::text, '')::timestamptz AS history_event_at
),
lead_row AS (
  SELECT l.id
  FROM leads l
  CROSS JOIN input i
  WHERE i.clickup_task_id IS NOT NULL
    AND l.clickup_task_id = i.clickup_task_id
    AND l.deleted_at IS NULL
  ORDER BY l.id DESC
  LIMIT 1
),
-- Igual que en la adquisicion: se lee y se bloquea la ultima proyeccion del
-- lead en el mismo paso, para que dos entregas simultaneas del webhook se
-- serialicen en vez de liberar dos veces.
projection AS MATERIALIZED (
  SELECT
    o.id, o.lead_id, o.released_at, o.response_due_at, o.restoration_state,
    o.last_clickup_history_id, o.last_clickup_event_at
  FROM lead_chat_ownerships o
  JOIN lead_row lr ON lr.id = o.lead_id
  WHERE o.deleted_at IS NULL
  ORDER BY o.id DESC
  LIMIT 1
  FOR UPDATE OF o
),
classified AS (
  SELECT
    lr.id AS lead_id,
    p.id AS ownership_id,
    p.released_at,
    p.restoration_state,
    CASE
      WHEN i.history_id IS NOT NULL
       AND p.last_clickup_history_id = i.history_id THEN 'already_applied'
      WHEN i.history_event_at IS NOT NULL
       AND p.last_clickup_event_at IS NOT NULL
       AND i.history_event_at < p.last_clickup_event_at THEN 'stale_event'
      WHEN p.id IS NULL OR p.released_at IS NOT NULL THEN 'no_active_ownership'
      ELSE 'released'
    END AS outcome
  FROM lead_row lr
  CROSS JOIN input i
  LEFT JOIN projection p ON p.lead_id = lr.id
),
release AS (
  UPDATE lead_chat_ownerships o
  SET
    released_at = NOW(),
    release_reason = 'clickup_released',
    restoration_state = 'not_required',
    last_clickup_history_id = i.history_id,
    last_clickup_event_at = COALESCE(i.history_event_at, NOW()),
    updated_at = NOW()
  FROM classified c
  CROSS JOIN input i
  WHERE o.id = c.ownership_id
    AND c.outcome = 'released'
  RETURNING o.id, o.lead_id, o.released_at, o.restoration_state
),
audit_entry AS (
  INSERT INTO audit_logs (
    event_name, entity_type, entity_id, actor_type, actor_id,
    result, before_payload, after_payload, metadata
  )
  SELECT
    'lead_chat_ownership_release',
    'lead_chat_ownership',
    c.ownership_id,
    'system',
    'crm-clickup-lead-chat-ownership',
    c.outcome,
    jsonb_build_object('released_at', c.released_at),
    jsonb_build_object('released_at', r.released_at),
    jsonb_build_object(
      'lead_id', c.lead_id,
      'clickup_task_id', (SELECT clickup_task_id FROM input),
      'new_status', (SELECT new_status FROM input),
      'history_id', (SELECT history_id FROM input),
      'history_event_at', (SELECT history_event_at FROM input)
    )
  FROM classified c
  LEFT JOIN release r ON r.id = c.ownership_id
  WHERE c.outcome <> 'already_applied'
  RETURNING 1
)
SELECT
  c.ownership_id,
  c.lead_id,
  COALESCE(r.released_at, c.released_at) AS released_at,
  COALESCE(r.restoration_state, c.restoration_state) AS restoration_state,
  c.outcome
FROM classified c
LEFT JOIN release r ON r.id = c.ownership_id

UNION ALL

SELECT
  NULL::bigint AS ownership_id,
  NULL::bigint AS lead_id,
  NULL::timestamptz AS released_at,
  NULL::text AS restoration_state,
  'unknown_task' AS outcome
WHERE NOT EXISTS (SELECT 1 FROM classified);
