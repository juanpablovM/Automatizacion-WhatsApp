// Shared translation utilities for the v3 -> v3.1 differential test harnesses
// (design.md D11). Extracted so the validator differential test
// (tests/unit/v3-v31-composition-differential.test.js) and the authorizer
// differential test (tests/unit/v3-v31-authorizer-composition-differential.test.js)
// translate an existing v3 (policy input, proposal) pair into its single-item
// v3.1 equivalent the exact same way.

const ITEM_FIELDS = new Set(['product', 'quantity', 'measurements']);
const ITEM_ID = 'li_0';

// Translates a raw `compileV3TurnPolicy` input (the exact shape both
// `buildV3PolicyInput(row)` and every hand-built v3 test policy already use)
// into its single-item v3.1 equivalent.
const toV31Input = (v3Input) => {
  const facts = (v3Input.facts || []).map((fact) => (
    ITEM_FIELDS.has(fact.field) ? { ...fact, fact_id: `fact:item:${ITEM_ID}:${fact.field}` } : fact
  ));
  const nonItemGoals = (v3Input.goals || []).filter((goal) => !ITEM_FIELDS.has(goal.goal_id));
  const productValue = facts.find((fact) => fact.fact_id === `fact:item:${ITEM_ID}:product`)?.value;
  const quantityValue = facts.find((fact) => fact.fact_id === `fact:item:${ITEM_ID}:quantity`)?.value;
  const lineItemsResolved = [productValue, quantityValue].every(
    (value) => value !== undefined && value !== null && String(value).trim() !== '',
  );
  return {
    ...v3Input,
    version: 'v3.1',
    facts,
    goals: [...nonItemGoals, {
      goal_id: 'line_items', status: lineItemsResolved ? 'resolved' : 'unresolved',
      importance: 'required_for_effect', blocks_effects: ['create_lead'],
    }],
  };
};

// Translates a v3 proposal (single implicit item) into its v3.1 equivalent.
const toV31Proposal = (v31Policy, v3Proposal) => {
  const catalogResolutions = v3Proposal.catalog_resolution && v3Proposal.catalog_resolution.status !== 'not_applicable'
    ? [{
      item_ref: ITEM_ID,
      status: v3Proposal.catalog_resolution.status,
      evidence_quote: v3Proposal.catalog_resolution.evidence_quote,
      evidence_occurrence: v3Proposal.catalog_resolution.evidence_occurrence,
      grounding_ref: v3Proposal.catalog_resolution.grounding_ref,
    }]
    : [];
  const observations = (v3Proposal.observations || []).map((observationEntry) => ({
    ...observationEntry,
    item_ref: ITEM_FIELDS.has(observationEntry.concept) ? ITEM_ID : null,
    resolves_goal_ids: ITEM_FIELDS.has(observationEntry.concept) ? [] : observationEntry.resolves_goal_ids,
  }));
  const stateMutations = (v3Proposal.state_mutations || []).map((mutation) => ({
    ...mutation,
    item_ref: ITEM_FIELDS.has(mutation.field) ? ITEM_ID : null,
  }));
  const primaryRequest = v3Proposal.primary_request === null ? null : {
    goal_id: v3Proposal.primary_request.goal_id,
    item_ref: ITEM_FIELDS.has(v3Proposal.primary_request.goal_id) ? ITEM_ID : null,
  };
  return {
    version: 'ai_conversation_proposal/v3.1',
    policy_digest: v31Policy.policy_digest,
    reply_text: v3Proposal.reply_text,
    primary_request: primaryRequest,
    catalog_resolutions: catalogResolutions,
    observations,
    state_mutations: stateMutations,
    effect_requests: v3Proposal.effect_requests || [],
  };
};

module.exports = { ITEM_FIELDS, ITEM_ID, toV31Input, toV31Proposal };
