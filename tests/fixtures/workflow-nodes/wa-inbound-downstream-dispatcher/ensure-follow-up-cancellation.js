// Opt-out and lost-intent phrasing lives in shared/customer-opt-out-vocabulary.js.
// In n8n that file is prepended to this node; under Node it is required.
const customerIntent = typeof detectOptOut === 'function'
  ? { OPT_OUT_PATTERNS, LOST_PATTERNS, normalizeIntentText, detectOptOut, detectLostIntent }
  : require('../shared/customer-opt-out-vocabulary.js');
const normalizeText = customerIntent.normalizeIntentText;

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
  const optOut = customerIntent.detectOptOut(customerText);
  const lost = customerIntent.detectLostIntent(customerText);
  const normalizedText = normalizeText(customerText);
  const pendingChoice = row.pending_question_key === 'previous_context_choice'
    || String(row.current_step || '').split('|')[0] === 'previous_context';
  const tomorrowPostponement = pendingChoice && /^(?:gracias(?: por todo)?\s+)?(?:(?:hablame|escribeme|contactame|hablemos|hablamos|retomamos|seguimos|continuamos|lo vemos)\s+manana|manana(?:\s+(?:hablamos|seguimos|retomamos))?)(?:\s+por favor)?$/.test(normalizedText);
  const unsupportedPostponement = pendingChoice && /^(?:hablame\s+)?pasado manana$/.test(normalizedText);
  const passiveChoice = pendingChoice && (['reaction', 'sticker'].includes(row.message_type) || !normalizedText
    || /^(?:muchas )?gracias(?: por (?:todo|la ayuda|tu ayuda|su ayuda))?$|^(?:chao|chau|hasta luego|adios|hasta manana|nos vemos)$/.test(normalizedText));
  const windowStart = String(row.follow_up_window_start || '09:00').trim();
  const windowEnd = String(row.follow_up_window_end || '20:00').trim();
  const timePattern = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
  const validWindow = timePattern.test(windowStart) && timePattern.test(windowEnd) && windowStart < windowEnd;

  let action = validConversation ? 'cancel' : 'none';
  let cancelReason = validConversation ? 'client_replied' : 'no_conversation';
  if (optOut) {
    action = 'opt_out';
    cancelReason = 'opt_out';
  } else if (lost) {
    action = 'cancel';
    cancelReason = 'lost';
  } else if (row.bot_suppressed) {
    action = 'none';
    cancelReason = 'human_control_active';
  } else if (row.response_kind === 'commercial_review_pending') {
    action = 'none';
    cancelReason = 'commercial_review_pending';
  } else if (escalated) {
    action = 'cancel';
    cancelReason = 'escalated';
  } else if (closed) {
    action = 'cancel';
    cancelReason = 'closed';

  } else if (passiveChoice) {
    action = 'none';
    cancelReason = 'non_commercial_context_reply';
  } else if (tomorrowPostponement) {
    cancelReason = 'postponed_until_tomorrow';
  }

  const responseText = String(row.response_text || '').trim();
  const firstDelayHours = Math.max(1, Number(row.follow_up_first_delay_hours || 24));
  const scheduleCandidate = validConversation
    && action === 'cancel'
    && ['client_replied', 'postponed_until_tomorrow'].includes(cancelReason)
    && !unsupportedPostponement
    && (!tomorrowPostponement || validWindow)
    && responseText.length > 0
    && String(row.conversation_status_code || '') === 'waiting_user';
  const databaseCanResolveTimestamp = inboundIdentity?.type === 'event';
  const shouldSchedule = scheduleCandidate
    && Boolean(inboundIdentity)
    && (!tomorrowPostponement || databaseCanResolveTimestamp)
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
      && !tomorrowPostponement
      && inboundCreatedEpochMs
      ? new Date(inboundCreatedEpochMs + firstDelayHours * 3600000).toISOString()
      : null,
    follow_up_window_start: validWindow ? windowStart : null,
    follow_up_window_end: validWindow ? windowEnd : null,
    follow_up_schedule_skipped_reason: tomorrowPostponement && !validWindow ? 'invalid_send_window'
      : scheduleCandidate && !shouldSchedule
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
    OPT_OUT_PATTERNS: customerIntent.OPT_OUT_PATTERNS,
    LOST_PATTERNS: customerIntent.LOST_PATTERNS,
    detectOptOut: customerIntent.detectOptOut,
    detectLostIntent: customerIntent.detectLostIntent,
    resolveCancellationAction,
    resolveInboundCreatedEpochMs,
    resolveInboundIdentity,
    buildIdempotencyKey,
  };
}

if (typeof items !== 'undefined') {
  const firstDelayHours = Number($env.FOLLOW_UP_FIRST_DELAY_HOURS || 24);
  const windowStart = String($env.FOLLOW_UP_WINDOW_START || '09:00');
  const windowEnd = String($env.FOLLOW_UP_WINDOW_END || '20:00');
  return items.map((item) => ({
    json: {
      ...item.json,
      ...resolveCancellationAction({
        ...item.json,
        follow_up_first_delay_hours: firstDelayHours,
        follow_up_window_start: windowStart,
        follow_up_window_end: windowEnd,
      }),
    },
  }));
}
