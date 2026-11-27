// =============================================================================
// CRM inbound runtime (CRM -> bot, contract v1 revision 1.2, "1.2b",
// message.send and the 1.2d contingency handoffs).
// -----------------------------------------------------------------------------
// Pure helpers shared by the crm-inbound-events Code nodes: configuration,
// signature verification over the raw request bytes, envelope validation,
// the Evolution request of a CRM message.send and response shaping. Nothing
// here touches the database; the idempotency inbox and the ownership change
// live in crm_inbound_apply_chat_event() (migration 040), the message.send
// intent in crm_inbound_claim_message_send() / crm_inbound_complete_message_send()
// (migration 041). The secret and the raw body are never returned, so any
// output item can be logged by n8n without exposing either.
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
// Chat ownership is implemented since 1.2b. message.send is built behind
// CRM_INBOUND_MESSAGE_SEND_ENABLED: while it is off it answers invalid_event,
// like opportunity.*. handoff.acknowledged / handoff.resolved and the
// conversation_id identity (1.2d) are behind CRM_INBOUND_HANDOFFS_ENABLED.
const CRM_INBOUND_CHAT_TYPES = ['chat.take', 'chat.release'];
const CRM_INBOUND_CHAT_DATA_KEYS = ['crm_opportunity_id', 'crm_seller_id', 'ownership_version'];
const CRM_INBOUND_MESSAGE_SEND_TYPE = 'message.send';
const CRM_INBOUND_MESSAGE_SEND_DATA_KEYS = [
  'crm_opportunity_id', 'crm_seller_id', 'client_message_id', 'ownership_version', 'text',
];
// WhatsApp's text limit, in characters (code points) of the trimmed text.
const CRM_INBOUND_MESSAGE_MAX_CHARS = 4096;
// Same namespace rule as the outbound dispatcher (CRM_EVENTS_ID_PREFIX): the
// message_id answered to message.send must be the one message.new carries.
const CRM_INBOUND_ID_PREFIX_PATTERN = /^[a-z0-9]{1,16}$/;
// 1.2d (contingency handoffs), behind CRM_INBOUND_HANDOFFS_ENABLED:
//   * chat.take / chat.release / message.send carry exactly one of
//     crm_opportunity_id or conversation_id ("wa-<prefix>-conversation-<id>",
//     the envelope conversation_id the dispatcher sends);
//   * handoff.acknowledged / handoff.resolved close a handoff the bot sent
//     ("wa-<prefix>-handoff-<id>").
// Feature document: odd/tasks/crm-1-2d-contingency-handoffs.md (S5-S7).
const CRM_INBOUND_IDENTITY_KEYS = ['crm_opportunity_id', 'conversation_id'];
const CRM_INBOUND_HANDOFF_TYPES = ['handoff.acknowledged', 'handoff.resolved'];
const CRM_INBOUND_HANDOFF_DATA_KEYS = ['handoff_id', 'crm_seller_id'];
// At most 18 digits, so the id always fits a PostgreSQL bigint.
const CRM_INBOUND_CONVERSATION_ID_PATTERN = /^wa-([a-z0-9]{1,16})-conversation-([1-9][0-9]{0,17})$/;
const CRM_INBOUND_HANDOFF_ID_PATTERN = /^wa-([a-z0-9]{1,16})-handoff-([1-9][0-9]{0,17})$/;
// 1.3 (customer threads, .orca/drops/whatsapp-events-1.3-crm-response.md
// §4.1-§4.4), on when the bot speaks 1.3 (CRM_EVENTS_PROTOCOL_REVISION=1.3)
// and the 1.2d identities are on (CRM_INBOUND_HANDOFFS_ENABLED=true). Only a
// request with protocol_revision "1.3" takes these rules; 1.2 requests keep
// theirs:
//   * chat.take / chat.release / message.send carry exactly one of
//     crm_opportunity_id, conversation_id or contact_id
//     ("wa-<prefix>-contact-<id>"); every key acts on the customer;
//   * contact.opportunity_linked {contact_id, crm_opportunity_id,
//     crm_seller_id} keeps a CRM-created opportunity on the customer.
// Feature document: odd/tasks/crm-1-3-customer-threads.md (S6-S8).
const CRM_INBOUND_IDENTITY_KEYS_13 = ['crm_opportunity_id', 'conversation_id', 'contact_id'];
const CRM_INBOUND_CONTACT_LINK_TYPE = 'contact.opportunity_linked';
const CRM_INBOUND_CONTACT_LINK_DATA_KEYS = ['contact_id', 'crm_opportunity_id', 'crm_seller_id'];
const CRM_INBOUND_CONTACT_ID_PATTERN = /^wa-([a-z0-9]{1,16})-contact-([1-9][0-9]{0,17})$/;

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

// message.send has its own switch, off by default, so chat.take / chat.release
// can stay on while it is not. It answers with the message_id the dispatcher
// uses in message.new ("wa-<CRM_EVENTS_ID_PREFIX>-message-<id>"), so an enabled
// switch without a valid prefix is a misconfiguration: message.send answers 503
// (the CRM retries) and the chat events keep working.
const readCrmMessageSendConfig = (env = {}) => {
  const enabled = String(env.CRM_INBOUND_MESSAGE_SEND_ENABLED ?? '').trim() === 'true';
  const config = { enabled, id_prefix: null, errors: [] };
  if (!enabled) return config;
  const idPrefix = String(env.CRM_EVENTS_ID_PREFIX ?? '').trim();
  if (!crmInboundConfigured(idPrefix)) config.errors.push('CRM_EVENTS_ID_PREFIX_missing');
  else if (!CRM_INBOUND_ID_PREFIX_PATTERN.test(idPrefix)) config.errors.push('CRM_EVENTS_ID_PREFIX_invalid');
  else config.id_prefix = idPrefix;
  return config;
};

// 1.2d has its own switch, off by default. While it is off the new types and
// the conversation_id identity answer exactly what they answered before
// (400 invalid_event). On, it needs the CRM_EVENTS_ID_PREFIX the dispatcher
// builds conversation and handoff ids with; without a valid one the 1.2d
// paths answer 503 (the CRM retries) and everything else keeps working.
const readCrmHandoffsConfig = (env = {}) => {
  const enabled = String(env.CRM_INBOUND_HANDOFFS_ENABLED ?? '').trim() === 'true';
  const config = { enabled, id_prefix: null, errors: [] };
  if (!enabled) return config;
  const idPrefix = String(env.CRM_EVENTS_ID_PREFIX ?? '').trim();
  if (!crmInboundConfigured(idPrefix)) config.errors.push('CRM_EVENTS_ID_PREFIX_missing');
  else if (!CRM_INBOUND_ID_PREFIX_PATTERN.test(idPrefix)) config.errors.push('CRM_EVENTS_ID_PREFIX_invalid');
  else config.id_prefix = idPrefix;
  return config;
};

// 1.3 has no switch of its own: it is on when the bot sends 1.3
// (CRM_EVENTS_PROTOCOL_REVISION) and the 1.2d identities are on. It reuses
// their CRM_EVENTS_ID_PREFIX: without a valid one the 1.3 paths answer 503.
const readCrmContactsConfig = (env = {}) => {
  const handoffs = readCrmHandoffsConfig(env);
  const enabled = handoffs.enabled && String(env.CRM_EVENTS_PROTOCOL_REVISION ?? '').trim() === '1.3';
  if (!enabled) return { enabled: false, id_prefix: null, errors: [] };
  return { enabled: true, id_prefix: handoffs.id_prefix, errors: handoffs.errors };
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

// The text a message.send delivers: trimmed, non-empty, at most 4,096
// characters, no NUL (PostgreSQL text cannot store it). Returns null if invalid.
const crmInboundMessageText = (value) => {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (text === '' || text.includes('\u0000')) return null;
  return [...text].length <= CRM_INBOUND_MESSAGE_MAX_CHARS ? text : null;
};

// The numeric id of one of our external ids ("wa-<prefix>-<kind>-<id>"), or ''
// when it carries another prefix (well formed, but not ours).
const crmInboundOwnId = (value, pattern, idPrefix) => {
  const match = pattern.exec(value);
  return match && match[1] === idPrefix ? match[2] : '';
};

// Returns the list of violations of the envelope and of the data of its type
// (chat.take / chat.release, message.send when enabled, and the 1.2d identity
// and closure types when enabled). Field names only: values are never echoed
// back.
const validateCrmInboundEnvelope = (parsed, { messageSend = false, handoffs = false, contacts = false } = {}) => {
  if (!crmInboundIsObject(parsed)) return ['envelope'];
  if (contacts && parsed.protocol_revision === '1.3') return validateCrmInboundEnvelope13(parsed, { messageSend });
  const errors = [];
  for (const key of Object.keys(parsed)) {
    if (!CRM_INBOUND_ENVELOPE_KEYS.includes(key)) errors.push(`envelope.${key}: unknown`);
  }
  for (const key of CRM_INBOUND_ENVELOPE_KEYS) if (!(key in parsed)) errors.push(`envelope.${key}: missing`);
  if (parsed.schema_version !== 1) errors.push('envelope.schema_version');
  if (parsed.protocol_revision !== '1.2') errors.push('envelope.protocol_revision');
  if (!(typeof parsed.event_id === 'string' && CRM_INBOUND_ID_PATTERN.test(parsed.event_id))) errors.push('envelope.event_id');
  if (!crmInboundRealInstant(parsed.occurred_at)) errors.push('envelope.occurred_at');
  const isMessageSend = messageSend && parsed.type === CRM_INBOUND_MESSAGE_SEND_TYPE;
  const isHandoff = handoffs && CRM_INBOUND_HANDOFF_TYPES.includes(parsed.type);
  if (!CRM_INBOUND_CHAT_TYPES.includes(parsed.type) && !isMessageSend && !isHandoff) errors.push('envelope.type: unsupported');
  if (!crmInboundIsObject(parsed.data)) return [...errors, 'envelope.data'];
  const data = parsed.data;
  if (isHandoff) {
    for (const key of Object.keys(data)) {
      if (!CRM_INBOUND_HANDOFF_DATA_KEYS.includes(key)) errors.push(`data.${key}: unknown`);
    }
    if (!(typeof data.handoff_id === 'string' && CRM_INBOUND_ID_PATTERN.test(data.handoff_id))) errors.push('data.handoff_id');
    if (!(typeof data.crm_seller_id === 'string' && CRM_INBOUND_UUID_PATTERN.test(data.crm_seller_id))) errors.push('data.crm_seller_id');
    return errors;
  }
  if (handoffs) {
    // 1.2d: exactly one identity; the shared checks below read only the one present.
    const identities = CRM_INBOUND_IDENTITY_KEYS.filter((key) => key in data);
    const dataKeys = [...(isMessageSend ? CRM_INBOUND_MESSAGE_SEND_DATA_KEYS : CRM_INBOUND_CHAT_DATA_KEYS), 'conversation_id'];
    for (const key of Object.keys(data)) {
      if (!dataKeys.includes(key)) errors.push(`data.${key}: unknown`);
    }
    if (identities.length !== 1) {
      errors.push('data: exactly one of crm_opportunity_id or conversation_id');
    } else if (identities[0] === 'conversation_id') {
      if (!(typeof data.conversation_id === 'string' && CRM_INBOUND_CONVERSATION_ID_PATTERN.test(data.conversation_id))) {
        errors.push('data.conversation_id');
      }
    } else if (!(typeof data.crm_opportunity_id === 'string' && CRM_INBOUND_UUID_PATTERN.test(data.crm_opportunity_id))) {
      errors.push('data.crm_opportunity_id');
    }
    errors.push(...validateCrmInboundCommonData(data, isMessageSend));
    return errors;
  }
  const dataKeys = isMessageSend ? CRM_INBOUND_MESSAGE_SEND_DATA_KEYS : CRM_INBOUND_CHAT_DATA_KEYS;
  for (const key of Object.keys(data)) {
    if (!dataKeys.includes(key)) errors.push(`data.${key}: unknown`);
  }
  if (!(typeof data.crm_opportunity_id === 'string' && CRM_INBOUND_UUID_PATTERN.test(data.crm_opportunity_id))) errors.push('data.crm_opportunity_id');
  errors.push(...validateCrmInboundCommonData(data, isMessageSend));
  return errors;
};

// Revision 1.3 (only with the contacts switch on): the 1.2 envelope with
// protocol_revision "1.3", the three identities and contact.opportunity_linked.
function validateCrmInboundEnvelope13(parsed, { messageSend }) {
  const errors = [];
  for (const key of Object.keys(parsed)) {
    if (!CRM_INBOUND_ENVELOPE_KEYS.includes(key)) errors.push(`envelope.${key}: unknown`);
  }
  for (const key of CRM_INBOUND_ENVELOPE_KEYS) if (!(key in parsed)) errors.push(`envelope.${key}: missing`);
  if (parsed.schema_version !== 1) errors.push('envelope.schema_version');
  if (!(typeof parsed.event_id === 'string' && CRM_INBOUND_ID_PATTERN.test(parsed.event_id))) errors.push('envelope.event_id');
  if (!crmInboundRealInstant(parsed.occurred_at)) errors.push('envelope.occurred_at');
  const isMessageSend = messageSend && parsed.type === CRM_INBOUND_MESSAGE_SEND_TYPE;
  const isHandoff = CRM_INBOUND_HANDOFF_TYPES.includes(parsed.type);
  const isLink = parsed.type === CRM_INBOUND_CONTACT_LINK_TYPE;
  if (!CRM_INBOUND_CHAT_TYPES.includes(parsed.type) && !isMessageSend && !isHandoff && !isLink) errors.push('envelope.type: unsupported');
  if (!crmInboundIsObject(parsed.data)) return [...errors, 'envelope.data'];
  const data = parsed.data;
  const contactValid = () => typeof data.contact_id === 'string' && CRM_INBOUND_CONTACT_ID_PATTERN.test(data.contact_id);
  const uuidValid = (key) => typeof data[key] === 'string' && CRM_INBOUND_UUID_PATTERN.test(data[key]);
  if (isHandoff) {
    for (const key of Object.keys(data)) {
      if (!CRM_INBOUND_HANDOFF_DATA_KEYS.includes(key)) errors.push(`data.${key}: unknown`);
    }
    if (!(typeof data.handoff_id === 'string' && CRM_INBOUND_ID_PATTERN.test(data.handoff_id))) errors.push('data.handoff_id');
    if (!uuidValid('crm_seller_id')) errors.push('data.crm_seller_id');
    return errors;
  }
  if (isLink) {
    for (const key of Object.keys(data)) {
      if (!CRM_INBOUND_CONTACT_LINK_DATA_KEYS.includes(key)) errors.push(`data.${key}: unknown`);
    }
    if (!contactValid()) errors.push('data.contact_id');
    if (!uuidValid('crm_opportunity_id')) errors.push('data.crm_opportunity_id');
    if (!uuidValid('crm_seller_id')) errors.push('data.crm_seller_id');
    return errors;
  }
  const identities = CRM_INBOUND_IDENTITY_KEYS_13.filter((key) => key in data);
  const dataKeys = [
    ...(isMessageSend ? CRM_INBOUND_MESSAGE_SEND_DATA_KEYS : CRM_INBOUND_CHAT_DATA_KEYS), 'conversation_id', 'contact_id',
  ];
  for (const key of Object.keys(data)) {
    if (!dataKeys.includes(key)) errors.push(`data.${key}: unknown`);
  }
  if (identities.length !== 1) {
    errors.push('data: exactly one of crm_opportunity_id, conversation_id or contact_id');
  } else if (identities[0] === 'contact_id') {
    if (!contactValid()) errors.push('data.contact_id');
  } else if (identities[0] === 'conversation_id') {
    if (!(typeof data.conversation_id === 'string' && CRM_INBOUND_CONVERSATION_ID_PATTERN.test(data.conversation_id))) {
      errors.push('data.conversation_id');
    }
  } else if (!uuidValid('crm_opportunity_id')) {
    errors.push('data.crm_opportunity_id');
  }
  errors.push(...validateCrmInboundCommonData(data, isMessageSend));
  return errors;
}

// The data rules every chat.take / chat.release / message.send shares, after
// its identity (in this order, so the details keep their order).
function validateCrmInboundCommonData(data, isMessageSend) {
  const errors = [];
  if (!(typeof data.crm_seller_id === 'string' && CRM_INBOUND_UUID_PATTERN.test(data.crm_seller_id))) errors.push('data.crm_seller_id');
  if (!(Number.isSafeInteger(data.ownership_version) && data.ownership_version >= 0)) errors.push('data.ownership_version');
  if (isMessageSend) {
    if (!(typeof data.client_message_id === 'string' && CRM_INBOUND_UUID_PATTERN.test(data.client_message_id))) errors.push('data.client_message_id');
    if (crmInboundMessageText(data.text) === null) errors.push('data.text');
  }
  return errors;
}

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
  const messageSendConfig = readCrmMessageSendConfig(env);
  const handoffsConfig = readCrmHandoffsConfig(env);
  const contactsConfig = readCrmContactsConfig(env);
  const errors = validateCrmInboundEnvelope(parsed, {
    messageSend: messageSendConfig.enabled,
    handoffs: handoffsConfig.enabled,
    contacts: contactsConfig.enabled,
  });
  if (errors.length > 0) return crmInboundInvalid(errors);

  const bodySha256 = cryptoModule.createHash('sha256').update(rawBody).digest('hex');
  if (contactsConfig.enabled && parsed.protocol_revision === '1.3' && !CRM_INBOUND_HANDOFF_TYPES.includes(parsed.type)) {
    return crmInboundContactAction(parsed, bodySha256, contactsConfig, messageSendConfig);
  }
  if (CRM_INBOUND_HANDOFF_TYPES.includes(parsed.type)) {
    if (handoffsConfig.errors.length > 0) return crmInboundRespond(503, { error: 'receiver_unavailable' });
    return {
      action: 'apply_handoff',
      event_id: parsed.event_id,
      event_type: parsed.type,
      body_sha256: bodySha256,
      handoff_ref: parsed.data.handoff_id,
      handoff_id: crmInboundOwnId(parsed.data.handoff_id, CRM_INBOUND_HANDOFF_ID_PATTERN, handoffsConfig.id_prefix),
      crm_seller_id: parsed.data.crm_seller_id.toLowerCase(),
    };
  }

  if ('conversation_id' in parsed.data) {
    const isSend = parsed.type === CRM_INBOUND_MESSAGE_SEND_TYPE;
    if (handoffsConfig.errors.length > 0 || (isSend && messageSendConfig.errors.length > 0)) {
      return crmInboundRespond(503, { error: 'receiver_unavailable' });
    }
    const conversation = {
      action: isSend ? 'send_conversation' : 'apply_conversation',
      event_id: parsed.event_id,
      event_type: parsed.type,
      body_sha256: bodySha256,
      conversation_ref: parsed.data.conversation_id,
      conversation_id: crmInboundOwnId(parsed.data.conversation_id, CRM_INBOUND_CONVERSATION_ID_PATTERN, handoffsConfig.id_prefix),
      crm_seller_id: parsed.data.crm_seller_id.toLowerCase(),
    };
    if (!isSend) return { ...conversation, ownership_version: String(parsed.data.ownership_version) };
    return {
      ...conversation,
      client_message_id: parsed.data.client_message_id.toLowerCase(),
      ownership_version: String(parsed.data.ownership_version),
      text: crmInboundMessageText(parsed.data.text),
    };
  }

  if (parsed.type === CRM_INBOUND_MESSAGE_SEND_TYPE) {
    if (messageSendConfig.errors.length > 0) return crmInboundRespond(503, { error: 'receiver_unavailable' });
    return {
      action: 'send',
      event_id: parsed.event_id,
      event_type: parsed.type,
      body_sha256: bodySha256,
      crm_opportunity_id: parsed.data.crm_opportunity_id.toLowerCase(),
      crm_seller_id: parsed.data.crm_seller_id.toLowerCase(),
      client_message_id: parsed.data.client_message_id.toLowerCase(),
      ownership_version: String(parsed.data.ownership_version),
      text: crmInboundMessageText(parsed.data.text),
    };
  }

  return {
    action: 'apply',
    event_id: parsed.event_id,
    event_type: parsed.type,
    body_sha256: bodySha256,
    crm_opportunity_id: parsed.data.crm_opportunity_id.toLowerCase(),
    crm_seller_id: parsed.data.crm_seller_id.toLowerCase(),
    ownership_version: String(parsed.data.ownership_version),
  };
};

// A verified 1.3 chat.take / chat.release / message.send or
// contact.opportunity_linked: one item for Apply CRM Contact Event or Claim
// CRM Contact Message Send. Every identity column is present ('' when absent),
// and the numeric ids are '' when the id carries another prefix (well formed,
// but not ours: the database answers 422).
function crmInboundContactAction(parsed, bodySha256, contactsConfig, messageSendConfig) {
  const isSend = parsed.type === CRM_INBOUND_MESSAGE_SEND_TYPE;
  if (contactsConfig.errors.length > 0 || (isSend && messageSendConfig.errors.length > 0)) {
    return crmInboundRespond(503, { error: 'receiver_unavailable' });
  }
  const data = parsed.data;
  const prefix = contactsConfig.id_prefix;
  const action = {
    action: isSend ? 'send_contact' : 'apply_contact',
    event_id: parsed.event_id,
    event_type: parsed.type,
    body_sha256: bodySha256,
    crm_opportunity_id: typeof data.crm_opportunity_id === 'string' ? data.crm_opportunity_id.toLowerCase() : '',
    conversation_ref: typeof data.conversation_id === 'string' ? data.conversation_id : '',
    conversation_id: typeof data.conversation_id === 'string'
      ? crmInboundOwnId(data.conversation_id, CRM_INBOUND_CONVERSATION_ID_PATTERN, prefix) : '',
    contact_ref: typeof data.contact_id === 'string' ? data.contact_id : '',
    contact_id: typeof data.contact_id === 'string'
      ? crmInboundOwnId(data.contact_id, CRM_INBOUND_CONTACT_ID_PATTERN, prefix) : '',
    id_prefix: prefix,
    crm_seller_id: data.crm_seller_id.toLowerCase(),
    ownership_version: parsed.type === CRM_INBOUND_CONTACT_LINK_TYPE ? '' : String(data.ownership_version),
  };
  if (!isSend) return action;
  return { ...action, client_message_id: data.client_message_id.toLowerCase(), text: crmInboundMessageText(data.text) };
}

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

// -----------------------------------------------------------------------------
// message.send: the Evolution request and its outcome.
// -----------------------------------------------------------------------------
// The same sendText request wa-outbound-messages sends for a bot reply. The
// claim row (crm_inbound_claim_message_send) carries the conversation's phone,
// its instance and the text. A missing value is a definite failure: nothing is
// sent and the CRM may retry the same bytes once an operator fixes it.
const buildCrmEvolutionSendRequest = (row = {}, env = {}) => {
  const baseUrl = String(env.EVOLUTION_API_BASE_URL ?? '').trim().replace(/\/+$/, '');
  const apiKey = String(env.EVOLUTION_API_KEY ?? '').trim();
  const instance = String(row.instance_name || env.EVOLUTION_DEFAULT_INSTANCE || '').trim();
  const number = String(row.phone_number ?? '').trim();
  const text = String(row.text_body ?? '');
  if (!baseUrl || !apiKey) return { ok: false, error: 'evolution_not_configured' };
  if (!instance) return { ok: false, error: 'evolution_instance_missing' };
  if (!number) return { ok: false, error: 'phone_number_missing' };
  if (text.trim() === '') return { ok: false, error: 'text_missing' };
  return {
    ok: true,
    url: `${baseUrl}/message/sendText/${encodeURIComponent(instance)}`,
    api_key: apiKey,
    body: { number, text, delay: 0, linkPreview: false },
  };
};

// Connection errors that prove the request never reached Evolution.
const CRM_EVOLUTION_NOT_SENT_CODES = ['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'EHOSTUNREACH', 'ENETUNREACH'];
const CRM_EVOLUTION_ERROR_MAX_CHARS = 500;

const crmEvolutionErrorText = (value) => {
  let text;
  try { text = typeof value === 'string' ? value : JSON.stringify(value ?? null); } catch (_error) { text = String(value); }
  return String(text ?? '').slice(0, CRM_EVOLUTION_ERROR_MAX_CHARS);
};

// Exactly once toward the customer: Evolution has no idempotency key, so only
// an outcome that proves the message was NOT sent is 'failed' (the CRM retry
// sends it again). Anything ambiguous is 'unknown' and is never resent
// automatically; an operator resolves it (docs/crm-integration/README.md).
//   2xx with a provider message id -> sent; 2xx without one -> unknown;
//   4xx -> failed; 5xx "Connection Closed" (WhatsApp unlinked) -> failed;
//   other 5xx, timeouts and resets -> unknown.
const classifyCrmEvolutionResult = ({ statusCode, body, error } = {}) => {
  if (error) {
    const code = String(error.code ?? '').toUpperCase();
    return {
      outcome: CRM_EVOLUTION_NOT_SENT_CODES.includes(code) ? 'failed' : 'unknown',
      provider_message_id: null,
      provider_status: null,
      error: crmEvolutionErrorText(`${code || 'request_error'}: ${error.message ?? ''}`),
    };
  }
  const status = Number(statusCode);
  if (status >= 200 && status < 300) {
    const id = [body?.key?.id, body?.data?.key?.id]
      .find((value) => typeof value === 'string' && value.trim() !== '');
    if (id === undefined) {
      return {
        outcome: 'unknown',
        provider_message_id: null,
        provider_status: status,
        error: 'evolution_message_id_missing',
      };
    }
    return { outcome: 'sent', provider_message_id: id.trim(), provider_status: status, error: null };
  }
  const detail = crmEvolutionErrorText(body);
  if (status >= 400 && status < 500) return { outcome: 'failed', provider_message_id: null, provider_status: status, error: detail };
  if (status >= 500 && /connection closed/i.test(detail)) {
    return { outcome: 'failed', provider_message_id: null, provider_status: status, error: detail };
  }
  return { outcome: 'unknown', provider_message_id: null, provider_status: Number.isFinite(status) ? status : null, error: detail };
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    readCrmInboundConfig,
    readCrmMessageSendConfig,
    readCrmHandoffsConfig,
    readCrmContactsConfig,
    validateCrmInboundEnvelope,
    verifyCrmInboundRequest,
    shapeCrmInboundResponse,
    buildCrmEvolutionSendRequest,
    classifyCrmEvolutionResult,
  };
}
