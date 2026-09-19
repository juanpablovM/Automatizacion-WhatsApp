const buildV3PolicyInput = (() => {
  const asObject = (value) => value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const safe = (value, fallback = '') => String(value ?? fallback).trim();
const POLICY_FIELDS = [
  'name', 'product', 'service', 'commune', 'quantity', 'measurements', 'use_case',
  'service_scope', 'fulfillment', 'urgency', 'desired_date', 'terrain', 'truck_access',
  'debris_removal', 'customer_type', 'company', 'company_rut', 'contact_name',
  'contact_role', 'email', 'purchase_order', 'invoice_required', 'address',
  'access_restrictions', 'reception_contact', 'issue_description', 'payment_amount',
  'payment_method', 'quote_number',
];

const sanitizePriorRequest = (value) => {
  const source = asObject(value);
  const sourceValues = asObject(source.values);
  const values = {};
  for (const field of POLICY_FIELDS) {
    const candidate = sourceValues[field];
    if (candidate === undefined || candidate === null || safe(candidate) === '') continue;
    values[field] = candidate;
  }
  if (!Object.keys(values).length || !safe(source.lead_id)) return null;
  return {
    lead_id: safe(source.lead_id),
    source_conversation_id: safe(source.source_conversation_id) || null,
    completed_at: safe(source.completed_at) || null,
    lead_status_code: safe(source.lead_status_code) || null,
    values,
  };
};

const persistedPendingGoal = (value) => {
  const key = safe(value);
  if (!key) return null;
  return key === 'confirm' ? 'final_confirmation' : key;
};

const buildV3PolicyInput = (row, options = {}) => {
  const input = asObject(row);
  const context = asObject(input.qualification_context);
  const explicitGrounding = asObject(input.v3_grounding);
  const commercialContext = asObject(input.commercial_context);
  const inputReferenceContext = asObject(input.reference_context);
  const priorRequest = sanitizePriorRequest(inputReferenceContext.prior_request);
  const legacyModality = context.modality;
  const legacyServiceScope = ['material', 'installation', 'both'].includes(legacyModality)
    ? legacyModality
    : ['pickup', 'delivery'].includes(legacyModality) ? 'material' : undefined;
  const legacyFulfillment = ['pickup', 'delivery'].includes(legacyModality)
    ? legacyModality
    : undefined;
  const catalogItems = Array.isArray(commercialContext.catalog_items) ? commercialContext.catalog_items : [];
  const refPart = (value) => safe(value).normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const derivedCatalog = [];
  for (const item of catalogItems) {
    const name = safe(item?.name);
    if (!name) continue;
    const concept = safe(item?.item_type).toLowerCase() === 'service' ? 'service' : 'product';
    derivedCatalog.push({ ref: `${concept}:${refPart(item.id || item.sku || name)}`, concept, value: name });
  }
  const canonicalModalitySynonyms = [
    { ref: 'service_scope:material', concept: 'service_scope', value: 'material' },
    { ref: 'service_scope:installation', concept: 'service_scope', value: 'installation' },
    { ref: 'service_scope:both', concept: 'service_scope', value: 'both' },
    { ref: 'fulfillment:delivery', concept: 'fulfillment', value: 'delivery' },
    { ref: 'fulfillment:pickup', concept: 'fulfillment', value: 'pickup' },
  ];
  const modalitySynonyms = [
    ...(Array.isArray(explicitGrounding.modality_synonyms) ? explicitGrounding.modality_synonyms : []),
    ...canonicalModalitySynonyms,
  ].filter((entry, index, entries) => entry?.ref
    && entries.findIndex((candidate) => candidate?.ref === entry.ref) === index);
  const grounding = {
    catalog: [
      ...(Array.isArray(explicitGrounding.catalog) ? explicitGrounding.catalog : []),
      ...derivedCatalog,
    ].filter((entry) => entry?.concept !== 'commune'),
    modality_synonyms: modalitySynonyms,
  };
  const facts = [];
  const goals = [];
  const allowedMutations = [];
  const scope = context.service_scope ?? legacyServiceScope;
  const fulfillment = context.fulfillment ?? legacyFulfillment;
  const requiredGoals = new Set(['product', 'quantity', 'service_scope']);
  if (scope === 'material' || scope === 'both') requiredGoals.add('fulfillment');
  if (scope === 'installation' || scope === 'both') {
    for (const field of ['commune', 'address', 'terrain', 'truck_access', 'debris_removal']) requiredGoals.add(field);
  }
  if (fulfillment === 'delivery') {
    requiredGoals.add('commune');
    requiredGoals.add('address');
    requiredGoals.add('access_restrictions');
  }
  if (context.customer_type === 'b2b' || context.lead_class === 'D') {
    for (const field of ['commune', 'company', 'contact_name', 'purchase_order']) requiredGoals.add(field);
  }
  let previousMetadata = asObject(input.metadata_json);
  if (typeof input.metadata_json === 'string') {
    try { previousMetadata = asObject(JSON.parse(input.metadata_json)); } catch (_error) { /* No prior retry evidence. */ }
  }
  const previousPending = safe(input.previous_commercial_pending_question_key
    ?? previousMetadata.previous_commercial_pending_question_key
    ?? previousMetadata.pending_question_key);
  const previousRetry = Math.max(0, Number(input.previous_commercial_question_retry
    ?? previousMetadata.previous_commercial_question_retry
    ?? previousMetadata.commercial_question_retry) || 0);
  const sameAddressPending = safe(input.pending_question_key) === 'address' && previousPending === 'address';
  const nextAddressRetry = sameAddressPending ? previousRetry + 1 : 0;
  for (const field of POLICY_FIELDS) {
    const compatibilityValue = field === 'service_scope'
      ? legacyServiceScope
      : field === 'fulfillment' ? legacyFulfillment : undefined;
    // A v3 fact must come from committed conversation state. Direct fields on
    // the workflow item are legacy heuristics for the current turn and have no
    // evidence lineage; treating them as facts produced values such as
    // "Perfecto" and "Domicilio" in the service field.
    const value = context[field] ?? compatibilityValue;
    const hasValue = value !== undefined && value !== null && safe(value) !== '';
    const factId = hasValue ? `fact:${field}` : null;
    if (hasValue) {
      facts.push({
        fact_id: factId,
        field,
        value,
        mutability: 'customer_correctable',
        source: { message_id: safe(input.last_message_id), evidence_digest: safe(input.last_evidence_digest) },
      });
    }
    goals.push({
      goal_id: field,
      status: hasValue ? 'resolved' : 'unresolved',
      importance: requiredGoals.has(field) ? 'required_for_effect' : 'optional',
      blocks_effects: requiredGoals.has(field) ? ['create_lead'] : [],
      ...(field === 'address' ? { guidance: {
        known_commune: safe(context.commune) || null,
        question_focus: 'street_and_approximate_number',
        commune_alone_is_not_address: true,
        previous_retry_count: previousRetry,
        next_retry_count_without_progress: nextAddressRetry,
        clarify_at: 2,
        handoff_at: 3,
        next_action_without_progress: nextAddressRetry >= 3 ? 'handoff' : nextAddressRetry >= 2 ? 'clarify' : 'ask',
        reset_retry_on_new_commercial_evidence: true,
      } } : {}),
    });
    // A shadow turn is a rehearsal, and a rehearsal with the authority removed
    // is not a rehearsal of anything: the model reads the customer correctly,
    // proposes recording what it read, and is refused for exceeding an authority
    // that was emptied for it alone. What keeps a shadow turn from touching
    // production is the lane, not the policy — `planShadowEvaluation` sets
    // allow_mutations/allow_effects false, the payload ships empty mutation and
    // effect arrays, and the evaluator has no effect executor or commit wired.
    allowedMutations.push(hasValue
      ? { operation: 'replace', concept: field, field, current_fact_id: factId }
      : { operation: 'set', concept: field, field });
  }
  return {
    turn: {
      id: safe(input.inbound_event_id ?? input.turn_id),
      conversation_id: safe(
        input.route_conversation_id
          ?? input.conversation_id
          ?? input.target_conversation_id,
      ),
      conversation_revision: Number(input.conversation_revision || 0),
      // Pending-question authority is persisted independently from the legacy
      // step evaluator. `current_step` may describe what that evaluator inferred
      // from the message being processed, so reading it here makes a fresh turn
      // look like it is answering a question that was never asked.
      pending_question_goal_id: persistedPendingGoal(input.pending_question_key),
      message: {
        id: safe(input.external_message_id ?? input.inbound_event_id),
        text: safe(input.text_body ?? input.message_current),
      },
    },
    history: { messages: Array.isArray(input.recent_messages) ? input.recent_messages : [], truncated: false },
    reference_context: { prior_request: priorRequest },
    facts,
    goals,
    allowed_mutations: allowedMutations,
    grounding,
    claim_rules: [
      { rule_id: 'no_stock_confirmation', kind: 'forbidden_pattern', pattern: '\\bstock\\s+(confirmado|disponible)\\b', flags: 'iu' },
      { rule_id: 'no_unreceipted_derivation', kind: 'forbidden_pattern', pattern: '\\b(ya|quedo)\\s+derivad[oa]\\b', flags: 'iu' },
      { rule_id: 'no_unreceipted_quote_progress', kind: 'forbidden_pattern', pattern: '\\b(?:(?:estoy|estamos|seguimos)\\s+(?:procesando|gestionando)\\s+(?:tu|la)\\s+cotizaci[oó]n|(?:tu|la)\\s+cotizaci[oó]n\\s+(?:ya\\s+)?(?:est[aá]|qued[oó])\\s+en\\s+proceso)\\b', flags: 'iu' },
      { rule_id: 'no_unreceipted_delivery_progress', kind: 'forbidden_pattern', pattern: '\\b(?:recibas|recibir[aá]s)\\s+tu\\s+material\\s+pronto\\b', flags: 'iu' },
    ],
    effect_permissions: [{ type: 'create_lead' }, { type: 'handoff' }],
    effect_requirements: [
      {
        effect_type: 'create_lead',
        required_goal_ids: [...requiredGoals],
        trigger: 'explicit_confirmation_when_ready',
      },
      { effect_type: 'handoff', required_goal_ids: [] },
    ],
  };
};


  return buildV3PolicyInput;
})();

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { buildV3PolicyInput };
}
