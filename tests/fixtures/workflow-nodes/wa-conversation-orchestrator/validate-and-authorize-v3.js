return items.map((item) => {
  const input = item.json || {};
  const policy = input.v3_policy || input.turn_policy;
  const proposal = input.ai_proposal;
  const validation = validateV3AiProposal(policy, proposal);
  const decision = validation.valid ? authorizeV3ConversationDecision(policy, proposal, validation) : null;
  return { json: {
    ...input,
    v3_validation: validation,
    v3_decision: decision,
    v3_proposal_valid: validation.valid,
    decision_id: decision?.decision_id || null,
    policy_digest: decision?.policy_digest || policy?.policy_digest || null,
    proposal_digest: decision?.proposal_digest || validation.proposal_digest || null,
    decision_digest: decision ? digestObject(decision) : null,
    delivery_key: decision?.reply.delivery_key || null,
    reply_text: decision?.reply.text || '',
    response_text: decision?.reply.text || '',
    v3_initial_state: decision?.effect_commands.length ? 'effects_pending' : 'ready_to_commit',
  } };
});
