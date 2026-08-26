return items.map((item) => {
  const input = item.json || {};
  const plan = planShadowEvaluation({
    route: input.contract_route || {
      turn_id: input.inbound_event_id,
      mode: input.contract_mode || input.route_mode,
      rule_id: input.route_rule_id,
    },
    legacy_delivery: {
      delivered: input.outbound_lane_complete === true
        && (input.delivery_status === 'sent' || input.outbound_dispatch_status === 'already_sent'),
      receipt_ref: input.delivery_receipt_ref || input.outbound_message_id || input.external_message_id,
    },
    payload: input,
  });
  return { json: { ...input, shadow_plan: plan, shadow_dispatch: plan.dispatch, shadow_payload: plan.payload } };
});
