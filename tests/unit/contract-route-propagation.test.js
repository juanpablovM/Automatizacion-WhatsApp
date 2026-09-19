import fs from 'node:fs';
import { createRequire } from 'node:module';

const nodeRequire = createRequire(import.meta.url);
const { resolveConversationContractRoute, buildV3PolicyInput } = nodeRequire(
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

// The shadow lane lives in `wa-inbound-downstream-dispatcher`, a different
// workflow from the one that resolves the route. `wa-inbound-entry` wires the
// two directly — `Execute Conversation Orchestrator -> Execute Durable
// Downstream Dispatcher` — so the dispatcher's input item *is* the
// orchestrator's output, and `Prepare Conversation Output` is the only node in
// between.
//
// That node rebuilds the item from an explicit allowlist of ~90 fields and
// named none of the route fields. `planShadowEvaluation` therefore received
// `{ mode: undefined }`, and its gate — `fixedRoute.mode === 'shadow'` — was
// false on every turn, at every value of AI_PRD_CONTRACT_MODE. Five days of
// shadow rollout recorded zero comparable rows: not because no traffic
// qualified, but because the lane could not be reached.
// A shadow turn is delivered by the legacy lane, so it passes through
// `Apply AI Assistance` on its way to the terminal. That node rebuilds the item
// from `deterministicFields`, another explicit allowlist, and never named
// `v3_grounding`. Production proved it: five shadow policies compiled with
// `grounding.catalog: []` while the load query returned 28 entries against the
// same database, and every observation failed `grounding_invalid`.
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

describe('the contract route survives the orchestrator boundary', () => {
  // The dispatcher node ships its runtime inlined, ending in a CommonJS export
  // guard, so it needs a `module` to write to the way n8n's sandbox provides one.
  const runCodeNode = (source, items) => new Function(
    'items', '$env', 'module', 'exports', 'require', source,
  )(items, {}, { exports: {} }, {}, nodeRequire);

  const prepareConversationOutput = (row) => runCodeNode(
    fs.readFileSync(
      'tests/fixtures/workflow-nodes/wa-conversation-orchestrator/prepare-conversation-output.js',
      'utf8',
    ),
    [{ json: row }],
  )[0].json;

  // `refs` stands in for the upstream items n8n resolves through `$('Node')`.
  const prepareAiPrdShadow = (row, refs = {}) => {
    const workflow = JSON.parse(fs.readFileSync('n8n/workflows/wa-inbound-downstream-dispatcher.json', 'utf8'));
    const node = workflow.nodes.find(({ name }) => name === 'Prepare AI PRD Shadow');
    return new Function(
      'items', '$env', '$', 'module', 'exports', 'require', node.parameters.jsCode,
    )(
      [{ json: row }],
      {},
      (target) => ({ first: () => ({ json: refs[target] ?? row }) }),
      { exports: {} },
      {},
      nodeRequire,
    )[0].json;
  };

  // Built by the real resolver rather than sketched: a hand-written route is a
  // guess about the contract, and this test is asserting the contract.
  const routeFor = (mode) => {
    const route = resolveConversationContractRoute({ inbound_event_id: turn().inbound_event_id }, { mode });
    return {
      contract_route: route,
      contract_version: route.contract_version,
      contract_mode: route.mode,
      route_mode: route.mode,
      route_rule_id: route.rule_id,
    };
  };
  const shadowRoute = routeFor('shadow');

  // What `Outbound Lane Complete` and the outbound lane contribute downstream,
  // after the orchestrator has already returned.
  const delivered = {
    outbound_lane_complete: true,
    delivery_status: 'sent',
    delivery_receipt_ref: 'evolution:msg-1',
  };

  test('the orchestrator hands the route to its caller', () => {
    const out = prepareConversationOutput(turn(shadowRoute));

    for (const field of ROUTE_FIELDS) {
      expect(out, `${field} never leaves the orchestrator`).toHaveProperty(field);
    }
    expect(out.contract_mode).toBe('shadow');
    expect(out.contract_route).toEqual(shadowRoute.contract_route);
  });

  test('the grounding authority reaches the shadow evaluator too', () => {
    // Found by running shadow against production: the audit came back with
    // `grounding.catalog: []` while 28 catalog items were active. Same drop as
    // the route, one field over. `Prepare Shadow Evaluation` compiles the v3
    // policy from the payload the dispatcher forwards, so an empty catalog here
    // means no product, service or commune observation can ever validate and
    // `create_lead` is unreachable under v3.
    const v3Grounding = { catalog: [{ ref: 'product:H25', concept: 'product', value: 'hormigon H25' }] };
    const out = prepareConversationOutput(turn({ ...shadowRoute, v3_grounding: v3Grounding }));

    expect(out.v3_grounding).toEqual(v3Grounding);
  });

  test('a delivered shadow turn actually reaches the evaluator', () => {
    const handoff = prepareConversationOutput(turn(shadowRoute));
    const planned = prepareAiPrdShadow({ ...handoff, ...delivered });

    expect(planned.shadow_dispatch).toBe(true);
    expect(planned.shadow_plan.reason).toBe('post_delivery');
    expect(planned.shadow_plan.turn_id).toBe(String(turn().inbound_event_id));
    expect(planned.shadow_plan.route_rule_id).toBe('rollout:shadow');
  });

  test('evaluates the message the customer sent, not the reply we sent back', () => {
    // The shadow lane runs after outbound delivery, and by then the item has
    // been through `Merge Outbound Context`: `text_body` holds the reply, not
    // the inbound message. Production proved it — three shadow policies compiled
    // with `turn.message.text` set to the bot's own question, so the model was
    // asked to evidence observations against text the customer never wrote and
    // every proposal failed on observation shape.
    const inbound = prepareConversationOutput(turn({
      ...shadowRoute,
      text_body: 'Necesito 15 m3 de hormigon H25 en Santiago con despacho',
    }));
    const afterOutbound = {
      ...inbound,
      ...delivered,
      // What the outbound lane leaves behind.
      text_body: 'Para dimensionar correctamente la cotizacion, cuanta cantidad necesitas?',
    };

    const planned = prepareAiPrdShadow(afterOutbound, { 'Workflow Input': inbound });

    expect(planned.shadow_dispatch).toBe(true);
    expect(planned.shadow_payload.text_body).toBe('Necesito 15 m3 de hormigon H25 en Santiago con despacho');
  });

  test('still uses the delivery signals from the lane that actually delivered', () => {
    // The inbound item knows nothing about delivery; the gate depends on it.
    const inbound = prepareConversationOutput(turn(shadowRoute));
    const planned = prepareAiPrdShadow({ ...inbound, ...delivered }, { 'Workflow Input': inbound });

    expect(planned.shadow_plan.legacy_delivery_receipt_ref).toBe('evolution:msg-1');
    expect(planned.shadow_plan.reason).toBe('post_delivery');
  });

  test('a canary turn is not silently evaluated as shadow', () => {
    const handoff = prepareConversationOutput(turn(routeFor('canary')));
    const planned = prepareAiPrdShadow({ ...handoff, ...delivered });

    expect(planned.shadow_dispatch).toBe(false);
    expect(planned.shadow_plan.reason).toBe('not_eligible');
  });

  test('a shadow turn whose delivery never completed is not evaluated', () => {
    // The comparison is legacy-vs-v3 on a turn the customer already received.
    // Without a delivered legacy reply there is nothing to compare against.
    const handoff = prepareConversationOutput(turn(shadowRoute));
    const planned = prepareAiPrdShadow({ ...handoff, outbound_lane_complete: false });

    expect(planned.shadow_dispatch).toBe(false);
  });
});
