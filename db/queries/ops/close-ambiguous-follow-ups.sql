-- =============================================================================
-- close-ambiguous-follow-ups.sql — Declara terminales los follow-ups cerrados
-- por respuesta ambigua del proveedor.
-- -----------------------------------------------------------------------------
-- Contexto: un follow-up cuyo envio devolvio una respuesta ambigua queda con
-- last_send_error = 'outbound_unknown', sin next_retry_at y con intentos
-- disponibles. En los hechos ya es terminal —no se reintenta a proposito,
-- porque reintentar un envio ambiguo puede duplicar un mensaje ya entregado—
-- pero figura como 'error', de modo que la metrica de fallas mezcla dos cosas
-- distintas: intentos agotados y cierres deliberados por ambiguedad.
--
-- Este backfill los mueve a 'cancelled', el unico estado terminal no-falla que
-- el esquema admite, y deja el marcador explicito en last_send_error. La
-- combinacion cancelled + closed_no_replay_ambiguous_outbound es inequivoca y
-- no se confunde con los cancelados por respuesta del cliente, que llevan
-- result = 'responded'.
--
-- NO cambia el comportamiento del sistema: estos registros ya no se reintentan.
-- Cambia lo que la base declara sobre ellos.
--
-- Es idempotente: una segunda ejecucion no encuentra candidatos.
-- Es selectivo: solo alcanza filas con la firma exacta de ambiguedad, nunca un
-- error real con intentos agotados.
-- =============================================================================
BEGIN;

SET LOCAL lock_timeout = '3s';

WITH candidates AS (
  SELECT id, estado, last_send_error, send_attempt_count, max_send_attempts
  FROM follow_ups
  WHERE estado = 'error'
    AND last_send_error = 'outbound_unknown'
    AND next_retry_at IS NULL
    AND deleted_at IS NULL
  FOR UPDATE
),
closed AS (
  UPDATE follow_ups follow_up
  SET
    estado = 'cancelled',
    last_send_error = 'closed_no_replay_ambiguous_outbound',
    updated_at = NOW()
  FROM candidates candidate
  WHERE follow_up.id = candidate.id
  RETURNING follow_up.id, candidate.estado AS before_estado, candidate.last_send_error AS before_error
)
INSERT INTO audit_logs (
  event_name, entity_type, entity_id, actor_type, actor_id, result,
  before_payload, after_payload, metadata
)
SELECT
  'follow_up_closed_ambiguous',
  'follow_up',
  closed.id,
  'system',
  'close-ambiguous-follow-ups',
  'closed',
  jsonb_build_object('estado', closed.before_estado, 'last_send_error', closed.before_error),
  jsonb_build_object('estado', 'cancelled', 'last_send_error', 'closed_no_replay_ambiguous_outbound'),
  jsonb_build_object(
    'reason', 'ambiguous_provider_response_never_retried',
    'no_replay', TRUE
  )
FROM closed;

-- Postcondicion: ningun follow-up conserva la firma de ambiguedad sin declarar.
DO $close_ambiguous_follow_ups$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM follow_ups
    WHERE estado = 'error'
      AND last_send_error = 'outbound_unknown'
      AND next_retry_at IS NULL
      AND deleted_at IS NULL
  ) THEN
    RAISE EXCEPTION 'ambiguous follow-ups remain undeclared after backfill';
  END IF;
END
$close_ambiguous_follow_ups$;

COMMIT;
