import fs from 'node:fs';
import { createRequire } from 'node:module';

const nodeRequire = createRequire(import.meta.url);
const { buildV3PolicyInput } = nodeRequire(
  '../fixtures/workflow-nodes/shared/v3-rollout-runtime.js',
);
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

const degradeV3Route = (row) => {
  const workflow = JSON.parse(fs.readFileSync('n8n/workflows/wa-conversation-orchestrator.json', 'utf8'));
  const node = workflow.nodes.find(({ name }) => name === 'Degrade V3 Route To Legacy');
  return new Function('items', node.parameters.jsCode)([{ json: row }])[0].json;
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

  test('the grounding authority survives too, or no claim can be evidenced', () => {
    // Same trap, one field further along. `Load Conversation State` publishes
    // the catalog as `v3_grounding`, and `Compile V3 Turn Policy` turns it into
    // the authority every grounded observation is checked against. Dropped
    // here, the policy compiles with an empty catalog: product and service
    // observations fail `grounding_invalid`, and `create_lead` becomes unreachable.
    const v3Grounding = {
      catalog: [{ ref: 'product:H25', concept: 'product', value: 'hormigon H25' }],
    };
    const out = outputOf(turn({ ...canaryRoute, v3_grounding: v3Grounding }));

    expect(out.v3_grounding).toEqual(v3Grounding);
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

  test('an active v3 race is explicitly degraded to legacy with its route audit preserved', () => {
    const out = degradeV3Route({
      ...turn(canaryRoute),
      route_matches: false,
      route_failure_reason: 'active_turn_exists',
    });

    expect(out).toMatchObject({
      contract_version: 'legacy',
      contract_mode: 'legacy',
      route_mode: 'legacy',
      v3_route_degraded: true,
      v3_route_failure_reason: 'active_turn_exists',
      v3_original_contract_route: canaryRoute.contract_route,
    });
    expect(out.contract_route).toMatchObject({
      contract_version: 'legacy',
      mode: 'legacy',
      visible_contract: 'legacy',
      recovery_contract: 'legacy',
      legacy_reinterpretation_allowed: true,
    });
  });

  test('the v3 policy uses the fixed route identity without overwriting prior context identity', () => {
    const input = {
      ...turn(canaryRoute),
      conversation_id: null,
      target_conversation_id: 101,
      original_conversation_id: 101,
      route_conversation_id: 202,
    };

    const policyInput = buildV3PolicyInput(input);

    expect(policyInput.turn.conversation_id).toBe('202');
    expect(input.target_conversation_id).toBe(101);
    expect(input.original_conversation_id).toBe(101);
  });

  test('declares explicit confirmation as the create-lead trigger', () => {
    const policyInput = buildV3PolicyInput(turn(canaryRoute));

    expect(policyInput.effect_requirements).toContainEqual({
      effect_type: 'create_lead',
      required_goal_ids: ['product', 'quantity', 'service_scope'],
      trigger: 'explicit_confirmation_when_ready',
    });
  });

  test('separates service scope from fulfillment while reading legacy modality facts', () => {
    const material = buildV3PolicyInput(turn({
      ...canaryRoute,
      qualification_context: { modality: 'material' },
    }));
    const delivery = buildV3PolicyInput(turn({
      ...canaryRoute,
      qualification_context: { modality: 'delivery' },
    }));

    expect(material.facts).toContainEqual(expect.objectContaining({
      field: 'service_scope', value: 'material',
    }));
    expect(material.goals).toContainEqual(expect.objectContaining({
      goal_id: 'fulfillment', status: 'unresolved', importance: 'required_for_effect',
    }));
    expect(delivery.facts).toContainEqual(expect.objectContaining({
      field: 'fulfillment', value: 'delivery',
    }));
    expect(delivery.goals).toContainEqual(expect.objectContaining({
      goal_id: 'service_scope', status: 'resolved', importance: 'required_for_effect',
    }));
    expect(material.allowed_mutations.map(({ field }) => field)).toEqual(expect.arrayContaining([
      'service_scope', 'fulfillment',
    ]));
    expect(material.allowed_mutations.map(({ field }) => field)).not.toContain('modality');
  });

  test('does not promote current-turn legacy heuristics into authoritative v3 facts', () => {
    const policyInput = buildV3PolicyInput(turn({
      ...canaryRoute,
      service: 'Perfecto',
      commune: 'Domicilio',
      modality: 'delivery',
      qualification_context: { product: 'Bloques de Hormigón' },
    }));

    expect(policyInput.facts).toContainEqual(expect.objectContaining({
      field: 'product', value: 'Bloques de Hormigón',
    }));
    expect(policyInput.facts.map(({ field }) => field)).not.toContain('service');
    expect(policyInput.facts.map(({ field }) => field)).not.toContain('commune');
    expect(policyInput.facts.map(({ field }) => field)).not.toContain('fulfillment');
  });

  test('carries only persisted pending-question meaning into the v3 turn policy input', () => {
    const regular = buildV3PolicyInput(turn({ pending_question_key: 'fulfillment' }));
    const persistedConfirmation = buildV3PolicyInput(turn({ pending_question_key: 'confirm' }));
    const currentTurnLegacyConfirmation = buildV3PolicyInput(turn({ current_step: 'confirm' }));

    expect(regular.turn.pending_question_goal_id).toBe('fulfillment');
    expect(persistedConfirmation.turn.pending_question_goal_id).toBe('final_confirmation');
    expect(currentTurnLegacyConfirmation.turn.pending_question_goal_id).toBeNull();
  });

  test('keeps communes out of closed grounding and publishes the both scope', () => {
    const policyInput = buildV3PolicyInput(turn({
      v3_grounding: {
        catalog: [
          { ref: 'product:bloques', concept: 'product', value: 'Bloques' },
          { ref: 'commune:santiago', concept: 'commune', value: 'Santiago' },
        ],
      },
    }));

    expect(policyInput.grounding.catalog).toEqual([
      { ref: 'product:bloques', concept: 'product', value: 'Bloques' },
    ]);
    expect(policyInput.grounding.modality_synonyms).toContainEqual({
      ref: 'service_scope:both', concept: 'service_scope', value: 'both',
    });
  });
});

// A turn that v3 does not author the reply for — the `Use V3 Contract?` legacy
// branch, and the `V3 Control Only?` branch that lets v3 steer without writing —
// is delivered through `Apply AI Assistance` on its way to the terminal. That
// node rebuilds the item from `deterministicFields`, an explicit allowlist, and
// never named `v3_grounding`, so the field was dropped from every turn that
// crossed it. Production proved it during the rollout: five policies compiled
// with `grounding.catalog: []` while the load query returned 28 entries against
// the same database, and every observation failed `grounding_invalid`.
describe('the grounding authority survives the legacy lane too', () => {
  const applyAiAssistance = (row) => {
    const source = fs.readFileSync(
      'tests/fixtures/workflow-nodes/wa-conversation-orchestrator/apply-ai-assistance.js',
      'utf8',
    );
    return new Function('items', '$env', source)([{ json: row }], {})[0].json;
  };

  test('carries v3_grounding through Apply AI Assistance', () => {
    const v3Grounding = { catalog: [{ ref: 'product:H25', concept: 'product', value: 'hormigon H25' }] };
    const out = applyAiAssistance({
      conversation_id: 1, inbound_event_id: 192, text_body: 'Hola', v3_grounding: v3Grounding,
    });

    expect(out.v3_grounding).toEqual(v3Grounding);
  });

  test('reads the merge-suffixed field the way every other deterministic field is read', () => {
    // `Merge AI Assistance` combines with addSuffix, so the policy side arrives
    // as `_1`. A field read only by its bare name is null on every real turn.
    const v3Grounding = { catalog: [{ ref: 'commune:maipu', concept: 'commune', value: 'Maipu' }] };
    const out = applyAiAssistance({
      conversation_id: 1, inbound_event_id_1: 192, text_body_1: 'Hola', v3_grounding_1: v3Grounding,
    });

    expect(out.v3_grounding).toEqual(v3Grounding);
  });
});
