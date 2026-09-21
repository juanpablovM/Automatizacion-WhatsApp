-- =============================================================================
-- 03_register_customer_message.sql — Mensaje del cliente contra el SLA.
-- -----------------------------------------------------------------------------
-- Cada mensaje entrante del cliente sobre un chat con propiedad viva abre (o
-- reabre) el plazo del vendedor: el mensaje pasa a ser el pendiente y el plazo
-- queda en `message.created_at + $4 horas`. Un mensaje mas nuevo REEMPLAZA al
-- anterior y arranca su propia ventana completa, porque el SLA se mide contra
-- lo ultimo que el cliente pregunto, no contra lo primero.
--
-- Regla critica: un plazo YA VENCIDO no revive. Si `response_due_at` ya quedo
-- en el pasado, esta consulta NO lo toca y devuelve 'expired' para que el
-- llamador sepa que el bot puede hablar. Reabrir la ventana con cada mensaje
-- nuevo dejaria a un cliente insistente manteniendo al bot mudo para siempre,
-- que es exactamente lo contrario del proposito del SLA. El vendedor recupera
-- el chat solo volviendo a mover la tarea a 'in progress'.
--
-- Idempotencia: reprocesar el mismo mensaje reescribe los mismos valores
-- (mismo pending_message_id y mismo response_due_at derivado de su
-- created_at), asi que la reentrega es inofensiva y no corre el plazo.
--
-- `bot_suppressed` se calcula con el predicado canonico de propiedad de la
-- migracion 018 sobre el estado YA aplicado, no sobre el previo: es la
-- respuesta que el dispatcher necesita para decidir si Gemini contesta.
--
-- Devuelve siempre exactamente una fila.
--
-- Params:
--   $1 lead_id (bigint), $2 message_id (bigint),
--   $3 message_created_at (timestamptz), $4 window_hours (numeric; el llamador
--   pasa 2)
-- =============================================================================
WITH input AS (
  SELECT
    NULLIF($1::text, '')::bigint AS lead_id,
    NULLIF($2::text, '')::bigint AS message_id,
    NULLIF($3::text, '')::timestamptz AS message_created_at,
    COALESCE(NULLIF($4::text, '')::numeric, 2) AS window_hours
),
-- Solo la propiedad viva del lead, bloqueada: dos mensajes del cliente pueden
-- entrar a la vez y sin el bloqueo el plazo resultante depende de cual escriba
-- ultimo, no de cual mensaje es mas nuevo.
active AS MATERIALIZED (
  SELECT o.id, o.response_due_at, o.pending_message_id
  FROM lead_chat_ownerships o
  CROSS JOIN input i
  WHERE o.lead_id = i.lead_id
    AND o.released_at IS NULL
    AND o.deleted_at IS NULL
  FOR UPDATE OF o
),
classified AS (
  SELECT
    a.id AS ownership_id,
    a.response_due_at AS before_due_at,
    CASE
      WHEN a.response_due_at IS NOT NULL AND a.response_due_at <= NOW() THEN 'expired'
      WHEN a.response_due_at IS NULL THEN 'deadline_started'
      ELSE 'deadline_replaced'
    END AS outcome
  FROM active a
),
applied AS (
  UPDATE lead_chat_ownerships o
  SET
    pending_message_id = i.message_id,
    pending_message_at = i.message_created_at,
    response_due_at = i.message_created_at + (i.window_hours || ' hours')::interval,
    updated_at = NOW()
  FROM classified c
  CROSS JOIN input i
  WHERE o.id = c.ownership_id
    AND c.outcome IN ('deadline_started', 'deadline_replaced')
  RETURNING o.id, o.response_due_at
)
SELECT
  c.ownership_id,
  (
    COALESCE(a.response_due_at, c.before_due_at) IS NULL
    OR COALESCE(a.response_due_at, c.before_due_at) > NOW()
  ) AS bot_suppressed,
  COALESCE(a.response_due_at, c.before_due_at) AS response_due_at,
  c.outcome
FROM classified c
LEFT JOIN applied a ON a.id = c.ownership_id

UNION ALL

SELECT
  NULL::bigint AS ownership_id,
  FALSE AS bot_suppressed,
  NULL::timestamptz AS response_due_at,
  'no_active_ownership' AS outcome
WHERE NOT EXISTS (SELECT 1 FROM classified);
