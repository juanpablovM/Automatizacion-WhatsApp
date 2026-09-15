// `Execute Shadow AI Advisor` is a sub-workflow call, so it replaces the item
// with the advisor's own output. In the legacy branch that output is an
// explicit allowlist which echoes neither `conversation_id`, `turn_policy` nor
// `shadow_plan`. Read the turn context back from the node that built it: without
// it the audit lands with no conversation and no turn, and an unattributable row
// is not a comparable one.
//
// The verdict is the point of the rollout. The request side already asks the
// model for an `ai_conversation_proposal/v3` whenever the policy is a v3 one,
// and `normalize-ai-result` parses it back into `ai_proposal`; recording only
// that the call completed leaves the question the rollout exists to answer
// unanswered. Run the same validator the live v3 lane runs, and record its
// verdict next to the liveness signal rather than instead of it.
const V3_POLICY_VERSION = 'ai_prd_turn_policy/v3';

const validateShadowProposal = (policy, proposal) => {
  if (!proposal || typeof proposal !== 'object') {
    // The model erred, was rate limited, or returned unparseable output. That
    // is a failure of the turn, not evidence about the model's ability to
    // satisfy the contract, so it must not be counted as a rejected proposal.
    return { proposal_present: false, proposal_valid: false, validation_status: 'not_evaluated', validation_error_codes: [] };
  }
  if (policy?.version !== V3_POLICY_VERSION) {
    return { proposal_present: true, proposal_valid: false, validation_status: 'not_evaluated', validation_error_codes: ['invalid_turn_policy'] };
  }
  let validation;
  try {
    validation = validateV3AiProposal(policy, proposal);
  } catch (error) {
    // A validator that throws proves nothing about the proposal. Recording it
    // as a rejection would quietly bias the rollout's headline number.
    return {
      proposal_present: true,
      proposal_valid: false,
      validation_status: 'not_evaluated',
      validation_error_codes: [String(error?.message || 'validator_error')],
    };
  }
  const valid = validation?.valid === true;
  return {
    proposal_present: true,
    proposal_valid: valid,
    validation_status: valid ? 'accepted' : 'error',
    validation_error_codes: (validation?.errors || []).map(({ code }) => code).filter(Boolean),
  };
};

return items.map((item) => {
  const result = item.json || {};
  const context = $('Prepare Shadow Evaluation').first().json || {};
  const input = { ...context, ...result };
  const policy = input.v3_policy || input.turn_policy || null;
  const verdict = validateShadowProposal(policy, input.ai_proposal);
  // Keep what the model proposed. The verdict alone says whether v3 would accept
  // it; only the text says whether it read the customer better than the reply we
  // actually sent, and that comparison is the whole reason the rehearsal runs.
  const proposal = input.ai_proposal && typeof input.ai_proposal === 'object' ? input.ai_proposal : null;
  const proposed = {
    proposed_reply: typeof proposal?.reply_text === 'string' ? proposal.reply_text : null,
    proposed_observations: (Array.isArray(proposal?.observations) ? proposal.observations : [])
      .map(({ concept, normalized_value }) => ({ concept, normalized_value })),
    proposed_mutation_fields: (Array.isArray(proposal?.state_mutations) ? proposal.state_mutations : [])
      .map(({ field }) => field).filter(Boolean),
    proposed_effect_types: (Array.isArray(proposal?.effect_requests) ? proposal.effect_requests : [])
      .map(({ type }) => type).filter(Boolean),
  };
  const audit = recordShadowEvaluation(input.shadow_plan || input, {
    ok: !input.ai_request_error && !input.ai_fallback_reason,
    error: input.ai_request_error || input.ai_fallback_reason || null,
    duration_ms: Math.max(0, Date.now() - Number(input.shadow_started_at_ms || Date.now())),
  });
  return { json: { ...input, shadow_audit: { ...audit, ...verdict, ...proposed } } };
});
