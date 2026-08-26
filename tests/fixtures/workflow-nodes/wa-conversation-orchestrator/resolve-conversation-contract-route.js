const input = items[0]?.json ?? {};
const activeRoute = input.active_contract_route || (input.active_route_mode ? {
  mode: input.active_route_mode,
  contract_version: input.active_contract_version,
  rule_id: input.active_route_rule_id,
} : null);
const route = resolveConversationContractRoute({
  ...input,
  turn_id: input.inbound_event_id,
  active_route: activeRoute,
}, {
  mode: input.requested_contract_mode || $env.AI_PRD_CONTRACT_MODE || 'legacy',
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
