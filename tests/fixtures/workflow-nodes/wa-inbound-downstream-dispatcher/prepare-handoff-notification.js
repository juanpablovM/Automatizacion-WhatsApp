// =============================================================================
// Prepare Handoff Notification — Unidad 3: notificacion durable al area.
// -----------------------------------------------------------------------------
// Nodo del dispatcher "WA - Inbound Downstream Dispatcher". Decide si el
// handoff debe notificarse en este turno y construye el payload del area.
//
// Reglas deterministas:
//   - Se notifica solo cuando el handoff existe y esta 'pending' con intentos
//     disponibles (notification_attempt_count < max_attempts).
//   - Un handoff ya 'notified'/'acknowledged'/'resolved' nunca se re-notifica
//     (verificable exactamente una vez: notified_at + audit).
//   - El reenvio por fallo lo disparan los reintentos del dispatch/recovery;
//     la idempotencia la garantiza el contador de intentos en la BD.
// =============================================================================

const NOTIFIED_OR_BETTER = new Set(['notified', 'acknowledged', 'resolved']);

const prepareHandoffNotification = (row) => {
  const handoffId = Number(row.handoff_id || row.declared_handoff_id || 0);
  const estado = String(row.handoff_estado || row.declared_handoff_status || 'pending').trim();
  const attempts = Number(row.handoff_attempts ?? row.notification_attempt_count ?? 0);
  const maxAttempts = Number(row.handoff_max_attempts ?? 3);
  const scope = row.handoff_scope || row.declared_handoff_scope || {};

  const exists = handoffId > 0 || Boolean(row.declared_handoff_exists);
  const alreadyNotified = NOTIFIED_OR_BETTER.has(estado);
  const attemptsLeft = attempts < maxAttempts;
  const shouldNotify = exists && !alreadyNotified && attemptsLeft && estado === 'pending';

  return {
    handoff_id: handoffId > 0 ? handoffId : null,
    handoff_estado: estado,
    notification_attempts: attempts,
    notification_max_attempts: maxAttempts,
    should_notify: shouldNotify,
    notification_skipped: !shouldNotify,
    notification_channel: 'internal',
    notification_payload: shouldNotify
      ? {
          channel: 'internal',
          idempotency_key: scope.idempotency_key || row.declared_handoff_key || null,
          motivo: scope.motivo || row.declared_handoff_motivo || null,
          area: scope.area || row.declared_handoff_area || null,
          area_label: scope.area_label || row.declared_handoff_area_label || null,
          prioridad: scope.prioridad || row.declared_handoff_prioridad || null,
          responsable: scope.responsable || row.declared_handoff_responsable || null,
          phone_number: scope.phone_number || row.phone_number || null,
          conversation_id: scope.conversation_id || row.conversation_id || null,
          escalation_reason: scope.escalation_reason || null,
        }
      : null,
  };
};

// =============================================================================
// Seccion n8n (Code node). En Node (harness) `items` no existe.
// =============================================================================
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { prepareHandoffNotification };
}

if (typeof items !== 'undefined') {
  const row = items[0]?.json ?? {};
  return [{ json: { ...row, ...prepareHandoffNotification(row) } }];
}