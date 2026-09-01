// The mock AI server answered `{}` to every call, so no v3 proposal could ever
// be valid and the canary could only ever reach contingency. Thirteen nodes of
// the valid lane have never executed once.
//
// This test builds the policy with the same runtime the orchestrator uses — a
// policy cannot be hand-written, because the validator recomputes its digest —
// and then judges the mock's proposal with the real validator. The contract is
// the oracle: if `validateV3AiProposal` accepts it, the workflow will too.
import { createRequire } from 'node:module';
import path from 'node:path';
import { describe, expect, test } from 'vitest';
import { buildValidProposal, createMockAiServer } from '../fixtures/mock-ai-server.mjs';

const require = createRequire(import.meta.url);
const fixtures = path.resolve(__dirname, '..', 'fixtures', 'workflow-nodes', 'shared');
const { buildV3PolicyInput } = require(path.join(fixtures, 'v3-rollout-runtime.js'));
const { compileV3TurnPolicy, validateV3AiProposal } = require(path.join(fixtures, 'v3-contract-runtime.js'));

const MESSAGE = 'Necesito 20 m3 de hormigon H25 en Santiago con delivery';

const buildPolicy = (overrides = {}) => compileV3TurnPolicy(buildV3PolicyInput({
  inbound_event_id: '1',
  conversation_id: '1',
  conversation_revision: 1,
  external_message_id: 'msg-1',
  text_body: MESSAGE,
  qualification_context: {},
  commercial_context: {
    catalog_items: [{
      id: 'h25',
      name: 'hormigon H25',
      item_type: 'product',
      applicable_cities: ['Santiago'],
    }],
  },
  ...overrides,
}));

// What the customer said, and what a competent model would observe in it. The
// canary owns this; the mock owns turning it into a contract-shaped proposal.
const PLAN = {
  reply_text: 'Perfecto, tomo 20 m3 de hormigon H25 para Santiago con delivery.',
  observations: [
    {
      id: 'obs-product',
      concept: 'product',
      quote: 'hormigon H25',
      normalized_value: 'hormigon H25',
      grounding_ref: 'product:h25',
      resolves_goal_ids: ['product'],
    },
    {
      id: 'obs-commune',
      concept: 'commune',
      quote: 'Santiago',
      normalized_value: 'Santiago',
      grounding_ref: 'commune:santiago',
      resolves_goal_ids: ['commune'],
    },
    {
      id: 'obs-quantity',
      concept: 'quantity',
      quote: '20 m3',
      normalized_value: '20 m3',
      grounding_ref: null,
      resolves_goal_ids: ['quantity'],
    },
    {
      id: 'obs-modality',
      concept: 'modality',
      quote: 'delivery',
      normalized_value: 'delivery',
      grounding_ref: 'modality:delivery',
      resolves_goal_ids: ['modality'],
    },
  ],
  effects: ['create_lead'],
};

describe('Mock AI — synthesizes a proposal the v3 contract accepts', () => {
  test('the real validator accepts it and authorizes the lead effect', () => {
    const policy = buildPolicy();
    const validation = validateV3AiProposal(policy, buildValidProposal(policy, PLAN));

    expect(validation.errors).toEqual([]);
    expect(validation.valid).toBe(true);

    // Reaching `valid` is not the point: the valid lane only runs its effect
    // nodes when an effect is actually authorized.
    expect(validation.authorized_effect_requests.map(({ type }) => type)).toEqual(['create_lead']);
    expect(validation.authorized_mutations.map(({ field }) => field).sort())
      .toEqual(['commune', 'modality', 'product', 'quantity']);
  });

  test('derives evidence offsets from the message rather than trusting the plan', () => {
    const policy = buildPolicy();
    const proposal = buildValidProposal(policy, PLAN);
    const commune = proposal.observations.find(({ id }) => id === 'obs-commune');

    expect(commune.evidence_occurrence).toBe(1);
    expect(MESSAGE.indexOf(commune.evidence_quote)).toBeGreaterThan(-1);
  });

  test('requests only effects the policy permits', () => {
    // A shadow turn grants no permissions at all; asking anyway would make the
    // whole proposal invalid and send the turn to contingency.
    const policy = buildPolicy({ shadow_mode: true });
    const proposal = buildValidProposal(policy, PLAN);

    expect(proposal.effect_requests).toEqual([]);
    expect(validateV3AiProposal(policy, proposal).valid).toBe(true);
  });

  test('serves the synthesized proposal only once a plan is installed', async () => {
    // The contingency canary depends on this server answering `{}`, so a plan
    // has to be opt-in per run and the default behaviour must not move.
    const server = createMockAiServer();
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    const policy = buildPolicy();
    const complete = async () => {
      const response = await fetch(`${base}/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          messages: [{ role: 'user', content: JSON.stringify({ turn_policy: policy }) }],
        }),
      });
      const body = await response.json();
      return JSON.parse(body.choices[0].message.content);
    };

    try {
      expect(await complete()).toEqual({});

      await fetch(`${base}/plan`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(PLAN),
      });

      const validation = validateV3AiProposal(policy, await complete());
      expect(validation.errors).toEqual([]);
      expect(validation.authorized_effect_requests.map(({ type }) => type)).toEqual(['create_lead']);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  test('omits a mutation the policy does not authorize', () => {
    // `use_case` is a real policy field, but nothing in the message grounds it
    // and the plan never observes it, so no mutation may appear for it.
    const policy = buildPolicy();
    const proposal = buildValidProposal(policy, PLAN);

    expect(proposal.state_mutations.map(({ field }) => field)).not.toContain('use_case');
    expect(proposal.state_mutations.every(({ replaces_fact_id }) => replaces_fact_id === null)).toBe(true);
  });
});
