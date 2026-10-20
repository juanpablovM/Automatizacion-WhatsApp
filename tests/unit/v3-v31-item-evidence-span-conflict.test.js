import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { describe, expect, test } from 'vitest';

const require = createRequire(import.meta.url);
const { validateV3AiProposal } = require('../fixtures/workflow-nodes/shared/v3-contract-runtime.js');

// -----------------------------------------------------------------------------
// Slice 3c follow-up (live A/B round 2, N=10, production catalog, after
// 3c.1-3c.5). v3.1 first-turn validity matched v3 (20/20), but 3 of 20
// first-turn proposals and 1 of 6 valid corrections misattributed a
// quantity/measurement across items:
//   - copied: the same evidenced text ("500 ml", "300 ml") resolved the same
//     item concept on BOTH items — deterministically detectable, since the
//     same (field, evidence_quote, evidence_occurrence) triple can never
//     legitimately authorize two different item_ref values. Task 3c.7's
//     validator rule (item_evidence_span_conflict) rejects this shape.
//   - moved: a single, non-duplicated evidence span was attached to the
//     WRONG item. No shape signal distinguishes "the right item" from "the
//     wrong item" for one unambiguous span, so this is NOT — and cannot be —
//     caught by a deterministic validator rule. It stays a documented gap
//     here and is addressed only by the v3.1 prompt rule added in task 3c.8
//     ("never copy or move a quantity or measurement from one item to
//     another").
//
// Every fixture below starts from a REAL captured turn_policy (never
// hand-authored) in captured-live-proposals.json, mutated only in the exact
// shape the live evidence described.
// -----------------------------------------------------------------------------

const fixturePath = path.join(process.cwd(), 'tests', 'fixtures', 'v3-line-items', 'captured-live-proposals.json');
const captured = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));
const byScenario = (scenario) => captured.filter((entry) => entry.scenario === scenario);
const clone = (value) => JSON.parse(JSON.stringify(value));
const errorCodes = (validation) => validation.errors.map((error) => error.code);

describe('captured first-turn proposal (pandereta + wire), quantity misattribution', () => {
  const base = () => byScenario('first-turn')[3];

  test('sanity: the unmodified captured proposal still validates (no false positive from the new rule)', () => {
    const entry = base();
    const validation = validateV3AiProposal(entry.turn_policy, entry.proposal);
    expect(validation.valid).toBe(true);
    expect(validation.errors).toEqual([]);
  });

  test('copied: the "aprox 500 ml" span duplicated onto the wire item is rejected', () => {
    const entry = base();
    const proposal = clone(entry.proposal);
    proposal.observations.push({
      id: 'obs-quantity-wire-copy',
      concept: 'quantity',
      raw_value: 'aprox 500 ml',
      normalized_value: { kind: 'approximate', value: 500, unit: 'ml', name: null },
      evidence_quote: 'aprox 500 ml',
      evidence_occurrence: 1,
      grounding_ref: null,
      resolves_goal_ids: ['line_items'],
      item_ref: 'new:2',
    });
    proposal.state_mutations.push({
      operation: 'set', field: 'quantity', item_ref: 'new:2',
      observation_id: 'obs-quantity-wire-copy', replaces_fact_id: null,
    });

    const validation = validateV3AiProposal(entry.turn_policy, proposal);

    expect(validation.valid).toBe(false);
    expect(errorCodes(validation)).toEqual(['item_evidence_span_conflict']);
  });

  test('moved (documented gap): the quantity span reattached solely to the wire item is not caught here', () => {
    const entry = base();
    const proposal = clone(entry.proposal);
    const qtyObservation = proposal.observations.find((observationEntry) => observationEntry.id === 'obs-quantity');
    qtyObservation.item_ref = 'new:2'; // was 'new:1' (pandereta); now wrongly the wire item
    const qtyMutation = proposal.state_mutations.find((mutation) => mutation.observation_id === 'obs-quantity');
    qtyMutation.item_ref = 'new:2';

    const validation = validateV3AiProposal(entry.turn_policy, proposal);

    // Documented boundary: this single, non-duplicated span carries no
    // shape signal that it targets the wrong item, so the validator still
    // accepts it. Left to the v3.1 prompt rule (task 3c.8), not this rule.
    expect(validation.valid).toBe(true);
    expect(errorCodes(validation)).toEqual([]);
  });
});

describe('captured wire-correction proposal, quantity misattribution', () => {
  const base = () => byScenario('wire-correction')[0];

  test('sanity: the unmodified captured correction still validates and stays scoped to the wire item', () => {
    const entry = base();
    const validation = validateV3AiProposal(entry.turn_policy, entry.proposal);
    expect(validation.valid).toBe(true);
    expect(validation.errors).toEqual([]);
  });

  test('copied: the "300 ml" correction span duplicated onto the fence item is rejected', () => {
    const entry = base();
    const proposal = clone(entry.proposal);
    proposal.observations.push({
      id: 'obs-qty-fence-copy',
      concept: 'quantity',
      raw_value: '300 ml',
      normalized_value: { kind: 'exact', value: 300, unit: 'ml', name: null },
      evidence_quote: '300 ml',
      evidence_occurrence: 1,
      grounding_ref: null,
      resolves_goal_ids: ['line_items'],
      item_ref: 'li_fence',
    });
    proposal.state_mutations.push({
      operation: 'set', field: 'quantity', item_ref: 'li_fence',
      observation_id: 'obs-qty-fence-copy', replaces_fact_id: null,
    });

    const validation = validateV3AiProposal(entry.turn_policy, proposal);

    expect(validation.valid).toBe(false);
    expect(errorCodes(validation)).toEqual(['item_evidence_span_conflict']);
  });

  test('moved (documented gap): the "300 ml" correction reattached solely to the fence item is not caught here', () => {
    const entry = base();
    const proposal = clone(entry.proposal);
    const qtyObservation = proposal.observations.find((observationEntry) => observationEntry.id === 'obs_qty_wire');
    qtyObservation.item_ref = 'li_fence'; // was 'li_wire'; the live defect put 300 ml on the pandereta instead
    const qtyMutation = proposal.state_mutations.find((mutation) => mutation.observation_id === 'obs_qty_wire');
    qtyMutation.item_ref = 'li_fence';

    const validation = validateV3AiProposal(entry.turn_policy, proposal);

    // Same documented boundary as the first-turn case above: one
    // unambiguous, non-duplicated span carries no shape signal that the
    // model chose the wrong item. Left to the v3.1 prompt rule (task 3c.8).
    expect(validation.valid).toBe(true);
    expect(errorCodes(validation)).toEqual([]);
  });
});
