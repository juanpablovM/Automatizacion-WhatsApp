// A debounced customer event is only queued by the durable inbox claim. Once
// its window closes, something must claim the contact's queue, or a lone
// message waits for the minute scheduler. This branch waits the window and
// drains that queue; the claim admits it only when nothing newer arrived (a
// newer message schedules its own drain). The margin keeps the wake-up after
// the window even with timer jitter.
const DEBOUNCE_WAKE_MARGIN_SECONDS = 0.25;

return items
  .map((item) => item?.json ?? {})
  .filter((row) => row.debounce_pending === true
    && row.duplicate_event !== true
    && /^\d+$/.test(String(row.inbound_event_id ?? ''))
    && Number(row.debounce_seconds) > 0)
  .map((row) => ({ json: {
    queue_scope_inbound_event_id: String(row.inbound_event_id),
    debounce_wait_seconds: Number(row.debounce_seconds) + DEBOUNCE_WAKE_MARGIN_SECONDS,
  } }));
