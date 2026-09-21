// =============================================================================
// OPS - Handoff ClickUp Closure — Normalize ClickUp Closure
// -----------------------------------------------------------------------------
// Turns an inbound ClickUp webhook into the values two lanes need: the task id
// and the requested handoff state for the closure query, and the ClickUp status
// transition itself for commercial lead chat ownership.
//
// This is the project's first inbound integration, so the node is deliberately
// strict about what it accepts:
//   - the HMAC signature must verify before any payload field is read
//   - only task status changes are actionable; every other ClickUp event is
//     acknowledged and ignored rather than treated as an error
//   - an unmapped status is ignored too, so renaming a column in ClickUp can
//     never silently advance a handoff
//
// Authentication follows ClickUp's documented webhook contract: every delivery
// carries an X-Signature header holding the hex HMAC-SHA256 digest of the raw
// request body, keyed by the webhook's own secret. ClickUp never sends a bearer
// token or a shared secret in the clear, so there is no plaintext path to
// accept — offering one would reject every genuine delivery while widening the
// attack surface.
//
// Status mapping is configuration, not code. CLICKUP_STATUS_ACKNOWLEDGED and
// CLICKUP_STATUS_RESOLVED hold comma-separated ClickUp status names; matching
// is case-insensitive and whitespace-tolerant because ClickUp status names are
// user-editable labels.
//
// The lead chat ownership lane rides on the same delivery but does not share
// the closure lane's verdict. A salesperson owns the chat while the task sits
// in 'in progress' and stops owning it on any transition out of it — including
// a transition to a status the handoff mapping does not know. So `lead_routable`
// is decided from the event shape alone and stays true where `actionable` is
// false; reading `actionable` for both lanes would silently drop that release.
//
// Output (always exactly one item):
//   { authorized, actionable, clickup_task_id, estado, reason }
// plus, on every authorized item:
//   { clickup_history_id, clickup_history_at, clickup_previous_status,
//     clickup_new_status, is_ownership_acquisition, lead_routable }
// An unauthorized item keeps the original five fields and carries none of the
// ownership ones: nothing downstream may act on a payload that failed HMAC.
// =============================================================================

const DEFAULT_ACKNOWLEDGED_STATUSES = 'in progress,en progreso,en curso';
const DEFAULT_RESOLVED_STATUSES = 'complete,completed,closed,done,cerrado,resuelto';

const parseStatusList = (raw, fallback) => String(raw || fallback)
  .split(',')
  .map((entry) => entry.trim().toLowerCase())
  .filter(Boolean);

// ClickUp stamps history entries with epoch milliseconds carried in a string
// ("1568036964079"). The ownership queries take a timestamptz, so the
// conversion happens here rather than being left to the driver to guess. An
// unusable value becomes null, which those queries already read as "no ordering
// evidence" instead of failing the delivery.
const toIsoTimestamp = (value) => {
  if (value === null || value === undefined) return null;
  const raw = String(value).trim();
  if (!raw) return null;
  const epochMs = /^-?\d+$/.test(raw) ? Number(raw) : Date.parse(raw);
  if (!Number.isFinite(epochMs)) return null;
  const parsed = new Date(epochMs);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
};

// Verbatim on purpose. `before.status` is the label an expired lease writes back
// to ClickUp, and a trimmed or lowercased copy would restore a status the space
// does not have.
const verbatimStatus = (side) => {
  if (!side || side.status === null || side.status === undefined) return null;
  return typeof side.status === 'string' ? side.status : String(side.status);
};

// Ownership fields travel on every authorized item so the routing IF nodes read
// a real boolean instead of an absent key.
const EMPTY_LEAD_FIELDS = {
  clickup_history_id: null,
  clickup_history_at: null,
  clickup_previous_status: null,
  clickup_new_status: null,
  is_ownership_acquisition: false,
  lead_routable: false,
};

const reject = (reason) => [{
  json: {
    authorized: false,
    actionable: false,
    clickup_task_id: null,
    estado: null,
    reason,
  },
}];

const ignore = (reason, clickupTaskId = null, leadFields = {}) => [{
  json: {
    authorized: true,
    actionable: false,
    clickup_task_id: clickupTaskId,
    estado: null,
    reason,
    ...EMPTY_LEAD_FIELDS,
    ...leadFields,
  },
}];

const input = items[0] ? items[0].json || {} : {};
const body = input.body || {};
const headers = input.headers || {};
// The query string is deliberately unused: a signed body is the only accepted
// proof of origin, and a token in the URL would leak through logs and referrers.

// --- Authentication ---------------------------------------------------------
// The secret is required. An unset secret must never mean "allow everyone":
// this endpoint can advance operational state, so it fails closed.
const crypto = require('crypto');

const webhookSecret = String($env.CLICKUP_WEBHOOK_SECRET || '');
if (!webhookSecret) {
  return reject('clickup_webhook_secret_not_configured');
}

const presentedSignature = String(
  headers['x-signature'] || headers['X-Signature'] || '',
).trim();

if (!presentedSignature) {
  return reject('missing_signature');
}

// ClickUp signs the exact bytes it sent. n8n has already parsed the JSON, so
// prefer a raw body when the webhook node provides one and fall back to a
// separator-free re-serialization, which is the reconstruction ClickUp
// documents for clients that auto-parse. JSON.parse preserves key insertion
// order, so the round trip reproduces the original bytes for ClickUp payloads.
const rawBody = typeof input.rawBody === 'string'
  ? input.rawBody
  : JSON.stringify(body);

const expectedSignature = crypto
  .createHmac('sha256', webhookSecret)
  .update(rawBody, 'utf8')
  .digest('hex');

// Compare in constant time. Buffers of unequal length make timingSafeEqual
// throw, so the length check comes first and leaks only the length.
const presentedDigest = Buffer.from(presentedSignature, 'utf8');
const expectedDigest = Buffer.from(expectedSignature, 'utf8');
const signatureMatches = presentedDigest.length === expectedDigest.length
  && crypto.timingSafeEqual(presentedDigest, expectedDigest);

if (!signatureMatches) {
  return reject('invalid_signature');
}

// --- Event shape ------------------------------------------------------------
const eventName = String(body.event || '').trim();
if (eventName !== 'taskStatusUpdated') {
  return ignore(`unsupported_event:${eventName || 'missing'}`);
}

const clickupTaskId = String(body.task_id || '').trim();
if (!clickupTaskId) {
  return ignore('missing_task_id');
}

// ClickUp reports the transition inside history_items; the last entry carries
// the status the task ended up in.
const historyItems = Array.isArray(body.history_items) ? body.history_items : [];
const statusChange = historyItems
  .filter((entry) => entry && entry.field === 'status' && entry.after)
  .pop();

const afterStatus = statusChange && statusChange.after
  ? String(statusChange.after.status || '').trim().toLowerCase()
  : '';

if (!afterStatus) {
  return ignore('missing_status_change', clickupTaskId);
}

// --- Status mapping ---------------------------------------------------------
const acknowledgedStatuses = parseStatusList(
  $env.CLICKUP_STATUS_ACKNOWLEDGED,
  DEFAULT_ACKNOWLEDGED_STATUSES,
);
const resolvedStatuses = parseStatusList(
  $env.CLICKUP_STATUS_RESOLVED,
  DEFAULT_RESOLVED_STATUSES,
);

// --- Lead chat ownership ----------------------------------------------------
// `is_ownership_acquisition` reads the acknowledged list directly instead of the
// mapped `estado`: the lease exists while the task is in progress, which is what
// that list names, and `estado` collapses to 'resolved' whenever an operator
// lists a status in both places.
//
// `lead_routable` is deliberately independent of `estado`. Reaching this point
// already proves the delivery is a signed taskStatusUpdated with a task id and a
// usable destination status, which is everything the ownership queries need.
const leadFields = {
  clickup_history_id: statusChange.id === null || statusChange.id === undefined
    ? null
    : String(statusChange.id),
  clickup_history_at: toIsoTimestamp(statusChange.date),
  clickup_previous_status: verbatimStatus(statusChange.before),
  clickup_new_status: verbatimStatus(statusChange.after),
  is_ownership_acquisition: acknowledgedStatuses.includes(afterStatus),
  lead_routable: Boolean(clickupTaskId) && Boolean(afterStatus),
};

// Resolved wins when a status appears in both lists: closing is the stronger
// claim, and an operator who lists a status twice most likely means "done".
let estado = null;
if (resolvedStatuses.includes(afterStatus)) {
  estado = 'resolved';
} else if (acknowledgedStatuses.includes(afterStatus)) {
  estado = 'acknowledged';
}

// An unmapped status stays non-actionable for the handoff lane — renaming a
// ClickUp column must never advance a handoff — but it still routes to the
// ownership lane, which only cares that the task left 'in progress'.
if (!estado) {
  return ignore(`unmapped_status:${afterStatus}`, clickupTaskId, leadFields);
}

return [{
  json: {
    authorized: true,
    actionable: true,
    clickup_task_id: clickupTaskId,
    estado,
    reason: `status:${afterStatus}`,
    ...leadFields,
  },
}];
