// =============================================================================
// CRM events runtime (bot -> CRM, contract v1 revision 1.1).
// -----------------------------------------------------------------------------
// Pure helpers shared by the crm-events-dispatcher Code nodes: configuration,
// the lead.qualified body builder, HMAC signing, response classification and
// retry backoff. The CRM rejects unknown fields, so the builder emits exactly
// the contract keys, in contract order, and the stored body string is what
// every delivery attempt sends: it is never re-serialized.
// =============================================================================

const CRM_SUPPORTED_PROTOCOL_REVISIONS = ['1.1'];
const CRM_MAX_BODY_BYTES = 65536;
const CRM_NAME_FALLBACK = 'Cliente WhatsApp';
const CRM_REQUIREMENT_FALLBACK = 'Sin requerimiento informado';
const CRM_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const CRM_UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CRM_MAX_STORED_RESPONSE_CHARS = 8192;

const crmConfigured = (value) => {
  const text = String(value ?? '').trim();
  return text !== '' && !text.includes('__PENDIENTE__');
};

const crmPositiveInt = (value, fallback) => {
  const parsed = Number(String(value ?? '').trim());
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
};

// Reads the sender configuration from the n8n environment. The secret is
// validated here but never returned, so a configuration item can be passed
// between nodes and logged without exposing it.
const readCrmEventsConfig = (env = {}) => {
  const enabled = String(env.CRM_EVENTS_ENABLED ?? '').trim() === 'true';
  const config = {
    enabled,
    errors: [],
    url: null,
    since: null,
    protocol_revision: null,
    enqueue_batch_size: crmPositiveInt(env.CRM_EVENTS_BATCH_SIZE, 20),
    deliver_batch_size: crmPositiveInt(env.CRM_EVENTS_BATCH_SIZE, 20),
    stale_seconds: crmPositiveInt(env.CRM_EVENTS_STALE_SECONDS, 900),
    retry_base_seconds: crmPositiveInt(env.CRM_EVENTS_RETRY_BASE_SECONDS, 30),
    retry_max_seconds: crmPositiveInt(env.CRM_EVENTS_RETRY_MAX_SECONDS, 3600),
    max_attempts: crmPositiveInt(env.CRM_EVENTS_MAX_ATTEMPTS, 20),
    timeout_ms: crmPositiveInt(env.CRM_EVENTS_TIMEOUT_MS, 15000),
  };
  if (!enabled) return config;

  const url = String(env.CRM_EVENTS_URL ?? '').trim();
  if (!crmConfigured(url)) config.errors.push('CRM_EVENTS_URL_missing');
  else if (!/^https?:\/\/[^\s/?#]+[^\s]*$/i.test(url)) config.errors.push('CRM_EVENTS_URL_invalid');
  else config.url = url;

  if (!crmConfigured(env.CRM_EVENTS_HMAC_SECRET)) config.errors.push('CRM_EVENTS_HMAC_SECRET_missing');

  // Never backfill the whole lead history: only leads created at or after this
  // instant are sent, so the variable is required.
  const since = String(env.CRM_EVENTS_SINCE ?? '').trim();
  if (!crmConfigured(since)) {
    config.errors.push('CRM_EVENTS_SINCE_missing');
  } else {
    const parsed = /^\d{4}-\d{2}-\d{2}/.test(since) ? new Date(since) : new Date(NaN);
    if (Number.isNaN(parsed.getTime())) config.errors.push('CRM_EVENTS_SINCE_invalid');
    else config.since = parsed.toISOString();
  }

  const revision = crmConfigured(env.CRM_EVENTS_PROTOCOL_REVISION)
    ? String(env.CRM_EVENTS_PROTOCOL_REVISION).trim()
    : '1.1';
  if (!CRM_SUPPORTED_PROTOCOL_REVISIONS.includes(revision)) {
    config.errors.push(`CRM_EVENTS_PROTOCOL_REVISION_unsupported:${revision}`);
  } else {
    config.protocol_revision = revision;
  }
  return config;
};

const crmText = (value) => String(value ?? '').trim();

// Cuts to at most `max` UTF-16 units without leaving half a surrogate pair, so
// the limit holds whether the CRM counts code units or code points.
const crmTruncate = (value, max) => {
  if (value.length <= max) return value;
  let out = value.slice(0, max);
  const last = out.charCodeAt(out.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) out = out.slice(0, -1);
  return out.trimEnd();
};

const crmAsObject = (value) => {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  try {
    const parsed = JSON.parse(String(value || '{}'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch (_error) {
    return {};
  }
};

// The bot stores leads.phone_number as digits without "+". The CRM wants "+"
// followed by 8-15 digits, the first nonzero.
const normalizeCrmPhone = (value) => {
  const digits = String(value ?? '').replace(/\D/g, '');
  return /^[1-9]\d{7,14}$/.test(digits) ? `+${digits}` : null;
};

const isValidCrmId = (value) => typeof value === 'string' && CRM_ID_PATTERN.test(value);

// Same naming idea as the ClickUp task, reimplemented here: a factory pickup
// with no city says so instead of "Sin Ciudad".
const crmLeadTitle = (name, row, qualification) => {
  const service = crmText(row.service) || 'Sin Servicio';
  const city = crmText(row.city);
  const isPickup = (qualification.service_scope === 'material' && qualification.fulfillment === 'pickup')
    || qualification.modality === 'pickup'
    || crmText(row.service) === 'retiro';
  const title = isPickup && !city
    ? `${name} - retiro en fábrica`
    : `${name} - ${service} - ${city || 'Sin Ciudad'}`;
  return crmTruncate(title, 200);
};

const blockedCrmEvent = (reason) => ({ blocked_reason: reason, event_id: null, conversation_id: null, revision: null, body: null });

// Builds the exact lead.qualified body string for one candidate row. Returns
// blocked_reason instead of a body when the CRM would reject the event.
const buildLeadQualifiedEvent = (row, config = {}) => {
  const leadNumber = Number(row.lead_id);
  const revision = Number(row.revision);
  const conversationNumber = Number(row.conversation_id);
  if (!Number.isSafeInteger(leadNumber) || leadNumber <= 0) return blockedCrmEvent('invalid_lead_id');
  if (!Number.isSafeInteger(revision) || revision < 1) return blockedCrmEvent('invalid_revision');
  if (row.conversation_id === null || row.conversation_id === undefined || !Number.isSafeInteger(conversationNumber) || conversationNumber <= 0) {
    return blockedCrmEvent('conversation_missing');
  }
  const sellerId = crmText(row.crm_user_id);
  if (!sellerId) return blockedCrmEvent('seller_not_mapped');
  if (!CRM_UUID_PATTERN.test(sellerId)) return blockedCrmEvent('invalid_seller_uuid');
  const phone = normalizeCrmPhone(row.phone_number);
  if (!phone) return blockedCrmEvent('invalid_phone');

  const leadId = `wa-lead-${leadNumber}`;
  const eventId = `${leadId}-r${revision}`;
  const conversationId = `wa-conversation-${conversationNumber}`;
  if (![leadId, eventId, conversationId].every(isValidCrmId)) return blockedCrmEvent('invalid_id');

  const qualification = crmAsObject(row.qualification_context);
  const name = crmTruncate(crmText(row.whatsapp_name), 200) || CRM_NAME_FALLBACK;
  const companyRut = crmText(qualification.company_rut);
  const rut = companyRut && companyRut.length <= 32 ? companyRut : null;
  const title = crmLeadTitle(name, row, qualification);
  let requirement = crmTruncate(crmText(row.requirement), 16000) || CRM_REQUIREMENT_FALLBACK;

  const serialize = () => JSON.stringify({
    schema_version: 1,
    protocol_revision: config.protocol_revision || '1.1',
    event_id: eventId,
    type: 'lead.qualified',
    conversation_id: conversationId,
    data: {
      lead_id: leadId,
      revision,
      phone,
      name,
      ...(rut ? { rut } : {}),
      crm_seller_id: sellerId.toLowerCase(),
      title,
      requirement,
    },
  });

  // JSON escaping can inflate a long requirement past the transport limit.
  // Shorten only the requirement, proportionally, until the bytes fit.
  let body = serialize();
  for (let guard = 0; Buffer.byteLength(body, 'utf8') > CRM_MAX_BODY_BYTES && guard < 50; guard += 1) {
    const ratio = CRM_MAX_BODY_BYTES / Buffer.byteLength(body, 'utf8');
    requirement = crmTruncate(requirement, Math.max(1, Math.floor(requirement.length * ratio * 0.95))) || CRM_REQUIREMENT_FALLBACK;
    body = serialize();
  }
  if (Buffer.byteLength(body, 'utf8') > CRM_MAX_BODY_BYTES) return blockedCrmEvent('payload_too_large');

  return { blocked_reason: null, event_id: eventId, conversation_id: conversationId, revision, body };
};

// X-WhatsApp-Signature = "v1=" + hex HMAC-SHA256(secret, timestamp + "." + body).
const signCrmRequest = (body, secret, timestamp, cryptoModule) => {
  const ts = String(timestamp);
  if (!/^\d{10}$/.test(ts)) throw new Error('CRM signature requires a 10-digit unix-seconds timestamp');
  const digest = cryptoModule
    .createHmac('sha256', String(secret))
    .update(Buffer.concat([Buffer.from(`${ts}.`, 'ascii'), Buffer.from(String(body), 'utf8')]))
    .digest('hex');
  return { 'X-WhatsApp-Timestamp': ts, 'X-WhatsApp-Signature': `v1=${digest}` };
};

const crmParseBody = (body) => {
  if (body && typeof body === 'object' && !Buffer.isBuffer(body)) return body;
  const text = Buffer.isBuffer(body) ? body.toString('utf8') : String(body ?? '');
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch (_error) {
    return null;
  }
};

const crmStoredResponse = (parsed, code) => {
  if (!parsed) return null;
  const json = JSON.stringify(parsed);
  if (json.length <= CRM_MAX_STORED_RESPONSE_CHARS) return json;
  return JSON.stringify({ error: code || null, truncated: true });
};

const CRM_RETRYABLE_STATUS = (status) => status === 408 || status === 429 || (status >= 500 && status <= 599);

// Maps one delivery attempt to delivered | retry | parked. 503 and transport
// failures retry (a duplicate event returns the stored 200, so re-sending is
// safe); every rejection the CRM states explicitly is parked for a human.
const classifyCrmResponse = (response, eventId) => {
  if (response?.error) {
    const message = crmTruncate(crmText(response.error.message || response.error) || 'unknown', 300);
    return { outcome: 'retry', http_status: null, error: `network_error:${message}`, response_json: null, crm_customer_id: null, crm_opportunity_id: null };
  }
  const status = Number(response?.statusCode || 0);
  const parsed = crmParseBody(response?.body);
  const code = parsed && typeof parsed.error === 'string' ? parsed.error
    : parsed && typeof parsed.code === 'string' ? parsed.code : null;
  const base = { http_status: status || null, response_json: crmStoredResponse(parsed, code), crm_customer_id: null, crm_opportunity_id: null };

  if (status === 200) {
    const valid = parsed
      && parsed.event_id === eventId
      && CRM_UUID_PATTERN.test(String(parsed.crm_customer_id ?? ''))
      && CRM_UUID_PATTERN.test(String(parsed.crm_opportunity_id ?? ''));
    if (!valid) return { ...base, outcome: 'parked', error: 'invalid_success_response' };
    return {
      ...base,
      outcome: 'delivered',
      error: null,
      crm_customer_id: parsed.crm_customer_id,
      crm_opportunity_id: parsed.crm_opportunity_id,
    };
  }
  const error = `http_${status}${code ? `:${crmTruncate(code, 100)}` : ''}`;
  if (CRM_RETRYABLE_STATUS(status)) return { ...base, outcome: 'retry', error };
  return { ...base, outcome: 'parked', error };
};

// min(cap, base * 2^(attempt-1)) seconds plus up to 20% jitter.
const retryDelaySeconds = (attempt, settings = {}, random = Math.random) => {
  const base = crmPositiveInt(settings.base_seconds, 30);
  const cap = crmPositiveInt(settings.cap_seconds, 3600);
  const exponent = Math.max(0, Math.min(Number(attempt) || 1, 64) - 1);
  const delay = Math.min(cap, base * 2 ** exponent);
  const jitter = Math.floor(delay * 0.2 * Math.min(Math.max(random(), 0), 0.999999));
  return delay + jitter;
};

// n8n's Postgres node answers an empty claim with one { success: true } item;
// only a row the claim took carries its id, token and body.
const isClaimedCrmEvent = (row) => {
  const id = Number(row?.crm_event_id);
  return Number.isSafeInteger(id) && id > 0
    && crmText(row?.claim_token) !== ''
    && typeof row?.body === 'string' && row.body !== ''
    && crmText(row?.event_id) !== '';
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    readCrmEventsConfig,
    buildLeadQualifiedEvent,
    normalizeCrmPhone,
    isValidCrmId,
    signCrmRequest,
    classifyCrmResponse,
    retryDelaySeconds,
    isClaimedCrmEvent,
  };
}
