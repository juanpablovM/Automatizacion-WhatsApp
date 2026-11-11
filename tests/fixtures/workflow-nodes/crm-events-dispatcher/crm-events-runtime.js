// =============================================================================
// CRM events runtime (bot -> CRM, contract v1 revisions 1.1 and 1.2).
// -----------------------------------------------------------------------------
// Pure helpers shared by the crm-events-dispatcher Code nodes: configuration,
// the lead.qualified and message.new body builders, HMAC signing, response
// classification and retry backoff. The CRM rejects unknown fields, so the
// builders emit exactly the contract keys, in contract order, and the stored
// body string is what every delivery attempt sends: it is never re-serialized.
// Revision 1.2 adds the structured lead record and message.new; 1.1 stays the
// default and its bodies are unchanged.
// =============================================================================

const CRM_SUPPORTED_PROTOCOL_REVISIONS = ['1.1', '1.2'];
const CRM_MAX_BODY_BYTES = 65536;
const CRM_NAME_FALLBACK = 'Cliente WhatsApp';
const CRM_REQUIREMENT_FALLBACK = 'Sin requerimiento informado';
const CRM_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
// Environment namespace for every id sent to the CRM. The CRM treats ids as
// global, so a reset database or a second environment must never reuse one.
const CRM_ID_PREFIX_PATTERN = /^[a-z0-9]{1,16}$/;
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
// Batch sizes: CRM_EVENTS_BATCH_SIZE (default 20) bounds the leads enqueued per
// pass, and under 1.1 also the events delivered. Under 1.2 every chat message
// is an event too, so delivery takes 100 per pass (CRM_EVENTS_DELIVER_BATCH_SIZE
// overrides it; CRM_EVENTS_BATCH_SIZE does not) and message enqueue takes 100
// (CRM_EVENTS_MESSAGE_BATCH_SIZE): at one pass per minute a burst of chat
// traffic drains instead of lagging behind. CRM_EVENTS_DELIVER_BUDGET_SECONDS
// (default 450, under the workflow's 600 s execution timeout) stops a pass from
// starting a request that could outlive it while the CRM is slow.
const readCrmEventsConfig = (env = {}) => {
  const enabled = String(env.CRM_EVENTS_ENABLED ?? '').trim() === 'true';
  const config = {
    enabled,
    errors: [],
    url: null,
    since: null,
    protocol_revision: null,
    id_prefix: null,
    enqueue_batch_size: crmPositiveInt(env.CRM_EVENTS_BATCH_SIZE, 20),
    deliver_batch_size: crmPositiveInt(env.CRM_EVENTS_DELIVER_BATCH_SIZE, crmPositiveInt(env.CRM_EVENTS_BATCH_SIZE, 20)),
    message_batch_size: crmPositiveInt(env.CRM_EVENTS_MESSAGE_BATCH_SIZE, 100),
    deliver_budget_seconds: crmPositiveInt(env.CRM_EVENTS_DELIVER_BUDGET_SECONDS, 450),
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

  const idPrefix = String(env.CRM_EVENTS_ID_PREFIX ?? '').trim();
  if (!crmConfigured(idPrefix)) config.errors.push('CRM_EVENTS_ID_PREFIX_missing');
  else if (!CRM_ID_PREFIX_PATTERN.test(idPrefix)) config.errors.push('CRM_EVENTS_ID_PREFIX_invalid');
  else config.id_prefix = idPrefix;

  const revision = crmConfigured(env.CRM_EVENTS_PROTOCOL_REVISION)
    ? String(env.CRM_EVENTS_PROTOCOL_REVISION).trim()
    : '1.1';
  if (!CRM_SUPPORTED_PROTOCOL_REVISIONS.includes(revision)) {
    config.errors.push(`CRM_EVENTS_PROTOCOL_REVISION_unsupported:${revision}`);
  } else {
    config.protocol_revision = revision;
    if (revision === '1.2') {
      config.deliver_batch_size = crmPositiveInt(env.CRM_EVENTS_DELIVER_BATCH_SIZE, 100);
    }
  }
  return config;
};

// NUL is never valid CRM text, so it is dropped before trimming.
const crmText = (value) => String(value ?? '').replace(/\u0000/g, '').trim();

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

const blockedCrmEvent = (reason) => ({ blocked_reason: reason, event_id: null, conversation_id: null, revision: null, body: null, record_hash: null });

// ---------------------------------------------------------------------------
// Revision 1.2 lead record. Every optional key is emitted only when the bot
// value maps cleanly to the CRM enum or format; anything else is omitted, never
// sent blank or null, because the CRM answers 400 to an invalid value.
// ---------------------------------------------------------------------------

// Free text: a nonblank string cut to `max`. Non-strings are not text.
const crmOptionalText = (value, max) => {
  if (typeof value !== 'string') return null;
  return crmTruncate(crmText(value), max) || null;
};

// Identifiers (RUT, purchase order) are never cut: a truncated one is wrong.
const crmOptionalIdentifier = (value, max) => {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const text = crmText(value);
  return text && text.length <= max ? text : null;
};

const crmFold = (value) => (typeof value === 'string'
  ? value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim().toLowerCase()
  : '');

const CRM_CUSTOMER_TYPES = {
  natural: 'natural', b2c: 'natural', particular: 'natural', persona: 'natural',
  company: 'company', b2b: 'company', contractor: 'company', empresa: 'company', constructora: 'company',
};
const CRM_URGENCIES = {
  urgente: 'urgente', urgent: 'urgente',
  alta: 'alta', high: 'alta',
  media: 'media', medium: 'media',
  baja: 'baja', low: 'baja',
};

const crmIsPickup = (row, qualification) => (qualification.service_scope === 'material' && qualification.fulfillment === 'pickup')
  || qualification.modality === 'pickup'
  || crmText(row.service) === 'retiro';

// The bot keeps two vocabularies: v3.1 service_scope/fulfillment and the
// legacy modality. Installation wins over delivery: the crew brings the goods.
const crmFulfillment = (row, qualification) => {
  if (crmIsPickup(row, qualification)) return 'pickup';
  if (['installation', 'both'].includes(qualification.service_scope) || qualification.modality === 'installation') return 'install';
  if (qualification.fulfillment === 'delivery' || qualification.modality === 'delivery') return 'delivery';
  return null;
};

const crmCalendarDate = (year, month, day) => {
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
};

// Only unambiguous real calendar dates: ISO YYYY-MM-DD, or the Chilean
// day-first DD/MM/YYYY (or DD-MM-YYYY) with a four-digit year.
const crmDesiredDate = (value) => {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  let match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (match) return crmCalendarDate(Number(match[1]), Number(match[2]), Number(match[3]));
  match = /^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/.exec(text);
  if (match) return crmCalendarDate(Number(match[3]), Number(match[2]), Number(match[1]));
  return null;
};

// Quantity: a positive number, or a string holding one number and at most one
// unit token ("20 m3"). "1.500" is ambiguous in Chile (thousands or decimal),
// so a separator followed by exactly three digits is not parsed.
const crmQuantity = (value) => {
  if (typeof value === 'number') return { quantity: Number.isFinite(value) && value > 0 ? value : null, unit: null };
  if (typeof value !== 'string') return { quantity: null, unit: null };
  const match = /^\s*(\d+(?:[.,]\d+)?)\s*([^\d\s][^\s]{0,19})?\s*$/.exec(value);
  if (!match || /[.,]\d{3}$/.test(match[1])) return { quantity: null, unit: null };
  const quantity = Number(match[1].replace(',', '.'));
  if (!Number.isFinite(quantity) || quantity <= 0) return { quantity: null, unit: null };
  return { quantity, unit: match[2] ? crmOptionalIdentifier(match[2], 20) : null };
};

const crmItems = (qualification) => {
  const source = Array.isArray(qualification.line_items) && qualification.line_items.length > 0
    ? qualification.line_items
    : [{ product: qualification.product, quantity: qualification.quantity, measurements: qualification.measurements }];
  const items = [];
  for (const raw of source) {
    if (items.length >= 50) break;
    const item = crmAsObject(raw);
    const product = crmOptionalText(item.product, 200);
    if (!product) continue;
    const parsed = crmQuantity(item.quantity);
    const explicitUnit = item.unit === undefined || item.unit === null ? null : crmOptionalIdentifier(item.unit, 20);
    items.push({
      product,
      variant: crmOptionalText(item.variant, 200),
      quantity: parsed.quantity,
      unit: item.unit === undefined || item.unit === null ? parsed.unit : explicitUnit,
      measurements: crmOptionalText(item.measurements, 200),
    });
  }
  return items;
};

const crmSite = (qualification) => {
  const site = {};
  const terrain = crmOptionalText(qualification.terrain, 100);
  if (terrain) site.terrain = terrain;
  if (typeof qualification.truck_access === 'boolean') site.truck_access = qualification.truck_access;
  if (typeof qualification.debris_removal === 'boolean') site.debris_removal = qualification.debris_removal;
  const restrictions = crmOptionalText(qualification.access_restrictions, 500);
  if (restrictions) site.access_restrictions = restrictions;
  return Object.keys(site).length > 0 ? site : null;
};

const crmAiSummary = (advisorOutput) => {
  const advisor = crmAsObject(advisorOutput);
  const diagnostic = crmAsObject(advisor.diagnostic_datos);
  const summary = {};
  const put = (key, value) => {
    const text = crmOptionalText(value, 4000);
    if (text) summary[key] = text;
  };
  if (advisor.lead_class !== 'none') put('lead_class', advisor.lead_class);
  put('next_best_action', advisor.next_best_action);
  put('executive_summary', advisor.executive_summary);
  put('pain', diagnostic.pain);
  put('scope', diagnostic.scope);
  put('timing', diagnostic.timing);
  put('obstacle', diagnostic.obstacle);
  return Object.keys(summary).length > 0 ? summary : null;
};

// The 1.2 keys after `requirement`, in contract order. ai_summary is added by
// the caller because it stays out of the record hash.
const crmLeadRecord12 = (row, qualification) => {
  const record = {};
  const put = (key, value) => {
    if (value !== null && value !== undefined) record[key] = value;
  };
  const isPickup = crmIsPickup(row, qualification);
  put('customer_type', CRM_CUSTOMER_TYPES[crmFold(qualification.customer_type)] || null);
  put('company', crmOptionalText(qualification.company, 200));
  put('tax_document', qualification.invoice_required === true ? 'factura' : qualification.invoice_required === false ? 'boleta' : null);
  put('purchase_order', crmOptionalIdentifier(qualification.purchase_order, 100));
  put('service', crmOptionalText(row.service, 100));
  put('fulfillment', crmFulfillment(row, qualification));
  // A factory pickup has no delivery place: no city and no commune.
  put('city', isPickup ? null : crmOptionalText(row.city, 100));
  put('commune', isPickup ? null : crmOptionalText(qualification.commune, 100));
  put('address', crmOptionalText(qualification.address, 300));
  put('use_case', crmOptionalText(qualification.use_case, 200));
  put('urgency', CRM_URGENCIES[crmFold(qualification.urgency)] || null);
  put('desired_date', crmDesiredDate(qualification.desired_date));
  put('source_number', normalizeCrmPhone(row.source_number_phone));
  put('site', crmSite(qualification));
  const items = crmItems(qualification);
  put('items', items.length > 0 ? items : null);
  return record;
};

// Stable hash of the business fields: everything in data except lead_id,
// revision and ai_summary. The builder emits keys in a fixed order, so the
// serialization is canonical. A different hash is a customer correction.
const crmRecordHash = (data) => {
  const { lead_id: _leadId, revision: _revision, ai_summary: _aiSummary, ...business } = data;
  return require('crypto').createHash('sha256').update(JSON.stringify(business), 'utf8').digest('hex');
};

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

  // Defensive: the config gate normally rejects a missing or invalid prefix.
  const idPrefix = config.id_prefix;
  if (typeof idPrefix !== 'string' || !CRM_ID_PREFIX_PATTERN.test(idPrefix)) return blockedCrmEvent('id_prefix_missing');
  const leadId = `wa-${idPrefix}-lead-${leadNumber}`;
  const eventId = `${leadId}-r${revision}`;
  const conversationId = `wa-${idPrefix}-conversation-${conversationNumber}`;
  if (![leadId, eventId, conversationId].every(isValidCrmId)) return blockedCrmEvent('invalid_id');

  const qualification = crmAsObject(row.qualification_context);
  const name = crmTruncate(crmText(row.whatsapp_name), 200) || CRM_NAME_FALLBACK;
  const companyRut = crmText(qualification.company_rut);
  const rut = companyRut && companyRut.length <= 32 ? companyRut : null;
  const title = crmLeadTitle(name, row, qualification);
  let requirement = crmTruncate(crmText(row.requirement), 16000) || CRM_REQUIREMENT_FALLBACK;
  const isRevision12 = config.protocol_revision === '1.2';
  const record12 = isRevision12 ? crmLeadRecord12(row, qualification) : {};
  const aiSummary = isRevision12 ? crmAiSummary(row.advisor_output_payload) : null;

  const dataWith = (summary) => ({
    lead_id: leadId,
    revision,
    phone,
    name,
    ...(rut ? { rut } : {}),
    crm_seller_id: sellerId.toLowerCase(),
    title,
    requirement,
    ...record12,
    ...(summary ? { ai_summary: summary } : {}),
  });
  const serialize = (summary) => JSON.stringify({
    schema_version: 1,
    protocol_revision: config.protocol_revision || '1.1',
    event_id: eventId,
    type: 'lead.qualified',
    conversation_id: conversationId,
    data: dataWith(summary),
  });
  const fits = (text) => Buffer.byteLength(text, 'utf8') <= CRM_MAX_BODY_BYTES;

  // JSON escaping can inflate a long requirement past the transport limit.
  // Shorten only the requirement, proportionally, until the bytes fit. The AI
  // summary is left out of this sizing so it can never change the business
  // fields (and their hash); it is added afterwards only if it still fits.
  let body = serialize(null);
  for (let guard = 0; !fits(body) && guard < 50; guard += 1) {
    const ratio = CRM_MAX_BODY_BYTES / Buffer.byteLength(body, 'utf8');
    requirement = crmTruncate(requirement, Math.max(1, Math.floor(requirement.length * ratio * 0.95))) || CRM_REQUIREMENT_FALLBACK;
    body = serialize(null);
  }
  if (!fits(body)) return blockedCrmEvent('payload_too_large');
  if (aiSummary) {
    const withSummary = serialize(aiSummary);
    if (fits(withSummary)) body = withSummary;
  }

  return {
    blocked_reason: null,
    event_id: eventId,
    conversation_id: conversationId,
    revision,
    body,
    record_hash: isRevision12 ? crmRecordHash(dataWith(null)) : null,
  };
};

// ---------------------------------------------------------------------------
// message.new (revision 1.2 only; the CRM rejects it under 1.1).
// ---------------------------------------------------------------------------
const CRM_SENT_AT_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;
const CRM_MEDIA_PLACEHOLDERS = { image: '[image]', audio: '[audio]', video: '[video]', location: '[location]' };
const CRM_OUTGOING_SENDERS = { bot: 'bot', system: 'system', human: 'seller' };

// The CRM shows text only. A media message becomes a placeholder naming its
// type (and a document its file name), followed by the caption when there is
// one, so the seller sees that something arrived. Capped at 16,000 chars.
const crmMessageText = (row) => {
  const type = crmText(row.message_type);
  const body = crmText(row.text_body);
  let text;
  if (type === 'document') {
    const fileName = crmTruncate(crmText(row.file_name), 255);
    const placeholder = fileName ? `[document] ${fileName}` : '[document]';
    text = body ? `${placeholder}\n${body}` : placeholder;
  } else if (CRM_MEDIA_PLACEHOLDERS[type]) {
    text = body ? `${CRM_MEDIA_PLACEHOLDERS[type]}\n${body}` : CRM_MEDIA_PLACEHOLDERS[type];
  } else if (type === 'text' || type === 'interactive') {
    text = body || '[empty message]';
  } else {
    text = body || '[unsupported message]';
  }
  return crmTruncate(text, 16000);
};

const crmSentAt = (value) => {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString();
  const text = crmText(value);
  if (CRM_SENT_AT_PATTERN.test(text) && !Number.isNaN(Date.parse(text))) return text;
  // An explicit offset is unambiguous and converts to UTC; a bare local time
  // ("2026-11-11 14:03:22") is not and blocks the message.
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?([+-]\d{2}:\d{2})$/.test(text)) {
    const parsed = new Date(text);
    return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
  }
  return null;
};

const blockedCrmMessage = (reason, messageNumber) => ({
  blocked_reason: reason, message_id: messageNumber, event_id: null, conversation_id: null, body: null,
});

// Builds the exact message.new body for one stored message. Senders:
// incoming -> customer; outgoing bot -> bot, system -> system, human -> seller
// with the conversation seller's crm_user_id. A human message without a mapped
// seller is blocked, never relabeled as bot.
const buildMessageNewEvent = (row, config = {}) => {
  const messageNumber = Number(row.message_id);
  if (!Number.isSafeInteger(messageNumber) || messageNumber <= 0) return blockedCrmMessage('invalid_message_id', null);
  if (config.protocol_revision !== '1.2') return blockedCrmMessage('protocol_revision_unsupported', messageNumber);
  const conversationNumber = Number(row.conversation_id);
  if (row.conversation_id === null || row.conversation_id === undefined || !Number.isSafeInteger(conversationNumber) || conversationNumber <= 0) {
    return blockedCrmMessage('conversation_missing', messageNumber);
  }
  const idPrefix = config.id_prefix;
  if (typeof idPrefix !== 'string' || !CRM_ID_PREFIX_PATTERN.test(idPrefix)) return blockedCrmMessage('id_prefix_missing', messageNumber);

  const direction = crmText(row.direction);
  const senderType = crmText(row.sender_type);
  let sender;
  let sellerId = null;
  if (direction === 'incoming') {
    sender = 'customer';
  } else if (direction === 'outgoing') {
    if (senderType === 'customer') return blockedCrmMessage('sender_direction_mismatch', messageNumber);
    sender = CRM_OUTGOING_SENDERS[senderType];
    if (!sender) return blockedCrmMessage('unknown_sender_type', messageNumber);
    if (sender === 'seller') {
      sellerId = crmText(row.crm_user_id).toLowerCase();
      if (!sellerId) return blockedCrmMessage('seller_not_mapped', messageNumber);
      if (!CRM_UUID_PATTERN.test(sellerId)) return blockedCrmMessage('invalid_seller_uuid', messageNumber);
    }
  } else {
    return blockedCrmMessage('invalid_direction', messageNumber);
  }

  const sentAt = crmSentAt(row.sent_at);
  if (!sentAt) return blockedCrmMessage('invalid_sent_at', messageNumber);

  const messageId = `wa-${idPrefix}-message-${messageNumber}`;
  const eventId = `${messageId}-e1`;
  const conversationId = `wa-${idPrefix}-conversation-${conversationNumber}`;
  if (![messageId, eventId, conversationId].every(isValidCrmId)) return blockedCrmMessage('invalid_id', messageNumber);

  let text = crmMessageText(row);
  const serialize = () => JSON.stringify({
    schema_version: 1,
    protocol_revision: '1.2',
    event_id: eventId,
    type: 'message.new',
    conversation_id: conversationId,
    data: {
      message_id: messageId,
      direction: sender === 'customer' ? 'inbound' : 'outbound',
      text,
      sent_at: sentAt,
      sender,
      ...(sellerId ? { crm_seller_id: sellerId } : {}),
    },
  });
  let body = serialize();
  for (let guard = 0; Buffer.byteLength(body, 'utf8') > CRM_MAX_BODY_BYTES && guard < 50; guard += 1) {
    const ratio = CRM_MAX_BODY_BYTES / Buffer.byteLength(body, 'utf8');
    text = crmTruncate(text, Math.max(1, Math.floor(text.length * ratio * 0.95))) || '[empty message]';
    body = serialize();
  }
  if (Buffer.byteLength(body, 'utf8') > CRM_MAX_BODY_BYTES) return blockedCrmMessage('payload_too_large', messageNumber);

  return { blocked_reason: null, message_id: messageNumber, event_id: eventId, conversation_id: conversationId, body };
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
// The 200 result differs per event type: lead.qualified returns the CRM ids
// (plus `status` from 1.2 on), message.new returns crm_message_id and status.
// A 200 that does not match its type is parked: something is off and a human
// has to look before it is considered delivered.
const CRM_LEAD_RESULT_STATUSES = ['created', 'updated', 'ignored_stale', 'duplicate'];
const CRM_MESSAGE_RESULT_STATUSES = ['created', 'duplicate'];

const classifyCrmResponse = (response, eventId, eventType = 'lead.qualified') => {
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
    if (eventType === 'message.new') {
      const validMessage = parsed
        && parsed.event_id === eventId
        && typeof parsed.crm_message_id === 'string' && parsed.crm_message_id.trim() !== ''
        && CRM_MESSAGE_RESULT_STATUSES.includes(parsed.status);
      if (!validMessage) return { ...base, outcome: 'parked', error: 'invalid_success_response' };
      return { ...base, outcome: 'delivered', error: null };
    }
    const valid = parsed
      && parsed.event_id === eventId
      && CRM_UUID_PATTERN.test(String(parsed.crm_customer_id ?? ''))
      && CRM_UUID_PATTERN.test(String(parsed.crm_opportunity_id ?? ''))
      && (parsed.status === undefined || CRM_LEAD_RESULT_STATUSES.includes(parsed.status));
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
    buildMessageNewEvent,
    crmMessageText,
    normalizeCrmPhone,
    isValidCrmId,
    signCrmRequest,
    classifyCrmResponse,
    retryDelaySeconds,
    isClaimedCrmEvent,
  };
}
