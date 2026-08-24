const asObject = (value) => value && typeof value === 'object' && !Array.isArray(value) ? value : {};
const asArray = (value) => Array.isArray(value) ? value : [];
const safe = (value, fallback = '') => String(value ?? fallback).trim();
const normalizePhone = (value) => safe(value).replace(/\D/g, '');

const resolveConversationMode = (row = {}, env = {}) => {
  const requestedMode = safe(env.AI_PRD_CONVERSATION_MODE, 'legacy').toLowerCase();
  if (!['shadow', 'enforce'].includes(requestedMode)) return 'legacy';
  const controlledPhone = normalizePhone(env.AI_PRD_CONTROLLED_PHONE_NUMBER);
  const conversationPhone = normalizePhone(row.phone_number);
  if (!controlledPhone || !conversationPhone || conversationPhone !== controlledPhone) return 'legacy';
  return requestedMode;
};

const canonicalize = (value) => {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
};
const canonicalJson = (value) => JSON.stringify(canonicalize(value));

// Synchronous SHA-256 keeps the policy compiler portable inside n8n Code nodes.
const sha256 = (value) => {
  let bytes = unescape(encodeURIComponent(String(value)));
  const bitLength = bytes.length * 8;
  const hash = [];
  const constants = [];
  const isComposite = {};
  const rotate = (number, bits) => (number >>> bits) | (number << (32 - bits));
  for (let candidate = 2; constants.length < 64; candidate += 1) {
    if (isComposite[candidate]) continue;
    for (let multiple = candidate; multiple < 313; multiple += candidate) isComposite[multiple] = true;
    if (hash.length < 8) hash.push((Math.sqrt(candidate) * 0x100000000) | 0);
    constants.push((Math.cbrt(candidate) * 0x100000000) | 0);
  }
  bytes += '\x80';
  while (bytes.length % 64 !== 56) bytes += '\x00';
  const words = [];
  for (let index = 0; index < bytes.length; index += 1) {
    words[index >> 2] |= bytes.charCodeAt(index) << ((3 - index) % 4) * 8;
  }
  words.push((bitLength / 0x100000000) | 0, bitLength);
  for (let offset = 0; offset < words.length; offset += 16) {
    const schedule = words.slice(offset, offset + 16);
    const previous = hash.slice(0, 8);
    let working = hash.slice(0, 8);
    for (let round = 0; round < 64; round += 1) {
      const w15 = schedule[round - 15];
      const w2 = schedule[round - 2];
      const word = round < 16 ? schedule[round] : schedule[round] = (
        schedule[round - 16]
        + (rotate(w15, 7) ^ rotate(w15, 18) ^ (w15 >>> 3))
        + schedule[round - 7]
        + (rotate(w2, 17) ^ rotate(w2, 19) ^ (w2 >>> 10))
      ) | 0;
      const a = working[0];
      const e = working[4];
      const temp1 = (working[7] + (rotate(e, 6) ^ rotate(e, 11) ^ rotate(e, 25))
        + ((e & working[5]) ^ (~e & working[6])) + constants[round] + word) | 0;
      const temp2 = ((rotate(a, 2) ^ rotate(a, 13) ^ rotate(a, 22))
        + ((a & working[1]) ^ (a & working[2]) ^ (working[1] & working[2]))) | 0;
      working = [(temp1 + temp2) | 0, working[0], working[1], working[2], (working[3] + temp1) | 0, working[4], working[5], working[6]];
    }
    for (let index = 0; index < 8; index += 1) hash[index] = (previous[index] + working[index]) | 0;
  }
  return hash.map((word) => (word >>> 0).toString(16).padStart(8, '0')).join('');
};

const ALLOWED_STATE_FIELDS = [
  'name', 'product', 'commune', 'quantity', 'measurements', 'use_case', 'modality',
  'urgency', 'desired_date', 'photos', 'terrain', 'truck_access', 'debris_removal',
  'customer_type', 'company', 'company_rut', 'contact_name', 'contact_role', 'email',
  'purchase_order', 'invoice_required', 'address', 'access_restrictions',
  'reception_contact', 'sale_number', 'purchase_date', 'issue_description',
  'payment_amount', 'payment_method', 'quote_number', 'service', 'city', 'requirement',
];
const ALLOWED_DIALOGUE_ACTIONS = ['answer', 'ask', 'ask_clarification', 'confirm', 'handoff'];

const CONCEPT_BY_FIELD = {
  quantity: 'commercial_amount',
  measurements: 'commercial_amount',
  commune: 'commune',
  city: 'commune',
  product: 'product',
  modality: 'modality',
};

const stateTargetsForObjective = (objective) => {
  if (objective === 'quantity' || objective === 'measurements') return ['quantity', 'measurements'];
  return [objective];
};

const allowedStateMappings = (unresolvedObjectives, facts) => {
  const acceptedFields = new Set(facts.map((fact) => fact.field));
  const mappings = [];
  const seen = new Set();
  for (const objective of unresolvedObjectives) {
    for (const field of stateTargetsForObjective(objective)) {
      if (!ALLOWED_STATE_FIELDS.includes(field) || acceptedFields.has(field)) continue;
      const concept = CONCEPT_BY_FIELD[field] || field;
      const key = `${concept}:${field}`;
      if (seen.has(key)) continue;
      seen.add(key);
      mappings.push({ concept, field });
    }
  }
  return mappings;
};

const acceptedFacts = (row, qualificationContext) => Object.entries({
  service: row.service,
  city: row.city,
  requirement: row.requirement,
  ...qualificationContext,
}).filter(([, value]) => value !== null && value !== undefined && String(value).trim() !== '')
  .map(([field, value]) => ({ field, value }));

const compileTurnPolicy = (row = {}, env = {}) => {
  const qualificationContext = asObject(row.qualification_context);
  const objectiveKey = safe(row.pending_question_key, 'none');
  const objectiveState = asObject(asObject(asObject(qualificationContext._conversation_control).objectives)[objectiveKey]);
  const noProgressCount = Math.max(0, Number(objectiveState.no_progress_count) || 0);
  const missing = asArray(row.commercial_missing_fields).map((field) => safe(field)).filter(Boolean);
  const mode = resolveConversationMode(row, env);
  const catalogItems = asArray(asObject(row.commercial_context).catalog_items)
    .filter((item) => item?.is_active !== false)
    .map((item) => ({ id: item?.id ?? null, sku: safe(item?.sku), name: safe(item?.name), aliases: asArray(item?.service_keywords) }));
  const facts = acceptedFacts(row, qualificationContext);
  const unresolvedObjectives = [...new Set(missing.length ? missing : objectiveKey === 'none' ? [] : [objectiveKey])];
  const turnPolicy = {
    version: 'ai_prd_turn_policy/v2',
    turn_id: safe(row.inbound_event_id || row.external_message_id || row.conversation_id || 'unknown'),
    mode,
    message: {
      id: safe(row.external_message_id || row.inbound_event_id || 'unknown'),
      text: String(row.text_body ?? row.message_current ?? ''),
    },
    accepted_facts: facts,
    unresolved_objectives: unresolvedObjectives,
    objective: { key: objectiveKey, mode: objectiveKey === 'none' ? 'respond' : 'ask', no_progress_count: noProgressCount },
    catalog: catalogItems,
    modality_synonyms: { material: ['solo material', 'solo el material', 'suministro'] },
    allowed_state_fields: [...ALLOWED_STATE_FIELDS],
    allowed_state_mappings: allowedStateMappings(unresolvedObjectives, facts),
    allowed_dialogue_actions: [...ALLOWED_DIALOGUE_ACTIONS],
    forbidden_rule_ids: ['NO_INVENT_PRICE', 'NO_CONFIRM_STOCK', 'NO_CONFIRM_PAYMENT', 'NO_DISCOUNT', 'NO_PROMISE_DELIVERY', 'NO_PROMISE_INSTALLATION'],
    effect_permissions: { create_lead: false, handoff: noProgressCount >= 2 },
  };
  const turnPolicyCanonicalJson = canonicalJson(turnPolicy);
  return {
    ...row,
    pre_turn_snapshot: row.pre_turn_snapshot || {
      service: row.service ?? null,
      city: row.city ?? null,
      requirement: row.requirement ?? null,
      confirmation_status: row.confirmation_status ?? 'none',
      qualification_context: JSON.parse(JSON.stringify(qualificationContext)),
    },
    turn_policy: turnPolicy,
    turn_policy_canonical_json: turnPolicyCanonicalJson,
    turn_policy_digest: sha256(turnPolicyCanonicalJson),
  };
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    compileTurnPolicy,
    canonicalJson,
    sha256,
    allowedStateMappings,
    resolveConversationMode,
    normalizePhone,
    ALLOWED_STATE_FIELDS,
    ALLOWED_DIALOGUE_ACTIONS,
  };
}

if (typeof items !== 'undefined') {
  return items.map((item) => ({ json: compileTurnPolicy(item?.json ?? {}, typeof $env === 'undefined' ? {} : $env) }));
}
