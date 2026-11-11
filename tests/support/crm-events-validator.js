// Local mirror of the CRM receiver validator for contract v1, revisions 1.1 and
// 1.2 ("1.2a", live on CRM dev). Anything the real validator rejects answers
// 400, so every event the bot builds must pass these exact rules. Returns the
// list of violations; an empty list means the CRM would accept the shape.
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PHONE = /^\+[1-9][0-9]{7,14}$/;
const SENT_AT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;
const ENVELOPE_KEYS = ['schema_version', 'protocol_revision', 'event_id', 'conversation_id', 'type', 'data'];

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
  const allowed = revision === '1.2' ? [...LEAD_BASE_KEYS, ...LEAD_12_KEYS] : LEAD_BASE_KEYS;
  onlyKeys(errors, 'data', data, allowed);
  if (!(typeof data.lead_id === 'string' && ID.test(data.lead_id))) errors.push('data.lead_id');
  if (!(Number.isInteger(data.revision) && data.revision >= 1 && data.revision <= 2147483647)) errors.push('data.revision');
  if (!(typeof data.phone === 'string' && PHONE.test(data.phone))) errors.push('data.phone');
  if (!isText(data.name, 200)) errors.push('data.name');
  if (!(typeof data.crm_seller_id === 'string' && UUID.test(data.crm_seller_id))) errors.push('data.crm_seller_id');
  if (!isText(data.title, 200)) errors.push('data.title');
  if (!isText(data.requirement, 16000)) errors.push('data.requirement');
  if ('rut' in data && !isText(data.rut, 32)) errors.push('data.rut');
  if (revision !== '1.2') return;

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

const validateCrmEvent = (event) => {
  const errors = [];
  const parsed = typeof event === 'string' ? JSON.parse(event) : event;
  if (!isObject(parsed)) return ['envelope: not an object'];
  onlyKeys(errors, 'envelope', parsed, ENVELOPE_KEYS);
  for (const key of ENVELOPE_KEYS) if (!(key in parsed)) errors.push(`envelope.${key}: missing`);
  if (parsed.schema_version !== 1) errors.push('envelope.schema_version');
  if (!['1.1', '1.2'].includes(parsed.protocol_revision)) errors.push('envelope.protocol_revision');
  if (!(typeof parsed.event_id === 'string' && ID.test(parsed.event_id))) errors.push('envelope.event_id');
  if (!(typeof parsed.conversation_id === 'string' && ID.test(parsed.conversation_id))) errors.push('envelope.conversation_id');
  if (!isObject(parsed.data)) return [...errors, 'envelope.data'];
  if (parsed.type === 'lead.qualified') {
    validateLeadQualified(parsed.data, parsed.protocol_revision, errors);
  } else if (parsed.type === 'message.new') {
    if (parsed.protocol_revision !== '1.2') errors.push('message.new requires protocol_revision 1.2');
    validateMessageNew(parsed.data, errors);
  } else {
    errors.push(`envelope.type: ${parsed.type}`);
  }
  return errors;
};

module.exports = { validateCrmEvent };
