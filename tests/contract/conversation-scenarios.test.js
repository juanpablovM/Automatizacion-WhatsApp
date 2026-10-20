// =============================================================================
// Executable conversation catalogue.
// -----------------------------------------------------------------------------
// Replays every declared scenario through the real orchestrator nodes, with the
// database round trip between turns simulated by tests/fixtures/conversation.
// The catalogue is data: a scenario that is declared but not exercised cannot
// exist here, which is the point.
// =============================================================================

import { describe, expect, test } from 'vitest';
import { scenarios } from '../fixtures/conversation/scenarios.mjs';
import { runScenario, readActual } from '../fixtures/conversation/scenario-runner.mjs';

describe('conversation catalogue', () => {
  test('every scenario declares an id, a title and at least one turn', () => {
    const ids = new Set();
    for (const scenario of scenarios) {
      expect(scenario.id, 'a scenario needs an id').toBeTruthy();
      expect(scenario.title, `${scenario.id}: a scenario needs a title`).toBeTruthy();
      expect(scenario.turns?.length, `${scenario.id}: a scenario needs turns`).toBeGreaterThan(0);
      expect(ids.has(scenario.id), `duplicate scenario id: ${scenario.id}`).toBe(false);
      ids.add(scenario.id);
      for (const [index, turn] of scenario.turns.entries()) {
        expect(turn.expect, `${scenario.id} turn ${index + 1}: a turn needs expectations`)
          .toBeTruthy();
      }
    }
  });

  for (const scenario of scenarios) {
    test(`${scenario.id} — ${scenario.title}`, async () => {
      const { turns } = await runScenario(scenario);

      for (const result of turns) {
        for (const [field, expected] of Object.entries(result.turn.expect)) {
          const actual = readActual(result, field);
          expect(
            actual,
            `${scenario.id} turn ${result.index}: ${field}\n`
            + `  inbound: ${JSON.stringify(result.turn.inbound?.text ?? '')}\n`
            + `  expected: ${JSON.stringify(expected)}\n`
            + `  actual:   ${JSON.stringify(actual)}`,
          ).toEqual(expected);
        }
      }
    });
  }
});
