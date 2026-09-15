// The shadow evaluator writes exactly one row per turn, through
// `Persist Shadow Advisor Audit`, and that row is the whole point of a shadow
// rollout: it is what a legacy decision gets compared against. A row that lands
// with no conversation and no turn is not a comparable row.
//
// `Execute Shadow AI Advisor` is a sub-workflow call, so — like a Postgres node
// — it REPLACES the item with the advisor's output. `Normalize AI Result`, the
// advisor's terminal, builds that output from an explicit allowlist of `ai_*`
// and classification fields: it echoes neither `conversation_id`, `turn_policy`
// nor `shadow_plan`. Everything the audit needs is dropped at that boundary.
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { describe, expect, test } from 'vitest';

const nodeRequire = createRequire(import.meta.url);
const workflowPath = 'n8n/workflows/ai-prd-shadow-evaluator.json';
const workflow = () => JSON.parse(fs.readFileSync(workflowPath, 'utf8'));
const nodeNamed = (name) => workflow().nodes.find((node) => node.name === name);

// `refs` stands in for the upstream items n8n resolves through `$('Node')`.
const runCodeNode = (name, items, refs = {}) => new Function(
  'items', '$env', '$', 'module', 'exports', 'require', nodeNamed(name).parameters.jsCode,
)(
  items,
  {},
  (target) => ({ first: () => ({ json: refs[target] ?? {} }) }),
  { exports: {} },
  {},
  nodeRequire,
);

const preparedContext = {
  conversation_id: 4242,
  shadow_started_at_ms: Date.now(),
  turn_policy: { version: 'ai_prd_turn_policy/v3', policy_digest: 'b'.repeat(64) },
  shadow_plan: {
    schema: 'ai_prd_shadow_dispatch/v1',
    turn_id: '192',
    route_rule_id: 'rollout:shadow',
    legacy_delivery_receipt_ref: 'evolution:msg-1',
  },
};

// What the advisor sub-workflow actually returns: `ai_*` fields and nothing else.
const advisorOutput = { ai_provider: 'openai', ai_model: 'gpt-test', ai_request_error: null, ai_fallback_reason: null };

const recorded = () => runCodeNode(
  'Record Shadow Evaluation',
  [{ json: advisorOutput }],
  { 'Prepare Shadow Evaluation': preparedContext },
)[0].json;

describe('the shadow audit is attributable to the turn it evaluated', () => {
  test('recovers the turn context the advisor boundary drops', () => {
    const out = recorded();

    expect(out.shadow_audit.turn_id).toBe('192');
    expect(out.shadow_audit.route_rule_id).toBe('rollout:shadow');
    expect(out.shadow_audit.status).toBe('completed');
    expect(out.conversation_id).toBe(4242);
    expect(out.turn_policy.policy_digest).toBe('b'.repeat(64));
  });

  test('keeps the advisor output that the comparison is about', () => {
    const out = recorded();

    expect(out.ai_provider).toBe('openai');
    expect(out.ai_model).toBe('gpt-test');
  });

  test('records a failed advisor call as failed, with its reason', () => {
    const out = runCodeNode(
      'Record Shadow Evaluation',
      [{ json: { ...advisorOutput, ai_fallback_reason: 'provider_timeout' } }],
      { 'Prepare Shadow Evaluation': preparedContext },
    )[0].json;

    expect(out.shadow_audit.status).toBe('failed');
    expect(out.shadow_audit.error).toBe('provider_timeout');
    // Still attributable: a failed shadow evaluation is evidence too.
    expect(out.shadow_audit.turn_id).toBe('192');
  });
});

describe('every parameter the audit statement binds is present on the item', () => {
  // n8n binds `queryReplacement` positionally against `$json`. A name the item
  // does not carry binds undefined, reaches Postgres as NULL, and the statement
  // succeeds writing a useless row — no error anywhere.
  test('binds only fields the recorded item actually carries', () => {
    const node = nodeNamed('Persist Shadow Advisor Audit');
    const replacement = String(node.parameters?.options?.queryReplacement || '');
    const item = recorded();

    expect(replacement, 'the node must use the Postgres v2 bind shape').not.toBe('');

    const bound = [...replacement.matchAll(/\$json\.([A-Za-z_][A-Za-z0-9_]*)/g)].map(([, field]) => field);
    expect(bound.length).toBeGreaterThan(0);
    for (const field of bound) {
      expect(item, `${field} is bound but never set on the item`).toHaveProperty(field);
    }
  });

  test('binds one value per placeholder in the statement', () => {
    const node = nodeNamed('Persist Shadow Advisor Audit');
    const query = String(node.parameters?.query || '');
    const highest = Math.max(...[...query.matchAll(/\$(\d+)/g)].map(([, index]) => Number(index)));
    const values = String(node.parameters?.options?.queryReplacement || '')
      .replace(/^=\{\{|\}\}$/g, '')
      .trim();

    expect(values.startsWith('[')).toBe(true);
    // A comma at bracket depth 1 separates two bound values.
    let depth = 0;
    let count = 1;
    for (const character of values) {
      if ('[({'.includes(character)) depth += 1;
      else if ('])}'.includes(character)) depth -= 1;
      else if (character === ',' && depth === 1) count += 1;
    }
    expect(count).toBe(highest);
  });
});

// A shadow rollout exists to answer one question: what fraction of a real
// model's proposals would v3 accept? The lane recorded liveness instead — that
// the call completed, that nothing was mutated — and never ran the validator.
// Its first real production run persisted `validation: null` next to a policy
// it had correctly compiled, so the number the rollout was supposed to produce
// was still missing.
//
// The request side already speaks v3: `build-ai-request` switches on
// `turn_policy.version` and asks for an `ai_conversation_proposal/v3`, and
// `normalize-ai-result` parses it back into `ai_proposal`. Only the verdict was
// never taken.
describe('the shadow audit records whether v3 would accept the proposal', () => {
  const require2 = createRequire(import.meta.url);
  const { compileV3TurnPolicy } = require2('../fixtures/workflow-nodes/shared/v3-contract-runtime.js');

  const policy = compileV3TurnPolicy({
    turn: { id: '469', message: { text: 'Necesito 15 m3 de hormigon H25 en Santiago con despacho' } },
    conversation: { id: 162 },
    grounding: {
      catalog: [
        { ref: 'product:H25', concept: 'product', value: 'hormigon H25' },
        { ref: 'commune:santiago', concept: 'commune', value: 'Santiago' },
      ],
    },
  });

  const auditFor = (advisorOutput) => runCodeNode(
    'Record Shadow Evaluation',
    [{ json: advisorOutput }],
    { 'Prepare Shadow Evaluation': { ...preparedContext, turn_policy: policy, v3_policy: policy } },
  )[0].json.shadow_audit;

  test('accepts a proposal the policy authorizes', async () => {
    const { buildValidProposal } = await import('../fixtures/mock-ai-server.mjs');
    const proposal = buildValidProposal(policy, {
      reply_text: 'Tomo nota de hormigon H25 para Santiago.',
      observations: [{
        id: 'obs-product', concept: 'product', quote: 'hormigon H25',
        normalized_value: 'hormigon H25', grounding_ref: 'product:H25',
        // Derived, not guessed: a goal id the compiled policy does not declare
        // is itself a validation error, which would make this test pass for
        // the wrong reason.
        resolves_goal_ids: (policy.goals || []).slice(0, 1).map(({ goal_id }) => goal_id),
      }],
    });
    const audit = auditFor({ ...advisorOutput, ai_proposal: proposal });

    expect(audit.proposal_present).toBe(true);
    expect(audit.proposal_valid).toBe(true);
    expect(audit.validation_status).toBe('accepted');
    expect(audit.validation_error_codes).toEqual([]);
  });

  test('rejects a proposal the policy does not authorize, and says why', () => {
    // A claim about a product the catalog does not carry: the exact thing the
    // grounding authority exists to refuse.
    const audit = auditFor({
      ...advisorOutput,
      ai_proposal: {
        version: 'ai_conversation_proposal/v3',
        policy_digest: policy.policy_digest,
        reply_text: 'Te confirmo hormigon H99 premium.',
        primary_request: null,
        catalog_resolution: {
          status: 'matched', evidence_quote: 'hormigon H25', evidence_occurrence: 1,
          grounding_ref: 'product:H99',
        },
        observations: [{
          id: 'obs-invented', concept: 'product', raw_value: 'hormigon H25',
          normalized_value: 'hormigon H99 premium', evidence_quote: 'hormigon H25',
          evidence_occurrence: 1, grounding_ref: 'product:H99', resolves_goal_ids: ['product'],
        }],
        state_mutations: [],
        effect_requests: [],
      },
    });

    expect(audit.proposal_present).toBe(true);
    expect(audit.proposal_valid).toBe(false);
    expect(audit.validation_status).toBe('error');
    expect(audit.validation_error_codes).toContain('grounding_invalid');
  });

  test('separates "the model failed" from "the model proposed something invalid"', () => {
    // Both are failures of the turn, but only the second is evidence about the
    // model's ability to satisfy the contract. Counting them together would
    // make the rollout's headline number meaningless.
    const audit = auditFor({ ...advisorOutput, ai_proposal: null, ai_fallback_reason: 'rate_limited' });

    expect(audit.proposal_present).toBe(false);
    expect(audit.proposal_valid).toBe(false);
    expect(audit.validation_status).toBe('not_evaluated');
    expect(audit.status).toBe('failed');
    expect(audit.error).toBe('rate_limited');
  });

  test('the persisted row carries the verdict, not just liveness', () => {
    const node = nodeNamed('Persist Shadow Advisor Audit');
    const replacement = String(node.parameters?.options?.queryReplacement || '');

    expect(replacement).toContain('validation_status');
    expect(replacement).toContain('validation_error_codes');
  });
});

// A shadow run is a rehearsal: the customer is served by legacy while the model
// is asked, in parallel, what it would have said. For the two replies to be
// comparable the rehearsal has to be faithful — the model must be given the same
// authority a real v3 turn grants it, and what it proposed has to be kept.
//
// Neither held. `buildV3PolicyInput` emptied `allowed_mutations` and
// `effect_permissions` under `shadow`, so the model was told it could record no
// fact and request no effect; every proposal that read the customer correctly
// came back `mutation_mapping_forbidden`. And the proposal itself was validated
// and discarded, so nothing could ever be read side by side.
//
// The safety that keeps a shadow turn from touching anything does not live in
// the policy and never did: `planShadowEvaluation` sets `allow_mutations: false`
// and `allow_effects: false`, the payload empties the mutation and effect
// arrays, and the evaluator has no effect executor or commit node wired at all.
describe('a shadow rehearsal is faithful enough to compare', () => {
  const require3 = createRequire(import.meta.url);
  const { buildV3PolicyInput } = require3('../fixtures/workflow-nodes/shared/v3-rollout-runtime.js');

  const turnRow = {
    inbound_event_id: 494,
    conversation_id: 163,
    text_body: 'Buenas tardes, quiero comprar solo el material, 8 m3 de hormigon',
    qualification_context: {},
    v3_grounding: { catalog: [{ ref: 'product:H25', concept: 'product', value: 'hormigon H25' }] },
  };

  test('grants the model the same authority a real turn would', () => {
    const real = buildV3PolicyInput(turnRow);
    const rehearsal = buildV3PolicyInput({ ...turnRow, shadow_mode: true }, { shadow: true });

    expect(rehearsal.allowed_mutations).toEqual(real.allowed_mutations);
    expect(rehearsal.effect_permissions).toEqual(real.effect_permissions);
    expect(rehearsal.effect_requirements).toEqual(real.effect_requirements);
    // The authority has to be real, not merely equal to an empty one.
    expect(real.allowed_mutations.length).toBeGreaterThan(0);
    expect(real.effect_permissions.length).toBeGreaterThan(0);
  });

  test('keeps what the model proposed, so the two replies can be read together', () => {
    const audit = runCodeNode(
      'Record Shadow Evaluation',
      [{
        json: {
          ...advisorOutput,
          ai_proposal: {
            version: 'ai_conversation_proposal/v3',
            reply_text: 'Perfecto, 8 m3 de hormigon solo material. ¿A que comuna lo despachamos?',
            observations: [{ id: 'o1', concept: 'modality', normalized_value: 'material' }],
            state_mutations: [{ operation: 'set', field: 'modality' }],
            effect_requests: [],
          },
        },
      }],
      { 'Prepare Shadow Evaluation': preparedContext },
    )[0].json.shadow_audit;

    expect(audit.proposed_reply).toBe('Perfecto, 8 m3 de hormigon solo material. ¿A que comuna lo despachamos?');
    expect(audit.proposed_observations).toEqual([{ concept: 'modality', normalized_value: 'material' }]);
    expect(audit.proposed_mutation_fields).toEqual(['modality']);
  });

  test('records no proposed reply when the model produced none', () => {
    const audit = runCodeNode(
      'Record Shadow Evaluation',
      [{ json: { ...advisorOutput, ai_proposal: null, ai_fallback_reason: 'rate_limited' } }],
      { 'Prepare Shadow Evaluation': preparedContext },
    )[0].json.shadow_audit;

    expect(audit.proposed_reply).toBeNull();
    expect(audit.proposed_observations).toEqual([]);
  });
});
