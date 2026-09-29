const V3_CONTRACTS = Object.freeze({
  policy: 'ai_prd_turn_policy/v3',
  proposal: 'ai_conversation_proposal/v3',
  validation: 'conversation_validation_result/v3',
  decision: 'validated_conversation_decision/v3',
  // Slice 2a (design.md D6): the item-aware shape ships under new artifact
  // versions inside the unchanged v3 route family. Dark until Slice 2b wires
  // the switch — nothing in production requests these today.
  policy_v3_1: 'ai_prd_turn_policy/v3.1',
  proposal_v3_1: 'ai_conversation_proposal/v3.1',
  validation_v3_1: 'conversation_validation_result/v3.1',
  decision_v3_1: 'validated_conversation_decision/v3.1',
});

const CONCEPT_TO_FIELD = Object.freeze({
  name: 'name',
  product: 'product',
  service: 'service',
  commune: 'commune',
  quantity: 'quantity',
  measurements: 'measurements',
  use_case: 'use_case',
  service_scope: 'service_scope',
  fulfillment: 'fulfillment',
  modality: 'modality',
  urgency: 'urgency',
  desired_date: 'desired_date',
  photos: 'photos',
  terrain: 'terrain',
  truck_access: 'truck_access',
  debris_removal: 'debris_removal',
  customer_type: 'customer_type',
  company: 'company',
  company_rut: 'company_rut',
  contact_name: 'contact_name',
  contact_role: 'contact_role',
  email: 'email',
  purchase_order: 'purchase_order',
  invoice_required: 'invoice_required',
  address: 'address',
  access_restrictions: 'access_restrictions',
  reception_contact: 'reception_contact',
  sale_number: 'sale_number',
  purchase_date: 'purchase_date',
  issue_description: 'issue_description',
  payment_amount: 'payment_amount',
  payment_method: 'payment_method',
  quote_number: 'quote_number',
});

const GROUNDED_CONCEPTS = new Set([
  'product', 'service', 'service_scope', 'fulfillment', 'modality',
]);
const TOP_LEVEL_PROPOSAL_KEYS = new Set([
  'version',
  'policy_digest',
  'reply_text',
  'primary_request',
  'catalog_resolution',
  'observations',
  'state_mutations',
  'effect_requests',
]);
const OBSERVATION_KEYS = new Set([
  'id',
  'concept',
  'raw_value',
  'normalized_value',
  'evidence_quote',
  'evidence_occurrence',
  'grounding_ref',
  'resolves_goal_ids',
]);
const MUTATION_KEYS = new Set(['operation', 'field', 'observation_id', 'replaces_fact_id']);
const EFFECT_KEYS = new Set(['type', 'reason_observation_ids']);
const PRIMARY_REQUEST_KEYS = new Set(['goal_id']);
const FINAL_CONFIRMATION_GOAL = 'final_confirmation';
const CATALOG_RESOLUTION_KEYS = new Set([
  'status', 'evidence_quote', 'evidence_occurrence', 'grounding_ref',
]);
const CATALOG_RESOLUTION_STATUSES = new Set([
  'matched', 'unsupported', 'ambiguous', 'not_applicable',
]);

const isObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const jsonClone = (value) => JSON.parse(JSON.stringify(value));
const stableValue = (value) => {
  if (Array.isArray(value)) return value.map(stableValue);
  if (isObject(value)) {
    return Object.fromEntries(
      Object.keys(value)
        .filter((key) => value[key] !== undefined)
        .sort()
        .map((key) => [key, stableValue(value[key])])
    );
  }
  if (typeof value === 'number' && !Number.isFinite(value)) return null;
  return value;
};
const canonicalJson = (value) => JSON.stringify(stableValue(value));
const SHA256_K = Object.freeze([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);
const rotateRight = (value, bits) => (value >>> bits) | (value << (32 - bits));
const sha256 = (value) => {
  const bytes = new TextEncoder().encode(String(value));
  const paddedLength = Math.ceil((bytes.length + 9) / 64) * 64;
  const padded = new Uint8Array(paddedLength);
  padded.set(bytes);
  padded[bytes.length] = 0x80;
  const bitLength = BigInt(bytes.length) * 8n;
  const view = new DataView(padded.buffer);
  view.setUint32(paddedLength - 8, Number((bitLength >> 32n) & 0xffffffffn));
  view.setUint32(paddedLength - 4, Number(bitLength & 0xffffffffn));

  const hash = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
  const words = new Uint32Array(64);
  for (let offset = 0; offset < paddedLength; offset += 64) {
    for (let index = 0; index < 16; index += 1) words[index] = view.getUint32(offset + index * 4);
    for (let index = 16; index < 64; index += 1) {
      const left = words[index - 15];
      const right = words[index - 2];
      const sigma0 = rotateRight(left, 7) ^ rotateRight(left, 18) ^ (left >>> 3);
      const sigma1 = rotateRight(right, 17) ^ rotateRight(right, 19) ^ (right >>> 10);
      words[index] = (words[index - 16] + sigma0 + words[index - 7] + sigma1) >>> 0;
    }
    let [a, b, c, d, e, f, g, h] = hash;
    for (let index = 0; index < 64; index += 1) {
      const sum1 = rotateRight(e, 6) ^ rotateRight(e, 11) ^ rotateRight(e, 25);
      const choice = (e & f) ^ (~e & g);
      const first = (h + sum1 + choice + SHA256_K[index] + words[index]) >>> 0;
      const sum0 = rotateRight(a, 2) ^ rotateRight(a, 13) ^ rotateRight(a, 22);
      const majority = (a & b) ^ (a & c) ^ (b & c);
      const second = (sum0 + majority) >>> 0;
      h = g;
      g = f;
      f = e;
      e = (d + first) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (first + second) >>> 0;
    }
    [a, b, c, d, e, f, g, h].forEach((part, index) => { hash[index] = (hash[index] + part) >>> 0; });
  }
  return hash.map((part) => part.toString(16).padStart(8, '0')).join('');
};

const digestObject = (value) => sha256(canonicalJson(value));
const digestPolicy = (policy) => {
  const copy = { ...policy };
  delete copy.policy_digest;
  return digestObject(copy);
};
const utf8Length = (value) => new TextEncoder().encode(String(value)).length;
const exactKeys = (value, allowed) => isObject(value)
  && Object.keys(value).every((key) => allowed.has(key));

const sanitizePolicyPriorRequest = (value) => {
  const source = isObject(value) ? value : {};
  const sourceValues = isObject(source.values) ? source.values : {};
  const allowedFields = new Set(Object.values(CONCEPT_TO_FIELD));
  const values = Object.fromEntries(Object.entries(sourceValues)
    .filter(([field, candidate]) => allowedFields.has(field)
      && candidate !== undefined
      && candidate !== null
      && String(candidate).trim() !== '')
    .map(([field, candidate]) => [field, jsonClone(candidate)]));
  if (!String(source.lead_id ?? '').trim() || Object.keys(values).length === 0) return null;
  return {
    lead_id: String(source.lead_id).trim(),
    source_conversation_id: String(source.source_conversation_id ?? '').trim() || null,
    completed_at: String(source.completed_at ?? '').trim() || null,
    lead_status_code: String(source.lead_status_code ?? '').trim() || null,
    values,
  };
};

const compileV3TurnPolicy = (input) => {
  if (!isObject(input?.turn) || !isObject(input.turn.message)) throw new Error('turn_message_required');
  const messageText = typeof input.turn.message.text === 'string' ? input.turn.message.text : '';
  const historyMessages = Array.isArray(input.history?.messages) ? jsonClone(input.history.messages) : [];
  const facts = Array.isArray(input.facts) ? jsonClone(input.facts) : [];
  const goals = Array.isArray(input.goals) ? jsonClone(input.goals) : [];
  const groundingInput = isObject(input.grounding) ? jsonClone(input.grounding) : {};
  const grounding = {
    catalog: Array.isArray(groundingInput.catalog) ? groundingInput.catalog : [],
    modality_synonyms: Array.isArray(groundingInput.modality_synonyms) ? groundingInput.modality_synonyms : [],
  };
  grounding.snapshot_digest = digestObject(grounding);
  const referenceContextInput = isObject(input.reference_context) ? input.reference_context : {};
  const priorRequest = sanitizePolicyPriorRequest(referenceContextInput.prior_request);

  const policy = {
    version: input.version === 'v3.1' ? V3_CONTRACTS.policy_v3_1 : V3_CONTRACTS.policy,
    turn: {
      id: String(input.turn.id ?? ''),
      conversation_id: String(input.turn.conversation_id ?? ''),
      conversation_revision: Number(input.turn.conversation_revision ?? 0),
      pending_question_goal_id: typeof input.turn.pending_question_goal_id === 'string'
        && input.turn.pending_question_goal_id.length > 0
        ? input.turn.pending_question_goal_id
        : null,
      message: {
        id: String(input.turn.message.id ?? ''),
        text: messageText,
        encoding: 'utf-8',
        sha256: sha256(messageText),
      },
    },
    history: {
      messages: historyMessages,
      truncated: Boolean(input.history?.truncated),
      sha256: digestObject(historyMessages),
    },
    reference_context: { prior_request: priorRequest },
    facts,
    goals,
    conversation_policy: {
      normal_voice: 'ai_only',
      max_primary_requests: 1,
      may_answer_before_progressing: true,
      may_defer_commercial_goals: true,
      must_not_request_known_facts: true,
    },
    state_authority: {
      allowed_mutations: Array.isArray(input.allowed_mutations) ? jsonClone(input.allowed_mutations) : [],
    },
    grounding,
    claim_authority: {
      rules: Array.isArray(input.claim_rules) ? jsonClone(input.claim_rules) : [],
    },
    effect_authority: {
      permissions: Array.isArray(input.effect_permissions) ? jsonClone(input.effect_permissions) : [],
      requirements: Array.isArray(input.effect_requirements) ? jsonClone(input.effect_requirements) : [],
      operation_key_strategy: 'system_derived/v1',
    },
    commit_policy: {
      proposal_atomicity: 'all_or_nothing',
      effects_before_reply: true,
      delivery_idempotency: 'turn_reply/v1',
    },
    failure_policy: {
      max_repairs: 1,
      preserve_pre_turn_state: true,
      static_copy: 'contingency_only',
      handoff_after_exhaustion: true,
    },
  };
  return { ...policy, policy_digest: digestObject(policy) };
};

const validationError = (code, path, relatedIds = [], allowedValues = [], instruction = null) => ({
  code,
  path,
  disposition: 'repairable',
  related_ids: relatedIds,
  allowed_values: allowedValues,
  ...(instruction ? { instruction } : {}),
});

const findOccurrence = (text, quote, occurrence) => {
  if (!quote || !Number.isInteger(occurrence) || occurrence < 1) return null;
  let from = 0;
  let index = -1;
  for (let count = 0; count < occurrence; count += 1) {
    index = text.indexOf(quote, from);
    if (index < 0) return null;
    from = index + quote.length;
  }
  return { index, end: index + quote.length };
};

const hasExplicitCreateLeadDirective = (value) => {
  const text = String(value ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLocaleLowerCase('es')
    .replace(/\s+/g, ' ')
    .trim();
  return /\b(?:crea|crear|creen|genera|generar|generen|registra|registrar|ingresa|ingresar|procedan|procede)\b.{0,50}\b(?:solicitud|pedido|lead)\b/.test(text)
    || /\bquiero\b.{0,30}\b(?:crear|generar|registrar|ingresar)\b.{0,30}\b(?:solicitud|pedido|lead)\b/.test(text);
};

const projectedValueFor = (policy, observations, field) => {
  const observed = [...observations].reverse().find((entry) => CONCEPT_TO_FIELD[entry.concept] === field);
  if (observed) return observed.normalized_value;
  return (policy?.facts || []).find((fact) => fact.field === field)?.value;
};

const effectiveRequiredGoalIds = (configuredGoalIds, policy, observations) => {
  const required = new Set(Array.isArray(configuredGoalIds) ? configuredGoalIds : []);
  const serviceScope = projectedValueFor(policy, observations, 'service_scope');
  const fulfillment = projectedValueFor(policy, observations, 'fulfillment');
  // Commune/address describe the customer's project or delivery destination.
  // They are inapplicable to a material pickup at the single factory location,
  // and a company picking up material follows that same rule: there is no
  // separate company track, so nothing company-shaped reinstates the question.
  if (serviceScope === 'material' && fulfillment === 'pickup') {
    required.delete('commune');
    required.delete('address');
    required.delete('access_restrictions');
  }
  if (serviceScope === 'material' || serviceScope === 'both') required.add('fulfillment');
  if (serviceScope === 'installation' || serviceScope === 'both') {
    for (const goalId of ['commune', 'address', 'terrain', 'truck_access', 'debris_removal']) required.add(goalId);
  }
  if (fulfillment === 'delivery') {
    required.add('commune');
    required.add('address');
    required.add('access_restrictions');
  }
  return [...required];
};

const groundingEntries = (policy) => [
  ...(Array.isArray(policy.grounding?.catalog) ? policy.grounding.catalog : []),
  ...(Array.isArray(policy.grounding?.modality_synonyms) ? policy.grounding.modality_synonyms : []),
];
const groundingValue = (entry) => entry?.value ?? entry?.name ?? null;
const groundingRefsForConcept = (policy, concept) => [...new Set(
  groundingEntries(policy)
    .filter((entry) => entry?.concept === concept && typeof entry.ref === 'string' && entry.ref.length > 0)
    .map((entry) => entry.ref),
)];
const normalizedComparable = (value) => isObject(value)
  ? value.value ?? value.name ?? value.kind ?? canonicalJson(value)
  : value;
const sameGroundedValue = (left, right) => String(left ?? '').trim().toLocaleLowerCase('es')
  === String(right ?? '').trim().toLocaleLowerCase('es');
const hasExplicitConfirmation = (value) => {
  const text = String(value ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLocaleLowerCase('es')
    .replace(/\s+/g, ' ')
    .trim();
  if (/^si(?:[, ]+(?:correcto|de acuerdo|por favor|adelante))?[.!]?$/.test(text)) return true;
  return /\b(confirmo|confirmado|de acuerdo|adelante|procedan|proceder|procede|avancemos|pueden avanzar|quiero avanzar)\b/.test(text);
};

const isGenericProductRequestion = (value) => {
  const text = String(value ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLocaleLowerCase('es')
    .replace(/\s+/g, ' ')
    .trim();
  return /\bque\s+(?:producto|material)\s+(?:necesitas|necesita|buscas|busca|quieres|quiere)\b/.test(text);
};

const hasExplicitBothScope = (value) => {
  const text = String(value ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLocaleLowerCase('es')
    .replace(/\s+/g, ' ')
    .trim();
  return /\bamb(?:as|os)\b/.test(text)
    || /\b(?:dos|2)\s+(?:propuestas|alternativas|cotizaciones)\b/.test(text)
    || /\b(?:con\s+y\s+sin|sin\s+y\s+con)\s+instalacion\b/.test(text)
    || /\bsolo\s+material\b.{0,80}\b(?:tambien\s+)?(?:con\s+)?instalacion\b/.test(text)
    || /\b(?:con\s+)?instalacion\b.{0,80}\b(?:y\s+)?(?:otra\s+)?solo\s+material\b/.test(text)
    || /\b(?:el\s+)?(?:material|suministro)\b.{0,40}\b(?:y|e)\s+(?:tambien\s+)?(?:el\s+|la\s+)?(?:servicio\s+de\s+)?instalacion\b/.test(text)
    || /\b(?:la\s+)?(?:instalacion|instalar)\b.{0,40}\b(?:y|e)\s+(?:tambien\s+)?(?:el\s+)?(?:material|suministro)\b/.test(text);
};

const hasExplicitFulfillmentEvidence = (value, fulfillment) => {
  const text = String(value ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLocaleLowerCase('es')
    .replace(/[^a-z0-9ñ\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!text) return false;
  if (fulfillment === 'delivery') {
    return /\b(?:despach\w*|entreg\w*|envi\w*|domicilio|delivery|llev\w*|mand\w*|recib\w*|casa|obra)\b/.test(text);
  }
  if (fulfillment === 'pickup') {
    return /\b(?:retir\w*|retiro|recog\w*|buscar|busco|buscamos|planta|bodega|sucursal)\b/.test(text);
  }
  return false;
};

const matchesPriorRequestValue = (policy, field, value, occurrence) => {
  if (!occurrence) return false;
  const values = policy?.reference_context?.prior_request?.values;
  if (!isObject(values) || !Object.prototype.hasOwnProperty.call(values, field)) return false;
  const priorValue = values[field];
  if (isObject(priorValue) || isObject(value)) {
    return isObject(priorValue) && isObject(value)
      && canonicalJson(priorValue) === canonicalJson(value);
  }
  return sameGroundedValue(priorValue, value);
};

const hasExplicitQuantityEvidence = (value) => /\b\d+(?:[.,]\d+)?\s*(?:m2|m²|mtl|m\.?l\.?|metros?\s+lineales?|unidades?|uds?)(?=\s|$|[.,;:])/iu
  .test(String(value ?? ''));

// ---------------------------------------------------------------------------
// Shared quote-level rule bodies (design.md D11). Both validateV3AiProposalV3
// and validateV3AiProposalV31 call these exact functions instead of each
// re-deriving the rule. Editing a rule here changes both versions
// identically — that composition is the property
// v3-v31-composition-differential.test.js proves.
// ---------------------------------------------------------------------------
const addressRequiresStreetDetailsError = (policy, rawObservations, observationEntry, path) => {
  const addressGoal = (policy.goals || []).find((goal) => goal.goal_id === 'address');
  const knownCommune = projectedValueFor(policy, rawObservations, 'commune')
    ?? addressGoal?.guidance?.known_commune;
  const comparableAddress = (value) => String(normalizedComparable(value) ?? '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '').toLocaleLowerCase('es')
    .replace(/[^a-z0-9]+/g, ' ').trim();
  const communeText = comparableAddress(knownCommune);
  if (!communeText) return null;
  if (comparableAddress(observationEntry.normalized_value) !== communeText
      && comparableAddress(observationEntry.evidence_quote) !== communeText) return null;
  return validationError(
    'address_requires_street_details', `${path}.normalized_value`, [observationEntry.id], [],
    'The commune is already known. Ask for street and approximate number instead of treating the commune alone as an address.',
  );
};

const serviceScopeBothEvidenceError = (policy, canonicalGroundedValue, messageText, occurrence, observationEntry, path) => {
  if (canonicalGroundedValue !== 'both') return null;
  if (hasExplicitBothScope(messageText)) return null;
  if (matchesPriorRequestValue(policy, 'service_scope', canonicalGroundedValue, occurrence)) return null;
  return validationError(
    'service_scope_both_evidence_invalid', `${path}.grounding_ref`, [observationEntry.id],
    groundingRefsForConcept(policy, 'service_scope').filter((ref) => ref !== 'service_scope:both'),
    'Use both only when the customer explicitly requests two alternatives; a single installation request is installation.',
  );
};

const fulfillmentEvidenceError = (policy, canonicalGroundedValue, messageText, occurrence, observationEntry, path) => {
  if (hasExplicitFulfillmentEvidence(messageText, canonicalGroundedValue)) return null;
  if (matchesPriorRequestValue(policy, 'fulfillment', canonicalGroundedValue, occurrence)) return null;
  return validationError(
    'fulfillment_evidence_invalid', `${path}.grounding_ref`, [observationEntry.id],
    groundingRefsForConcept(policy, 'fulfillment'),
    'Use pickup or delivery only when the customer explicitly chooses a fulfillment mode; a generic acknowledgement resolves neither.',
  );
};

const quantityObservationRequiredError = () => validationError(
  'quantity_observation_required', 'observations', [], ['quantity'],
  'The customer stated an explicit quantity with a unit; add an evidenced quantity observation and its authorized mutation.',
);

const pickupFactoryAddressRequiredError = (normalizedReplyText) => {
  if (normalizedReplyText.includes('portezuelo 1502') && normalizedReplyText.includes('san bernardo')) return null;
  return validationError(
    'pickup_factory_address_required', 'reply_text', ['fulfillment'], ['Portezuelo 1502, San Bernardo'],
    'State the single official factory pickup address exactly: Portezuelo 1502, San Bernardo. Do not store it as the customer commune or project address.',
  );
};

const installationRequiresDeliveryError = (policy, serviceScope, fulfillment) => {
  if (!['installation', 'both'].includes(serviceScope) || fulfillment !== 'pickup') return null;
  const deliveryRefs = groundingEntries(policy)
    .filter((entry) => entry?.concept === 'fulfillment' && sameGroundedValue(groundingValue(entry), 'delivery'))
    .map((entry) => entry.ref);
  return validationError(
    'installation_requires_delivery', 'fulfillment', ['service_scope', 'fulfillment'], deliveryRefs,
    'Installation is available only with delivery. Correct fulfillment to delivery, or correct service_scope to material-only pickup without installation, but only with customer evidence. If this conflict is already persisted and the current message does not resolve it, ask whether the customer wants installation with delivery or material-only pickup; do not authorize an effect. Do not offer installation with factory pickup.',
  );
};

const isPersistedInstallationConflictClarification = (policy, observations, mutations, proposal, primaryRequestValid) => {
  const serviceScope = projectedValueFor(policy, [], 'service_scope');
  const fulfillment = projectedValueFor(policy, [], 'fulfillment');
  return Boolean(installationRequiresDeliveryError(policy, serviceScope, fulfillment))
    && primaryRequestValid
    && (proposal.primary_request?.goal_id === 'service_scope'
      || (serviceScope === 'both' && proposal.primary_request?.goal_id === 'fulfillment'))
    && observations.length === 0
    && mutations.length === 0
    && Array.isArray(proposal.effect_requests)
    && proposal.effect_requests.length === 0;
};

const primaryRequestGoalInapplicableError = (requestedGoal, serviceScope, allowedNextGoalIds) => {
  if (!(requestedGoal === 'fulfillment' && serviceScope === 'installation')) return null;
  return validationError(
    'primary_request_goal_inapplicable', 'primary_request.goal_id', ['fulfillment', 'installation'],
    allowedNextGoalIds.filter((goalId) => goalId !== 'fulfillment'),
    'Installation already implies delivery to the work site; do not ask pickup versus delivery.',
  );
};

// Quote-level only: this rule never inspects product/quantity/measurements,
// so a plain field-name Map is safe even though item facts (D4) share those
// three field names across different items.
const addressRetryBoundErrors = (policy, candidateMutations, primaryRequestValid, primaryRequest, permissions, candidateEffects) => {
  const errors = [];
  const addressGoal = (policy?.goals || []).find((goal) => goal.goal_id === 'address');
  const priorValues = new Map((policy?.facts || []).map((fact) => [fact.field, fact.value]));
  const materialProgress = candidateMutations.some((mutation) => (
    !['customer_type', 'lead_class', 'objection_detected', 'diagnostic_datos', 'executive_summary'].includes(mutation.field)
    && canonicalJson(mutation.projected_value) !== canonicalJson(priorValues.get(mutation.field) ?? null)
  ));
  const addressRetryExhausted = policy?.turn?.pending_question_goal_id === 'address'
    && addressGoal?.status !== 'resolved'
    && Number(addressGoal?.guidance?.next_retry_count_without_progress || 0)
      >= Number(addressGoal?.guidance?.handoff_at || 3)
    && !materialProgress;
  if (!addressRetryExhausted) return errors;
  if (primaryRequestValid && primaryRequest !== null) {
    errors.push(validationError('address_retry_exhausted', 'primary_request.goal_id', ['address'], [],
      'Do not ask another qualification question without new commercial evidence after the address retry limit.'));
  }
  if (permissions.has('handoff') && !candidateEffects.some((effect) => effect.type === 'handoff')) {
    errors.push(validationError('address_retry_handoff_required', 'effect_requests', ['address'], ['handoff'],
      'Request the permitted handoff instead of repeating the address question; do not claim completed assignment before its receipt.'));
  }
  return errors;
};

// ---------------------------------------------------------------------------
// v3.1 (Slice 2a, design.md D1-D5): item-scoped line items on top of the
// unchanged v3 contract above. Dark in this slice — nothing in production
// requests `input.version: 'v3.1'` until Slice 2b's switch.
// ---------------------------------------------------------------------------
const ITEM_FIELDS = new Set(['product', 'quantity', 'measurements']);
const ITEM_FACT_ID_RE = /^fact:item:([^:]+):(product|quantity|measurements)$/;
const MAX_LINE_ITEMS = 10;
const LINE_ITEM_VERSION = 'line_item/v1';
const FLAT_ITEM_ID = 'li_0';
const OBSERVATION_KEYS_V31 = new Set([...OBSERVATION_KEYS, 'item_ref']);
const MUTATION_KEYS_V31 = new Set(['operation', 'field', 'item_ref', 'observation_id', 'replaces_fact_id']);
const PRIMARY_REQUEST_KEYS_V31 = new Set(['goal_id', 'item_ref']);
const ITEM_SCOPED_REQUEST_GOALS_V31 = new Set([...ITEM_FIELDS, 'line_items']);
const CATALOG_RESOLUTION_KEYS_V31 = new Set([...CATALOG_RESOLUTION_KEYS, 'item_ref']);
const CATALOG_RESOLUTION_STATUSES_V31 = new Set(['matched', 'unsupported', 'ambiguous']);
const TOP_LEVEL_PROPOSAL_KEYS_V31 = new Set([
  'version', 'policy_digest', 'reply_text', 'primary_request',
  'catalog_resolutions', 'observations', 'state_mutations', 'effect_requests',
]);
// Per design D5, an ambiguous/unsupported item's clarification notice never
// rejects the rest of the proposal (v3's equivalent has no carve-out, so it
// stays a blocking code there).
const NON_BLOCKING_V31_CODES = new Set(['catalog_resolution_clarification_required']);

const itemIdFromFactId = (factId) => {
  const match = ITEM_FACT_ID_RE.exec(String(factId || ''));
  return match ? match[1] : null;
};

const existingLineItemsFromPolicy = (policy) => {
  const items = new Map();
  for (const fact of policy?.facts || []) {
    const match = ITEM_FACT_ID_RE.exec(fact?.fact_id || '');
    if (!match) continue;
    const [, itemId, field] = match;
    if (!items.has(itemId)) items.set(itemId, { item_id: itemId, product: null, quantity: null, measurements: null });
    items.get(itemId)[field] = fact.value;
  }
  return items;
};

// D1: handles are fixed inside the immutable decision, so replay derives the
// same id. Duplicated from shared/v3-line-items.js on purpose — these
// shared/*.js runtimes are concatenated standalone into n8n Code nodes with
// no cross-file `require` (see that file's own header comment).
const deriveItemIdV31 = (conversationId, turnId, handle) => {
  if (handle === undefined || handle === null || handle === '') return FLAT_ITEM_ID;
  const seed = [LINE_ITEM_VERSION, String(conversationId ?? ''), String(turnId ?? ''), String(handle)].join('\u0000');
  return `li_${sha256(seed).slice(0, 12)}`;
};

// 3c.16: an explicit distributive quantity ("500 metros de cada uno", "para
// ambos") legitimately sets the same quantity on each item it refers to, so
// one quantity span may authorize several item_ref values only when that
// shared quote itself carries a distributive marker and every value is
// identical. 3c.17 extends it to measurements; every other field or shape stays
// item_evidence_span_conflict, and distributiveSpanErrorsV31 below narrows
// which items a distributive span may reach.
const DISTRIBUTIVE_FIELDS_V31 = new Set(['quantity', 'measurements']);
const DISTRIBUTIVE_QUANTITY_MARKER_V31 = /\b(?:(?:de\s+)?cada\s+(?:uno|una|producto|item)|para\s+(?:ambos|ambas|los\s+dos|las\s+dos)|lo\s+mismo\s+para)\b/;
const isDistributiveQuantitySpanV31 = (field, observationEntry, firstObservation) => {
  if (!DISTRIBUTIVE_FIELDS_V31.has(field) || !firstObservation) return false;
  const quote = String(observationEntry.evidence_quote ?? '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLocaleLowerCase('es').replace(/\s+/g, ' ');
  return DISTRIBUTIVE_QUANTITY_MARKER_V31.test(quote)
    && canonicalJson(observationEntry.normalized_value ?? null) === canonicalJson(firstObservation.normalized_value ?? null);
};

const hasResolvedValue = (value) => value !== undefined && value !== null
  && (typeof value !== 'string' || value.trim() !== '');

// Repair guidance only (never changes accept/reject): live canary 2026-09-27
// showed the model emitting a catalog_resolutions entry for an item whose
// product was already a known fact while the customer named no product
// (a final confirmation). These helpers let the repair prompt say so.
const foldForProductMatchV31 = (value) => String(value ?? '')
  .normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLocaleLowerCase('es');
// Task 3c.19: a catalog product entry may list `synonyms` (migration 026).
// A mention is a whole-word phrase (accents, case and punctuation folded) of
// the product's name or one of its synonyms; when two products' phrases
// overlap, the longest one wins, so "placa de 50 reforzada" names only
// Placas de 50 cm Reforzadas and "bloques de cemento" does not name Cemento.
const phraseFoldV31 = (value) => foldForProductMatchV31(value).replace(/[^a-z0-9]+/g, ' ').trim();
const productSynonymsV31 = (entry) => (Array.isArray(entry?.synonyms) ? entry.synonyms : [])
  .filter((synonym) => typeof synonym === 'string' && synonym.trim() !== '');
const catalogHasSynonymsV31 = (entries) => entries
  .some((entry) => entry?.concept === 'product' && productSynonymsV31(entry).length > 0);
const productRefsMentionedV31 = (entries, text) => {
  const haystack = ` ${phraseFoldV31(text)} `;
  const spans = [];
  for (const entry of Array.isArray(entries) ? entries : []) {
    if (entry?.concept !== 'product' || typeof entry.ref !== 'string' || entry.ref === '') continue;
    const name = groundingValue(entry);
    for (const phrase of [typeof name === 'string' ? name : '', ...productSynonymsV31(entry)]) {
      const needle = phraseFoldV31(phrase);
      if (!needle) continue;
      for (let index = haystack.indexOf(` ${needle} `); index !== -1; index = haystack.indexOf(` ${needle} `, index + 1)) {
        spans.push({ ref: entry.ref, start: index + 1, end: index + 1 + needle.length });
      }
    }
  }
  return new Set(spans
    .filter((span) => !spans.some((other) => other.ref !== span.ref
      && other.start <= span.start && span.end <= other.end
      && other.end - other.start > span.end - span.start))
    .map((span) => span.ref));
};
// Task 3c.21 (owner rule): some products are quoted only in linear meters plus
// a height, never by area. Data-driven by catalog ref; today only Cierros de
// Hormigón (placas and postes are sold per unit, so they are not listed).
// An item's product is linear-only when its matched catalog resolution or its
// product observation points at a listed ref, or when its product value is the
// grounded value of a listed ref.
const LINEAR_ONLY_PRODUCT_REFS_V31 = new Set(['product:cierros-hormigon']);
const AREA_UNIT_V31 = /(?:^|[^a-z0-9])(?:m|mt|mts|mtr|mtrs|metros?)\s*\^?\s*2(?![0-9])|cuadrad|square|(?:^|[^a-z])sq(?![a-z])/;
const isAreaUnitV31 = (unit) => typeof unit === 'string'
  && AREA_UNIT_V31.test(unit.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLocaleLowerCase('es'));
const AREA_QUANTITY_IN_MESSAGE_V31 = /\b\d+(?:[.,]\d+)?\s*(?:m2|m²)(?=\s|$|[.,;:])/giu;
const isLinearOnlyProductV31 = (policy, product, groundingRefs = []) => {
  if (groundingRefs.some((ref) => LINEAR_ONLY_PRODUCT_REFS_V31.has(ref))) return true;
  const name = productNameTextV31(product);
  if (!name.trim()) return false;
  return groundingEntries(policy).some((entry) => entry?.concept === 'product'
    && LINEAR_ONLY_PRODUCT_REFS_V31.has(entry.ref) && sameGroundedValue(groundingValue(entry), name));
};
const linearQuantityInstructionV31 = (itemRef) => `Cierros are measured only in metros lineales (linear meters) plus the height (altura), never by area. Never record an area (m², metros cuadrados) as this item's quantity: drop this state_mutation and its quantity observation, and ask for the linear meters and the height with primary_request {"goal_id": "quantity", "item_ref": "${itemRef}"}.`;
const quoteNamesCatalogProductV31 = (policy, quote) => {
  const folded = foldForProductMatchV31(quote);
  if (!folded.trim()) return false;
  const entries = groundingEntries(policy);
  // Without synonyms in the catalog this is exactly the pre-3c.19 check.
  if (catalogHasSynonymsV31(entries) && productRefsMentionedV31(entries, quote).size > 0) return true;
  return entries
    .filter((entry) => entry?.concept === 'product')
    .map((entry) => foldForProductMatchV31(groundingValue(entry)))
    .some((name) => name.trim() !== '' && folded.includes(name));
};
// 3c.17: which quote items the current message names. Same folding as
// quoteNamesCatalogProductV31 (accents and case), matched against each item's
// product (a catalog value): the full product name, or a word of it (4+
// letters, optional plural "s") that no other item's product shares, so
// "concertina y púas" names "Alambre Concertina" and "Alambre de Púas" while
// the shared word "alambre" names neither.
const productNameTextV31 = (value) => (typeof value === 'string'
  ? value
  : (isObject(value) ? String(value.value ?? value.name ?? '') : ''));
const productWordsV31 = (name) => foldForProductMatchV31(name).split(/[^a-z0-9]+/).filter((word) => word.length >= 4);
// Task 3c.19: an item whose catalog product lists synonyms is also named when
// the message mentions one of them (productRefsMentionedV31, longest match).
// Items whose product has no synonyms keep exactly the 3c.17 matching.
const itemsNamedByMessageV31 = (messageText, productByRef, catalogEntries = []) => {
  const folded = foldForProductMatchV31(messageText);
  const wordsByRef = new Map([...productByRef].map(([ref, product]) => [ref, productWordsV31(productNameTextV31(product))]));
  const named = new Set();
  const productEntries = (Array.isArray(catalogEntries) ? catalogEntries : [])
    .filter((entry) => entry?.concept === 'product' && productSynonymsV31(entry).length > 0);
  const mentionedRefs = productEntries.length > 0 ? productRefsMentionedV31(catalogEntries, messageText) : new Set();
  for (const [ref, product] of productByRef) {
    const catalogEntry = productEntries.find((entry) => sameGroundedValue(groundingValue(entry), productNameTextV31(product)));
    if (catalogEntry && mentionedRefs.has(catalogEntry.ref)) {
      named.add(ref);
      continue;
    }
    const fullName = foldForProductMatchV31(productNameTextV31(product)).trim();
    if (fullName && folded.includes(fullName)) {
      named.add(ref);
      continue;
    }
    const otherWords = new Set([...wordsByRef].filter(([otherRef]) => otherRef !== ref).flatMap(([, words]) => words));
    const distinctive = wordsByRef.get(ref).filter((word) => !otherWords.has(word));
    if (distinctive.some((word) => new RegExp(`(?:^|[^a-z0-9])${word.replace(/s$/, '')}s?(?:$|[^a-z0-9])`).test(folded))) {
      named.add(ref);
    }
  }
  return named;
};

// 3c.17 (owner-approved): a distributive span shared by two or more items
// (accepted by isDistributiveQuantitySpanV31) may only
//   - set the field on items that hold no value for it yet (never overwrite);
//   - reach the items the message names, when it names any quote item;
//   - when it names none, ask the customer which items the value applies to
//     (mandatory, owner decision) and stay out of a final_confirmation or
//     create_lead turn.
// The assignment question is an item-scoped primary_request for the
// distributed field ({goal_id: field, item_ref: one target}): the validator
// already accepts it (item fields are known goals and item-scoped requests
// skip primary_request_goal_resolved), and 09_commit_v3_turn.sql persists it
// as pending_question_key=<field>, so the next "sí" cannot authorize
// create_lead (that needs a pending final_confirmation) and the next turn
// asks the final confirmation normally.
const distributiveSpanErrorsV31 = ({
  spans, messageText, existingItems, factsById, productByRef, primaryRequest, effectRequests, catalogEntries = [],
}) => {
  const errors = [];
  const namedRefs = itemsNamedByMessageV31(messageText, productByRef, catalogEntries);
  const holdsValue = (ref, field) => factsById.has(`fact:item:${ref}:${field}`)
    || hasResolvedValue(existingItems.get(ref)?.[field]);
  const productLabel = (ref) => productNameTextV31(productByRef.get(ref)) || ref;
  for (const entries of spans) {
    const targetRefs = [...new Set(entries.map((entry) => entry.itemRef))];
    if (targetRefs.length < 2) continue;
    const { field } = entries[0];
    const fillableRefs = targetRefs.filter((ref) => !holdsValue(ref, field));
    const allowedNamedRefs = [...namedRefs].filter((ref) => !holdsValue(ref, field)).sort();
    for (const entry of entries) {
      if (entry.operation === 'replace' || holdsValue(entry.itemRef, field)) {
        errors.push(validationError(
          'item_evidence_span_conflict', entry.path, [entry.observationId], fillableRefs,
          `A distributive value (for example "de cada uno") only fills items that have no ${field} yet, and item ${entry.itemRef} already has a ${field} value. Apply it only to items missing that field; to change an existing value the customer must name that product.`,
        ));
        continue;
      }
      if (namedRefs.size > 0 && !namedRefs.has(entry.itemRef)) {
        errors.push(validationError(
          'item_evidence_span_conflict', entry.path, [entry.observationId], allowedNamedRefs,
          `The customer names products in this message, so this distributive value applies only to the named items missing ${field} (${allowedNamedRefs.join(', ') || 'none'}); remove the ${field} mutation for ${entry.itemRef}, or drop it and ask which items the value applies to.`,
        ));
      }
    }
    // Owner decision (3c.17): with no named item the assignment question is
    // mandatory, so primary_request must be exactly {goal_id: field,
    // item_ref: <a target>}; null, final_confirmation or any other request
    // is rejected, and so is a create_lead request in that turn.
    const asksAssignment = primaryRequest?.goal_id === field && targetRefs.includes(primaryRequest?.item_ref);
    const requestsCreateLead = effectRequests.some((effect) => effect?.type === 'create_lead');
    if (namedRefs.size === 0 && (!asksAssignment || requestsCreateLead)) {
      const products = targetRefs.map(productLabel);
      errors.push(validationError(
        'distributive_assignment_unconfirmed',
        asksAssignment ? 'effect_requests' : 'primary_request',
        targetRefs, targetRefs,
        `The customer did not name which products the distributive value "${entries[0].observation.evidence_quote}" applies to, and it is applied to ${targetRefs.length} items (${targetRefs.map((ref) => `${ref}: ${productLabel(ref)}`).join(', ')}). Keep these mutations, but do not ask for final confirmation or create the lead in this turn: ask the customer to confirm that the value applies to ${products.join(' y ')}, with exactly primary_request {"goal_id":"${field}","item_ref":"${targetRefs[0]}"} (required; goal_id must be the literal "${field}"; never "name" (the customer's own name) or any other goal; primary_request null or any other request is rejected) and no create_lead effect.`,
      ));
    }
  }
  return errors;
};

const CATALOG_RESOLUTION_EVIDENCE_NOT_FOUND_INSTRUCTION_V31 = 'evidence_quote must be exact text from the current message. If the customer message names no product for this item, remove this entry: a message that names no product uses catalog_resolutions=[].';
const spuriousCatalogResolutionInstructionV31 = (itemRefs) => `Remove the catalog_resolutions entry for ${itemRefs.join(', ')}: that item's product is already a known fact and the evidence_quote names no product from the catalog. A confirmation or answer that names no product uses catalog_resolutions=[].`;

// Repair guidance only (never changes accept/reject): live A/B 2026-09-28
// (pandereta-live-then-wire-correction) showed the model emitting `replace`
// for an existing item's quantity that had never been recorded, citing a
// fact id that does not exist. The guidance says to `set` instead, or names
// the current fact id when the item field does hold a replaceable fact.
const itemFactNotReplaceableGuidanceV31 = (factsById, existingItems, mutation) => {
  const itemRef = mutation?.item_ref;
  if (!ITEM_FIELDS.has(mutation?.field) || typeof itemRef !== 'string' || !existingItems.has(itemRef)) return null;
  const currentFactId = `fact:item:${itemRef}:${mutation.field}`;
  const currentFact = factsById.get(currentFactId);
  if (!currentFact) {
    return {
      allowedValues: [null],
      instruction: `Item ${itemRef} has no current ${mutation.field} value, so there is nothing to replace: use operation "set" with replaces_fact_id: null on item_ref ${itemRef}. A customer's correction of a value that was never recorded is a set.`,
    };
  }
  if (currentFact.field !== mutation.field || currentFact.mutability !== 'customer_correctable') return null;
  return {
    allowedValues: [currentFactId],
    instruction: `Item ${itemRef} already has a current ${mutation.field} fact: to correct it use operation "replace" with replaces_fact_id: "${currentFactId}".`,
  };
};

// Required goals reuse the quote-level conditional rules in
// effectiveRequiredGoalIds, replacing product/quantity with line_items.
const effectiveRequiredGoalIdsV31 = (configuredGoalIds, policy, observations) => {
  const base = (Array.isArray(configuredGoalIds) ? configuredGoalIds : [])
    .filter((goalId) => goalId !== 'product' && goalId !== 'quantity');
  if (!base.includes('line_items')) base.push('line_items');
  return effectiveRequiredGoalIds(base, policy, observations);
};

const validateV3AiProposalV31 = (policy, proposal) => {
  const errors = [];
  const candidateObservations = [];
  const candidateMutations = [];
  const withheldMutations = [];
  const candidateEffects = [];
  const proposalObject = isObject(proposal) ? proposal : {};
  const policyDigestValid = policy?.version === V3_CONTRACTS.policy_v3_1
    && typeof policy.policy_digest === 'string'
    && digestPolicy(policy) === policy.policy_digest;

  if (!policyDigestValid) errors.push(validationError('policy_invalid', 'policy'));
  if (!exactKeys(proposalObject, TOP_LEVEL_PROPOSAL_KEYS_V31)) errors.push(validationError('proposal_shape_invalid', '$'));
  if (proposalObject.version !== V3_CONTRACTS.proposal_v3_1) errors.push(validationError('proposal_version_invalid', 'version'));
  if (proposalObject.policy_digest !== policy?.policy_digest) errors.push(validationError('policy_digest_mismatch', 'policy_digest'));
  if (typeof proposalObject.reply_text !== 'string' || proposalObject.reply_text.length === 0) {
    errors.push(validationError('reply_text_invalid', 'reply_text'));
  }

  const messageText = typeof policy?.turn?.message?.text === 'string' ? policy.turn.message.text : '';
  const existingItems = existingLineItemsFromPolicy(policy);

  // catalog_resolutions[]: one entry per item this turn resolves against the
  // catalog. Every entry needs real message evidence, like v3's singular
  // catalog_resolution.
  const catalogResolutions = Array.isArray(proposalObject.catalog_resolutions) ? proposalObject.catalog_resolutions : [];
  if (!Array.isArray(proposalObject.catalog_resolutions)) errors.push(validationError('catalog_resolutions_invalid', 'catalog_resolutions'));
  const catalogResolutionByRef = new Map();
  const validCatalogResolutionRefs = new Set();
  for (const [index, resolution] of catalogResolutions.entries()) {
    const path = `catalog_resolutions[${index}]`;
    const shapeValid = exactKeys(resolution, CATALOG_RESOLUTION_KEYS_V31)
      && CATALOG_RESOLUTION_STATUSES_V31.has(resolution?.status)
      && typeof resolution?.item_ref === 'string' && resolution.item_ref.length > 0;
    if (!shapeValid) {
      errors.push(validationError('catalog_resolution_shape_invalid', path));
      continue;
    }
    const occurrence = typeof resolution.evidence_quote === 'string'
      ? findOccurrence(messageText, resolution.evidence_quote, resolution.evidence_occurrence)
      : null;
    if (!occurrence) {
      errors.push(validationError(
        'catalog_resolution_evidence_not_found', `${path}.evidence_quote`, [], [],
        CATALOG_RESOLUTION_EVIDENCE_NOT_FOUND_INSTRUCTION_V31,
      ));
      continue;
    }
    if (resolution.status === 'matched') {
      const grounding = groundingEntries(policy).find((entry) => entry.ref === resolution.grounding_ref);
      if (!grounding || grounding.concept !== 'product') {
        errors.push(validationError(
          'catalog_resolution_grounding_invalid', `${path}.grounding_ref`, [], groundingRefsForConcept(policy, 'product'),
        ));
        continue;
      }
    } else if (resolution.grounding_ref !== null) {
      errors.push(validationError('catalog_resolution_grounding_forbidden', `${path}.grounding_ref`));
      continue;
    }
    catalogResolutionByRef.set(resolution.item_ref, resolution);
    validCatalogResolutionRefs.add(resolution.item_ref);
  }

  const primaryRequest = proposalObject.primary_request;
  let primaryRequestValid = primaryRequest === null;
  if (primaryRequest !== null) {
    const itemRefOk = primaryRequest?.item_ref === null
      || (typeof primaryRequest?.item_ref === 'string' && primaryRequest.item_ref.length > 0);
    const requestGoalValid = typeof primaryRequest?.goal_id === 'string'
      && (primaryRequest.goal_id === FINAL_CONFIRMATION_GOAL
        || ITEM_FIELDS.has(primaryRequest.goal_id)
        || (policy?.goals || []).some((goal) => goal.goal_id === primaryRequest.goal_id));
    primaryRequestValid = exactKeys(primaryRequest, PRIMARY_REQUEST_KEYS_V31) && itemRefOk && requestGoalValid;
    if (!primaryRequestValid) errors.push(validationError('primary_request_invalid', 'primary_request'));
    // Task 3c.18 (live 2026-09-28): the model asked item questions (the
    // pandereta clarification, the 3c.17 distributive assignment) with the
    // customer's `name` goal plus an item_ref. Only the item goals (and the
    // line_items equivalent accepted for item clarification below) may be
    // item-scoped; a quote-level goal takes item_ref null.
    if (primaryRequestValid && typeof primaryRequest.item_ref === 'string'
        && !ITEM_SCOPED_REQUEST_GOALS_V31.has(primaryRequest.goal_id)) {
      errors.push(validationError(
        'primary_request_item_ref_invalid', 'primary_request.item_ref', [primaryRequest.goal_id], [null],
        `Goal "${primaryRequest.goal_id}" is a quote-level goal, so primary_request.item_ref must be null for it. To ask or confirm something about one item use goal_id "product", "quantity" or "measurements" with that item's item_ref (for example, clarifying which product the customer means is "product"; confirming which items a quantity applies to is "quantity"). goal_id "name" only asks for the customer's own name.`,
      ));
    }
  }

  const observations = Array.isArray(proposalObject.observations) ? proposalObject.observations : [];
  if (!Array.isArray(proposalObject.observations)) errors.push(validationError('observations_invalid', 'observations'));
  const observationIds = new Set();
  // Design D11/Interfaces: v3.1's policy exposes a single quote-level
  // `line_items` goal (no per-item product/quantity/measurements goal is
  // emitted — see design.md's Deviations note). An item-scoped observation
  // legitimately resolves the field it observed, so the three item concept
  // names are known goal references too, exactly like `primary_request`'s
  // `requestGoalValid` below already treats them.
  const knownGoalIds = new Set([...(policy?.goals || []).map((goal) => goal.goal_id), ...ITEM_FIELDS]);
  for (const [index, observationEntry] of observations.entries()) {
    const path = `observations[${index}]`;
    let valid = exactKeys(observationEntry, OBSERVATION_KEYS_V31)
      && typeof observationEntry.id === 'string'
      && observationEntry.id.length > 0
      && typeof observationEntry.concept === 'string'
      && typeof observationEntry.raw_value === 'string'
      && typeof observationEntry.evidence_quote === 'string'
      && Array.isArray(observationEntry.resolves_goal_ids)
      && (observationEntry.item_ref === null
        || (typeof observationEntry.item_ref === 'string' && observationEntry.item_ref.length > 0));
    if (!valid) {
      errors.push(validationError('observation_shape_invalid', path));
      continue;
    }
    if (observationIds.has(observationEntry.id)) {
      errors.push(validationError('observation_id_duplicate', `${path}.id`, [observationEntry.id]));
      valid = false;
    }
    observationIds.add(observationEntry.id);
    if (observationEntry.resolves_goal_ids.some((goalId) => goalId !== 'line_items' && !knownGoalIds.has(goalId))) {
      errors.push(validationError('goal_reference_unknown', `${path}.resolves_goal_ids`, [observationEntry.id]));
      valid = false;
    }
    const occurrence = findOccurrence(messageText, observationEntry.evidence_quote, observationEntry.evidence_occurrence);
    if (!occurrence) {
      errors.push(validationError('evidence_quote_not_found', `${path}.evidence_quote`, [observationEntry.id]));
      valid = false;
    }
    if (GROUNDED_CONCEPTS.has(observationEntry.concept)) {
      const grounding = groundingEntries(policy).find((entry) => entry.ref === observationEntry.grounding_ref);
      const canonicalGroundedValue = groundingValue(grounding);
      const groundingValid = grounding
        && (!grounding.concept || grounding.concept === observationEntry.concept)
        && canonicalGroundedValue !== null
        && canonicalGroundedValue !== undefined
        && sameGroundedValue(canonicalGroundedValue, normalizedComparable(observationEntry.normalized_value));
      if (!groundingValid) {
        errors.push(validationError(
          'grounding_invalid', `${path}.grounding_ref`, [observationEntry.id],
          groundingRefsForConcept(policy, observationEntry.concept),
          'Replace grounding_ref with one allowed value, or remove this observation and every dependent mutation.',
        ));
        valid = false;
      }
      if (groundingValid && observationEntry.concept === 'service_scope') {
        const scopeError = serviceScopeBothEvidenceError(policy, canonicalGroundedValue, messageText, occurrence, observationEntry, path);
        if (scopeError) { errors.push(scopeError); valid = false; }
      }
      if (groundingValid && observationEntry.concept === 'fulfillment') {
        const fulfillmentError = fulfillmentEvidenceError(policy, canonicalGroundedValue, messageText, occurrence, observationEntry, path);
        if (fulfillmentError) { errors.push(fulfillmentError); valid = false; }
      }
    } else if (observationEntry.grounding_ref !== null) {
      errors.push(validationError(
        'grounding_ref_forbidden', `${path}.grounding_ref`, [observationEntry.id], [],
        'Use grounding_ref null for evidence-backed free-text concepts.',
      ));
      valid = false;
    }
    if (observationEntry.concept === 'address') {
      const addressError = addressRequiresStreetDetailsError(policy, observations, observationEntry, path);
      if (addressError) { errors.push(addressError); valid = false; }
    }
    if (valid && occurrence) {
      const startByte = utf8Length(messageText.slice(0, occurrence.index));
      const endByte = startByte + utf8Length(observationEntry.evidence_quote);
      candidateObservations.push({
        ...jsonClone(observationEntry),
        ...(GROUNDED_CONCEPTS.has(observationEntry.concept) ? {
          normalized_value: jsonClone(groundingValue(
            groundingEntries(policy).find((entry) => entry.ref === observationEntry.grounding_ref),
          )),
        } : {}),
        evidence: {
          message_id: policy.turn.message.id,
          quote: observationEntry.evidence_quote,
          occurrence: observationEntry.evidence_occurrence,
          start_byte: startByte,
          end_byte: endByte,
          sha256: sha256(`${policy.turn.message.id}\u0000${startByte}\u0000${endByte}\u0000${observationEntry.evidence_quote}`),
        },
      });
    }
  }

  const observationsById = new Map(candidateObservations.map((observationEntry) => [observationEntry.id, observationEntry]));

  // Every item this turn touches: existing items known before the turn, plus
  // any item_ref introduced this turn via an item-field observation or a
  // catalog_resolutions entry.
  const touchedItemRefs = new Set(existingItems.keys());
  for (const observationEntry of candidateObservations) {
    if (ITEM_FIELDS.has(observationEntry.concept) && observationEntry.item_ref) touchedItemRefs.add(observationEntry.item_ref);
  }
  for (const ref of validCatalogResolutionRefs) touchedItemRefs.add(ref);

  // A first turn can introduce several items even when none existed before it.
  // In that case a null item_ref must not materialize a third, flat item.
  const unscopedItemObservationIds = new Set();
  const newMultiItemProposal = existingItems.size < 2 && touchedItemRefs.size >= 2;
  const itemScopeValues = [...touchedItemRefs].sort();
  const itemScopeInstruction = `Set item_ref to the item whose product this value describes (one of: ${itemScopeValues.join(', ')}); a quantity or measurement written next to a product belongs to that product's item. Never leave a product, quantity or measurements observation or state_mutation without item_ref when the quote has several items.`;
  if (newMultiItemProposal) {
    for (const [index, observationEntry] of observations.entries()) {
      if (!ITEM_FIELDS.has(observationEntry?.concept) || observationEntry.item_ref !== null
          || !observationsById.has(observationEntry.id)) continue;
      errors.push(validationError('item_field_unscoped', `observations[${index}].item_ref`,
        [observationEntry.id], itemScopeValues, itemScopeInstruction));
      unscopedItemObservationIds.add(observationEntry.id);
    }
  }

  // item_identity_required: a genuinely new item must be introduced through
  // a catalog_resolutions entry (matched, ambiguous or unsupported).
  for (const ref of touchedItemRefs) {
    if (existingItems.has(ref) || validCatalogResolutionRefs.has(ref)) continue;
    errors.push(validationError('item_identity_required', 'catalog_resolutions', [ref]));
  }

  if (touchedItemRefs.size > MAX_LINE_ITEMS) {
    errors.push(validationError(
      'line_items_limit_exceeded', 'state_mutations', [], [],
      'Ask the customer to prioritize which items to keep, or hand off.',
    ));
  }

  for (const ref of validCatalogResolutionRefs) {
    const resolution = catalogResolutionByRef.get(ref);
    if (resolution.status === 'matched'
        && !candidateObservations.some((observationEntry) => observationEntry.item_ref === ref
          && observationEntry.concept === 'product' && observationEntry.grounding_ref === resolution.grounding_ref)) {
      errors.push(validationError(
        'catalog_resolution_product_observation_required', 'catalog_resolutions', [ref],
        groundingRefsForConcept(policy, 'product'),
      ));
    }
  }
  const ambiguousRefs = [...catalogResolutionByRef.values()]
    .filter((resolution) => resolution.status === 'ambiguous')
    .map((resolution) => resolution.item_ref);
  // Design's literal is `goal_id:'product'`. The policy only ever exposes the
  // single quote-level `line_items` goal for items (no per-item goal), so a
  // `primary_request` naming that item's `line_items` goal, scoped to the
  // exact ambiguous item_ref, asks the identical question with no less
  // specificity — accepted as an equivalent literal, never a looser one.
  if (ambiguousRefs.length > 0
      && !(primaryRequestValid && ['product', 'line_items'].includes(primaryRequest?.goal_id)
        && ambiguousRefs.includes(primaryRequest.item_ref))) {
    errors.push(validationError(
      'catalog_resolution_clarification_required', 'primary_request', ambiguousRefs, ['product'],
      'Ask one focused clarification that distinguishes the possible grounded products for the ambiguous item.',
    ));
  }

  // Composed from v3's quantity_observation_required (design.md D11): an
  // ambiguous/unsupported item already gets its own clarification notice
  // above, so this generic quote-level nag only fires when no item is
  // currently blocked on catalog resolution.
  const anyAmbiguousOrUnsupportedItem = [...catalogResolutionByRef.values()]
    .some((resolution) => ['ambiguous', 'unsupported'].includes(resolution.status));
  const tracksLineItemsGoal = (policy?.goals || []).some((goal) => goal.goal_id === 'line_items');
  const hasQuantityObservationV31 = candidateObservations.some((entry) => entry.concept === 'quantity');
  // Task 3c.21: the catalog refs this proposal ties to an item (its matched
  // resolution and its product observation), for the linear-only rule.
  const linearOnlyGroundingRefsFor = (itemRef) => [
    ...(catalogResolutionByRef.get(itemRef)?.status === 'matched' ? [catalogResolutionByRef.get(itemRef).grounding_ref] : []),
    ...candidateObservations
      .filter((entry) => entry.item_ref === itemRef && entry.concept === 'product')
      .map((entry) => entry.grounding_ref),
  ].filter((ref) => typeof ref === 'string');
  // Task 3c.21: when the only explicit quantity in the message is an area
  // (m²) and the proposal asks for the quantity of a linear-only item
  // (Cierros de Hormigón), leaving the m² out is the required behavior
  // (linear_quantity_required), so this nag does not fire. Any other explicit
  // quantity in the message still requires its observation.
  const asksLinearQuantityForAreaOnlyMessage = isObject(primaryRequest)
    && primaryRequest.goal_id === 'quantity' && typeof primaryRequest.item_ref === 'string'
    && !hasExplicitQuantityEvidence(messageText.replace(AREA_QUANTITY_IN_MESSAGE_V31, ' '))
    && isLinearOnlyProductV31(
      policy,
      candidateObservations.find((entry) => entry.item_ref === primaryRequest.item_ref && entry.concept === 'product')?.normalized_value
        ?? existingItems.get(primaryRequest.item_ref)?.product ?? null,
      linearOnlyGroundingRefsFor(primaryRequest.item_ref),
    );
  if (!anyAmbiguousOrUnsupportedItem && tracksLineItemsGoal && !asksLinearQuantityForAreaOnlyMessage
      && hasExplicitQuantityEvidence(messageText) && !hasQuantityObservationV31) {
    errors.push(quantityObservationRequiredError());
  }

  const factsById = new Map((policy?.facts || []).map((fact) => [fact.fact_id, fact]));
  const allowedMutations = Array.isArray(policy?.state_authority?.allowed_mutations)
    ? policy.state_authority.allowed_mutations
    : [];
  const mutations = Array.isArray(proposalObject.state_mutations) ? proposalObject.state_mutations : [];
  if (!Array.isArray(proposalObject.state_mutations)) errors.push(validationError('state_mutations_invalid', 'state_mutations'));
  const seenMutationTargets = new Set();
  // 3c.7 (design.md D4/Requirement "Item-Scoped Line Items...": a quantity
  // or measurement fact MUST attach only to the item its evidence names).
  // Live A/B round 2 found the model sometimes reused the exact same
  // evidenced text (same evidence_quote + evidence_occurrence in this
  // message) to resolve the same item concept on two different items —
  // copying or duplicating a fact instead of attaching it once. That one
  // shape is deterministically detectable: the same (field, evidence_quote,
  // evidence_occurrence) triple can never legitimately authorize two
  // different item_ref values in one proposal. A single span reattached to
  // the *wrong* item (no duplicate) has no such signal and is not caught
  // here — see design.md's Deviations/D11 follow-up notes and the v3.1
  // prompt rule added in task 3c.8.
  const evidenceSpanItemsByField = new Map();
  const existingItemCountPreTurn = existingItems.size;
  for (const [index, mutation] of mutations.entries()) {
    const path = `state_mutations[${index}]`;
    if (mutation?.operation === 'remove_item') {
      const observationEntry = observationsById.get(mutation?.observation_id);
      if (!exactKeys(mutation, MUTATION_KEYS_V31) || typeof mutation.item_ref !== 'string' || !mutation.item_ref || !observationEntry) {
        errors.push(validationError('mutation_shape_invalid', path, mutation?.observation_id ? [mutation.observation_id] : []));
        continue;
      }
      const targetKey = `remove_item\u0000${mutation.item_ref}`;
      if (seenMutationTargets.has(targetKey)) {
        errors.push(validationError('mutation_target_duplicate', path, [mutation.item_ref]));
        continue;
      }
      seenMutationTargets.add(targetKey);
      candidateMutations.push({
        operation: 'remove_item', field: null, item_ref: mutation.item_ref,
        observation_id: observationEntry.id, replaces_fact_id: null, projected_value: null,
      });
      continue;
    }

    const observationEntry = observationsById.get(mutation?.observation_id);
    if (!exactKeys(mutation, MUTATION_KEYS_V31) || !['set', 'replace'].includes(mutation?.operation) || !observationEntry) {
      errors.push(validationError('mutation_shape_invalid', path, mutation?.observation_id ? [mutation.observation_id] : []));
      continue;
    }
    const canonicalField = CONCEPT_TO_FIELD[observationEntry.concept];
    const allowed = allowedMutations.some((entry) => entry.operation === mutation.operation
      && entry.concept === observationEntry.concept
      && entry.field === mutation.field);
    if (!canonicalField || canonicalField !== mutation.field || !allowed) {
      errors.push(validationError('mutation_mapping_forbidden', `${path}.field`, [observationEntry.id], canonicalField ? [canonicalField] : []));
      continue;
    }
    if (mutation.operation === 'set' && mutation.replaces_fact_id !== null) {
      errors.push(validationError('set_cannot_replace_fact', `${path}.replaces_fact_id`, [observationEntry.id]));
      continue;
    }
    if (mutation.operation === 'replace') {
      const fact = factsById.get(mutation.replaces_fact_id);
      const factItemId = itemIdFromFactId(mutation.replaces_fact_id);
      const factMatchesItem = ITEM_FIELDS.has(mutation.field)
        ? factItemId !== null && factItemId === (mutation.item_ref ?? factItemId)
        : factItemId === null;
      if (!fact || fact.field !== mutation.field || fact.mutability !== 'customer_correctable' || !factMatchesItem) {
        const guidance = itemFactNotReplaceableGuidanceV31(factsById, existingItems, mutation);
        errors.push(validationError(
          'fact_not_replaceable', `${path}.replaces_fact_id`, [observationEntry.id],
          guidance?.allowedValues ?? [], guidance?.instruction ?? null,
        ));
        continue;
      }
    }

    let itemRef = mutation.item_ref ?? null;
    if (ITEM_FIELDS.has(mutation.field)) {
      if (itemRef === null) {
        if (newMultiItemProposal) {
          if (!unscopedItemObservationIds.has(observationEntry.id)) {
            errors.push(validationError('item_field_unscoped', `${path}.item_ref`,
              [observationEntry.id], itemScopeValues, itemScopeInstruction));
          }
          continue;
        }
        if (existingItemCountPreTurn >= 2) {
          errors.push(validationError(
            'item_target_required', `${path}.item_ref`, [observationEntry.id], [],
            'Drop this mutation and ask which item it refers to.',
          ));
          continue;
        }
        itemRef = existingItemCountPreTurn === 1 ? [...existingItems.keys()][0] : FLAT_ITEM_ID;
      }
      const targetKey = `${itemRef}\u0000${mutation.field}`;
      if (seenMutationTargets.has(targetKey)) {
        errors.push(validationError('mutation_target_duplicate', path, [observationEntry.id]));
        continue;
      }
      seenMutationTargets.add(targetKey);

      const evidenceSpanKey = `${mutation.field}\u0000${observationEntry.evidence_quote}\u0000${observationEntry.evidence_occurrence}`;
      const evidenceSpan = evidenceSpanItemsByField.get(evidenceSpanKey);
      if (evidenceSpan !== undefined && evidenceSpan.itemRef !== itemRef
          && !isDistributiveQuantitySpanV31(mutation.field, observationEntry, evidenceSpan.observation)) {
        errors.push(validationError(
          'item_evidence_span_conflict', path, [observationEntry.id], [],
          'This evidence already resolved this concept for a different item; attach it only to the item its evidence names, or drop this mutation and ask which item it refers to.',
        ));
        continue;
      }
      if (evidenceSpan === undefined) {
        evidenceSpanItemsByField.set(evidenceSpanKey, { itemRef, observation: observationEntry, entries: [] });
      }
      evidenceSpanItemsByField.get(evidenceSpanKey).entries.push({
        itemRef, field: mutation.field, operation: mutation.operation, path, observationId: observationEntry.id, observation: observationEntry,
      });

      if (mutation.field === 'product') {
        const resolution = catalogResolutionByRef.get(itemRef);
        if (resolution && ['ambiguous', 'unsupported'].includes(resolution.status)) {
          withheldMutations.push({
            operation: mutation.operation, field: mutation.field, item_ref: itemRef,
            observation_id: observationEntry.id, replaces_fact_id: mutation.replaces_fact_id,
            projected_value: jsonClone(observationEntry.normalized_value),
          });
          continue;
        }
      }
    } else {
      const targetKey = `\u0000${mutation.field}`;
      if (seenMutationTargets.has(targetKey)) {
        errors.push(validationError('mutation_target_duplicate', path, [observationEntry.id]));
        continue;
      }
      seenMutationTargets.add(targetKey);
    }

    candidateMutations.push({
      operation: mutation.operation,
      field: mutation.field,
      item_ref: ITEM_FIELDS.has(mutation.field) ? itemRef : null,
      observation_id: observationEntry.id,
      replaces_fact_id: mutation.replaces_fact_id,
      projected_value: jsonClone(observationEntry.normalized_value),
    });
  }

  // item_product_not_recorded (live 2026-09-28, conversation 347): a product
  // the customer requests for an item that has no product yet — a `matched`
  // new item, or an existing item with no product fact — only reaches the
  // quote through a product state_mutation. Without one the item silently
  // vanishes. Exempt: D5-withheld items (ambiguous/unsupported resolution),
  // items removed in this proposal, items whose product is already a fact
  // (restating or comparing), unresolved new handles (item_identity_required
  // already fires) and item_ref:null observations (item-scope rules own them).
  const removedItemRefsThisTurn = new Set(mutations
    .filter((mutation) => mutation?.operation === 'remove_item' && typeof mutation.item_ref === 'string')
    .map((mutation) => mutation.item_ref));
  for (const [index, observationEntry] of observations.entries()) {
    if (observationEntry?.concept !== 'product' || !observationsById.has(observationEntry.id)) continue;
    const itemRef = observationEntry.item_ref;
    if (typeof itemRef !== 'string' || removedItemRefsThisTurn.has(itemRef)) continue;
    const resolution = catalogResolutionByRef.get(itemRef);
    if (resolution && ['ambiguous', 'unsupported'].includes(resolution.status)) continue;
    const productPending = existingItems.has(itemRef)
      ? !hasResolvedValue(existingItems.get(itemRef).product)
      : resolution?.status === 'matched';
    if (!productPending) continue;
    const recorded = mutations.some((mutation) => mutation?.field === 'product'
      && (mutation.item_ref === itemRef || mutation.observation_id === observationEntry.id));
    if (recorded) continue;
    errors.push(validationError(
      'item_product_not_recorded', `observations[${index}]`, [observationEntry.id], [itemRef],
      `Add a state_mutation with operation "set", field "product", item_ref "${itemRef}", observation_id "${observationEntry.id}" and replaces_fact_id null. Every product the customer requests, including accessories such as wire or concertina mentioned "with" another product, is its own item and needs its own product mutation; never leave a product observation without its mutation.`,
    ));
  }

  for (const rule of policy?.claim_authority?.rules || []) {
    if (rule?.kind !== 'forbidden_pattern' || typeof rule.pattern !== 'string') continue;
    let pattern;
    try {
      pattern = new RegExp(rule.pattern, String(rule.flags || 'iu').replace(/g/g, ''));
    } catch (_error) {
      errors.push(validationError('claim_rule_invalid', 'policy.claim_authority.rules', [rule.rule_id].filter(Boolean)));
      continue;
    }
    if (pattern.test(proposalObject.reply_text || '')) {
      errors.push(validationError('forbidden_claim', 'reply_text', [rule.rule_id].filter(Boolean)));
    }
  }

  // line_items resolution: 1-10 remaining items, each with a non-null
  // product (never one withheld pending clarification) and quantity.
  const removedItemRefs = new Set(
    candidateMutations.filter((mutation) => mutation.operation === 'remove_item').map((mutation) => mutation.item_ref),
  );
  const remainingItemRefs = [...touchedItemRefs].filter((ref) => !removedItemRefs.has(ref));
  const productFor = (ref) => {
    const resolution = catalogResolutionByRef.get(ref);
    if (resolution && ['ambiguous', 'unsupported'].includes(resolution.status)) return null;
    const observed = candidateObservations.find((entry) => entry.item_ref === ref && entry.concept === 'product');
    if (observed) return observed.normalized_value;
    return existingItems.get(ref)?.product ?? null;
  };
  const quantityFor = (ref) => {
    const observed = candidateObservations.find((entry) => entry.item_ref === ref && entry.concept === 'quantity');
    if (observed) return observed.normalized_value;
    return existingItems.get(ref)?.quantity ?? null;
  };
  errors.push(...distributiveSpanErrorsV31({
    spans: [...evidenceSpanItemsByField.values()].map((span) => span.entries),
    messageText,
    existingItems,
    factsById,
    productByRef: new Map([...touchedItemRefs].map((ref) => [ref, productFor(ref)])),
    catalogEntries: groundingEntries(policy),
    primaryRequest: isObject(primaryRequest) ? primaryRequest : null,
    effectRequests: Array.isArray(proposalObject.effect_requests) ? proposalObject.effect_requests : [],
  }));
  // Task 3c.21: a linear-only product (Cierros de Hormigón) never takes an
  // area as its quantity; the repair asks for the linear meters and height.
  for (const [index, mutation] of mutations.entries()) {
    if (mutation?.field !== 'quantity' || !['set', 'replace'].includes(mutation?.operation)) continue;
    const candidate = candidateMutations.find((entry) => entry.field === 'quantity' && entry.observation_id === mutation.observation_id);
    if (!candidate || !isAreaUnitV31(candidate.projected_value?.unit)) continue;
    const itemRef = candidate.item_ref;
    if (!isLinearOnlyProductV31(policy, productFor(itemRef), linearOnlyGroundingRefsFor(itemRef))) continue;
    errors.push(validationError(
      'linear_quantity_required', `state_mutations[${index}]`, [mutation.observation_id], [itemRef],
      linearQuantityInstructionV31(itemRef),
    ));
  }
  const unresolvedProductRefs = remainingItemRefs.filter((ref) => !hasResolvedValue(productFor(ref))).map((ref) => `product@${ref}`);
  const unresolvedQuantityRefs = remainingItemRefs.filter((ref) => !hasResolvedValue(quantityFor(ref))).map((ref) => `quantity@${ref}`);
  // Items unresolved ONLY because this proposal's own unsupported/ambiguous
  // resolution withholds a product the policy already holds, with evidence
  // that names no catalog product: the repair hint says to drop it.
  const spuriousResolutionProductIds = new Set(remainingItemRefs
    .filter((ref) => {
      const resolution = catalogResolutionByRef.get(ref);
      return resolution && ['ambiguous', 'unsupported'].includes(resolution.status)
        && hasResolvedValue(existingItems.get(ref)?.product)
        && !quoteNamesCatalogProductV31(policy, resolution.evidence_quote);
    })
    .map((ref) => `product@${ref}`));
  const spuriousResolutionInstructionFor = (unresolvedIds) => {
    const itemRefs = unresolvedIds.filter((id) => spuriousResolutionProductIds.has(id)).map((id) => id.slice('product@'.length));
    return itemRefs.length > 0 ? spuriousCatalogResolutionInstructionV31(itemRefs) : null;
  };
  const lineItemsResolved = remainingItemRefs.length >= 1 && remainingItemRefs.length <= MAX_LINE_ITEMS
    && unresolvedProductRefs.length === 0 && unresolvedQuantityRefs.length === 0;

  const permissions = new Set((policy?.effect_authority?.permissions || []).map((permission) => permission.type));
  const requirements = new Map((policy?.effect_authority?.requirements || []).map((requirement) => [requirement.effect_type, requirement]));
  const resolvedGoalIds = new Set([
    ...(policy?.goals || []).filter((goal) => goal.status === 'resolved').map((goal) => goal.goal_id),
    ...candidateObservations.flatMap((observationEntry) => observationEntry.resolves_goal_ids),
  ]);
  if (lineItemsResolved) resolvedGoalIds.add('line_items');
  const createLeadRequirement = requirements.get('create_lead');
  const createLeadRequiredGoalIds = effectiveRequiredGoalIdsV31(
    createLeadRequirement?.required_goal_ids, policy, candidateObservations,
  );
  const createLeadUnresolvedRaw = createLeadRequiredGoalIds.filter((goalId) => goalId !== 'line_items' && !resolvedGoalIds.has(goalId));
  const createLeadUnresolved = (lineItemsResolved || !createLeadRequiredGoalIds.includes('line_items'))
    ? createLeadUnresolvedRaw
    : [...createLeadUnresolvedRaw, ...unresolvedProductRefs, ...unresolvedQuantityRefs];
  const unresolvedPolicyGoalIds = (policy?.goals || [])
    .filter((goal) => goal.status !== 'resolved' && !resolvedGoalIds.has(goal.goal_id))
    .map((goal) => goal.goal_id);
  const allowedNextGoalIds = createLeadRequirement
    ? (createLeadUnresolved.length > 0 ? createLeadUnresolved : [FINAL_CONFIRMATION_GOAL])
    : unresolvedPolicyGoalIds;
  const persistedConflictClarification = isPersistedInstallationConflictClarification(
    policy, candidateObservations, candidateMutations, proposalObject, primaryRequestValid,
  );
  if (primaryRequestValid && primaryRequest !== null && primaryRequest.item_ref === null
      && resolvedGoalIds.has(primaryRequest.goal_id) && !persistedConflictClarification) {
    errors.push(validationError(
      'primary_request_goal_resolved', 'primary_request.goal_id', [primaryRequest.goal_id], allowedNextGoalIds,
      'Remove the request or ask for one of the allowed unresolved goals.',
    ));
  }
  if (primaryRequestValid && primaryRequest?.goal_id === FINAL_CONFIRMATION_GOAL && createLeadUnresolved.length > 0) {
    const spuriousInstruction = spuriousResolutionInstructionFor(createLeadUnresolved);
    errors.push(validationError(
      'final_confirmation_not_ready', 'primary_request.goal_id', createLeadUnresolved, createLeadUnresolved,
      ['Ask for one unresolved required goal instead of asking for final confirmation.', spuriousInstruction]
        .filter(Boolean).join(' '),
    ));
  }

  // Composed from v3's pickup_factory_address_required and
  // primary_request_goal_inapplicable (design.md D11): both are quote-level
  // (service_scope/fulfillment are quote-level facts, never item-scoped).
  const requestedGoal = primaryRequestValid ? primaryRequest?.goal_id : null;
  const serviceScope = projectedValueFor(policy, candidateObservations, 'service_scope');
  const fulfillment = projectedValueFor(policy, candidateObservations, 'fulfillment');
  const installationDeliveryError = installationRequiresDeliveryError(policy, serviceScope, fulfillment);
  if (installationDeliveryError && !persistedConflictClarification) errors.push(installationDeliveryError);
  const normalizedReplyText = String(proposalObject.reply_text || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '').toLocaleLowerCase('es');
  const normalizedTurnText = String(messageText || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '').toLocaleLowerCase('es');
  const asksPickupLocation = /\b(?:donde|direccion|ubicacion|lugar)\b/.test(normalizedTurnText)
    && /\b(?:retir\w*|retiro|planta|fabrica|tienda)\b/.test(normalizedTurnText);
  const pickupAddressRequired = serviceScope === 'material' && fulfillment === 'pickup'
    && (requestedGoal === FINAL_CONFIRMATION_GOAL || asksPickupLocation);
  if (pickupAddressRequired) {
    const pickupError = pickupFactoryAddressRequiredError(normalizedReplyText);
    if (pickupError) errors.push(pickupError);
  }
  const goalInapplicableError = primaryRequestGoalInapplicableError(requestedGoal, serviceScope, allowedNextGoalIds);
  if (goalInapplicableError) errors.push(goalInapplicableError);

  const pendingQuestionGoalId = policy?.turn?.pending_question_goal_id || null;
  const createLeadDirectlyRequested = hasExplicitCreateLeadDirective(messageText);
  const hydratesPriorRequest = candidateObservations.some((observationEntry) => {
    const field = CONCEPT_TO_FIELD[observationEntry.concept];
    return field && matchesPriorRequestValue(policy, field, observationEntry.normalized_value, observationEntry.evidence);
  });
  const createLeadAuthorized = pendingQuestionGoalId === FINAL_CONFIRMATION_GOAL
    || (createLeadDirectlyRequested && !hydratesPriorRequest);

  const effects = Array.isArray(proposalObject.effect_requests) ? proposalObject.effect_requests : [];
  if (!Array.isArray(proposalObject.effect_requests)) errors.push(validationError('effect_requests_invalid', 'effect_requests'));
  for (const [index, effect] of effects.entries()) {
    const path = `effect_requests[${index}]`;
    if (!exactKeys(effect, EFFECT_KEYS) || typeof effect.type !== 'string' || !Array.isArray(effect.reason_observation_ids)) {
      errors.push(validationError('effect_shape_invalid', path));
      continue;
    }
    if (!permissions.has(effect.type)) {
      errors.push(validationError('effect_not_permitted', `${path}.type`, [], [...permissions]));
      continue;
    }
    const unknownObservation = effect.reason_observation_ids.find((id) => !observationsById.has(id));
    if (unknownObservation) {
      errors.push(validationError('effect_observation_unknown', `${path}.reason_observation_ids`, [unknownObservation]));
      continue;
    }
    const configuredGoalIds = requirements.get(effect.type)?.required_goal_ids || [];
    const unresolved = effect.type === 'create_lead'
      ? createLeadUnresolved
      : configuredGoalIds.filter((goalId) => !resolvedGoalIds.has(goalId));
    if (unresolved.length > 0) {
      errors.push(validationError(
        'effect_prerequisite_unresolved', path, unresolved, [], spuriousResolutionInstructionFor(unresolved),
      ));
      continue;
    }
    if (effect.type === 'create_lead' && !createLeadAuthorized) {
      errors.push(validationError(
        'effect_trigger_context_invalid', path, [effect.type], [FINAL_CONFIRMATION_GOAL],
        'Create the lead only after answering a pending final_confirmation, or after a direct request to create the lead.',
      ));
      continue;
    }
    candidateEffects.push(jsonClone(effect));
  }
  for (const requirement of requirements.values()) {
    if (requirement?.trigger !== 'explicit_confirmation_when_ready') continue;
    if (!permissions.has(requirement.effect_type)) continue;
    const unresolvedForRequirement = requirement.effect_type === 'create_lead'
      ? createLeadUnresolved
      : (Array.isArray(requirement.required_goal_ids) ? requirement.required_goal_ids : [])
        .filter((goalId) => !resolvedGoalIds.has(goalId));
    const alreadyRequested = candidateEffects.some((effect) => effect.type === requirement.effect_type);
    const triggered = requirement.effect_type === 'create_lead'
      ? createLeadDirectlyRequested && !hydratesPriorRequest
      : hasExplicitConfirmation(messageText);
    if (unresolvedForRequirement.length === 0 && triggered && !alreadyRequested) {
      errors.push(validationError(
        'effect_required', 'effect_requests', [requirement.effect_type], [requirement.effect_type],
        `Add one ${requirement.effect_type} effect_request because its prerequisites and configured trigger are satisfied.`,
      ));
    }
  }

  // Composed from v3's address_retry_exhausted/address_retry_handoff_required
  // (design.md D11): quote-level only, never inspects item fields.
  errors.push(...addressRetryBoundErrors(policy, candidateMutations, primaryRequestValid, primaryRequest, permissions, candidateEffects));

  const blockingErrors = errors.filter((error) => !NON_BLOCKING_V31_CODES.has(error.code));
  const valid = blockingErrors.length === 0;
  return {
    version: V3_CONTRACTS.validation_v3_1,
    valid,
    policy_digest: policy?.policy_digest || null,
    proposal_digest: isObject(proposal) ? digestObject(proposal) : null,
    errors,
    catalog_resolutions: valid ? [...catalogResolutionByRef.values()].map(jsonClone) : [],
    withheld_mutations: valid ? withheldMutations.map(jsonClone) : [],
    accepted_observations: valid ? candidateObservations : [],
    authorized_mutations: valid ? candidateMutations : [],
    authorized_effect_requests: valid ? candidateEffects : [],
  };
};

const validateV3AiProposalV3 = (policy, proposal) => {
  const errors = [];
  const candidateObservations = [];
  const candidateMutations = [];
  const candidateEffects = [];
  const proposalObject = isObject(proposal) ? proposal : {};
  const policyDigestValid = policy?.version === V3_CONTRACTS.policy
    && typeof policy.policy_digest === 'string'
    && digestPolicy(policy) === policy.policy_digest;

  if (!policyDigestValid) errors.push(validationError('policy_invalid', 'policy'));
  if (!exactKeys(proposalObject, TOP_LEVEL_PROPOSAL_KEYS)) errors.push(validationError('proposal_shape_invalid', '$'));
  if (proposalObject.version !== V3_CONTRACTS.proposal) errors.push(validationError('proposal_version_invalid', 'version'));
  if (proposalObject.policy_digest !== policy?.policy_digest) errors.push(validationError('policy_digest_mismatch', 'policy_digest'));
  if (typeof proposalObject.reply_text !== 'string' || proposalObject.reply_text.length === 0) {
    errors.push(validationError('reply_text_invalid', 'reply_text'));
  }

  const primaryRequest = proposalObject.primary_request;
  let primaryRequestValid = primaryRequest === null;
  if (primaryRequest !== null) {
    const requestGoalValid = typeof primaryRequest?.goal_id === 'string'
      && (primaryRequest.goal_id === FINAL_CONFIRMATION_GOAL
        || (policy?.goals || []).some((goal) => goal.goal_id === primaryRequest.goal_id));
    const requestValid = exactKeys(primaryRequest, PRIMARY_REQUEST_KEYS)
      && requestGoalValid;
    primaryRequestValid = requestValid;
    if (!requestValid) errors.push(validationError('primary_request_invalid', 'primary_request'));
  }

  const observations = Array.isArray(proposalObject.observations) ? proposalObject.observations : [];
  if (!Array.isArray(proposalObject.observations)) errors.push(validationError('observations_invalid', 'observations'));
  const observationIds = new Set();
  const messageText = typeof policy?.turn?.message?.text === 'string' ? policy.turn.message.text : '';
  const catalogResolution = proposalObject.catalog_resolution;
  let catalogResolutionValid = exactKeys(catalogResolution, CATALOG_RESOLUTION_KEYS)
    && CATALOG_RESOLUTION_STATUSES.has(catalogResolution?.status);
  if (!catalogResolutionValid) {
    errors.push(validationError('catalog_resolution_shape_invalid', 'catalog_resolution'));
  } else if (catalogResolution.status === 'not_applicable') {
    if (catalogResolution.evidence_quote !== null
        || catalogResolution.evidence_occurrence !== null
        || catalogResolution.grounding_ref !== null) {
      errors.push(validationError('catalog_resolution_shape_invalid', 'catalog_resolution'));
      catalogResolutionValid = false;
    }
  } else {
    const resolutionOccurrence = typeof catalogResolution.evidence_quote === 'string'
      ? findOccurrence(messageText, catalogResolution.evidence_quote, catalogResolution.evidence_occurrence)
      : null;
    if (!resolutionOccurrence) {
      errors.push(validationError('catalog_resolution_evidence_not_found', 'catalog_resolution.evidence_quote'));
      catalogResolutionValid = false;
    }
    if (catalogResolution.status === 'matched') {
      const grounding = groundingEntries(policy).find((entry) => entry.ref === catalogResolution.grounding_ref);
      if (!grounding || grounding.concept !== 'product') {
        errors.push(validationError(
          'catalog_resolution_grounding_invalid',
          'catalog_resolution.grounding_ref',
          [],
          groundingRefsForConcept(policy, 'product'),
        ));
        catalogResolutionValid = false;
      }
    } else if (catalogResolution.grounding_ref !== null) {
      errors.push(validationError('catalog_resolution_grounding_forbidden', 'catalog_resolution.grounding_ref'));
      catalogResolutionValid = false;
    }
  }
  const knownGoalIds = new Set((policy?.goals || []).map((goal) => goal.goal_id));
  for (const [index, observation] of observations.entries()) {
    const path = `observations[${index}]`;
    let valid = exactKeys(observation, OBSERVATION_KEYS)
      && typeof observation.id === 'string'
      && observation.id.length > 0
      && typeof observation.concept === 'string'
      && typeof observation.raw_value === 'string'
      && typeof observation.evidence_quote === 'string'
      && Array.isArray(observation.resolves_goal_ids);
    if (!valid) {
      errors.push(validationError('observation_shape_invalid', path));
      continue;
    }
    if (observationIds.has(observation.id)) {
      errors.push(validationError('observation_id_duplicate', `${path}.id`, [observation.id]));
      valid = false;
    }
    observationIds.add(observation.id);
    if (observation.resolves_goal_ids.some((goalId) => !knownGoalIds.has(goalId))) {
      errors.push(validationError('goal_reference_unknown', `${path}.resolves_goal_ids`, [observation.id]));
      valid = false;
    }
    const occurrence = findOccurrence(messageText, observation.evidence_quote, observation.evidence_occurrence);
    if (!occurrence) {
      errors.push(validationError('evidence_quote_not_found', `${path}.evidence_quote`, [observation.id]));
      valid = false;
    }
    if (observation.concept === 'address') {
      const addressError = addressRequiresStreetDetailsError(policy, observations, observation, path);
      if (addressError) { errors.push(addressError); valid = false; }
    }
    if (GROUNDED_CONCEPTS.has(observation.concept)) {
      const grounding = groundingEntries(policy).find((entry) => entry.ref === observation.grounding_ref);
      const canonicalGroundedValue = groundingValue(grounding);
      const groundingValid = grounding
        && (!grounding.concept || grounding.concept === observation.concept)
        && canonicalGroundedValue !== null
        && canonicalGroundedValue !== undefined
        && sameGroundedValue(canonicalGroundedValue, normalizedComparable(observation.normalized_value));
      if (!groundingValid) {
        errors.push(validationError(
          'grounding_invalid',
          `${path}.grounding_ref`,
          [observation.id],
          groundingRefsForConcept(policy, observation.concept),
          'Replace grounding_ref with one allowed value, or remove this observation and every dependent mutation.',
        ));
        valid = false;
      }
      if (groundingValid && observation.concept === 'service_scope') {
        const scopeError = serviceScopeBothEvidenceError(policy, canonicalGroundedValue, messageText, occurrence, observation, path);
        if (scopeError) { errors.push(scopeError); valid = false; }
      }
      if (groundingValid && observation.concept === 'fulfillment') {
        const fulfillmentError = fulfillmentEvidenceError(policy, canonicalGroundedValue, messageText, occurrence, observation, path);
        if (fulfillmentError) { errors.push(fulfillmentError); valid = false; }
      }
    } else if (observation.grounding_ref !== null) {
      errors.push(validationError(
        'grounding_ref_forbidden',
        `${path}.grounding_ref`,
        [observation.id],
        [],
        'Use grounding_ref null for evidence-backed free-text concepts.',
      ));
      valid = false;
    }
    if (valid && occurrence) {
      const startByte = utf8Length(messageText.slice(0, occurrence.index));
      const endByte = startByte + utf8Length(observation.evidence_quote);
      candidateObservations.push({
        ...jsonClone(observation),
        ...(GROUNDED_CONCEPTS.has(observation.concept) ? {
          normalized_value: jsonClone(groundingValue(
            groundingEntries(policy).find((entry) => entry.ref === observation.grounding_ref),
          )),
        } : {}),
        evidence: {
          message_id: policy.turn.message.id,
          quote: observation.evidence_quote,
          occurrence: observation.evidence_occurrence,
          start_byte: startByte,
          end_byte: endByte,
          sha256: sha256(`${policy.turn.message.id}\u0000${startByte}\u0000${endByte}\u0000${observation.evidence_quote}`),
        },
      });
    }
  }

  const observationsById = new Map(candidateObservations.map((observation) => [observation.id, observation]));
  if (catalogResolutionValid && !['unsupported', 'ambiguous'].includes(catalogResolution.status)
      && (policy?.goals || []).some((goal) => goal.goal_id === 'quantity')
      && hasExplicitQuantityEvidence(messageText)
      && !candidateObservations.some((observation) => observation.resolves_goal_ids.includes('quantity'))) {
    errors.push(quantityObservationRequiredError());
  }
  if (catalogResolutionValid && catalogResolution.status === 'matched'
      && !candidateObservations.some((observation) => observation.concept === 'product'
        && observation.grounding_ref === catalogResolution.grounding_ref)) {
    errors.push(validationError(
      'catalog_resolution_product_observation_required',
      'catalog_resolution.grounding_ref',
      [],
      groundingRefsForConcept(policy, 'product'),
    ));
  }
  if (catalogResolutionValid && ['unsupported', 'ambiguous'].includes(catalogResolution.status)
      && candidateObservations.some((observation) => observation.concept === 'product')) {
    errors.push(validationError('catalog_resolution_conflict', 'observations'));
  }
  if (catalogResolutionValid && ['unsupported', 'ambiguous'].includes(catalogResolution.status)
      && primaryRequestValid && primaryRequest !== null && primaryRequest.goal_id !== 'product') {
    errors.push(validationError(
      'catalog_resolution_action_forbidden',
      'primary_request.goal_id',
      [primaryRequest.goal_id],
      ['product'],
      'Resolve the requested product before asking for downstream qualification data.',
    ));
  }
  if (catalogResolutionValid && catalogResolution.status === 'unsupported'
      && primaryRequestValid && primaryRequest?.goal_id === 'product'
      && isGenericProductRequestion(proposalObject.reply_text)) {
    errors.push(validationError(
      'catalog_resolution_action_forbidden',
      'primary_request.goal_id',
      [],
      [],
      'The customer already named an unsupported request; offer catalog alternatives instead of asking the same generic product question.',
    ));
  }
  if (catalogResolutionValid && catalogResolution.status === 'ambiguous'
      && (!primaryRequestValid || primaryRequest?.goal_id !== 'product')) {
    errors.push(validationError(
      'catalog_resolution_clarification_required',
      'primary_request',
      [],
      ['product'],
      'Ask one focused clarification that distinguishes the possible grounded products.',
    ));
  }
  const factsById = new Map((policy?.facts || []).map((fact) => [fact.fact_id, fact]));
  const allowedMutations = Array.isArray(policy?.state_authority?.allowed_mutations)
    ? policy.state_authority.allowed_mutations
    : [];
  const mutations = Array.isArray(proposalObject.state_mutations) ? proposalObject.state_mutations : [];
  if (!Array.isArray(proposalObject.state_mutations)) errors.push(validationError('state_mutations_invalid', 'state_mutations'));
  for (const [index, mutation] of mutations.entries()) {
    const path = `state_mutations[${index}]`;
    const observation = observationsById.get(mutation?.observation_id);
    if (!exactKeys(mutation, MUTATION_KEYS) || !['set', 'replace'].includes(mutation?.operation) || !observation) {
      errors.push(validationError('mutation_shape_invalid', path, mutation?.observation_id ? [mutation.observation_id] : []));
      continue;
    }
    const canonicalField = CONCEPT_TO_FIELD[observation.concept];
    const allowed = allowedMutations.some((entry) => entry.operation === mutation.operation
      && entry.concept === observation.concept
      && entry.field === mutation.field
      && (mutation.operation !== 'replace' || entry.current_fact_id === mutation.replaces_fact_id));
    if (!canonicalField || canonicalField !== mutation.field || !allowed) {
      errors.push(validationError('mutation_mapping_forbidden', `${path}.field`, [observation.id], canonicalField ? [canonicalField] : []));
      continue;
    }
    if (mutation.operation === 'set' && mutation.replaces_fact_id !== null) {
      errors.push(validationError('set_cannot_replace_fact', `${path}.replaces_fact_id`, [observation.id]));
      continue;
    }
    if (mutation.operation === 'replace') {
      const fact = factsById.get(mutation.replaces_fact_id);
      if (!fact || fact.field !== mutation.field || fact.mutability !== 'customer_correctable') {
        errors.push(validationError('fact_not_replaceable', `${path}.replaces_fact_id`, [observation.id]));
        continue;
      }
    }
    candidateMutations.push({
      operation: mutation.operation,
      field: mutation.field,
      observation_id: observation.id,
      replaces_fact_id: mutation.replaces_fact_id,
      projected_value: jsonClone(observation.normalized_value),
    });
  }

  for (const rule of policy?.claim_authority?.rules || []) {
    if (rule?.kind !== 'forbidden_pattern' || typeof rule.pattern !== 'string') continue;
    let pattern;
    try {
      pattern = new RegExp(rule.pattern, String(rule.flags || 'iu').replace(/g/g, ''));
    } catch (_error) {
      errors.push(validationError('claim_rule_invalid', 'policy.claim_authority.rules', [rule.rule_id].filter(Boolean)));
      continue;
    }
    if (pattern.test(proposalObject.reply_text || '')) {
      errors.push(validationError('forbidden_claim', 'reply_text', [rule.rule_id].filter(Boolean)));
    }
  }

  const permissions = new Set((policy?.effect_authority?.permissions || []).map((permission) => permission.type));
  const requirements = new Map((policy?.effect_authority?.requirements || []).map((requirement) => [requirement.effect_type, requirement]));
  const resolvedGoalIds = new Set([
    ...(policy?.goals || []).filter((goal) => goal.status === 'resolved').map((goal) => goal.goal_id),
    ...candidateObservations.flatMap((observation) => observation.resolves_goal_ids),
  ]);
  const createLeadRequirement = requirements.get('create_lead');
  const createLeadRequiredGoalIds = effectiveRequiredGoalIds(
    createLeadRequirement?.required_goal_ids,
    policy,
    candidateObservations,
  );
  const createLeadUnresolved = createLeadRequiredGoalIds.filter((goalId) => !resolvedGoalIds.has(goalId));
  const unresolvedPolicyGoalIds = (policy?.goals || [])
    .filter((goal) => goal.status !== 'resolved' && !resolvedGoalIds.has(goal.goal_id))
    .map((goal) => goal.goal_id);
  const allowedNextGoalIds = createLeadRequirement
    ? (createLeadUnresolved.length > 0 ? createLeadUnresolved : [FINAL_CONFIRMATION_GOAL])
    : unresolvedPolicyGoalIds;
  const persistedConflictClarification = isPersistedInstallationConflictClarification(
    policy, candidateObservations, candidateMutations, proposalObject, primaryRequestValid,
  );
  if (primaryRequestValid && primaryRequest !== null && resolvedGoalIds.has(primaryRequest.goal_id)
      && !persistedConflictClarification) {
    errors.push(validationError(
      'primary_request_goal_resolved',
      'primary_request.goal_id',
      [primaryRequest.goal_id],
      allowedNextGoalIds,
      'Remove the request or ask for one of the allowed unresolved goals.',
    ));
  }
  const pendingQuestionGoalId = policy?.turn?.pending_question_goal_id || null;
  const createLeadDirectlyRequested = hasExplicitCreateLeadDirective(messageText);
  const hydratesPriorRequest = candidateObservations.some((observation) => {
    const field = CONCEPT_TO_FIELD[observation.concept];
    return field && matchesPriorRequestValue(policy, field, observation.normalized_value, observation.evidence);
  });
  // The proposal owns the semantic interpretation of an answer to the pending
  // final confirmation. Deterministic validation still owns context, readiness,
  // permissions, and direct imperative requests.
  const createLeadAuthorized = pendingQuestionGoalId === FINAL_CONFIRMATION_GOAL
    || (createLeadDirectlyRequested && !hydratesPriorRequest);
  if (primaryRequestValid && primaryRequest?.goal_id === FINAL_CONFIRMATION_GOAL
      && createLeadUnresolved.length > 0) {
    errors.push(validationError(
      'final_confirmation_not_ready',
      'primary_request.goal_id',
      createLeadUnresolved,
      createLeadUnresolved,
      'Ask for one unresolved required goal instead of asking for final confirmation.',
    ));
  }
  const requestedGoal = primaryRequestValid ? primaryRequest?.goal_id : null;
  const serviceScope = projectedValueFor(policy, candidateObservations, 'service_scope');
  const fulfillment = projectedValueFor(policy, candidateObservations, 'fulfillment');
  const installationDeliveryError = installationRequiresDeliveryError(policy, serviceScope, fulfillment);
  if (installationDeliveryError && !persistedConflictClarification) errors.push(installationDeliveryError);
  const normalizedReplyText = String(proposalObject.reply_text || '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLocaleLowerCase('es');
  const normalizedTurnText = String(messageText || '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLocaleLowerCase('es');
  const asksPickupLocation = /\b(?:donde|direccion|ubicacion|lugar)\b/.test(normalizedTurnText)
    && /\b(?:retir\w*|retiro|planta|fabrica|tienda)\b/.test(normalizedTurnText);
  const pickupAddressRequired = serviceScope === 'material' && fulfillment === 'pickup'
    && (requestedGoal === FINAL_CONFIRMATION_GOAL || asksPickupLocation);
  if (pickupAddressRequired) {
    const pickupError = pickupFactoryAddressRequiredError(normalizedReplyText);
    if (pickupError) errors.push(pickupError);
  }
  const goalInapplicableError = primaryRequestGoalInapplicableError(requestedGoal, serviceScope, allowedNextGoalIds);
  if (goalInapplicableError) errors.push(goalInapplicableError);
  const effects = Array.isArray(proposalObject.effect_requests) ? proposalObject.effect_requests : [];
  if (!Array.isArray(proposalObject.effect_requests)) errors.push(validationError('effect_requests_invalid', 'effect_requests'));
  for (const [index, effect] of effects.entries()) {
    const path = `effect_requests[${index}]`;
    if (!exactKeys(effect, EFFECT_KEYS) || typeof effect.type !== 'string' || !Array.isArray(effect.reason_observation_ids)) {
      errors.push(validationError('effect_shape_invalid', path));
      continue;
    }
    if (!permissions.has(effect.type)) {
      errors.push(validationError('effect_not_permitted', `${path}.type`, [], [...permissions]));
      continue;
    }
    const unknownObservation = effect.reason_observation_ids.find((id) => !observationsById.has(id));
    if (unknownObservation) {
      errors.push(validationError('effect_observation_unknown', `${path}.reason_observation_ids`, [unknownObservation]));
      continue;
    }
    const configuredGoalIds = requirements.get(effect.type)?.required_goal_ids || [];
    const requiredGoalIds = effect.type === 'create_lead'
      ? effectiveRequiredGoalIds(configuredGoalIds, policy, candidateObservations)
      : configuredGoalIds;
    const unresolved = requiredGoalIds.filter((goalId) => !resolvedGoalIds.has(goalId));
    if (unresolved.length > 0) {
      errors.push(validationError('effect_prerequisite_unresolved', path, unresolved));
      continue;
    }
    if (effect.type === 'create_lead' && !createLeadAuthorized) {
      errors.push(validationError(
        'effect_trigger_context_invalid',
        path,
        [effect.type],
        [FINAL_CONFIRMATION_GOAL],
        'Create the lead only after answering a pending final_confirmation, or after a direct request to create the lead.',
      ));
      continue;
    }
    candidateEffects.push(jsonClone(effect));
  }
  for (const requirement of requirements.values()) {
    if (requirement?.trigger !== 'explicit_confirmation_when_ready') continue;
    if (!permissions.has(requirement.effect_type)) continue;
    const configuredGoalIds = Array.isArray(requirement.required_goal_ids)
      ? requirement.required_goal_ids
      : [];
    const requiredGoalIds = requirement.effect_type === 'create_lead'
      ? effectiveRequiredGoalIds(configuredGoalIds, policy, candidateObservations)
      : configuredGoalIds;
    const ready = requiredGoalIds.every((goalId) => resolvedGoalIds.has(goalId));
    const alreadyRequested = candidateEffects.some((effect) => effect.type === requirement.effect_type);
    const triggered = requirement.effect_type === 'create_lead'
      ? createLeadDirectlyRequested && !hydratesPriorRequest
      : hasExplicitConfirmation(messageText);
    if (ready && triggered && !alreadyRequested) {
      errors.push(validationError(
        'effect_required',
        'effect_requests',
        [requirement.effect_type],
        [requirement.effect_type],
        `Add one ${requirement.effect_type} effect_request because its prerequisites and configured trigger are satisfied.`,
      ));
    }
  }
  if (catalogResolutionValid && ['unsupported', 'ambiguous'].includes(catalogResolution.status)) {
    const forbiddenMutation = candidateMutations.find((mutation) => mutation.field === 'product');
    if (forbiddenMutation) {
      errors.push(validationError('catalog_resolution_action_forbidden', 'state_mutations', [forbiddenMutation.observation_id]));
    }
    const forbiddenEffect = candidateEffects.find((effect) => {
      const requiredGoalIds = requirements.get(effect.type)?.required_goal_ids || [];
      return requiredGoalIds.includes('product');
    });
    if (forbiddenEffect) {
      errors.push(validationError('catalog_resolution_action_forbidden', 'effect_requests', [forbiddenEffect.type]));
    }
  }

  errors.push(...addressRetryBoundErrors(policy, candidateMutations, primaryRequestValid, primaryRequest, permissions, candidateEffects));

  const valid = errors.length === 0;
  return {
    version: V3_CONTRACTS.validation,
    valid,
    policy_digest: policy?.policy_digest || null,
    proposal_digest: isObject(proposal) ? digestObject(proposal) : null,
    errors,
    catalog_resolution: catalogResolutionValid ? jsonClone(catalogResolution) : null,
    accepted_observations: valid ? candidateObservations : [],
    authorized_mutations: valid ? candidateMutations : [],
    authorized_effect_requests: valid ? candidateEffects : [],
  };
};

// Shared by authorizeV3ConversationDecisionV3 and authorizeV3ConversationDecisionV31
// (design.md D11, orchestrator follow-up): the handoff escalation-reason
// enrichment is quote-level (pending_question_goal_id/address goal guidance
// are never item-scoped), so both authorizers call this exact function.
// Downstream handoff routing (ensure-escalation-handoff.js REASON_TO_MOTIVE)
// reads `escalation_reason`, so this must not silently differ by version.
const buildV3EffectCommand = (policy, effect, authorizedMutationCount, operationKeyNamespace) => {
  const payload = {
    conversation_id: policy.turn.conversation_id,
    turn_id: policy.turn.id,
    reason_observation_ids: jsonClone(effect.reason_observation_ids),
  };
  if (effect.type === 'handoff'
      && policy.turn.pending_question_goal_id === 'address'
      && (policy.goals || []).find((goal) => goal.goal_id === 'address')?.guidance?.next_action_without_progress === 'handoff'
      && authorizedMutationCount === 0) {
    payload.escalation_reason = 'no_progress_commercial_question_loop';
    payload.pending_question_key = 'address';
  }
  const payloadDigest = digestObject(payload);
  return {
    type: effect.type,
    operation_key: sha256(`${operationKeyNamespace}\u0000${policy.turn.conversation_id}\u0000${policy.turn.id}\u0000${effect.type}\u0000${payloadDigest}`),
    payload,
    payload_digest: payloadDigest,
    required_before_reply: true,
  };
};

const authorizeV3ConversationDecisionV3 = (policy, proposal, validation) => {
  if (validation?.version !== V3_CONTRACTS.validation || validation.valid !== true) {
    throw new Error('validated_proposal_required');
  }
  if (validation.policy_digest !== policy?.policy_digest || validation.proposal_digest !== digestObject(proposal)) {
    throw new Error('validation_digest_mismatch');
  }
  const decisionId = sha256(`${V3_CONTRACTS.decision}\u0000${policy.policy_digest}\u0000${validation.proposal_digest}`);
  const replySha = sha256(proposal.reply_text);
  const deliveryKey = sha256(`turn_reply/v1\u0000${policy.turn.conversation_id}\u0000${policy.turn.id}\u0000${replySha}`);
  const effectCommands = validation.authorized_effect_requests.map((effect) => (
    buildV3EffectCommand(policy, effect, validation.authorized_mutations.length, 'effect/v3')
  ));
  return {
    version: V3_CONTRACTS.decision,
    decision_id: decisionId,
    outcome: 'authorized',
    turn_id: policy.turn.id,
    conversation_id: policy.turn.conversation_id,
    conversation_revision_expected: policy.turn.conversation_revision,
    expected_snapshot_digest: digestObject({
      conversation_revision: policy.turn.conversation_revision,
      facts: policy.facts,
    }),
    policy_digest: policy.policy_digest,
    proposal_digest: validation.proposal_digest,
    reply: {
      text: proposal.reply_text,
      sha256: replySha,
      delivery_key: deliveryKey,
      primary_request: proposal.primary_request === null ? null : jsonClone(proposal.primary_request),
    },
    catalog_resolution: jsonClone(validation.catalog_resolution),
    observations: jsonClone(validation.accepted_observations),
    state_mutations: jsonClone(validation.authorized_mutations),
    effect_commands: effectCommands,
    commit_policy: { mode: 'semantic_all_or_nothing' },
  };
};

// D1: an existing item_ref already IS the persisted item_id (dual-read never
// rewrites a committed id). Only a brand-new handle needs deriving.
const authorizeV3ConversationDecisionV31 = (policy, proposal, validation) => {
  if (validation?.version !== V3_CONTRACTS.validation_v3_1 || validation.valid !== true) {
    throw new Error('validated_proposal_required');
  }
  if (validation.policy_digest !== policy?.policy_digest || validation.proposal_digest !== digestObject(proposal)) {
    throw new Error('validation_digest_mismatch');
  }
  const existingItems = existingLineItemsFromPolicy(policy);
  const resolveItemId = (itemRef) => (itemRef === null || itemRef === undefined
    ? null
    : (existingItems.has(itemRef) ? itemRef : deriveItemIdV31(policy.turn.conversation_id, policy.turn.id, itemRef)));

  const decisionId = sha256(`${V3_CONTRACTS.decision_v3_1}\u0000${policy.policy_digest}\u0000${validation.proposal_digest}`);
  const replySha = sha256(proposal.reply_text);
  const deliveryKey = sha256(`turn_reply/v1\u0000${policy.turn.conversation_id}\u0000${policy.turn.id}\u0000${replySha}`);
  const effectCommands = validation.authorized_effect_requests.map((effect) => (
    buildV3EffectCommand(policy, effect, validation.authorized_mutations.length, 'effect/v3.1')
  ));
  return {
    version: V3_CONTRACTS.decision_v3_1,
    decision_id: decisionId,
    outcome: 'authorized',
    turn_id: policy.turn.id,
    conversation_id: policy.turn.conversation_id,
    conversation_revision_expected: policy.turn.conversation_revision,
    expected_snapshot_digest: digestObject({
      conversation_revision: policy.turn.conversation_revision,
      facts: policy.facts,
    }),
    policy_digest: policy.policy_digest,
    proposal_digest: validation.proposal_digest,
    reply: {
      text: proposal.reply_text,
      sha256: replySha,
      delivery_key: deliveryKey,
      primary_request: proposal.primary_request === null ? null : jsonClone(proposal.primary_request),
    },
    catalog_resolutions: jsonClone(validation.catalog_resolutions),
    withheld_mutations: jsonClone(validation.withheld_mutations),
    observations: jsonClone(validation.accepted_observations),
    state_mutations: validation.authorized_mutations.map((mutation) => ({
      operation: mutation.operation,
      field: mutation.field,
      item_id: resolveItemId(mutation.item_ref),
      observation_id: mutation.observation_id,
      replaces_fact_id: mutation.replaces_fact_id,
      projected_value: jsonClone(mutation.projected_value),
    })),
    effect_commands: effectCommands,
    commit_policy: { mode: 'semantic_all_or_nothing' },
  };
};

const validateV3AiProposal = (policy, proposal) => (
  policy?.version === V3_CONTRACTS.policy_v3_1
    ? validateV3AiProposalV31(policy, proposal)
    : validateV3AiProposalV3(policy, proposal)
);

const authorizeV3ConversationDecision = (policy, proposal, validation) => (
  validation?.version === V3_CONTRACTS.validation_v3_1
    ? authorizeV3ConversationDecisionV31(policy, proposal, validation)
    : authorizeV3ConversationDecisionV3(policy, proposal, validation)
);

module.exports = {
  V3_CONTRACTS,
  CONCEPT_TO_FIELD,
  GROUNDED_CONCEPTS,
  canonicalJson,
  sha256,
  digestObject,
  compileV3TurnPolicy,
  validateV3AiProposal,
  authorizeV3ConversationDecision,
  productRefsMentionedV31,
};
