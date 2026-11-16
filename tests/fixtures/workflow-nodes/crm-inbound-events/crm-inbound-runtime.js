// =============================================================================
// CRM inbound runtime (CRM -> bot, contract v1 revision 1.2, "1.2b").
// -----------------------------------------------------------------------------
// Pure helpers shared by the crm-inbound-events Code nodes: configuration,
// signature verification over the raw request bytes, envelope validation and
// response shaping. Nothing here touches the database; the idempotency inbox
// and the ownership change live in crm_inbound_apply_chat_event() (migration
// 040). The secret and the raw body are never returned, so any output item can
// be logged by n8n without exposing either.
//
// Request rules (agreed with the CRM, .orca/drops/crm-requirements-v1-2.md B):
//   X-CRM-Timestamp: 10-digit Unix seconds, within +-300 s of now.
//   X-CRM-Signature: "v1=" + lowercase hex HMAC-SHA256(secret,
//                    timestamp + "." + raw body bytes).
//   Body: at most 65,536 bytes of UTF-8 JSON; unknown fields are rejected.
// =============================================================================

const CRM_INBOUND_MAX_BODY_BYTES = 65536;
const CRM_INBOUND_SKEW_SECONDS = 300;
const CRM_INBOUND_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const CRM_INBOUND_UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CRM_INBOUND_OCCURRED_AT_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(\.\d{1,6})?Z$/;
const CRM_INBOUND_SIGNATURE_PATTERN = /^v1=[0-9a-f]{64}$/;
const CRM_INBOUND_ENVELOPE_KEYS = ['schema_version', 'protocol_revision', 'event_id', 'type', 'occurred_at', 'data'];
// Only chat ownership is implemented in 1.2b. opportunity.*, handoff.* and
// message.send arrive in 1.2c+ and answer invalid_event until then.
const CRM_INBOUND_CHAT_TYPES = ['chat.take', 'chat.release'];
const CRM_INBOUND_CHAT_DATA_KEYS = ['crm_opportunity_id', 'crm_seller_id', 'ownership_version'];

const crmInboundConfigured = (value) => {
  const text = String(value ?? '').trim();
  return text !== '' && !text.includes('__PENDIENTE__');
};

// Disabled (the default) answers 503 to every request. Enabled without its own
// secret is a misconfiguration that also answers 503: the CRM retries 503 with
// backoff, so no event is lost while an operator fixes the variables.
const readCrmInboundConfig = (env = {}) => {
  const enabled = String(env.CRM_INBOUND_ENABLED ?? '').trim() === 'true';
  const config = { enabled, errors: [] };
  if (!enabled) return config;
  if (!crmInboundConfigured(env.CRM_INBOUND_HMAC_SECRET)) {
    config.errors.push('CRM_INBOUND_HMAC_SECRET_missing');
  } else if (String(env.CRM_INBOUND_HMAC_SECRET) === String(env.CRM_EVENTS_HMAC_SECRET ?? '')) {
    // Each direction has its own secret: a leaked outbound secret must not let
    // anyone drive chat ownership.
    config.errors.push('CRM_INBOUND_HMAC_SECRET_reused');
  }
  return config;
};

const crmInboundRespond = (httpStatus, response) => ({ action: 'respond', http_status: httpStatus, response });
const crmInboundInvalid = (details) => crmInboundRespond(400, { error: 'invalid_event', details });

const crmInboundHeader = (headers, name) => {
  if (!headers || typeof headers !== 'object') return '';
  const wanted = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === wanted) return String(Array.isArray(value) ? value[0] : value ?? '').trim();
  }
  return '';
};

const crmInboundSignatureValid = (rawBody, headers, secret, nowMs, cryptoModule) => {
  const timestamp = crmInboundHeader(headers, 'x-crm-timestamp');
  const presented = crmInboundHeader(headers, 'x-crm-signature');
  if (!/^\d{10}$/.test(timestamp) || !CRM_INBOUND_SIGNATURE_PATTERN.test(presented)) return false;
  if (Math.abs(Math.floor(nowMs / 1000) - Number(timestamp)) > CRM_INBOUND_SKEW_SECONDS) return false;
  const expected = cryptoModule
    .createHmac('sha256', String(secret))
    .update(Buffer.concat([Buffer.from(`${timestamp}.`, 'ascii'), rawBody]))
    .digest();
  const given = Buffer.from(presented.slice(3), 'hex');
  return given.length === expected.length && cryptoModule.timingSafeEqual(given, expected);
};

const crmInboundRealInstant = (value) => {
  if (typeof value !== 'string') return false;
  const match = CRM_INBOUND_OCCURRED_AT_PATTERN.exec(value);
  if (!match) return false;
  const [, year, month, day, hour, minute, second] = match.map(Number);
  const date = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
    && date.getUTCHours() === hour && date.getUTCMinutes() === minute && date.getUTCSeconds() === second;
};

const crmInboundIsObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

// Returns the list of violations of the envelope and of chat.take/chat.release
// data. Field names only: values are never echoed back.
const validateCrmInboundEnvelope = (parsed) => {
  if (!crmInboundIsObject(parsed)) return ['envelope'];
  const errors = [];
  for (const key of Object.keys(parsed)) {
    if (!CRM_INBOUND_ENVELOPE_KEYS.includes(key)) errors.push(`envelope.${key}: unknown`);
  }
  for (const key of CRM_INBOUND_ENVELOPE_KEYS) if (!(key in parsed)) errors.push(`envelope.${key}: missing`);
  if (parsed.schema_version !== 1) errors.push('envelope.schema_version');
  if (parsed.protocol_revision !== '1.2') errors.push('envelope.protocol_revision');
  if (!(typeof parsed.event_id === 'string' && CRM_INBOUND_ID_PATTERN.test(parsed.event_id))) errors.push('envelope.event_id');
  if (!crmInboundRealInstant(parsed.occurred_at)) errors.push('envelope.occurred_at');
  if (!CRM_INBOUND_CHAT_TYPES.includes(parsed.type)) errors.push('envelope.type: unsupported');
  if (!crmInboundIsObject(parsed.data)) return [...errors, 'envelope.data'];
  const data = parsed.data;
  for (const key of Object.keys(data)) {
    if (!CRM_INBOUND_CHAT_DATA_KEYS.includes(key)) errors.push(`data.${key}: unknown`);
  }
  if (!(typeof data.crm_opportunity_id === 'string' && CRM_INBOUND_UUID_PATTERN.test(data.crm_opportunity_id))) errors.push('data.crm_opportunity_id');
  if (!(typeof data.crm_seller_id === 'string' && CRM_INBOUND_UUID_PATTERN.test(data.crm_seller_id))) errors.push('data.crm_seller_id');
  if (!(Number.isSafeInteger(data.ownership_version) && data.ownership_version >= 0)) errors.push('data.ownership_version');
  return errors;
};

// Order matters: availability, then size (before hashing anything), then the
// signature (before reading any field), then the envelope.
const verifyCrmInboundRequest = ({ rawBody, headers, env, now, crypto: cryptoModule }) => {
  const config = readCrmInboundConfig(env);
  if (!config.enabled || config.errors.length > 0) return crmInboundRespond(503, { error: 'receiver_unavailable' });

  if (!Buffer.isBuffer(rawBody)) return crmInboundRespond(401, { error: 'unauthorized' });
  if (rawBody.length > CRM_INBOUND_MAX_BODY_BYTES) return crmInboundRespond(413, { error: 'payload_too_large' });

  if (!crmInboundSignatureValid(rawBody, headers, env.CRM_INBOUND_HMAC_SECRET, now, cryptoModule)) {
    return crmInboundRespond(401, { error: 'unauthorized' });
  }

  let parsed;
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(rawBody);
    parsed = JSON.parse(text);
  } catch (_error) {
    return crmInboundInvalid(['body: not UTF-8 JSON']);
  }
  const errors = validateCrmInboundEnvelope(parsed);
  if (errors.length > 0) return crmInboundInvalid(errors);

  return {
    action: 'apply',
    event_id: parsed.event_id,
    event_type: parsed.type,
    body_sha256: cryptoModule.createHash('sha256').update(rawBody).digest('hex'),
    crm_opportunity_id: parsed.data.crm_opportunity_id.toLowerCase(),
    crm_seller_id: parsed.data.crm_seller_id.toLowerCase(),
    ownership_version: String(parsed.data.ownership_version),
  };
};

// One shape for the Respond node, whichever branch produced the item: a
// validation answer, the database result, or a database failure (the Postgres
// node continues on error), which answers 503 so the CRM retries the same bytes.
const shapeCrmInboundResponse = (json = {}) => {
  if (json.action === 'respond' && Number.isInteger(json.http_status) && crmInboundIsObject(json.response)) {
    return { http_status: json.http_status, response_body: json.response };
  }
  const status = Number(json.http_status);
  let response = json.response;
  if (typeof response === 'string') {
    try { response = JSON.parse(response); } catch (_error) { response = null; }
  }
  if (!json.error && Number.isInteger(status) && status >= 200 && status <= 599 && crmInboundIsObject(response)) {
    return { http_status: status, response_body: response };
  }
  return { http_status: 503, response_body: { error: 'receiver_unavailable' } };
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    readCrmInboundConfig,
    validateCrmInboundEnvelope,
    verifyCrmInboundRequest,
    shapeCrmInboundResponse,
  };
}
