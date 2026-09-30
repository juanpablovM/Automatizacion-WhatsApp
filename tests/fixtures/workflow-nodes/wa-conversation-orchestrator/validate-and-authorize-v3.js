return items.map((item) => {
  const input = item.json || {};
  const policy = input.v3_policy || input.turn_policy;
  // Task 3c.23: a v3.1 reply_text is tidied (whitespace only) before
  // validation, so every digest, the stored decision and the sent text agree.
  const proposal = prepareV3ProposalForValidation(policy, input.ai_proposal);
  const validation = validateV3AiProposal(policy, proposal);
  const decision = validation.valid ? authorizeV3ConversationDecision(policy, proposal, validation) : null;
  return { json: {
    ...input,
    ...(proposal !== input.ai_proposal ? { ai_proposal: proposal } : {}),
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
