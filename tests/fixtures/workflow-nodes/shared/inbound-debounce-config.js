// =============================================================================
// inbound-debounce-config.js — the single reading of the inbound debounce env.
// -----------------------------------------------------------------------------
// INBOUND_DEBOUNCE_SECONDS: how long a contact must stay quiet before their
// pending messages become one turn (sliding window, default 6, 0 disables,
// capped at 60). INBOUND_DEBOUNCE_MAX_WAIT_SECONDS: how long a customer who
// keeps typing can defer that turn (default 30, never below the window, capped
// at 300). An unreadable value keeps the default rather than disabling.
// Code nodes get this file prepended through `runtimes` in
// tests/scripts/sync-workflow-nodes.mjs; Node harnesses require it.
// =============================================================================

const DEFAULT_INBOUND_DEBOUNCE_SECONDS = 6;
const MAX_INBOUND_DEBOUNCE_SECONDS = 60;
const DEFAULT_INBOUND_DEBOUNCE_MAX_WAIT_SECONDS = 30;
const MAX_INBOUND_DEBOUNCE_MAX_WAIT_SECONDS = 300;

const readWholeSeconds = (value, fallback, max) => {
  const raw = String(value ?? '').trim();
  if (!/^\d+$/.test(raw)) return fallback;
  return Math.min(max, Number(raw));
};

const resolveInboundDebounce = (env) => {
  const source = env || {};
  const seconds = readWholeSeconds(
    source.INBOUND_DEBOUNCE_SECONDS,
    DEFAULT_INBOUND_DEBOUNCE_SECONDS,
    MAX_INBOUND_DEBOUNCE_SECONDS,
  );
  if (seconds === 0) return { seconds: 0, max_wait_seconds: 0 };
  const maxWait = readWholeSeconds(
    source.INBOUND_DEBOUNCE_MAX_WAIT_SECONDS,
    DEFAULT_INBOUND_DEBOUNCE_MAX_WAIT_SECONDS,
    MAX_INBOUND_DEBOUNCE_MAX_WAIT_SECONDS,
  );
  return { seconds, max_wait_seconds: Math.max(seconds, maxWait) };
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { resolveInboundDebounce };
}
