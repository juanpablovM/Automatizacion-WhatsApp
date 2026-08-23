-- =============================================================================
-- 05_close_handoff_from_clickup.sql — Cierre del handoff desde ClickUp.
-- -----------------------------------------------------------------------------
-- Consume el cambio de estado de la tarea de ClickUp y avanza el ciclo de vida
-- que 04_advance_handoff_state.sql define, resolviendo el handoff por el id
-- externo en vez de por su clave primaria. El vinculo vive en
-- external_operations: operation_type = 'handoff_clickup_notification',
-- entity_type = 'handoff', external_id = id de la tarea de ClickUp.
--
-- Transiciones validas (identicas a 04):
--   notified -> acknowledged
--   notified|acknowledged -> resolved
--
-- Es idempotente por contrato: un webhook reintenta, y repetir el mismo estado
-- destino devuelve 'already_applied' sin volver a escribir ni auditar un falso
-- rechazo. Una tarea que no mapea a ningun handoff devuelve 'unknown_task', que
-- el llamador debe tratar como entrada invalida, no como error de servidor.
--
-- Al pasar a 'resolved' tambien cierra la conversacion asociada si sigue en
-- 'escalation_required': sin eso el handoff se cierra pero la conversacion
-- queda abierta para siempre, que es exactamente el sintoma que este cierre
-- viene a resolver.
--
-- Params:
--   $1 clickup_task_id (text), $2 estado ('acknowledged' | 'resolved')
-- =============================================================================
WITH input AS (
  SELECT
    NULLIF($1::text, '') AS clickup_task_id,
    $2::text AS requested_estado
),
-- Resuelve el handoff y lo bloquea en el mismo paso. El FOR UPDATE no es
-- decorativo: dos eventos de ClickUp para la misma tarea pueden llegar a la vez
-- (un operador mueve la tarea a una columna de cierre mientras una automatizacion
-- la marca en curso). Sin el bloqueo ambas transacciones leen 'notified', ambas
-- se clasifican como validas y la ultima en escribir gana, dejando el handoff en
-- 'acknowledged' con resolved_at ya escrito: un estado que ninguna transicion
-- legal produce. Con el bloqueo, la segunda transaccion espera, vuelve a leer el
-- estado ya confirmado y se clasifica como 'invalid_transition'.
locked_target AS (
  SELECT h.id, h.estado, h.conversation_id
  FROM external_operations eo
  JOIN input i ON i.clickup_task_id = eo.external_id
  JOIN handoffs h
    ON h.id = eo.entity_id
   AND h.deleted_at IS NULL
  WHERE eo.operation_type = 'handoff_clickup_notification'
    AND eo.entity_type = 'handoff'
    AND eo.status = 'succeeded'
  ORDER BY eo.id DESC
  LIMIT 1
  FOR UPDATE OF h
),
target AS (
  SELECT id, estado, conversation_id FROM locked_target
),
classified AS (
  SELECT
    t.id,
    t.conversation_id,
    t.estado AS before_estado,
    CASE
      WHEN t.estado = i.requested_estado THEN 'already_applied'
      WHEN i.requested_estado = 'acknowledged' AND t.estado = 'notified' THEN 'advanced'
      WHEN i.requested_estado = 'resolved' AND t.estado IN ('notified', 'acknowledged') THEN 'advanced'
      ELSE 'invalid_transition'
    END AS outcome
  FROM target t
  CROSS JOIN input i
),
apply AS (
  UPDATE handoffs h
  SET
    estado = (SELECT requested_estado FROM input),
    acknowledged_at = CASE
      WHEN (SELECT requested_estado FROM input) = 'acknowledged' AND h.acknowledged_at IS NULL
        THEN NOW()
      ELSE h.acknowledged_at
    END,
    resolved_at = CASE
      WHEN (SELECT requested_estado FROM input) = 'resolved' AND h.resolved_at IS NULL
        THEN NOW()
      ELSE h.resolved_at
    END,
    updated_at = NOW()
  FROM classified c
  WHERE h.id = c.id AND c.outcome = 'advanced'
  RETURNING h.id, h.estado
),
closed_conversation AS (
  UPDATE conversations conversation
  SET
    conversation_status_id = (
      SELECT id FROM conversation_statuses WHERE code = 'closed'
    ),
    closed_at = COALESCE(conversation.closed_at, NOW()),
    updated_at = NOW()
  FROM classified c
  WHERE conversation.id = c.conversation_id
    AND conversation.deleted_at IS NULL
    AND c.outcome = 'advanced'
    AND (SELECT requested_estado FROM input) = 'resolved'
    AND conversation.conversation_status_id = (
      SELECT id FROM conversation_statuses WHERE code = 'escalation_required'
    )
  RETURNING conversation.id
),
audit_entry AS (
  INSERT INTO audit_logs (
    event_name, entity_type, entity_id, actor_type, actor_id,
    result, before_payload, after_payload, metadata
  )
  SELECT
    'handoff_transition',
    'handoff',
    c.id,
    'system',
    'handoff-clickup-closure',
    c.outcome,
    jsonb_build_object('estado', c.before_estado),
    jsonb_build_object('estado', COALESCE(a.estado, c.before_estado)),
    jsonb_build_object(
      'requested', (SELECT requested_estado FROM input),
      'clickup_task_id', (SELECT clickup_task_id FROM input),
      'conversation_closed', EXISTS (SELECT 1 FROM closed_conversation)
    )
  FROM classified c
  LEFT JOIN apply a ON a.id = c.id
  WHERE c.outcome <> 'already_applied'
  RETURNING 1
)
SELECT
  c.id AS handoff_id,
  COALESCE(a.estado, c.before_estado) AS handoff_estado,
  c.outcome,
  EXISTS (SELECT 1 FROM closed_conversation) AS conversation_closed
FROM classified c
LEFT JOIN apply a ON a.id = c.id

UNION ALL

SELECT
  NULL::bigint AS handoff_id,
  NULL::text AS handoff_estado,
  'unknown_task' AS outcome,
  FALSE AS conversation_closed
WHERE NOT EXISTS (SELECT 1 FROM classified);
