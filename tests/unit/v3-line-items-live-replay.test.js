// Unit coverage for tests/ops/v3-line-items-live-replay.mjs's PURE logic
// (transcript scripting, request building, result aggregation, property
// checks) — per the orchestrator's explicit instruction, this file NEVER
// sets AI_REPLAY_LIVE=1 and NEVER calls the real network. Every model call
// below is a mocked `callModel` function injected into the harness's own
// dependency-injection seam.
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  LIVE_2026_09_26_MESSAGE,
  DEFAULT_GROUNDING,
  buildScriptedTranscripts,
  buildTurnPolicy,
  buildAiRequestForTurn,
  extractProposal,
  runTurn,
  runTranscript,
  aggregateRuns,
  checkItemizedFinalConfirmation,
  checkCorrectionScoping,
  checkMeasurementAttribution,
  replay,
} from '../ops/v3-line-items-live-replay.mjs';

const require = createRequire(import.meta.url);
const { V3_CONTRACTS } = require('../fixtures/workflow-nodes/shared/v3-contract-runtime.js');

const HARNESS_PATH = 'tests/ops/v3-line-items-live-replay.mjs';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('buildScriptedTranscripts — the scripted A/B transcripts (design.md Testing Strategy)', () => {
  test('includes the live 2026-09-26 message, a confirmation turn and a correction turn', () => {
    const transcripts = buildScriptedTranscripts();

    expect(transcripts.length).toBeGreaterThanOrEqual(2);
    for (const transcript of transcripts) {
      expect(transcript.turns[0].text).toBe(LIVE_2026_09_26_MESSAGE);
    }
    const kinds = transcripts.flatMap((transcript) => transcript.turns.map((turn) => turn.kind));
    expect(kinds).toContain('confirmation');
    expect(kinds).toContain('correction');
  });
});

describe('buildTurnPolicy — real compileV3TurnPolicy(buildV3PolicyInput(...)) per version', () => {
  test('stamps the v3 policy version by default', () => {
    const policy = buildTurnPolicy('v3', {}, DEFAULT_GROUNDING);
    expect(policy.version).toBe('ai_prd_turn_policy/v3');
  });

  test('stamps the v3.1 policy version when asked', () => {
    const policy = buildTurnPolicy('v3.1', {}, DEFAULT_GROUNDING);
    expect(policy.version).toBe('ai_prd_turn_policy/v3.1');
  });
});

describe('buildAiRequestForTurn — real Build AI Request node code, per version (D6)', () => {
  const env = { AI_PROVIDER: 'openai', OPENAI_API_KEY: 'fake-key-123' };

  test('v3 request pins the singular catalog_resolution shape', () => {
    const policy = buildTurnPolicy('v3', {}, DEFAULT_GROUNDING);
    const { ai_request: aiRequest } = buildAiRequestForTurn(policy, env);
    const schema = aiRequest.text.format.schema;
    expect(schema.properties).toHaveProperty('catalog_resolution');
    expect(schema.properties).not.toHaveProperty('catalog_resolutions');
  });

  test('v3.1 request pins the plural item-scoped catalog_resolutions shape', () => {
    const policy = buildTurnPolicy('v3.1', {}, DEFAULT_GROUNDING);
    const { ai_request: aiRequest } = buildAiRequestForTurn(policy, env);
    const schema = aiRequest.text.format.schema;
    expect(schema.properties).toHaveProperty('catalog_resolutions');
    expect(schema.properties).not.toHaveProperty('catalog_resolution');
  });
});

describe('extractProposal — real Normalize AI Result node code, given a scripted provider response', () => {
  test('parses the proposal out of a scripted output_text payload (the "mocked model")', () => {
    const policy = buildTurnPolicy('v3', {}, DEFAULT_GROUNDING);
    const scriptedProposal = {
      version: V3_CONTRACTS.proposal,
      policy_digest: policy.policy_digest,
      reply_text: 'Entendido.',
      primary_request: null,
      catalog_resolution: { status: 'not_applicable', evidence_quote: null, evidence_occurrence: null, grounding_ref: null },
      observations: [],
      state_mutations: [],
      effect_requests: [],
    };
    const proposal = extractProposal(policy, { statusCode: 200, body: { output_text: JSON.stringify(scriptedProposal) } }, {});
    expect(proposal).toEqual(scriptedProposal);
  });

  test('returns null when the provider response cannot be parsed as JSON', () => {
    const policy = buildTurnPolicy('v3', {}, DEFAULT_GROUNDING);
    const proposal = extractProposal(policy, { statusCode: 200, body: { output_text: 'not json' } }, {});
    expect(proposal).toBeNull();
  });
});

// A trivially valid proposal (no observations, no mutations) so both the v3
// and v3.1 real validators accept it deterministically — proves the
// orchestration wiring (request -> model -> normalize -> validate ->
// authorize -> reduce) without depending on the model's actual reasoning,
// which this harness never tests (that is Slice 2a's job).
const emptyProposalFor = (version, policy) => (version === 'v3.1'
  ? {
    version: V3_CONTRACTS.proposal_v3_1,
    policy_digest: policy.policy_digest,
    reply_text: 'Entendido.',
    primary_request: null,
    catalog_resolutions: [],
    observations: [],
    state_mutations: [],
    effect_requests: [],
  }
  : {
    version: V3_CONTRACTS.proposal,
    policy_digest: policy.policy_digest,
    reply_text: 'Entendido.',
    primary_request: null,
    catalog_resolution: { status: 'not_applicable', evidence_quote: null, evidence_occurrence: null, grounding_ref: null },
    observations: [],
    state_mutations: [],
    effect_requests: [],
  });

const OPENAI_ENV = { AI_PROVIDER: 'openai', OPENAI_API_KEY: 'fake-key-123' };

const mockCallModel = (calls) => (aiRequest, _env) => {
  calls.push(aiRequest);
  const schema = aiRequest.text.format.schema;
  const version = schema.properties.catalog_resolutions ? 'v3.1' : 'v3';
  const policyDigest = schema.properties.policy_digest.enum[0];
  const proposal = emptyProposalFor(version, { policy_digest: policyDigest });
  return Promise.resolve({ statusCode: 200, body: { output_text: JSON.stringify(proposal) } });
};

describe('runTurn — real validate/authorize/reduce, mocked model', () => {
  test('authorizes an empty proposal and leaves the quote state unchanged', async () => {
    const calls = [];
    const result = await runTurn({
      version: 'v3.1',
      qualificationContext: {},
      grounding: DEFAULT_GROUNDING,
      text: LIVE_2026_09_26_MESSAGE,
      env: OPENAI_ENV,
      callModel: mockCallModel(calls),
    });

    expect(calls).toHaveLength(1);
    expect(result.validation.valid).toBe(true);
    expect(result.decision).not.toBeNull();
    expect(result.qualificationContext).toEqual({});
  });

  test('never calls the model when a proposal is not extractable, and never touches the network', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const brokenCallModel = () => Promise.resolve({ statusCode: 200, body: { output_text: 'not json' } });
    const result = await runTurn({
      version: 'v3',
      qualificationContext: {},
      grounding: DEFAULT_GROUNDING,
      text: 'hola',
      env: {},
      callModel: brokenCallModel,
    });

    expect(result.proposal).toBeNull();
    expect(result.validation).toBeNull();
    expect(result.decision).toBeNull();
    expect(result.qualificationContext).toEqual({});
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('runTranscript — threads state across turns for both versions', () => {
  test('calls the mocked model once per turn per version and returns both version lanes', async () => {
    const calls = [];
    const transcript = { name: 'two-turn', turns: [{ kind: 'initial', text: LIVE_2026_09_26_MESSAGE }, { kind: 'confirmation', text: 'Sí, confirmo' }] };
    const run = await runTranscript(transcript, { grounding: DEFAULT_GROUNDING, env: OPENAI_ENV, callModel: mockCallModel(calls) });

    expect(calls).toHaveLength(4); // 2 turns x 2 versions
    expect(run.name).toBe('two-turn');
    expect(run.results.v3).toHaveLength(2);
    expect(run.results['v3.1']).toHaveLength(2);
    expect(run.results.v3.every((turn) => turn.validation.valid)).toBe(true);
    expect(run.results['v3.1'].every((turn) => turn.validation.valid)).toBe(true);
  });
});

describe('aggregateRuns — pure aggregation over N runs x transcripts', () => {
  const fakeTurn = (valid) => ({ validation: { valid } });
  const fakeRun = (v3Valid, v31Valid) => ({
    results: { v3: v3Valid.map(fakeTurn), 'v3.1': v31Valid.map(fakeTurn) },
  });

  test('counts validation passes and contingencies per version, and computes the pass rate', () => {
    const summary = aggregateRuns([
      fakeRun([true, true], [true, false]),
      fakeRun([true, false], [false, false]),
    ]);

    expect(summary.v3).toEqual({
      validationAttempts: 4, validationPasses: 3, contingencyCount: 1, validationPassRate: 0.75,
    });
    expect(summary['v3.1']).toEqual({
      validationAttempts: 4, validationPasses: 1, contingencyCount: 3, validationPassRate: 0.25,
    });
  });

  test('reports a zero pass rate (not NaN) when there are no attempts', () => {
    const summary = aggregateRuns([]);
    expect(summary.v3.validationPassRate).toBe(0);
    expect(summary['v3.1'].validationPassRate).toBe(0);
  });
});

describe('checkItemizedFinalConfirmation — one "•" line per item once there is more than one item', () => {
  test('matches when the reply has exactly one bullet per item', () => {
    const result = checkItemizedFinalConfirmation({
      decision: { reply: { text: '• Cierro de Hormigón — 5 m2, 3 metros de altura\n• Alambre de Púas — 200 ml' } },
      qualificationContext: { line_items: [{ item_id: 'li_a' }, { item_id: 'li_b' }] },
    });

    expect(result).toEqual({ checked: true, itemCount: 2, bulletCount: 2, matches: true });
  });

  test('flags a mismatch when an item is missing its bullet line', () => {
    const result = checkItemizedFinalConfirmation({
      decision: { reply: { text: '• Cierro de Hormigón — 5 m2' } },
      qualificationContext: { line_items: [{ item_id: 'li_a' }, { item_id: 'li_b' }] },
    });

    expect(result).toEqual({ checked: true, itemCount: 2, bulletCount: 1, matches: false });
  });

  test('is not applicable for a single-item (or empty) quote', () => {
    const result = checkItemizedFinalConfirmation({
      decision: { reply: { text: 'hormigon H25 20 m3' } },
      qualificationContext: { line_items: [{ item_id: 'li_0' }] },
    });

    expect(result.checked).toBe(false);
    expect(result.matches).toBe(true);
  });
});

describe('checkCorrectionScoping — a correction only ever touches its named item', () => {
  test('is scoped when the mutation targets only an allowed item', () => {
    const result = checkCorrectionScoping({
      decision: { state_mutations: [{ operation: 'set', field: 'quantity', item_id: 'li_b', projected_value: '300 ml' }] },
    }, ['li_b']);

    expect(result).toEqual({ checked: true, touchedItemIds: ['li_b'], scoped: true });
  });

  test('is not scoped when the mutation leaks onto an item the correction never named', () => {
    const result = checkCorrectionScoping({
      decision: { state_mutations: [{ operation: 'set', field: 'quantity', item_id: 'li_a', projected_value: '300 ml' }] },
    }, ['li_b']);

    expect(result.scoped).toBe(false);
    expect(result.touchedItemIds).toEqual(['li_a']);
  });
});

describe('checkMeasurementAttribution — a fact lands on the item its own evidence named (D5)', () => {
  const turnResultWith = (items) => ({ qualificationContext: { line_items: items } });

  test('passes when each item carries only its own quantity and measurements', () => {
    const result = checkMeasurementAttribution(turnResultWith([
      { item_id: 'li_a', product: 'Cierro de Hormigón', quantity: '5 m2', measurements: '3 metros de altura' },
      { item_id: 'li_b', product: 'Alambre de Púas', quantity: '200 ml', measurements: null },
    ]), [
      { productMatches: /cierro/i, measurements: '3 metros de altura' },
      { productMatches: /alambre/i, quantity: '200 ml', measurements: null },
    ]);

    expect(result).toEqual({ checked: true, mismatches: [], ok: true });
  });

  test('fails when a measurement leaked onto the wrong item — the exact drift design.md D5 fixes', () => {
    const result = checkMeasurementAttribution(turnResultWith([
      { item_id: 'li_a', product: 'Cierro de Hormigón', quantity: '5 m2', measurements: null },
      { item_id: 'li_b', product: 'Alambre de Púas', quantity: '200 ml', measurements: '3 metros de altura' },
    ]), [
      { productMatches: /alambre/i, measurements: null },
    ]);

    expect(result.ok).toBe(false);
    expect(result.mismatches).toEqual([
      { expectation: { productMatches: /alambre/i, measurements: null }, field: 'measurements', actual: '3 metros de altura' },
    ]);
  });
});

describe('replay — end-to-end with an injected mock, never a real network call', () => {
  test('runs the requested repetitions across all scripted transcripts and never calls fetch', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const calls = [];
    const report = await replay({
      runs: 1,
      env: OPENAI_ENV,
      callModel: mockCallModel(calls),
      transcripts: [{ name: 'single-turn', turns: [{ kind: 'initial', text: LIVE_2026_09_26_MESSAGE }] }],
    });

    expect(report.summary.v3.validationAttempts).toBe(1);
    expect(report.summary['v3.1'].validationAttempts).toBe(1);
    expect(report.summary.v3.validationPassRate).toBe(1);
    expect(report.finalConfirmations).toEqual([{ name: 'single-turn', checked: false, itemCount: 0, bulletCount: 0, matches: true }]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test('defaults to AI_REPLAY_RUNS (or 10) and the built-in scripted transcripts when not overridden', async () => {
    const calls = [];
    const report = await replay({ runs: 1, env: OPENAI_ENV, callModel: mockCallModel(calls) });
    expect(report.runs).toHaveLength(buildScriptedTranscripts().length);
  });
});

describe('the harness file documents its opt-in gate and never reads .env', () => {
  test('is opt-in via AI_REPLAY_LIVE, defaults AI_REPLAY_RUNS to 10, and documents the exact in-container command', () => {
    const source = fs.readFileSync(HARNESS_PATH, 'utf8');

    expect(source).toContain("process.env.AI_REPLAY_LIVE !== '1'");
    expect(source).toContain('AI_REPLAY_RUNS || 10');
    expect(source).toContain('docker compose exec n8n sh -c');
    expect(source).toContain('AI_REPLAY_LIVE=1 AI_REPLAY_RUNS=10 node tests/ops/v3-line-items-live-replay.mjs');
    expect(source).not.toContain("require('dotenv')");
    expect(source).not.toMatch(/readFileSync\([^)]*\.env/);
    expect(source).not.toContain('process.env.OPENAI_API_KEY, null, 2'); // never printed
  });
});
