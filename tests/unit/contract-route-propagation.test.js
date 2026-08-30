import { describe, expect, test } from 'vitest';
import { evaluateConversationStep } from '../fixtures/workflow-nodes/wa-conversation-orchestrator/evaluate-conversation-step.js';

// Resolve Conversation Contract Route decides the lane and emits five fields.
// Evaluate Conversation Step runs immediately after it and builds a fresh
// output object, so anything it does not name is dropped before the row ever
// reaches `Use V3 Contract?`, whose condition is
// `$json.contract_version === 'v3'`.
//
// When these fields did not survive, that condition compared undefined against
// 'v3' on every single turn: v3 could never activate, at any value of
// AI_PRD_CONTRACT_MODE. The switch was not wired to the branch it controls.
// apply-ai-assistance already lists all five in deterministicFields, so the
// contract expected them to flow; nothing emitted them.
const ROUTE_FIELDS = ['contract_route', 'contract_version', 'contract_mode', 'route_mode', 'route_rule_id'];

const turn = (overrides = {}) => ({
  conversation_id: 1,
  inbound_event_id: 192,
  text_body: 'Hola',
  ...overrides,
});

const canaryRoute = {
  contract_route: { mode: 'canary', contract_version: 'v3', rule_id: 'rollout:canary' },
  contract_version: 'v3',
  contract_mode: 'canary',
  route_mode: 'canary',
  route_rule_id: 'rollout:canary',
};

const outputOf = (row) => {
  const result = evaluateConversationStep(row);
  return result.json ?? result;
};

describe('the contract route survives step evaluation', () => {
  test('a v3 route reaches the output, so Use V3 Contract? can see it', () => {
    const out = outputOf(turn(canaryRoute));

    expect(out.contract_version).toBe('v3');
    expect(out.contract_mode).toBe('canary');
    expect(out.route_mode).toBe('canary');
    expect(out.route_rule_id).toBe('rollout:canary');
    expect(out.contract_route).toEqual(canaryRoute.contract_route);
  });

  test('every field the route emits is carried, none silently dropped', () => {
    const out = outputOf(turn(canaryRoute));

    for (const field of ROUTE_FIELDS) {
      expect(out, `${field} was dropped`).toHaveProperty(field);
    }
  });

  test('a legacy route is carried too, so the branch is decided by data not by absence', () => {
    const out = outputOf(turn({
      contract_route: { mode: 'legacy', contract_version: 'legacy', rule_id: 'rollout:legacy' },
      contract_version: 'legacy',
      contract_mode: 'legacy',
      route_mode: 'legacy',
      route_rule_id: 'rollout:legacy',
    }));

    expect(out.contract_version).toBe('legacy');
    expect(out.contract_mode).toBe('legacy');
  });

  test('a turn with no route resolved is not invented into one', () => {
    const out = outputOf(turn());

    expect(out.contract_version ?? null).toBeNull();
    expect(out.contract_route ?? null).toBeNull();
  });
});
