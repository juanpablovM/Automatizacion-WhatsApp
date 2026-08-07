// =============================================================================
// ensure-follow-up-cancellation.js — Nodo "Ensure Follow-Up Cancellation"
// (WA - Inbound Downstream Dispatcher). SOURCE OF TRUTH de cuando una
// conversacion cancela su cadencia de seguimiento (A-010).
// -----------------------------------------------------------------------------
// Reglas (PRD #20/#849 A-010, 25.4):
//   1. El cliente responde (mensaje entrante del usuario) -> 'client_replied':
//      la persona volvio a conversar; los follow_ups pendientes se cancelan.
//   2. El agente deriva a humano (handoff_escalated/handoff_scope presente) o
//      el lead se cierra -> 'escalated' | 'closed'.
//   3. Perdida de interes (detectLostIntent sobre el texto, p. ej. "ya no me
//      interesa", "no voy a comprar") -> 'lost' con lost_reason.
//   4. Opt-out explicito (detectOptOut, p. ej. "no me escribas mas", "baja
//      pas") -> 'opt_out' (estado definitivo: el pipeline nunca vuelve a
//      escribirle).
//
// La decision es PURA (string por item) y la escritura la hace el nodo
// Postgres "Cancel Pending Follow Ups" (queries 05/06) con el scope emitido
// aqui; si no hay follow-ups pendientes, la query devuelve already_cancelled
// y no se escribe nada.
// =============================================================================
const OPT_OUT_PATTERNS = [
  /no me escribas mas/i,
  /escribas mas/i,
  /baja.*(de la lista|pas|mensajes|programa)/i,
  /stop/i,
  /no quiero (mas )?(mensajes|publicidad|informacion|seguir recibiendo)/i,
  /dej[a|en] de escribirme/i,
  /no me envies mas mensajes/i,
  /darme de baja/i,
  /quitar(me)? de la lista/i,
  /no me molestes/i,
];

const LOST_PATTERNS = [
  /ya no (me interesa|necesito|quiero)/i,
  /lo pense y no (voy a|quiero)/i,
  /estoy con (otra|la competencia)/i,
  /no voy a (comprar|avanzar)/i,
  /cerremos el tema/i,
];

const detectOptOut = (text) => {
  const source = String(text ?? '').trim().toLowerCase();
  if (!source) return false;
  return OPT_OUT_PATTERNS.some((pattern) => pattern.test(source));
};

const detectLostIntent = (text) => {
  const source = String(text ?? '').trim();
  if (!source) return false;
  return LOST_PATTERNS.some((pattern) => pattern.test(source));
};

const hasPendingFollowUps = (row) => {
  if (row.declared_follow_up_pending === true) return true;
  const pending = row.follow_up_pending_count;
  if (typeof pending === 'number') return pending > 0;
  if (typeof pending === 'string') return Number(pending) > 0;
  return row.follow_up_pending === true;
};

const resolveCancellationAction = (row) => {
  const customerText = String(row.customer_message || row.user_text || row.message_text || '').trim();
  const isCustomerTurn = Boolean(row.from_user) || Boolean(row.is_customer_message) || String(row.direction || '') === 'inbound';
  const handoffWrite = Boolean(row.handoff_write || row.handoff_scope?.idempotency_key);
  const escalated = Boolean(row.should_escalate) || handoffWrite;
  const lost = detectLostIntent(customerText);
  const optOut = detectOptOut(customerText);
  const pending = hasPendingFollowUps(row);

  let action = null;
  let cancelReason = null;
  let lostReason = null;

  if (optOut) {
    action = 'opt_out';
    cancelReason = 'opt_out';
  } else if (lost) {
    action = 'cancel';
    cancelReason = 'lost';
    lostReason = customerText.slice(0, 120);
  } else if (escalated) {
    action = 'cancel';
    cancelReason = 'escalated';
  } else if (isCustomerTurn && customerText) {
    action = 'cancel';
    cancelReason = 'client_replied';
  }

  const shouldApply = action && pending;

  return {
    decided: Boolean(action),
    should_apply: shouldApply,
    follow_up_cancel_action: action,
    follow_up_cancel_reason: cancelReason,
    follow_up_lost_reason: lostReason,
    follow_up_pending: pending,
    follow_up_scope: shouldApply
      ? {
          conversation_id: Number(row.conversation_id) > 0 ? Number(row.conversation_id) : null,
          cancel_reason: cancelReason,
          lost_reason: lostReason,
        }
      : null,
  };
};

// ---------------------------------------------------------------------------
// Seccion n8n: procesa el item del dispatcher.
// ---------------------------------------------------------------------------
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    OPT_OUT_PATTERNS,
    LOST_PATTERNS,
    detectOptOut,
    detectLostIntent,
    hasPendingFollowUps,
    resolveCancellationAction,
  };
}

if (typeof items !== 'undefined') {
  const rows = items.map((item) => ({
    ...item.json,
    resolution: resolveCancellationAction(item.json),
  }));
  return rows.map(({ resolution, ...rest }) => ({
    json: { ...rest, ...resolution, follow_up_cancel_decided: true },
  }));
}