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

const MESSAGE = 'Quiero crear una solicitud por 20 m3 de hormigon H25 en Santiago, solo material con delivery a Av. Siempre Viva 123, sin restricciones de acceso';

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
  reply_text: 'Perfecto, registraré la solicitud por 20 m3 de hormigon H25 para Santiago con delivery.',
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
      grounding_ref: null,
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
      id: 'obs-service-scope',
      concept: 'service_scope',
      quote: 'solo material',
      normalized_value: 'material',
      grounding_ref: 'service_scope:material',
      resolves_goal_ids: ['service_scope'],
    },
    {
      id: 'obs-fulfillment',
      concept: 'fulfillment',
      quote: 'delivery',
      normalized_value: 'delivery',
      grounding_ref: 'fulfillment:delivery',
      resolves_goal_ids: ['fulfillment'],
    },
    {
      id: 'obs-address',
      concept: 'address',
      quote: 'Av. Siempre Viva 123',
      normalized_value: 'Av. Siempre Viva 123',
      grounding_ref: null,
      resolves_goal_ids: ['address'],
    },
    {
      id: 'obs-access-restrictions', concept: 'access_restrictions',
      quote: 'sin restricciones de acceso', normalized_value: 'sin restricciones de acceso',
      grounding_ref: null, resolves_goal_ids: ['access_restrictions'],
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
      .toEqual(['access_restrictions', 'address', 'commune', 'fulfillment', 'product', 'quantity', 'service_scope']);
  });

  test('derives evidence offsets from the message rather than trusting the plan', () => {
    const policy = buildPolicy();
    const proposal = buildValidProposal(policy, PLAN);
    const commune = proposal.observations.find(({ id }) => id === 'obs-commune');

    expect(commune.evidence_occurrence).toBe(1);
    expect(MESSAGE.indexOf(commune.evidence_quote)).toBeGreaterThan(-1);
  });

  test('requests only effects the policy permits', () => {
    // Asking for an effect the policy does not permit invalidates the whole
    // proposal and sends the turn to contingency, so the mock has to read the
    // permissions rather than assume them. A shadow turn used to be the case
    // that produced an empty set; it no longer is — a rehearsal is compiled with
    // the same authority as a real turn — so strip the permissions directly.
    const policy = buildPolicy();
    const withoutPermissions = { ...policy, effect_authority: { ...policy.effect_authority, permissions: [] } };
    const proposal = buildValidProposal(withoutPermissions, PLAN);

    expect(proposal.effect_requests).toEqual([]);
  });

  test('a rehearsal is compiled with the same effect authority as a real turn', () => {
    // The rehearsal exists to show what the model would have proposed. Emptying
    // its authority made every faithful proposal invalid and the measurement a
    // tautology; the lane, not the policy, is what keeps it from touching
    // anything.
    const real = buildPolicy();
    const rehearsal = buildPolicy({ shadow_mode: true });

    expect(rehearsal.effect_authority.permissions).toEqual(real.effect_authority.permissions);
    expect(real.effect_authority.permissions.length).toBeGreaterThan(0);
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
