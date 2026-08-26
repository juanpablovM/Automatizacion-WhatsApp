const CONTRACT_MODES = new Set(['legacy', 'shadow', 'canary', 'enforce']);

const asObject = (value) => value && typeof value === 'object' && !Array.isArray(value) ? value : {};
const safe = (value, fallback = '') => String(value ?? fallback).trim();
const modeVersion = (mode) => ['canary', 'enforce'].includes(mode) ? 'v3' : 'legacy';
const normalizeMode = (value) => {
  const mode = safe(value, 'legacy').toLowerCase();
  return CONTRACT_MODES.has(mode) ? mode : 'legacy';
};

const normalizeActiveRoute = (value) => {
  const route = asObject(value);
  const mode = normalizeMode(route.mode ?? route.route_mode);
  const ruleId = safe(route.rule_id ?? route.route_rule_id);
  if (!ruleId) return null;
  return {
    mode,
    contract_version: safe(route.contract_version, modeVersion(mode)),
    rule_id: ruleId,
  };
};

const resolveConversationContractRoute = (turn, configuration = {}) => {
  const input = asObject(turn);
  const requestedMode = normalizeMode(configuration.mode);
  const requestedRuleId = safe(configuration.rule_id, `rollout:${requestedMode}`);
  const activeRoute = normalizeActiveRoute(input.active_route);
  const fixed = activeRoute || {
    mode: requestedMode,
    contract_version: modeVersion(requestedMode),
    rule_id: requestedRuleId,
  };
  const isV3 = fixed.contract_version === 'v3';
  return {
    schema: 'conversation_contract_route/v1',
    turn_id: safe(input.turn_id ?? input.inbound_event_id),
    mode: fixed.mode,
    contract_version: fixed.contract_version,
    rule_id: fixed.rule_id,
    route_replayed: Boolean(activeRoute),
    route_drift_detected: Boolean(activeRoute)
      && (activeRoute.mode !== requestedMode || activeRoute.rule_id !== requestedRuleId),
    shadow_requested: fixed.mode === 'shadow',
    visible_contract: fixed.mode === 'shadow' ? 'legacy' : fixed.contract_version,
    recovery_contract: isV3 ? 'v3' : 'legacy',
    legacy_reinterpretation_allowed: !isV3,
  };
};

const planShadowEvaluation = ({ route, legacy_delivery: legacyDelivery, payload }) => {
  const fixedRoute = asObject(route);
  const delivery = asObject(legacyDelivery);
  const source = asObject(payload);
  const dispatch = fixedRoute.mode === 'shadow' && delivery.delivered === true
    && Boolean(safe(delivery.receipt_ref));
  return {
    schema: 'ai_prd_shadow_dispatch/v1',
    dispatch,
    reason: dispatch ? 'post_delivery' : 'not_eligible',
    turn_id: safe(fixedRoute.turn_id),
    route_rule_id: safe(fixedRoute.rule_id),
    legacy_delivery_receipt_ref: safe(delivery.receipt_ref) || null,
    wait_for_completion: false,
    visible_latency_ms: 0,
    allow_mutations: false,
    allow_effects: false,
    payload: {
      ...source,
      shadow_mode: true,
      state_mutations: [],
      effect_requests: [],
      authorized_mutations: [],
      authorized_effect_requests: [],
    },
  };
};

const recordShadowEvaluation = (plan, outcome) => {
  const dispatch = asObject(plan);
  const result = asObject(outcome);
  const ok = result.ok === true;
  return {
    schema: 'ai_prd_shadow_audit/v1',
    turn_id: safe(dispatch.turn_id),
    route_rule_id: safe(dispatch.route_rule_id),
    legacy_delivery_receipt_ref: safe(dispatch.legacy_delivery_receipt_ref) || null,
    status: ok ? 'completed' : 'failed',
    error: ok ? null : safe(result.error, 'shadow_failed'),
    duration_ms: Math.max(0, Number(result.duration_ms || 0)),
    visible_delivery_affected: false,
    mutations_applied: 0,
    effects_executed: 0,
  };
};

const POLICY_FIELDS = [
  'name', 'product', 'service', 'commune', 'quantity', 'measurements', 'use_case',
  'modality', 'urgency', 'desired_date', 'terrain', 'truck_access',
  'debris_removal', 'customer_type', 'company', 'company_rut', 'contact_name',
  'contact_role', 'email', 'purchase_order', 'invoice_required', 'address',
  'access_restrictions', 'reception_contact', 'issue_description', 'payment_amount',
  'payment_method', 'quote_number',
];

const buildV3PolicyInput = (row, options = {}) => {
  const input = asObject(row);
  const context = asObject(input.qualification_context);
  const shadow = options.shadow === true || input.shadow_mode === true;
  const explicitGrounding = asObject(input.v3_grounding);
  const commercialContext = asObject(input.commercial_context);
  const catalogItems = Array.isArray(commercialContext.catalog_items) ? commercialContext.catalog_items : [];
  const refPart = (value) => safe(value).normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const derivedCatalog = [];
  for (const item of catalogItems) {
    const name = safe(item?.name);
    if (!name) continue;
    const concept = safe(item?.item_type).toLowerCase() === 'service' ? 'service' : 'product';
    derivedCatalog.push({ ref: `${concept}:${refPart(item.id || item.sku || name)}`, concept, value: name });
    for (const city of Array.isArray(item?.applicable_cities) ? item.applicable_cities : []) {
      if (safe(city)) derivedCatalog.push({ ref: `commune:${refPart(city)}`, concept: 'commune', value: safe(city) });
    }
  }
  const grounding = {
    catalog: [
      ...(Array.isArray(explicitGrounding.catalog) ? explicitGrounding.catalog : []),
      ...derivedCatalog,
    ],
    modality_synonyms: Array.isArray(explicitGrounding.modality_synonyms)
      ? explicitGrounding.modality_synonyms
      : [
          { ref: 'modality:material', concept: 'modality', value: 'material' },
          { ref: 'modality:delivery', concept: 'modality', value: 'delivery' },
          { ref: 'modality:installation', concept: 'modality', value: 'installation' },
          { ref: 'modality:pickup', concept: 'modality', value: 'pickup' },
        ],
  };
  const facts = [];
  const goals = [];
  const allowedMutations = [];
  for (const field of POLICY_FIELDS) {
    const directValue = input[field];
    const value = context[field] ?? directValue;
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
      importance: ['product', 'commune', 'quantity', 'modality'].includes(field) ? 'required_for_effect' : 'optional',
      blocks_effects: ['product', 'commune', 'quantity', 'modality'].includes(field) ? ['create_lead'] : [],
    });
    if (!shadow) {
      allowedMutations.push(hasValue
        ? { operation: 'replace', concept: field, field, current_fact_id: factId }
        : { operation: 'set', concept: field, field });
    }
  }
  return {
    turn: {
      id: safe(input.inbound_event_id ?? input.turn_id),
      conversation_id: safe(input.conversation_id ?? input.target_conversation_id),
      conversation_revision: Number(input.conversation_revision || 0),
      message: {
        id: safe(input.external_message_id ?? input.inbound_event_id),
        text: safe(input.text_body ?? input.message_current),
      },
    },
    history: { messages: Array.isArray(input.recent_messages) ? input.recent_messages : [], truncated: false },
    facts,
    goals,
    allowed_mutations: allowedMutations,
    grounding,
    claim_rules: [
      { rule_id: 'no_stock_confirmation', kind: 'forbidden_pattern', pattern: '\\bstock\\s+(confirmado|disponible)\\b', flags: 'iu' },
      { rule_id: 'no_unreceipted_derivation', kind: 'forbidden_pattern', pattern: '\\b(ya|quedo)\\s+derivad[oa]\\b', flags: 'iu' },
    ],
    effect_permissions: shadow ? [] : [{ type: 'create_lead' }, { type: 'handoff' }],
    effect_requirements: shadow ? [] : [
      { effect_type: 'create_lead', required_goal_ids: ['product', 'commune', 'quantity', 'modality'] },
      { effect_type: 'handoff', required_goal_ids: [] },
    ],
  };
};

module.exports = {
  CONTRACT_MODES,
  resolveConversationContractRoute,
  planShadowEvaluation,
  recordShadowEvaluation,
  buildV3PolicyInput,
};
