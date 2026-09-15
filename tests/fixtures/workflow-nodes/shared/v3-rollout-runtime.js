const CONTRACT_MODES = new Set(['legacy', 'shadow', 'canary', 'enforce']);

const asObject = (value) => value && typeof value === 'object' && !Array.isArray(value) ? value : {};
const safe = (value, fallback = '') => String(value ?? fallback).trim();
const modeVersion = (mode) => ['canary', 'enforce'].includes(mode) ? 'v3' : 'legacy';
const normalizeMode = (value) => {
  const mode = safe(value, 'enforce').toLowerCase();
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

module.exports = {
  CONTRACT_MODES,
  resolveConversationContractRoute,
  planShadowEvaluation,
  recordShadowEvaluation,
  get buildV3PolicyInput() { return require('./v3-policy-builder.js').buildV3PolicyInput; },
};
