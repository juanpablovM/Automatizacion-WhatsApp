import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { describe, expect, test } from 'vitest';

const require = createRequire(import.meta.url);
const {
  validateV3AiProposal, V3_CONTRACTS,
} = require('../fixtures/workflow-nodes/shared/v3-contract-runtime.js');

// -----------------------------------------------------------------------------
// Task 3c.18 (contract v3.1 only). Live 2026-09-28 the model used
// primary_request.goal_id="name" (the CUSTOMER's own name goal) to ask about
// an item:
//   - scenario B turn 2: "¿con 'pandereta' te refieres a cierros de hormigón?"
//     with {goal_id:"name", item_ref:"li_52d7e0a1c9f4"} (validated clean, so
//     pending_question_key became `name`);
//   - scenario C: the 3c.17 repair of "500 metros de cada uno de los
//     alambres" wrote the right assignment question but with
//     {goal_id:"name", item_ref:"li_2e3e2dd78cd4"}, rejected again, contingency.
// primary_request_item_ref_invalid rejects (repairable) an item_ref on a
// quote-level goal: only the item goals (product, quantity, measurements, and
// the line_items equivalent already accepted for item clarification) may be
// item-scoped.
// -----------------------------------------------------------------------------

const fixtureDir = path.join(process.cwd(), 'tests', 'fixtures', 'v3-line-items');
const readFixture = (file) => JSON.parse(fs.readFileSync(path.join(fixtureDir, file), 'utf8'));
const clone = (value) => JSON.parse(JSON.stringify(value));
const errorCodes = (validation) => validation.errors.map((error) => error.code);

const distributive = readFixture('captured-distributive-ambiguous.json');
const [finalConfirmationProposal, nameRepairProposal] = distributive.proposals;
const CONCERTINA_REF = 'li_2e3e2dd78cd4';

const live = readFixture('captured-live-proposals.json');
const hashedCorrections = live.filter((entry) => entry.scenario === 'wire-correction-hashed-ids');
const panderetaNameEntry = hashedCorrections[1];
const PANDERETA_REF = 'li_52d7e0a1c9f4';

const itemRefInvalidInstruction = (goalId) => `Goal "${goalId}" is a quote-level goal, so primary_request.item_ref must be null for it. To ask or confirm something about one item use goal_id "product", "quantity" or "measurements" with that item's item_ref (for example, clarifying which product the customer means is "product"; confirming which items a quantity applies to is "quantity"). goal_id "name" only asks for the customer's own name.`;

describe('captured scenario C: the distributive assignment question asked with goal "name"', () => {
  test('the fixture is the live v3.1 turn "500 metros de cada uno de los alambres" with two proposals', () => {
    expect(distributive.policy.version).toBe(V3_CONTRACTS.policy_v3_1);
    expect(distributive.policy.turn.message.text).toBe('500 metros de cada uno de los alambres');
    expect(finalConfirmationProposal.primary_request).toEqual({ goal_id: 'final_confirmation', item_ref: null });
    expect(nameRepairProposal.primary_request).toEqual({ goal_id: 'name', item_ref: CONCERTINA_REF });
  });

  test('the first proposal keeps its 3c.17 outcome: only distributive_assignment_unconfirmed', () => {
    const validation = validateV3AiProposal(distributive.policy, finalConfirmationProposal);
    expect(errorCodes(validation)).toEqual(['distributive_assignment_unconfirmed']);
  });

  test('the repair with {goal_id:"name", item_ref} is rejected with primary_request_item_ref_invalid and the distributive code', () => {
    const validation = validateV3AiProposal(distributive.policy, nameRepairProposal);

    expect(validation.valid).toBe(false);
    expect(errorCodes(validation)).toEqual(['primary_request_item_ref_invalid', 'distributive_assignment_unconfirmed']);
    const itemRefError = validation.errors[0];
    expect(itemRefError).toMatchObject({
      path: 'primary_request.item_ref', disposition: 'repairable', related_ids: ['name'], allowed_values: [null],
    });
    expect(itemRefError.instruction).toBe(itemRefInvalidInstruction('name'));
  });

  test('the distributive instruction names the literal goal_id and forbids "name"', () => {
    const validation = validateV3AiProposal(distributive.policy, nameRepairProposal);
    const distributiveError = validation.errors.find((error) => error.code === 'distributive_assignment_unconfirmed');

    expect(distributiveError.instruction).toContain(`exactly primary_request {"goal_id":"quantity","item_ref":"${CONCERTINA_REF}"}`);
    expect(distributiveError.instruction).toContain('goal_id must be the literal "quantity"; never "name" (the customer\'s own name) or any other goal');
  });

  test('the same repair with {goal_id:"quantity", item_ref} validates clean', () => {
    const proposal = clone(nameRepairProposal);
    proposal.primary_request = { goal_id: 'quantity', item_ref: CONCERTINA_REF };

    const validation = validateV3AiProposal(distributive.policy, proposal);
    expect(validation.errors).toEqual([]);
    expect(validation.valid).toBe(true);
  });
});

describe('captured scenario B turn 2: the pandereta clarification asked with goal "name"', () => {
  test('the captured {goal_id:"name", item_ref} proposal is now rejected only with primary_request_item_ref_invalid', () => {
    expect(panderetaNameEntry.proposal.primary_request).toEqual({ goal_id: 'name', item_ref: PANDERETA_REF });
    const validation = validateV3AiProposal(panderetaNameEntry.turn_policy, panderetaNameEntry.proposal);

    expect(errorCodes(validation)).toEqual(['primary_request_item_ref_invalid']);
    expect(validation.errors[0].instruction).toBe(itemRefInvalidInstruction('name'));
  });

  test.each(['product', 'line_items'])('the same clarification with goal_id "%s" and that item_ref validates', (goalId) => {
    const proposal = clone(panderetaNameEntry.proposal);
    proposal.primary_request = { goal_id: goalId, item_ref: PANDERETA_REF };

    const validation = validateV3AiProposal(panderetaNameEntry.turn_policy, proposal);
    expect(validation.errors).toEqual([]);
  });

  test('a quote-level goal other than name with an item_ref is rejected too (commune)', () => {
    const proposal = clone(panderetaNameEntry.proposal);
    proposal.primary_request = { goal_id: 'commune', item_ref: PANDERETA_REF };

    const validation = validateV3AiProposal(panderetaNameEntry.turn_policy, proposal);
    expect(errorCodes(validation)).toContain('primary_request_item_ref_invalid');
    expect(validation.errors.find((error) => error.code === 'primary_request_item_ref_invalid').instruction)
      .toBe(itemRefInvalidInstruction('commune'));
  });

  test('a legitimate {goal_id:"name", item_ref:null} asking the customer\'s name stays valid', () => {
    const proposal = clone(panderetaNameEntry.proposal);
    proposal.primary_request = { goal_id: 'name', item_ref: null };
    proposal.reply_text = 'Gracias por corregirme: dejo el alambre de púas en 300 ml. ¿Me indicas tu nombre?';

    const validation = validateV3AiProposal(panderetaNameEntry.turn_policy, proposal);
    expect(validation.errors).toEqual([]);
    expect(validation.valid).toBe(true);
  });
});

describe('primary_request_item_ref_invalid never changes other captured outcomes', () => {
  const changedByDesign = new Set(['captured-live-proposals.json#11', 'captured-distributive-ambiguous.json#1']);
  const allCaptured = fs.readdirSync(fixtureDir)
    .filter((file) => file.endsWith('.json'))
    .flatMap((file) => {
      const data = readFixture(file);
      return Array.isArray(data)
        ? data.map((entry, index) => [`${file}#${index}`, entry.turn_policy, entry.proposal])
        : data.proposals.map((proposal, index) => [`${file}#${index}`, data.policy, proposal]);
    })
    .filter(([name]) => !changedByDesign.has(name));

  test('covers every other captured proposal', () => {
    expect(allCaptured.length).toBeGreaterThanOrEqual(19);
  });

  test.each(allCaptured)('%s does not raise primary_request_item_ref_invalid', (_name, capturedPolicy, proposal) => {
    expect(errorCodes(validateV3AiProposal(capturedPolicy, proposal))).not.toContain('primary_request_item_ref_invalid');
  });
});
