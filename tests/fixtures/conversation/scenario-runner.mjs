// =============================================================================
// Scenario runner.
// -----------------------------------------------------------------------------
// Replays a declared conversation through the engine, one turn at a time, with
// the database round trip simulated between turns. A scenario says what the
// customer sent and when; everything else is derived.
// =============================================================================

import { runTurn } from './engine.mjs';
import { createWorld, inputRowFor, commitTurn } from './world.mjs';

export const runScenario = async (scenario) => {
  const world = createWorld(scenario.contact, scenario.given ?? {});
  const turns = [];

  for (const [index, turn] of scenario.turns.entries()) {
    if (!turn.at) throw new Error(`${scenario.id} turn ${index + 1}: every turn needs an 'at'`);
    const input = inputRowFor(world, turn);
    const { deterministic, applied } = await runTurn(input, turn.ai, scenario.env ?? {});
    commitTurn(world, turn, applied);
    turns.push({ index: index + 1, turn, input, deterministic, applied });
  }

  return { scenario, turns, world };
};

// Reads one expected field off a turn result. `deterministic.` addresses the
// step before the model proposal was applied; everything else addresses the
// applied output, which is what gets persisted and sent.
export const readActual = (result, field) => {
  if (field.startsWith('deterministic.')) {
    return result.deterministic[field.slice('deterministic.'.length)];
  }
  if (field.startsWith('qualification_context.')) {
    const key = field.slice('qualification_context.'.length);
    return result.applied.qualification_context?.[key];
  }
  return result.applied[field];
};
