import { createRequire } from 'node:module';
import { describe, expect, test } from 'vitest';

const require = createRequire(import.meta.url);
const {
  compileV3TurnPolicy, validateV3AiProposal, authorizeV3ConversationDecision,
} = require('../fixtures/workflow-nodes/shared/v3-contract-runtime.js');
const { buildV3PolicyInput } = require('../fixtures/workflow-nodes/shared/v3-policy-builder.js');
const { toV31Input, toV31Proposal } = require('../support/v3-v31-translate.js');

// -----------------------------------------------------------------------------
// design.md D11 (orchestrator follow-up, gap 2) — authorizeV3ConversationDecision
// must carry the same effect_commands payload enrichment under v3.1 as it
// does under v3. v3's authorizer adds `escalation_reason` /
// `pending_question_key` to a handoff command's payload when the address
// retry bound triggered it with no material progress (see
// v3-address-hardbound.test.js, "existing permitted handoff needs no quote
// address and carries the domain reason"). Downstream handoff routing
// (ensure-escalation-handoff.js REASON_TO_MOTIVE / motiveFromReason) reads
// `escalation_reason`, so silently omitting it under v3.1 changes routing
// for the exact case the address retry bound exists to catch.
// -----------------------------------------------------------------------------

const context = {
  product: 'Bloques', commune: 'Rancagua', quantity: '120 unidades',
  service_scope: 'material', fulfillment: 'delivery', access_restrictions: 'Sin restricciones',
};
const buildInput = () => buildV3PolicyInput({
  inbound_event_id: 991, conversation_id: 22, external_message_id: 'authorizer-differential',
  text_body: 'Rancagua', pending_question_key: 'address', qualification_context: context,
  previous_commercial_pending_question_key: 'address', previous_commercial_question_retry: 2,
});
const buildProposal = (policy) => ({
  version: 'ai_conversation_proposal/v3', policy_digest: policy.policy_digest,
  reply_text: 'Registré el caso para revisión por una persona del equipo.',
  primary_request: null,
  catalog_resolution: { status: 'not_applicable', evidence_quote: null, evidence_occurrence: null, grounding_ref: null },
  observations: [], state_mutations: [], effect_requests: [{ type: 'handoff', reason_observation_ids: [] }],
});

const decideV3 = () => {
  const policy = compileV3TurnPolicy(buildInput());
  const proposal = { ...buildProposal(policy), policy_digest: policy.policy_digest };
  const validation = validateV3AiProposal(policy, proposal);
  return authorizeV3ConversationDecision(policy, proposal, validation);
};
const decideV31 = () => {
  const policy = compileV3TurnPolicy(toV31Input(buildInput()));
  const v3Proposal = buildProposal(compileV3TurnPolicy(buildInput()));
  const proposal = toV31Proposal(policy, v3Proposal);
  const validation = validateV3AiProposal(policy, proposal);
  return authorizeV3ConversationDecision(policy, proposal, validation);
};

describe('v3 -> v3.1 authorizer composition differential (design.md D11)', () => {
  test('the address-retry handoff carries the identical escalation payload enrichment under v3 and v3.1', () => {
    const v3Decision = decideV3();
    const v31Decision = decideV31();

    expect(v3Decision.effect_commands[0]).toMatchObject({
      type: 'handoff',
      payload: { escalation_reason: 'no_progress_commercial_question_loop', pending_question_key: 'address' },
    });
    // Same payload (conversation_id/turn_id/reason_observation_ids/escalation_reason/
    // pending_question_key) under both versions — only the operation_key's
    // namespace prefix ('effect/v3' vs 'effect/v3.1') differs.
    expect(v31Decision.effect_commands[0].payload).toEqual(v3Decision.effect_commands[0].payload);
    expect(v31Decision.effect_commands[0].payload_digest).toEqual(v3Decision.effect_commands[0].payload_digest);
    expect(v31Decision.effect_commands[0]).toMatchObject({
      type: 'handoff',
      required_before_reply: true,
      payload: { escalation_reason: 'no_progress_commercial_question_loop', pending_question_key: 'address' },
    });
  });
});
