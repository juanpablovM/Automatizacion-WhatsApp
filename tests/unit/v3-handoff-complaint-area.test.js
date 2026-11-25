import { createRequire } from 'node:module';
import { describe, expect, test } from 'vitest';

const require = createRequire(import.meta.url);
const { buildV3PolicyInput } = require('../fixtures/workflow-nodes/shared/v3-policy-builder.js');
const {
  compileV3TurnPolicy, validateV3AiProposal, authorizeV3ConversationDecision,
} = require('../fixtures/workflow-nodes/shared/v3-contract-runtime.js');

// CRM 1.2d (odd/tasks/crm-1-2d-contingency-handoffs.md, S1): a v3 handoff whose
// reason names an `issue_description` observation is a customer complaint and
// goes to the claims area; every other v3 handoff keeps the sales area.

const TEXT = 'Me llegaron las baldosas quebradas, quiero que me las repongan';

const issueObservation = (version) => ({
  id: 'obs_issue', concept: 'issue_description', raw_value: 'baldosas quebradas',
  normalized_value: 'baldosas quebradas', evidence_quote: 'baldosas quebradas', evidence_occurrence: 1,
  grounding_ref: null, resolves_goal_ids: [], ...(version === 'v3.1' ? { item_ref: null } : {}),
});

const decide = (version, { withIssue }) => {
  const policy = compileV3TurnPolicy(buildV3PolicyInput({
    inbound_event_id: 5, conversation_id: 7, external_message_id: `complaint-${version}`,
    text_body: TEXT, qualification_context: {},
  }, { version }));
  const proposal = {
    version: version === 'v3.1' ? 'ai_conversation_proposal/v3.1' : 'ai_conversation_proposal/v3',
    policy_digest: policy.policy_digest,
    reply_text: 'Lamento lo ocurrido. Te comunico con una persona del equipo.',
    primary_request: null,
    ...(version === 'v3.1'
      ? { catalog_resolutions: [] }
      : { catalog_resolution: { status: 'not_applicable', evidence_quote: null, evidence_occurrence: null, grounding_ref: null } }),
    observations: withIssue ? [issueObservation(version)] : [],
    state_mutations: [],
    effect_requests: [{ type: 'handoff', reason_observation_ids: withIssue ? ['obs_issue'] : [] }],
  };
  const validation = validateV3AiProposal(policy, proposal);
  expect(validation.errors).toEqual([]);
  return authorizeV3ConversationDecision(policy, proposal, validation).effect_commands[0];
};

describe.each(['v3', 'v3.1'])('%s handoff area', (version) => {
  test('a handoff for an issue description is a complaint for the claims area', () => {
    const command = decide(version, { withIssue: true });
    expect(command.type).toBe('handoff');
    expect(command.payload).toMatchObject({ escalation_area: 'claims', reason_observation_ids: ['obs_issue'] });
  });

  test('a handoff without an issue description carries no area (sales by default)', () => {
    const command = decide(version, { withIssue: false });
    expect(command.type).toBe('handoff');
    expect(command.payload).not.toHaveProperty('escalation_area');
  });
});
