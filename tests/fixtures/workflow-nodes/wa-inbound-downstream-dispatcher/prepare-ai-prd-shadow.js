// This node runs after outbound delivery, so by the time it sees an item the
// lane has been through `Merge Outbound Context` and `text_body` holds the reply
// we sent, not the message the customer wrote. The shadow evaluator compiles its
// v3 policy from this payload, so taking the turn context from here asks the
// model to evidence observations against our own words: production compiled
// three policies whose `turn.message.text` was the bot's question, and every
// proposal failed on observation shape.
//
// `Workflow Input` is the dispatcher trigger, holding the orchestrator's output
// before any outbound processing touched it. Take the turn from there and keep
// only the delivery signals from the current item, which is the one lane that
// knows whether the customer was actually served.
return items.map((item) => {
  const delivery = item.json || {};
  let turn = delivery;
  try {
    turn = $('Workflow Input').first().json || delivery;
  } catch (_error) {
    // A replay or a recovery path may not expose the trigger item. Degrading to
    // the current item keeps the lane alive; the gate below still refuses to
    // dispatch anything that was not delivered.
    turn = delivery;
  }
  const input = { ...turn, ...delivery, text_body: turn.text_body ?? delivery.text_body };
  const plan = planShadowEvaluation({
    route: input.contract_route || {
      turn_id: input.inbound_event_id,
      mode: input.contract_mode || input.route_mode,
      rule_id: input.route_rule_id,
    },
    legacy_delivery: {
      delivered: delivery.outbound_lane_complete === true
        && (delivery.delivery_status === 'sent' || delivery.outbound_dispatch_status === 'already_sent'),
      receipt_ref: delivery.delivery_receipt_ref || delivery.outbound_message_id || delivery.external_message_id,
    },
    payload: input,
  });
  return { json: { ...delivery, shadow_plan: plan, shadow_dispatch: plan.dispatch, shadow_payload: plan.payload } };
});
