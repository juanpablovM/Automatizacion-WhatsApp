// =============================================================================
// Dispatch Handoff Notification — Unidad 3: stub determinista de notificacion.
// -----------------------------------------------------------------------------
// Nodo del dispatcher "WA - Inbound Downstream Dispatcher". Sustituye al
// canal real (ClickUp/WhatsApp interno) por un stub 100% determinista:
//   - por defecto emite outcome 'succeeded' (caso de produccion: el area
//     queda notificada una sola vez y el estado pasa a 'notified');
//   - los tests fuerzan fallos con row.notification_stub_mode='failed' para
//     validar reintentos (max 3) y auditoria sin tocar servicios externos.
//
// Nunca envia mensajes reales: el payload es un objeto interno que persiste
// `mark_handoff_attempt` con la idempotencia del handoff.
// =============================================================================

const dispatchHandoffNotification = (row) => {
  const shouldDispatch = Boolean(row.should_notify) && row.handoff_write !== false;
  const mode = String(row.notification_stub_mode || 'succeeded').trim();
  const outcome = mode === 'failed' ? 'failed' : 'succeeded';
  const statusCode = outcome === 'succeeded' ? 200 : 503;
  const error = outcome === 'failed'
    ? String(row.notification_stub_error || 'Stub notification failure (simulated)')
    : null;

  return {
    should_dispatch: shouldDispatch,
    dispatch_skipped: !shouldDispatch,
    notification_outcome: shouldDispatch ? outcome : 'skipped',
    notification_status_code: shouldDispatch ? statusCode : null,
    notification_error: shouldDispatch ? error : null,
    notification_stub: true,
  };
};

// =============================================================================
// Seccion n8n (Code node). En Node (harness) `items` no existe.
// =============================================================================
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { dispatchHandoffNotification };
}

if (typeof items !== 'undefined') {
  const row = items[0]?.json ?? {};
  return [{ json: { ...row, ...dispatchHandoffNotification(row) } }];
}