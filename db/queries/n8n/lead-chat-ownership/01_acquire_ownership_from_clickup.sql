-- =============================================================================
-- 01_acquire_ownership_from_clickup.sql — Adquisicion de la propiedad del chat.
-- -----------------------------------------------------------------------------
-- Una tarea comercial que pasa a 'in progress' otorga al vendedor la propiedad
-- provisoria del chat: desde ese momento la IA calla hasta que la propiedad se
-- libere (transicion fuera de 'in progress') o venza el SLA. Esta consulta es
-- la unica puerta de entrada de esa señal.
--
-- Idempotencia por identidad del evento: los webhooks de ClickUp reintentan y
-- llegan desordenados. `last_clickup_history_id` deduplica la reentrega exacta
-- ('already_applied') y `last_clickup_event_at` descarta el evento viejo que
-- llega tarde ('stale_event'). Sin ese segundo guard, un 'in progress' de hace
-- una hora reasigna la propiedad que un 'complete' mas nuevo ya libero, y el
-- bot queda mudo sin que nadie este atendiendo.
--
-- Efectos: inserta o refresca una fila de lead_chat_ownerships y deja traza en
-- audit_logs. El ON CONFLICT apunta al indice parcial
-- uq_lead_chat_ownerships_active_lead, por lo que su predicado
-- `WHERE released_at IS NULL AND deleted_at IS NULL` debe coincidir
-- exactamente con el de la migracion 018.
--
-- Sobre una propiedad ya viva el upsert refresca solo la identidad de ClickUp:
-- NO reescribe `acquired_at` (la antiguedad del lease es evidencia) y NO
-- pisa un `previous_clickup_status` ya capturado, porque el estado a restaurar
-- es el que habia ANTES de la primera toma, no el de la reentrega. Una fila ya
-- liberada nunca resucita: el indice parcial la excluye y se inserta una nueva.
-- Si el lead ya tiene un ultimo mensaje del cliente, la adquisicion lo toma como
-- pendiente y abre el SLA desde el instante real del cambio de estado. Esperar
-- al proximo mensaje para iniciar el reloj dejaria un `in progress` abandonado
-- bloqueando al bot indefinidamente.
--
-- Devuelve siempre exactamente una fila, incluso cuando la tarea no mapea a
-- ningun lead ('unknown_task'), que el llamador debe tratar como entrada
-- invalida y no como error de servidor.
--
-- Params:
--   $1 clickup_task_id (text), $2 previous_status (text, estado ANTERIOR a la
--   transicion), $3 history_id (text), $4 history_event_at (timestamptz)
-- =============================================================================
WITH input AS (
  SELECT
    NULLIF($1::text, '') AS clickup_task_id,
    NULLIF($2::text, '') AS previous_status,
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
latest_customer_message AS (
  SELECT m.id, m.created_at
  FROM messages m
  JOIN conversations c ON c.id = m.conversation_id
  JOIN lead_row lr ON TRUE
  WHERE m.deleted_at IS NULL
    AND m.direction = 'incoming'
    AND m.sender_type = 'customer'
    AND (m.lead_id = lr.id OR c.lead_id = lr.id)
  ORDER BY m.created_at DESC, m.id DESC
  LIMIT 1
),
-- Ultima proyeccion conocida del lead (viva o liberada) y bloqueo de la fila.
-- El FOR UPDATE no es decorativo: dos entregas del mismo webhook pueden correr
-- a la vez, ambas leer "sin historial" y ambas clasificarse como 'acquired'.
-- La segunda espera aqui, vuelve a leer la identidad ya escrita y se clasifica
-- como 'already_applied'.
projection AS MATERIALIZED (
  SELECT
    o.id, o.lead_id, o.released_at, o.acquired_at, o.previous_clickup_status,
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
    p.acquired_at,
    p.previous_clickup_status,
    CASE
      WHEN i.history_id IS NOT NULL
       AND p.last_clickup_history_id = i.history_id THEN 'already_applied'
      WHEN i.history_event_at IS NOT NULL
       AND p.last_clickup_event_at IS NOT NULL
       AND i.history_event_at < p.last_clickup_event_at THEN 'stale_event'
      ELSE 'acquired'
    END AS outcome
  FROM lead_row lr
  CROSS JOIN input i
  LEFT JOIN projection p ON p.lead_id = lr.id
),
acquisition AS (
  INSERT INTO lead_chat_ownerships (
    lead_id, clickup_task_id, previous_clickup_status,
    acquired_at, last_clickup_history_id, last_clickup_event_at,
    pending_message_id, pending_message_at, response_due_at
  )
  SELECT
    c.lead_id,
    i.clickup_task_id,
    i.previous_status,
    COALESCE(i.history_event_at, NOW()),
    i.history_id,
    COALESCE(i.history_event_at, NOW()),
    lcm.id,
    lcm.created_at,
    CASE
      WHEN lcm.id IS NOT NULL
        THEN COALESCE(i.history_event_at, NOW()) + INTERVAL '2 hours'
      ELSE NULL
    END
  FROM classified c
  CROSS JOIN input i
  LEFT JOIN latest_customer_message lcm ON TRUE
  WHERE c.outcome = 'acquired'
  ON CONFLICT (lead_id) WHERE released_at IS NULL AND deleted_at IS NULL
  DO UPDATE SET
    clickup_task_id = EXCLUDED.clickup_task_id,
    previous_clickup_status = COALESCE(
      lead_chat_ownerships.previous_clickup_status,
      EXCLUDED.previous_clickup_status
    ),
    last_clickup_history_id = EXCLUDED.last_clickup_history_id,
    last_clickup_event_at = EXCLUDED.last_clickup_event_at,
    updated_at = NOW()
  RETURNING id, lead_id, acquired_at, previous_clickup_status
),
audit_entry AS (
  INSERT INTO audit_logs (
    event_name, entity_type, entity_id, actor_type, actor_id,
    result, before_payload, after_payload, metadata
  )
  SELECT
    'lead_chat_ownership_acquisition',
    'lead_chat_ownership',
    COALESCE(a.id, c.ownership_id),
    'system',
    'crm-clickup-lead-chat-ownership',
    c.outcome,
    jsonb_build_object('ownership_id', c.ownership_id),
    jsonb_build_object(
      'ownership_id', COALESCE(a.id, c.ownership_id),
      'previous_clickup_status', COALESCE(a.previous_clickup_status, c.previous_clickup_status)
    ),
    jsonb_build_object(
      'lead_id', c.lead_id,
      'clickup_task_id', (SELECT clickup_task_id FROM input),
      'history_id', (SELECT history_id FROM input),
      'history_event_at', (SELECT history_event_at FROM input)
    )
  FROM classified c
  LEFT JOIN acquisition a ON a.lead_id = c.lead_id
  WHERE c.outcome <> 'already_applied'
  RETURNING 1
)
SELECT
  COALESCE(a.id, c.ownership_id) AS ownership_id,
  c.lead_id,
  COALESCE(a.previous_clickup_status, c.previous_clickup_status) AS previous_clickup_status,
  COALESCE(a.acquired_at, c.acquired_at) AS acquired_at,
  c.outcome
FROM classified c
LEFT JOIN acquisition a ON a.lead_id = c.lead_id

UNION ALL

SELECT
  NULL::bigint AS ownership_id,
  NULL::bigint AS lead_id,
  NULL::text AS previous_clickup_status,
  NULL::timestamptz AS acquired_at,
  'unknown_task' AS outcome
WHERE NOT EXISTS (SELECT 1 FROM classified);
