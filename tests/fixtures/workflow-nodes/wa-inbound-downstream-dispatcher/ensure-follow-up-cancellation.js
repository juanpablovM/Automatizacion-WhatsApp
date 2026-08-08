const OPT_OUT_PATTERNS = [
  /no me escribas mas/i,
  /escribas mas/i,
  /baja.*(de la lista|pas|mensajes|programa)/i,
  /\bstop\b/i,
  /no quiero (mas )?(mensajes|publicidad|informacion|seguir recibiendo)/i,
  /dej(?:a|en) de escribirme/i,
  /no me envies mas mensajes/i,
  /darme de baja/i,
  /quitarme de la lista/i,
  /no me molestes/i,
];

const LOST_PATTERNS = [
  /ya no (me interesa|necesito|quiero)/i,
  /lo pense y no (voy a|quiero)/i,
  /estoy con (otra|la competencia)/i,
  /no voy a (comprar|avanzar)/i,
  /cerremos el tema/i,
];

const matches = (patterns, text) => patterns.some((pattern) => pattern.test(String(text || '').trim()));
const detectOptOut = (text) => matches(OPT_OUT_PATTERNS, text);
const detectLostIntent = (text) => matches(LOST_PATTERNS, text);

const resolveCancellationAction = (row, now = new Date()) => {
  const conversationId = Number(row.conversation_id);
  const validConversation = Number.isSafeInteger(conversationId) && conversationId > 0;
  const customerText = String(row.text_body || '').trim();
  const inboundMessageId = Number(row.message_id || 0) || null;
  const inboundEventId = Number(row.inbound_event_id || 0) || null;
  const handoffWrite = Boolean(row.handoff_write || row.handoff_scope?.idempotency_key);
  const escalated = Boolean(row.should_escalate || row.escalation_required || handoffWrite);
  const closed = ['closed', 'inactive_timeout', 'handed_to_sales'].includes(String(row.conversation_status_code || ''));
  const optOut = detectOptOut(customerText);
  const lost = detectLostIntent(customerText);

  let action = validConversation ? 'cancel' : null;
  let cancelReason = validConversation ? 'client_replied' : null;
  if (optOut) {
    action = 'opt_out';
    cancelReason = 'opt_out';
  } else if (lost) {
    cancelReason = 'lost';
  } else if (escalated) {
    cancelReason = 'escalated';
  } else if (closed) {
    cancelReason = 'closed';
  }

  const responseText = String(row.response_text || '').trim();
  const shouldSchedule = validConversation
    && action === 'cancel'
    && cancelReason === 'client_replied'
    && responseText.length > 0
    && String(row.conversation_status_code || '') === 'waiting_user';
  const sourceKey = inboundMessageId || inboundEventId;
  const cycleKey = sourceKey ? `inbound:${sourceKey}` : null;
  const firstDelayHours = Math.max(1, Number(row.follow_up_first_delay_hours || 24));

  return {
    follow_up_cancel_action: action,
    follow_up_cancel_reason: cancelReason,
    follow_up_source_text: customerText || null,
    follow_up_source_message_id: inboundMessageId,
    follow_up_should_schedule: shouldSchedule,
    follow_up_cycle_key: cycleKey,
    follow_up_motivo: 'lead_sin_respuesta',
    follow_up_scheduled_at: shouldSchedule
      ? new Date(now.getTime() + firstDelayHours * 3600000).toISOString()
      : null,
    follow_up_cancel_decided: Boolean(action),
  };
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { OPT_OUT_PATTERNS, LOST_PATTERNS, detectOptOut, detectLostIntent, resolveCancellationAction };
}

if (typeof items !== 'undefined') {
  return items.map((item) => ({
    json: {
      ...item.json,
      ...resolveCancellationAction({
        ...item.json,
        follow_up_first_delay_hours: Number($env.FOLLOW_UP_FIRST_DELAY_HOURS || 24),
      }),
    },
  }));
}
