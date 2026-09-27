import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { describe, expect, test } from 'vitest';

const require = createRequire(import.meta.url);
const {
  validateV3AiProposal,
  authorizeV3ConversationDecision,
} = require('../fixtures/workflow-nodes/shared/v3-contract-runtime.js');
const { reduceV3StateMutations } = require('../fixtures/workflow-nodes/shared/v3-line-items.js');

// -----------------------------------------------------------------------------
// Slice 3c — rollout step 3 (live A/B, N=10, production catalog) found that
// v3.1 first-turn proposals validated only 2/20 times while v3 validated
// 20/20. This file replays the CAPTURED real model output byte-for-byte
// (turn_policy + proposal pairs, never hand-authored) through the real
// validator/authorizer/reducer and pins the exact, documented outcome for
// each one: either it validates and the reduced state matches design.md's D5
// semantics, or it is correctly rejected on the one documented clarification
// rule (an ambiguous item's product must be resolved before anything else is
// asked) — never on a contract-shape bug the model could not have avoided.
// -----------------------------------------------------------------------------

const fixturePath = path.join(process.cwd(), 'tests', 'fixtures', 'v3-line-items', 'captured-live-proposals.json');
const captured = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));

const byScenario = (scenario) => captured.filter((entry) => entry.scenario === scenario);

const firstTurn = byScenario('first-turn');
const wireCorrection = byScenario('wire-correction');
const wireCorrectionHashed = byScenario('wire-correction-hashed-ids');

const validationErrorCodes = (validation) => validation.errors.map((error) => error.code);

const decisionAndState = (entry, validation) => {
  const decision = authorizeV3ConversationDecision(entry.turn_policy, entry.proposal, validation);
  const state = reduceV3StateMutations(entry.input.qualification_context, decision.state_mutations);
  return { decision, state };
};

describe('captured first-turn proposals — pandereta (ambiguous) + wire (matched) + commune', () => {
  test.each([0, 1, 2, 4])('entry %i is correctly rejected on the one documented clarification rule', (index) => {
    const entry = firstTurn[index];
    const validation = validateV3AiProposal(entry.turn_policy, entry.proposal);

    // The model did not prioritize resolving the ambiguous pandereta item
    // over an unrelated goal (service/use_case/service_scope) in its single
    // primary_request. Design.md's validator rule requires the ambiguous
    // item's clarification first — this is real, intentional production
    // behavior, not a contract-shape defect, so rejection is correct.
    expect(validationErrorCodes(validation)).toEqual(['catalog_resolution_clarification_required']);
  });

  test('entry 3 asks about the ambiguous item specifically and validates; the reduced state matches D5', () => {
    const entry = firstTurn[3];
    const validation = validateV3AiProposal(entry.turn_policy, entry.proposal);

    expect(validation.valid).toBe(true);
    expect(validation.errors).toEqual([]);

    const { decision, state } = decisionAndState(entry, validation);
    const panderetaItemId = decision.state_mutations.find((mutation) => mutation.field === 'measurements').item_id;
    const wireItemId = decision.state_mutations.find((mutation) => mutation.field === 'product').item_id;
    expect(panderetaItemId).not.toBe(wireItemId);

    const panderetaItem = state.line_items.find((item) => item.item_id === panderetaItemId);
    const wireItem = state.line_items.find((item) => item.item_id === wireItemId);

    // D5: the ambiguous item keeps its evidenced quantity/measurements, and
    // its product stays withheld (never authorized this turn).
    expect(panderetaItem.product).toBeNull();
    expect(panderetaItem.quantity).toEqual({ kind: 'approximate', value: 500, unit: 'ml', name: null });
    expect(panderetaItem.measurements).toEqual({ kind: 'height', value: 3, unit: 'metros', name: null });

    // The clear (matched) item commits its product; a clear item may commit
    // with quantity null.
    expect(wireItem.product).toBe('Alambre de Púas');
    expect(wireItem.quantity).toBeNull();

    // Quote-level facts commit at quote level, not on any item.
    expect(state.commune).toBe('Lo prado');
  });
});

describe('captured wire-correction proposals — the correction stays scoped to the named wire item', () => {
  const cases = [
    ...wireCorrection.map((entry, index) => ({ entry, label: `wire-correction[${index}]` })),
    ...wireCorrectionHashed.map((entry, index) => ({ entry, label: `wire-correction-hashed-ids[${index}]` })),
  ];

  test.each(cases.map(({ label }) => label))('%s validates and corrects only the wire item', (label) => {
    const { entry } = cases.find((candidate) => candidate.label === label);
    const validation = validateV3AiProposal(entry.turn_policy, entry.proposal);

    expect(validation.errors).toEqual([]);
    expect(validation.valid).toBe(true);

    const { decision, state } = decisionAndState(entry, validation);
    const inputItems = entry.input.qualification_context.line_items;
    const wireInputItem = inputItems.find((item) => item.product === 'Alambre de Púas');
    const fenceInputItem = inputItems.find((item) => item.item_id !== wireInputItem.item_id);

    // Scoping (D5 correction semantics): the un-named item is byte-identical
    // to its pre-turn state — the correction never touches it.
    const fenceAfter = state.line_items.find((item) => item.item_id === fenceInputItem.item_id);
    expect(fenceAfter).toEqual(fenceInputItem);

    // The named item is the only one the decision actually mutates, and its
    // quantity is corrected to the evidenced value (300 ml).
    const quantityMutation = decision.state_mutations.find((mutation) => mutation.field === 'quantity');
    expect(quantityMutation.item_id).toBe(wireInputItem.item_id);
    const wireAfter = state.line_items.find((item) => item.item_id === wireInputItem.item_id);
    expect(wireAfter.quantity).toEqual({ kind: 'exact', value: 300, unit: 'ml', name: null });
    expect(wireAfter.product).toBe('Alambre de Púas');
  });
});
