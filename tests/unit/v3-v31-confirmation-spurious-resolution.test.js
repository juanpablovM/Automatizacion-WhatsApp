import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { describe, expect, test } from 'vitest';

const require = createRequire(import.meta.url);
const { validateV3AiProposal, digestObject } = require('../fixtures/workflow-nodes/shared/v3-contract-runtime.js');

// -----------------------------------------------------------------------------
// Live canary 2026-09-27, final-confirmation turn ("Sí, está todo correcto").
// The model emitted a spurious catalog_resolutions entry for an item whose
// product was already a known fact, although the customer named no product:
//   proposals[0]: unsupported, evidence "todo"          -> effect_prerequisite_unresolved
//   proposals[1]: matched, evidence "todo está correcto" -> catalog_resolution_evidence_not_found
// Both captured proposals MUST stay rejected with the same codes (the
// protection is never weakened); the fix only adds repair guidance telling
// the model to drop a catalog_resolution that names no product.
// -----------------------------------------------------------------------------

const fixturePath = path.join(
  process.cwd(), 'tests', 'fixtures', 'v3-line-items', 'captured-confirmation-spurious-resolution.json',
);
const captured = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));
const { policy, proposals } = captured;
const [unsupportedProposal, matchedProposal] = proposals;

const SPURIOUS_ITEM_REF = 'li_3280817426f1';

describe('captured final-confirmation proposals with a spurious catalog_resolution', () => {
  test('the fixture is the v3.1 final-confirmation turn with no product in the message', () => {
    expect(policy.version).toBe('ai_prd_turn_policy/v3.1');
    expect(policy.turn.pending_question_goal_id).toBe('final_confirmation');
    expect(policy.turn.message.text).toBe('Sí, está todo correcto');
  });

  test('the unsupported resolution is still rejected with effect_prerequisite_unresolved on the same item', () => {
    const validation = validateV3AiProposal(policy, unsupportedProposal);

    expect(validation.valid).toBe(false);
    expect(validation.errors.map((error) => error.code)).toEqual(['effect_prerequisite_unresolved']);
    expect(validation.errors[0].path).toBe('effect_requests[0]');
    expect(validation.errors[0].related_ids).toEqual([`product@${SPURIOUS_ITEM_REF}`]);
  });

  test('the unsupported rejection now carries guidance to remove the resolution that names no product', () => {
    const [error] = validateV3AiProposal(policy, unsupportedProposal).errors;

    expect(error.instruction).toContain('catalog_resolutions');
    expect(error.instruction).toContain(SPURIOUS_ITEM_REF);
    expect(error.instruction).toContain('names no product');
  });

  test('the matched resolution is still rejected with catalog_resolution_evidence_not_found', () => {
    const validation = validateV3AiProposal(policy, matchedProposal);

    expect(validation.valid).toBe(false);
    expect(validation.errors.map((error) => error.code)).toEqual(['catalog_resolution_evidence_not_found']);
    expect(validation.errors[0].path).toBe('catalog_resolutions[0].evidence_quote');
  });

  test('the evidence_not_found rejection now carries guidance to remove the resolution if no product is named', () => {
    const [error] = validateV3AiProposal(policy, matchedProposal).errors;

    expect(error.instruction).toContain('catalog_resolutions');
    expect(error.instruction).toContain('names no product');
  });

  test('final_confirmation_not_ready caused by the same spurious resolution keeps its code and gains the hint', () => {
    const proposal = {
      ...unsupportedProposal,
      primary_request: { goal_id: 'final_confirmation', item_ref: null },
      effect_requests: [],
    };
    const validation = validateV3AiProposal(policy, proposal);
    const error = validation.errors.find((entry) => entry.code === 'final_confirmation_not_ready');

    expect(validation.valid).toBe(false);
    expect(error?.related_ids).toEqual([`product@${SPURIOUS_ITEM_REF}`]);
    expect(error?.instruction).toContain('Ask for one unresolved required goal instead of asking for final confirmation.');
    expect(error?.instruction).toContain('names no product');
  });

  test.each([0, 1])('proposal %i validates clean once catalog_resolutions is empty', (index) => {
    const validation = validateV3AiProposal(policy, { ...proposals[index], catalog_resolutions: [] });

    expect(validation.errors).toEqual([]);
    expect(validation.valid).toBe(true);
  });

  test('an unsupported resolution whose evidence names a catalog product gets no remove-resolution hint', () => {
    const { policy_digest: _digest, ...policyBody } = {
      ...policy,
      turn: { ...policy.turn, message: { ...policy.turn.message, text: 'Sí, pero el Alambre de Púas no' } },
    };
    const namedPolicy = { ...policyBody, policy_digest: digestObject(policyBody) };
    const proposal = {
      ...unsupportedProposal,
      policy_digest: namedPolicy.policy_digest,
      catalog_resolutions: [{
        ...unsupportedProposal.catalog_resolutions[0], evidence_quote: 'Alambre de Púas',
      }],
    };
    const validation = validateV3AiProposal(namedPolicy, proposal);
    const prerequisite = validation.errors.find((error) => error.code === 'effect_prerequisite_unresolved');

    expect(validation.valid).toBe(false);
    expect(prerequisite?.related_ids).toEqual([`product@${SPURIOUS_ITEM_REF}`]);
    expect(prerequisite?.instruction).toBeUndefined();
  });
});
