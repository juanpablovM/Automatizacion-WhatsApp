-- =============================================================================
-- 05_load_ownership_state.sql — Revalidacion final antes de un envio arbitrado.
-- -----------------------------------------------------------------------------
-- Solo lectura. El dispatcher la ejecuta inmediatamente antes de mandar una
-- respuesta de la IA, aunque ya haya consultado el estado al principio del
-- flujo: entre la decision y el envio pasan segundos en los que el vendedor
-- pudo tomar el chat, y en ese hueco el bot le contesta encima al cliente.
--
-- `bot_suppressed` es el predicado canonico de propiedad de la migracion 018
-- escrito tal cual, sin enum intermedio:
--   released_at IS NULL
--   AND deleted_at IS NULL
--   AND (response_due_at IS NULL OR response_due_at > NOW())
--
-- Se lee la ultima proyeccion no borrada del lead, este viva o liberada: la
-- fila liberada tambien es respuesta ('free') y su released_at explica por que.
-- El indice parcial uq_lead_chat_ownerships_active_lead garantiza que si hay
-- una viva es la de id mas alto.
--
-- Devuelve siempre exactamente una fila: un lead sin ninguna propiedad
-- registrada responde 'free', no cero filas, para que el dispatcher no tenga
-- que distinguir "sin datos" de "libre".
--
-- Params:
--   $1 lead_id (bigint)
-- =============================================================================
WITH input AS (
  SELECT NULLIF($1::text, '')::bigint AS lead_id
),
projection AS (
  SELECT
    o.id, o.released_at, o.deleted_at, o.response_due_at,
    o.last_human_message_id, o.last_human_reply_at
  FROM lead_chat_ownerships o
  CROSS JOIN input i
  WHERE o.lead_id = i.lead_id
    AND o.deleted_at IS NULL
  ORDER BY o.id DESC
  LIMIT 1
),
evaluated AS (
  SELECT
    p.*,
    (
      p.released_at IS NULL
      AND p.deleted_at IS NULL
      AND (p.response_due_at IS NULL OR p.response_due_at > NOW())
    ) AS bot_suppressed
  FROM projection p
)
SELECT
  e.id AS ownership_id,
  e.bot_suppressed,
  e.response_due_at,
  e.released_at,
  e.last_human_message_id,
  e.last_human_reply_at,
  CASE WHEN e.bot_suppressed THEN 'suppressed' ELSE 'free' END AS outcome
FROM evaluated e

UNION ALL

SELECT
  NULL::bigint AS ownership_id,
  FALSE AS bot_suppressed,
  NULL::timestamptz AS response_due_at,
  NULL::timestamptz AS released_at,
  NULL::bigint AS last_human_message_id,
  NULL::timestamptz AS last_human_reply_at,
  'free' AS outcome
WHERE NOT EXISTS (SELECT 1 FROM evaluated);
