-- =============================================================================
-- 06_claim_expired_ownerships.sql — Barrido de leases vencidos (batch).
-- -----------------------------------------------------------------------------
-- Unica consulta del dominio que PUEDE devolver cero filas: es un claim por
-- lotes, y "no hay nada vencido" es su respuesta normal, no un error ni un
-- desenlace que el llamador deba clasificar.
--
-- Hace dos cosas en un orden que importa:
--   1. Libera internamente el lease vencido (released_at, release_reason =
--      'sla_expired'). La IA queda habilitada en ese mismo instante.
--   2. Recien despues encola la restauracion del estado previo en ClickUp.
-- Si se hiciera al reves, una caida de ClickUp dejaria al bot mudo mientras
-- nadie atiende: exactamente el bloqueo que este diseño existe para evitar.
-- PostgreSQL es la autoridad; ClickUp es proyeccion asincrona.
--
-- Sin evidencia no se adivina: cuando previous_clickup_status es NULL la
-- liberacion interna igual ocurre, pero la restauracion queda en
-- 'skipped_no_previous_status' con restoration_error legible. Mover la tarea a
-- un estado inventado es peor que dejar el faltante a la vista de un operador.
--
-- Claim con FOR UPDATE SKIP LOCKED y restoration_claim_token, igual que
-- handoff-routing/02_claim_notification.sql: varios ticks concurrentes se
-- reparten filas distintas en vez de pelear por la misma.
--
-- El claim deja la fila en 'processing', NO en 'pending'. La diferencia no es
-- cosmetica: todo predicado del barrido excluye lo ya liberado, asi que un
-- worker que muere despues de reclamar dejaba la restauracion en 'pending'
-- para siempre, sin ninguna via de reintento, y la restauracion se perdia en
-- silencio. Marcarla 'processing' con restoration_claimed_at la vuelve
-- rescatable por la rama (b) de `candidates`, que es la unica razon por la que
-- $2 stale_processing_seconds existe.
--
-- Se reclama la UNION de dos conjuntos, no uno solo:
--   (a) leases recien vencidos todavia no liberados — la toma normal;
--   (b) filas ya liberadas cuya restauracion sigue en 'pending' o 'processing'
--       y cuyo restoration_claimed_at es mas viejo que $2 segundos — el
--       rescate, con token nuevo.
-- Un solo predicado con OR expresa esa union con un unico LIMIT y una unica
-- pasada de locking; dos subconsultas UNION-idas tomarian hasta 2x batch_size.
--
-- Cada reclamo emite un restoration_claim_token nuevo. Por eso el CAS de
-- 07_complete_restoration.sql convierte el cierre tardio del worker muerto en
-- 'claim_mismatch' en vez de dejarlo pisar el resultado del claim vigente,
-- exactamente como 03_complete_notification.sql hace con los handoffs.
--
-- 'skipped_no_previous_status' es terminal y queda fuera de la rama (b): sin
-- evidencia del estado previo no hay nada que reintentar, y reclamarla otra
-- vez solo inflaria restoration_attempt_count sin acercar la restauracion.
--
-- La clave de operacion es ESTABLE por adquisicion:
--   clickup-status-restore:ownership:{ownership_id}:{acquired_at ISO-8601}
-- Estable para que el rescate de un claim trabado en 'processing' reutilice la
-- misma fila de external_operations en vez de crear una nueva por intento, y
-- distinta por adquisicion para que una toma posterior del mismo chat no
-- herede el resultado de la anterior.
--
-- Params:
--   $1 batch_size (integer, por defecto 20),
--   $2 stale_processing_seconds (integer, por defecto 900)
-- =============================================================================
WITH input AS (
  SELECT
    COALESCE(NULLIF($1::text, '')::integer, 20) AS batch_size,
    COALESCE(NULLIF($2::text, '')::integer, 900) AS stale_processing_seconds
),
candidates AS MATERIALIZED (
  SELECT
    o.id, o.lead_id, o.clickup_task_id, o.previous_clickup_status,
    o.acquired_at, o.response_due_at, o.restoration_state
  FROM lead_chat_ownerships o
  WHERE o.deleted_at IS NULL
    AND (
      -- (a) Lease vencido todavia no liberado.
      (
        o.released_at IS NULL
        AND o.response_due_at IS NOT NULL
        AND o.response_due_at <= NOW()
      )
      -- (b) Restauracion abandonada: la fila ya se libero pero su restauracion
      -- sigue abierta y el claim que la abrio es mas viejo que $2 segundos. El
      -- worker murio despues de reclamar; sin este rescate la restauracion se
      -- pierde en silencio. 'pending' entra ademas de 'processing' para que las
      -- filas que quedaron colgadas con el comportamiento anterior tambien
      -- salgan. Los terminales ('succeeded', 'failed', 'skipped_*') no entran.
      OR (
        o.released_at IS NOT NULL
        AND o.restoration_state IN ('pending', 'processing')
        AND o.restoration_claimed_at IS NOT NULL
        AND o.restoration_claimed_at
            < NOW() - ((SELECT stale_processing_seconds FROM input) * INTERVAL '1 second')
      )
    )
  ORDER BY o.response_due_at NULLS LAST, o.id
  LIMIT (SELECT batch_size FROM input)
  FOR UPDATE OF o SKIP LOCKED
),
claimed AS (
  UPDATE lead_chat_ownerships o
  SET
    -- COALESCE y no NOW() a secas: el rescate de un 'processing' trabado no
    -- debe reescribir el instante real de la liberacion.
    released_at = COALESCE(o.released_at, NOW()),
    release_reason = COALESCE(o.release_reason, 'sla_expired'),
    -- 'processing' y no 'pending': el claim ya tomo la fila, y solo un estado
    -- que declare eso puede ser rescatado por la rama (b) si el worker muere.
    restoration_state = CASE
      WHEN c.previous_clickup_status IS NOT NULL THEN 'processing'
      ELSE 'skipped_no_previous_status'
    END,
    -- Token nuevo en cada reclamo: el worker viejo pierde la autorizacion en el
    -- mismo instante en que el nuevo la gana.
    restoration_claim_token = gen_random_uuid()::text,
    restoration_claimed_at = NOW(),
    restoration_attempt_count = o.restoration_attempt_count + 1,
    restoration_error = CASE
      WHEN c.previous_clickup_status IS NULL
        THEN 'previous_clickup_status_missing: '
          || 'el lease vencio sin evidencia del estado previo de ClickUp; '
          || 'la restauracion requiere intervencion manual'
      ELSE NULL
    END,
    updated_at = NOW()
  FROM candidates c
  WHERE o.id = c.id
  RETURNING
    o.id, o.lead_id, o.clickup_task_id, o.previous_clickup_status,
    o.acquired_at, o.released_at, o.release_reason, o.restoration_state,
    o.restoration_claim_token, o.restoration_attempt_count
),
keyed AS (
  SELECT
    c.*,
    'clickup-status-restore:ownership:' || c.id::text || ':'
      || to_char(c.acquired_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
      AS operation_key
  FROM claimed c
),
seeded AS (
  INSERT INTO external_operations (
    operation_key, operation_type, entity_type, entity_id, status,
    attempt_count, locked_at, claim_token, request_payload
  )
  SELECT
    k.operation_key,
    'clickup_status_restore',
    'lead_chat_ownership',
    k.id,
    'processing',
    1,
    NOW(),
    gen_random_uuid(),
    jsonb_build_object(
      'ownership_id', k.id,
      'lead_id', k.lead_id,
      'clickup_task_id', k.clickup_task_id,
      'previous_clickup_status', k.previous_clickup_status,
      'restoration_claim_token', k.restoration_claim_token
    )
  FROM keyed k
  WHERE k.restoration_state = 'processing'
  ON CONFLICT (operation_key) DO UPDATE SET
    status = 'processing',
    attempt_count = external_operations.attempt_count + 1,
    locked_at = NOW(),
    claim_token = gen_random_uuid(),
    last_error = NULL,
    request_payload = EXCLUDED.request_payload,
    updated_at = NOW()
  RETURNING id, entity_id
),
audit_entry AS (
  INSERT INTO audit_logs (
    event_name, entity_type, entity_id, actor_type, actor_id,
    result, before_payload, after_payload, metadata
  )
  SELECT
    'lead_chat_ownership_sla_expiry',
    'lead_chat_ownership',
    k.id,
    'system',
    'ops-lead-chat-ownership-sweeper',
    CASE
      WHEN k.restoration_state = 'processing' THEN 'restoration_claimed'
      ELSE 'restoration_skipped_no_previous_status'
    END,
    jsonb_build_object('restoration_attempt_count', k.restoration_attempt_count - 1),
    jsonb_build_object(
      'released_at', k.released_at,
      'release_reason', k.release_reason,
      'restoration_state', k.restoration_state
    ),
    jsonb_build_object(
      'lead_id', k.lead_id,
      'clickup_task_id', k.clickup_task_id,
      'previous_clickup_status', k.previous_clickup_status,
      'operation_key', k.operation_key
    )
  FROM keyed k
  RETURNING 1
)
SELECT
  k.id AS ownership_id,
  k.lead_id,
  k.clickup_task_id,
  k.previous_clickup_status,
  k.restoration_state,
  k.restoration_claim_token,
  k.operation_key
FROM keyed k
ORDER BY k.id;
