// The recovery claim runs from three places: the minute schedule and the
// dispatcher's "next inbox event" claim every settled queue; the entry
// webhook's debounce waiter scopes the claim to its own contact queue, so one
// contact's drain never processes another contact's turn in its execution.
const input = items[0]?.json ?? {};
const debounce = resolveInboundDebounce($env);
const scope = String(input.queue_scope_inbound_event_id ?? '').trim();

return [{ json: {
  stale_seconds: Math.max(60, Number($env.INBOUND_PROCESSING_STALE_SECONDS || 600)),
  batch_size: Math.max(1, Math.min(100, Number($env.INBOUND_RECOVERY_BATCH_SIZE || 20))),
  max_attempts: Math.max(1, Number($env.INBOUND_MAX_PROCESSING_ATTEMPTS || 5)),
  debounce_seconds: debounce.seconds,
  debounce_max_wait_seconds: debounce.max_wait_seconds,
  queue_scope_inbound_event_id: /^\d+$/.test(scope) ? scope : null,
} }];
