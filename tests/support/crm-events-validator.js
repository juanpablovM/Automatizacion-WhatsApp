// Local mirror of the CRM receiver validator for contract v1, revisions 1.1,
// 1.2 ("1.2a", the 1.2b ownership events and the 1.2d handoff.created, live on
// CRM dev) and 1.3 (customer threads: a root contact_id on every event,
// conversation_id only on conversation events, contact.upserted; agreed in
// .orca/drops/whatsapp-events-1.3-crm-response.md §1-§2). Anything the real validator rejects answers
// 400, so every event the bot builds must pass these exact rules. Returns the
// list of violations; an empty list means the CRM would accept the shape.
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PHONE = /^\+[1-9][0-9]{7,14}$/;
const SENT_AT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;
const ENVELOPE_KEYS = ['schema_version', 'protocol_revision', 'event_id', 'conversation_id', 'type', 'data'];
// 1.3: contact_id is accepted (and required) only with protocol_revision 1.3.
const ENVELOPE_KEYS_13 = [...ENVELOPE_KEYS, 'contact_id'];
const CONTACT_TYPES = ['contact.upserted', 'contact.state'];
// Revisions with the 1.2 event set; 1.3 keeps every 1.2 data rule.
const STRUCTURED = ['1.2', '1.3'];

const isObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const isText = (value, max) => typeof value === 'string'
  && value.trim() !== ''
  && !value.includes('\u0000')
  && value.length <= max;
const isRealDate = (value) => {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
};

const onlyKeys = (errors, path, value, allowed) => {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) errors.push(`${path}.${key}: unknown key`);
  }
};

const LEAD_BASE_KEYS = ['lead_id', 'revision', 'phone', 'name', 'rut', 'crm_seller_id', 'title', 'requirement'];
const LEAD_12_KEYS = [
  'customer_type', 'company', 'tax_document', 'purchase_order', 'service', 'fulfillment', 'city', 'commune',
  'address', 'use_case', 'urgency', 'desired_date', 'source_number', 'site', 'items', 'ai_summary',
];
const OPTIONAL_TEXT = {
  company: 200, purchase_order: 100, service: 100, city: 100, commune: 100, address: 300, use_case: 200,
};
const OPTIONAL_ENUM = {
  customer_type: ['natural', 'company'],
  tax_document: ['boleta', 'factura'],
  fulfillment: ['delivery', 'install', 'pickup'],
  urgency: ['urgente', 'alta', 'media', 'baja'],
};
const SITE_KEYS = ['terrain', 'truck_access', 'debris_removal', 'access_restrictions'];
const ITEM_KEYS = ['product', 'variant', 'quantity', 'unit', 'measurements'];
const AI_SUMMARY_KEYS = ['lead_class', 'next_best_action', 'executive_summary', 'pain', 'scope', 'timing', 'obstacle'];

const validateLeadQualified = (data, revision, errors) => {
  const allowed = STRUCTURED.includes(revision) ? [...LEAD_BASE_KEYS, ...LEAD_12_KEYS] : LEAD_BASE_KEYS;
  onlyKeys(errors, 'data', data, allowed);
  if (!(typeof data.lead_id === 'string' && ID.test(data.lead_id))) errors.push('data.lead_id');
  if (!(Number.isInteger(data.revision) && data.revision >= 1 && data.revision <= 2147483647)) errors.push('data.revision');
  if (!(typeof data.phone === 'string' && PHONE.test(data.phone))) errors.push('data.phone');
  if (!isText(data.name, 200)) errors.push('data.name');
  if (!(typeof data.crm_seller_id === 'string' && UUID.test(data.crm_seller_id))) errors.push('data.crm_seller_id');
  if (!isText(data.title, 200)) errors.push('data.title');
  if (!isText(data.requirement, 16000)) errors.push('data.requirement');
  if ('rut' in data && !isText(data.rut, 32)) errors.push('data.rut');
  if (!STRUCTURED.includes(revision)) return;

  for (const [key, max] of Object.entries(OPTIONAL_TEXT)) {
    if (key in data && !isText(data[key], max)) errors.push(`data.${key}`);
  }
  for (const [key, values] of Object.entries(OPTIONAL_ENUM)) {
    if (key in data && !values.includes(data[key])) errors.push(`data.${key}`);
  }
  if ('desired_date' in data && !isRealDate(data.desired_date)) errors.push('data.desired_date');
  if ('source_number' in data && !(typeof data.source_number === 'string' && PHONE.test(data.source_number))) errors.push('data.source_number');
  if ('site' in data) {
    const site = data.site;
    if (!isObject(site) || Object.keys(site).length === 0) {
      errors.push('data.site');
    } else {
      onlyKeys(errors, 'data.site', site, SITE_KEYS);
      if ('terrain' in site && !isText(site.terrain, 100)) errors.push('data.site.terrain');
      if ('truck_access' in site && typeof site.truck_access !== 'boolean') errors.push('data.site.truck_access');
      if ('debris_removal' in site && typeof site.debris_removal !== 'boolean') errors.push('data.site.debris_removal');
      if ('access_restrictions' in site && !isText(site.access_restrictions, 500)) errors.push('data.site.access_restrictions');
    }
  }
  if ('items' in data) {
    if (!Array.isArray(data.items) || data.items.length > 50) {
      errors.push('data.items');
    } else {
      data.items.forEach((item, index) => {
        const path = `data.items[${index}]`;
        if (!isObject(item)) { errors.push(path); return; }
        onlyKeys(errors, path, item, ITEM_KEYS);
        if (!isText(item.product, 200)) errors.push(`${path}.product`);
        if ('variant' in item && item.variant !== null && !isText(item.variant, 200)) errors.push(`${path}.variant`);
        if ('quantity' in item && item.quantity !== null
          && !(typeof item.quantity === 'number' && Number.isFinite(item.quantity) && item.quantity > 0)) errors.push(`${path}.quantity`);
        if ('unit' in item && item.unit !== null && !isText(item.unit, 20)) errors.push(`${path}.unit`);
        if ('measurements' in item && item.measurements !== null && !isText(item.measurements, 200)) errors.push(`${path}.measurements`);
      });
    }
  }
  if ('ai_summary' in data) {
    const summary = data.ai_summary;
    if (!isObject(summary) || Object.keys(summary).length === 0) {
      errors.push('data.ai_summary');
    } else {
      onlyKeys(errors, 'data.ai_summary', summary, AI_SUMMARY_KEYS);
      for (const key of Object.keys(summary)) {
        if (!isText(summary[key], 4000)) errors.push(`data.ai_summary.${key}`);
      }
    }
  }
};

const validateMessageNew = (data, errors) => {
  onlyKeys(errors, 'data', data, ['message_id', 'direction', 'text', 'sent_at', 'sender', 'crm_seller_id']);
  if (!(typeof data.message_id === 'string' && ID.test(data.message_id))) errors.push('data.message_id');
  if (!['inbound', 'outbound'].includes(data.direction)) errors.push('data.direction');
  if (!isText(data.text, 16000)) errors.push('data.text');
  if (!(typeof data.sent_at === 'string' && SENT_AT.test(data.sent_at) && !Number.isNaN(Date.parse(data.sent_at)))) errors.push('data.sent_at');
  if (!['customer', 'bot', 'seller', 'system'].includes(data.sender)) errors.push('data.sender');
  if ((data.direction === 'inbound') !== (data.sender === 'customer')) errors.push('data.direction_sender_mismatch');
  if (data.sender === 'seller') {
    if (!(typeof data.crm_seller_id === 'string' && UUID.test(data.crm_seller_id))) errors.push('data.crm_seller_id');
  } else if ('crm_seller_id' in data) {
    errors.push('data.crm_seller_id: only for sender seller');
  }
};

// 1.2b: ownership.taken data keys only {version, crm_seller_id, source};
// crm_seller_id is required and may be null. ownership.released data keys only
// {version, reason}.
const OWNERSHIP_VERSION_OK = (value) => Number.isInteger(value) && value >= 1 && value <= 2147483647;
const validateOwnershipTaken = (data, errors) => {
  onlyKeys(errors, 'data', data, ['version', 'crm_seller_id', 'source']);
  if (!OWNERSHIP_VERSION_OK(data.version)) errors.push('data.version');
  if (!('crm_seller_id' in data)) errors.push('data.crm_seller_id: missing');
  else if (data.crm_seller_id !== null && !(typeof data.crm_seller_id === 'string' && UUID.test(data.crm_seller_id))) errors.push('data.crm_seller_id');
  if (!['clickup', 'crm'].includes(data.source)) errors.push('data.source');
};
const validateOwnershipReleased = (data, errors) => {
  onlyKeys(errors, 'data', data, ['version', 'reason']);
  if (!OWNERSHIP_VERSION_OK(data.version)) errors.push('data.version');
  if (!['seller_released', 'sla_expired', 'customer_new_quote', 'opportunity_closed'].includes(data.reason)) errors.push('data.reason');
};

// 1.2d: handoff.created. reason snake_case 1-64, priority enum, description
// nonblank up to 16,000. Revision 1.2: exactly one of crm_opportunity_id or
// crm_seller_id (both or neither is 400); crm_seller_id requires phone (E.164)
// and allows name (up to 200); with crm_opportunity_id both are omitted.
const HANDOFF_KEYS = [
  'handoff_id', 'kind', 'area', 'reason', 'priority', 'description',
  'crm_opportunity_id', 'crm_seller_id', 'phone', 'name', 'postventa_type',
];
const validateHandoffCreated = (data, revision, errors) => {
  onlyKeys(errors, 'data', data, HANDOFF_KEYS);
  if (!(typeof data.handoff_id === 'string' && ID.test(data.handoff_id))) errors.push('data.handoff_id');
  if (!['commercial', 'operational', 'complaint'].includes(data.kind)) errors.push('data.kind');
  if ('area' in data && !['sales', 'management', 'finance', 'scheduling', 'claims'].includes(data.area)) errors.push('data.area');
  if (!(typeof data.reason === 'string' && data.reason.length <= 64 && /^[a-z][a-z0-9]*(_[a-z0-9]+)*$/.test(data.reason))) errors.push('data.reason');
  if (!['urgente', 'alta', 'media', 'baja'].includes(data.priority)) errors.push('data.priority');
  if (!isText(data.description, 16000)) errors.push('data.description');
  if ('crm_opportunity_id' in data && !(typeof data.crm_opportunity_id === 'string' && UUID.test(data.crm_opportunity_id))) errors.push('data.crm_opportunity_id');
  if (!STRUCTURED.includes(revision)) {
    for (const key of ['crm_seller_id', 'phone', 'name']) if (key in data) errors.push(`data.${key}: requires 1.2`);
    return;
  }
  const hasOpportunity = 'crm_opportunity_id' in data;
  const hasSeller = 'crm_seller_id' in data;
  if (hasOpportunity === hasSeller) errors.push('data: exactly one of crm_opportunity_id or crm_seller_id');
  if (hasSeller) {
    if (!(typeof data.crm_seller_id === 'string' && UUID.test(data.crm_seller_id))) errors.push('data.crm_seller_id');
    if (!(typeof data.phone === 'string' && PHONE.test(data.phone))) errors.push('data.phone');
    if ('name' in data && !isText(data.name, 200)) errors.push('data.name');
  } else {
    for (const key of ['phone', 'name']) if (key in data) errors.push(`data.${key}: only with crm_seller_id`);
  }
};

// 1.3 contact.upserted: data {revision, phone, name}; revision a growing
// integer, phone E.164 (required), name optional up to 200 or null.
// contact.state (1.3, CRM response §3): the bot's state per customer.
const CONTACT_STATES = ['ready_to_quote', 'handed_off', 'seller_held', 'qualifying', 'idle'];
const CONTACT_STATE_KEYS = ['state_version', 'state', 'progress', 'stage', 'conversation_id', 'changed_at'];
function validateContactState(data, errors) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) { errors.push('data: object required'); return; }
  const keys = Object.keys(data).sort();
  if (keys.join(',') !== [...CONTACT_STATE_KEYS].sort().join(',')) errors.push(`data: keys must be exactly ${CONTACT_STATE_KEYS.join(', ')}`);
  if (!Number.isInteger(data.state_version) || data.state_version < 1 || data.state_version > 2147483647) errors.push('data.state_version: integer 1-2147483647');
  if (!CONTACT_STATES.includes(data.state)) errors.push('data.state: unknown');
  if (!Number.isInteger(data.progress) || data.progress < 0 || data.progress > 100) errors.push('data.progress: integer 0-100');
  if (data.stage !== null && !(typeof data.stage === 'string' && /^[a-z][a-z0-9_]{0,63}$/.test(data.stage))) errors.push('data.stage: null or snake_case id');
  if (data.state === 'idle' && data.conversation_id !== null) errors.push('data.conversation_id: null for idle');
  if (data.conversation_id !== null && !(typeof data.conversation_id === 'string' && data.conversation_id.length > 0)) errors.push('data.conversation_id: id or null');
  if (!(typeof data.changed_at === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(data.changed_at))) errors.push('data.changed_at: UTC timestamp with seconds');
}

const validateContactUpserted = (data, errors) => {
  onlyKeys(errors, 'data', data, ['revision', 'phone', 'name']);
  if (!(Number.isInteger(data.revision) && data.revision >= 1 && data.revision <= 2147483647)) errors.push('data.revision');
  if (!(typeof data.phone === 'string' && PHONE.test(data.phone))) errors.push('data.phone');
  if ('name' in data && data.name !== null && !isText(data.name, 200)) errors.push('data.name');
};

const validateCrmEvent = (event) => {
  const errors = [];
  const parsed = typeof event === 'string' ? JSON.parse(event) : event;
  if (!isObject(parsed)) return ['envelope: not an object'];
  const is13 = parsed.protocol_revision === '1.3';
  const isContact = CONTACT_TYPES.includes(parsed.type);
  onlyKeys(errors, 'envelope', parsed, is13 ? ENVELOPE_KEYS_13 : ENVELOPE_KEYS);
  // 1.3: contact_id on every event; conversation_id on conversation events
  // only, never on contact.*. Earlier revisions keep their rules.
  const required = ENVELOPE_KEYS.filter((key) => !(is13 && isContact && key === 'conversation_id'));
  if (is13) required.push('contact_id');
  for (const key of required) if (!(key in parsed)) errors.push(`envelope.${key}: missing`);
  if (parsed.schema_version !== 1) errors.push('envelope.schema_version');
  if (!['1.1', '1.2', '1.3'].includes(parsed.protocol_revision)) errors.push('envelope.protocol_revision');
  if (!(typeof parsed.event_id === 'string' && ID.test(parsed.event_id))) errors.push('envelope.event_id');
  if (is13 && isContact) {
    if ('conversation_id' in parsed) errors.push(`envelope.conversation_id: not allowed on ${parsed.type}`);
  } else if (!(typeof parsed.conversation_id === 'string' && ID.test(parsed.conversation_id))) {
    errors.push('envelope.conversation_id');
  }
  if (is13 && 'contact_id' in parsed && !(typeof parsed.contact_id === 'string' && ID.test(parsed.contact_id))) errors.push('envelope.contact_id');
  if (!isObject(parsed.data)) return [...errors, 'envelope.data'];
  if (isContact) {
    if (!is13) errors.push(`${parsed.type} requires protocol_revision 1.3`);
    if (parsed.type === 'contact.upserted') validateContactUpserted(parsed.data, errors);
    else validateContactState(parsed.data, errors);
  } else if (parsed.type === 'lead.qualified') {
    validateLeadQualified(parsed.data, parsed.protocol_revision, errors);
  } else if (parsed.type === 'message.new') {
    if (!STRUCTURED.includes(parsed.protocol_revision)) errors.push('message.new requires protocol_revision 1.2');
    validateMessageNew(parsed.data, errors);
  } else if (parsed.type === 'ownership.taken' || parsed.type === 'ownership.released') {
    if (!STRUCTURED.includes(parsed.protocol_revision)) errors.push(`${parsed.type} requires protocol_revision 1.2 in the bot`);
    if (parsed.type === 'ownership.taken') validateOwnershipTaken(parsed.data, errors);
    else validateOwnershipReleased(parsed.data, errors);
  } else if (parsed.type === 'handoff.created') {
    validateHandoffCreated(parsed.data, parsed.protocol_revision, errors);
  } else {
    errors.push(`envelope.type: ${parsed.type}`);
  }
  return errors;
};

module.exports = { validateCrmEvent };
