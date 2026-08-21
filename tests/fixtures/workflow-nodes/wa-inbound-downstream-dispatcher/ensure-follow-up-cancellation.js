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

const asPositiveInteger = (value) => {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
};

const resolveInboundCreatedEpochMs = (row, explicitEpochMs = 0) => {
  const numeric = Number(explicitEpochMs || row.inbound_created_epoch_ms || 0);
  if (Number.isFinite(numeric) && numeric > 0) return numeric;

  const parsed = Date.parse(String(row.inbound_created_at || ''));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
};

const resolveInboundIdentity = (row) => {
  const inboundEventId = asPositiveInteger(row.inbound_event_id);
  if (inboundEventId) return { type: 'event', id: inboundEventId };

  const inboundMessageId = asPositiveInteger(row.message_id);
  if (inboundMessageId) return { type: 'message', id: inboundMessageId };

  return null;
};

// One persisted inbound applies the follow-up policy at most once to its target
// conversation. The action is intentionally absent from the key: a replay must
// not create another policy event if downstream classification changes.
const buildIdempotencyKey = (targetConversationId, inboundIdentity) => {
  if (!targetConversationId || !inboundIdentity) return null;
  return `follow-up-policy:${targetConversationId}:${inboundIdentity.type}:${inboundIdentity.id}`;
};

const resolveCancellationAction = (row, explicitEpochMs = 0) => {
  const targetConversationId = asPositiveInteger(
    row.target_conversation_id
      || row.follow_up_target_conversation_id
      || row.conversation_id,
  );
  const validConversation = Boolean(targetConversationId);
  const customerText = String(row.text_body || '').trim();
  const inboundMessageId = asPositiveInteger(row.message_id);
  const inboundEventId = asPositiveInteger(row.inbound_event_id);
  const inboundIdentity = resolveInboundIdentity(row);
  const inboundCreatedEpochMs = resolveInboundCreatedEpochMs(row, explicitEpochMs);
  const handoffWrite = Boolean(row.handoff_write || row.handoff_scope?.idempotency_key);
  const escalated = Boolean(row.should_escalate || row.escalation_required || handoffWrite);
  const closed = ['closed', 'inactive_timeout', 'handed_to_sales'].includes(String(row.conversation_status_code || ''));
  const optOut = detectOptOut(customerText);
  const lost = detectLostIntent(customerText);

  let action = validConversation ? 'cancel' : 'none';
  let cancelReason = validConversation ? 'client_replied' : 'no_conversation';
  if (optOut) {
    action = 'opt_out';
    cancelReason = 'opt_out';
  } else if (lost) {
    action = 'cancel';
    cancelReason = 'lost';
  } else if (escalated) {
    action = 'cancel';
    cancelReason = 'escalated';
  } else if (closed) {
    action = 'cancel';
    cancelReason = 'closed';
  }

  const responseText = String(row.response_text || '').trim();
  const firstDelayHours = Math.max(1, Number(row.follow_up_first_delay_hours || 24));
  const scheduleCandidate = validConversation
    && action === 'cancel'
    && cancelReason === 'client_replied'
    && responseText.length > 0
    && String(row.conversation_status_code || '') === 'waiting_user';
  const databaseCanResolveTimestamp = inboundIdentity?.type === 'event';
  const shouldSchedule = scheduleCandidate
    && Boolean(inboundIdentity)
    && (Boolean(inboundCreatedEpochMs) || databaseCanResolveTimestamp);
  const cycleKey = inboundIdentity
    ? `inbound:${inboundIdentity.type}:${inboundIdentity.id}`
    : null;

  return {
    follow_up_target_conversation_id: targetConversationId,
    follow_up_cancel_action: action,
    follow_up_cancel_reason: cancelReason,
    follow_up_source_text: customerText || null,
    follow_up_source_message_id: inboundMessageId,
    follow_up_should_schedule: shouldSchedule,
    follow_up_cycle_key: cycleKey,
    follow_up_motivo: 'lead_sin_respuesta',
    follow_up_scheduled_at: shouldSchedule
      && inboundCreatedEpochMs
      ? new Date(inboundCreatedEpochMs + firstDelayHours * 3600000).toISOString()
      : null,
    follow_up_schedule_skipped_reason: scheduleCandidate && !shouldSchedule
      ? 'missing_persisted_inbound_identity_or_timestamp'
      : null,
    follow_up_cancel_decided: Boolean(action && action !== 'none'),
    follow_up_idempotency_key: buildIdempotencyKey(targetConversationId, inboundIdentity),
    follow_up_inbound_created_epoch_ms: inboundCreatedEpochMs,
    follow_up_source_event_id: inboundEventId,
    follow_up_first_delay_hours: firstDelayHours,
  };
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    OPT_OUT_PATTERNS,
    LOST_PATTERNS,
    detectOptOut,
    detectLostIntent,
    resolveCancellationAction,
    resolveInboundCreatedEpochMs,
    resolveInboundIdentity,
    buildIdempotencyKey,
  };
}

if (typeof items !== 'undefined') {
  const firstDelayHours = Number($env.FOLLOW_UP_FIRST_DELAY_HOURS || 24);
  return items.map((item) => ({
    json: {
      ...item.json,
      ...resolveCancellationAction({
        ...item.json,
        follow_up_first_delay_hours: firstDelayHours,
      }),
    },
  }));
}
