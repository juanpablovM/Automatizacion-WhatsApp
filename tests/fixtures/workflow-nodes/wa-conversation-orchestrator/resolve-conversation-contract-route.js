const input = items[0]?.json ?? {};
const activeRoute = input.active_contract_route || (input.active_route_mode ? {
  mode: input.active_route_mode,
  contract_version: input.active_contract_version,
  rule_id: input.active_route_rule_id,
} : null);
// Serving named numbers with v3 while everyone else stays on legacy is how the
// delivery path gets exercised for real without putting customers behind it:
// shadow never delivers, so authority, effects, commit and outbound have only
// ever run against a hand-written mock proposal. The allowlist only ever raises
// a turn to the v3 lane — it never pulls one back — so its blast radius is the
// numbers named in it.
const digitsOnly = (value) => String(value ?? '').replace(/\D/g, '');
const canaryPhones = new Set(
  String($env.AI_PRD_CONTRACT_CANARY_PHONES || '')
    .split(',')
    .map(digitsOnly)
    .filter(Boolean),
);
const globalMode = $env.AI_PRD_CONTRACT_MODE || 'enforce';
const phoneIsCanary = canaryPhones.size > 0
  && canaryPhones.has(digitsOnly(input.phone_number))
  && !['canary', 'enforce'].includes(String(globalMode).toLowerCase());

const route = resolveConversationContractRoute({
  ...input,
  turn_id: input.inbound_event_id,
  active_route: activeRoute,
}, {
  mode: input.requested_contract_mode || (phoneIsCanary ? 'canary' : globalMode),
  rule_id: input.requested_contract_rule_id || $env.AI_PRD_CONTRACT_RULE_ID || null,
});
return [{ json: {
  ...input,
  contract_route: route,
  contract_version: route.contract_version,
  contract_mode: route.mode,
  route_mode: route.mode,
  route_rule_id: route.rule_id,
} }];
