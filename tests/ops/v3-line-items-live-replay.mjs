#!/usr/bin/env node
// =============================================================================
// v3-line-items-live-replay.mjs — opt-in A/B live-replay harness
// (design.md, Slice 3, task 3.12; Testing Strategy "Live A/B" row).
// -----------------------------------------------------------------------------
// Compares the baseline v3 contract against the dark v3.1 item-aware contract
// over scripted transcripts, calling the REAL "Build AI Request" node code
// (tests/fixtures/workflow-nodes/ai-lead-qualification-assistant/build-ai-request.js)
// to build both requests, a real model call for the proposal, the REAL
// "Normalize AI Result" node code to extract it, and the real contract
// runtime (validateV3AiProposal/authorizeV3ConversationDecision from
// shared/v3-contract-runtime.js — these dispatch to the v3.1 validator and
// authorizer internally from `policy.version`, per design.md D6) to validate
// and authorize it. Property assertions only (validation pass rate,
// contingency count, measurement-to-item attribution, correction scoping, one
// "•" line per item in `final_confirmation`) — never exact wording, per the
// design's Testing Strategy table.
//
// This harness makes a REAL network call to OpenAI's API, and ONLY when
// explicitly opted in with AI_REPLAY_LIVE=1. It is meant to run INSIDE the
// n8n container, where OPENAI_API_KEY already exists as a container env var
// (docker-compose.yml passes it through from the operator's real
// environment) — this file NEVER reads or prints `.env` itself; it only ever
// reads `process.env.OPENAI_API_KEY`, which that container already has.
// Outside AI_REPLAY_LIVE=1, `main()` returns immediately and touches nothing
// live — see the entry-point guard at the bottom of this file.
//
// Run inside the n8n container (never on the host, and never with `.env`
// read directly by this script):
//
//   docker compose exec n8n sh -c \
//     'AI_REPLAY_LIVE=1 AI_REPLAY_RUNS=10 node tests/ops/v3-line-items-live-replay.mjs'
//
// Every exported function below is pure or takes its side-effecting
// dependency (`callModel`) as an injected parameter, so
// tests/unit/v3-line-items-live-replay.test.js covers all of this file's
// logic (transcript scripting, request building, result aggregation, and the
// property checks) with a mocked model — never AI_REPLAY_LIVE=1, never a real
// network call.
// =============================================================================
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');
const fixturesRoot = path.join(repoRoot, 'tests', 'fixtures', 'workflow-nodes');

const {
  compileV3TurnPolicy,
  validateV3AiProposal,
  authorizeV3ConversationDecision,
} = require(path.join(fixturesRoot, 'shared', 'v3-contract-runtime.js'));
const { buildV3PolicyInput } = require(path.join(fixturesRoot, 'shared', 'v3-policy-builder.js'));
const { reduceV3StateMutations, readLineItems } = require(path.join(fixturesRoot, 'shared', 'v3-line-items.js'));

const readFixture = (relativePath) => fs.readFileSync(path.join(fixturesRoot, relativePath), 'utf8');

// `Build AI Request` and `Normalize AI Result` are raw n8n Code node bodies
// with no module wrapper — they read `items`/`$env` at top level, exactly
// like the real n8n runtime does. `new Function` is the same technique
// tests/unit/build-ai-request-wrapper.test.js and
// tests/unit/v3-effect-execution-wrapper.test.js already use to exercise
// these fixtures standalone.
const runCodeNode = (source, items, env = {}) => new Function('items', '$env', source)(items, env);

export const LIVE_2026_09_26_MESSAGE =
  'Necesito cotizar una pandereta de 3 metros de altura con alambre pua. Son aprox 500 ml en la comuna de Lo prado';

// A minimal grounding catalog: "Alambre de Púas" resolves, "pandereta" does
// not (there is no catalog entry naming it) — the same ambiguity the live
// message and design.md's D5 scenario exercise on purpose.
export const DEFAULT_GROUNDING = Object.freeze({
  catalog: [
    { ref: 'product:alambre-de-puas', concept: 'product', value: 'Alambre de Púas' },
    { ref: 'product:cierro-de-hormigon', concept: 'product', value: 'Cierro de Hormigón' },
  ],
});

// Scripted transcripts (design.md Testing Strategy: "N >= 10 repetitions of
// scripted transcripts, including the 2026-09-26 message, a confirmation
// turn and correction turns"). Each transcript replays through BOTH v3 and
// v3.1 with the same turns, from a fresh empty quote.
export function buildScriptedTranscripts() {
  return [
    {
      name: 'pandereta-live-then-confirmation',
      turns: [
        { kind: 'initial', text: LIVE_2026_09_26_MESSAGE },
        { kind: 'confirmation', text: 'Sí, confirmo la cotización' },
      ],
    },
    {
      name: 'pandereta-live-then-wire-correction',
      turns: [
        { kind: 'initial', text: LIVE_2026_09_26_MESSAGE },
        { kind: 'correction', text: 'Corrección: el alambre de púas son 300 ml, no 500 ml' },
      ],
    },
  ];
}

let policyInputCounter = 0;

// compileV3TurnPolicy(buildV3PolicyInput(input, { version })) mirrors the
// exact call compile-v3-turn.js makes in production (design.md D7).
// `turn` carries what production reads from the inbound and the conversation:
// the customer's text, the pending question and the recent messages. Without
// them the model sees a blank turn and only ever greets.
export function buildTurnPolicy(version, qualificationContext, grounding = DEFAULT_GROUNDING, turn = {}) {
  policyInputCounter += 1;
  return compileV3TurnPolicy(buildV3PolicyInput({
    inbound_event_id: `replay-event-${policyInputCounter}`,
    conversation_id: 'replay-conversation',
    external_message_id: `replay-message-${policyInputCounter}`,
    text_body: turn.text ?? '',
    pending_question_key: turn.pendingQuestionKey ?? null,
    recent_messages: turn.recentMessages ?? [],
    qualification_context: qualificationContext,
    v3_grounding: grounding,
  }, { version }));
}

// D6: the route's contract_version stays 'v3' for both v3 and v3.1 — only
// turn_policy.version tells them apart.
export function buildAiRequestForTurn(turnPolicy, env) {
  const source = readFixture(path.join('ai-lead-qualification-assistant', 'build-ai-request.js'));
  return runCodeNode(source, [{ json: { contract_version: 'v3', turn_policy: turnPolicy } }], env)[0].json;
}

export function extractProposal(turnPolicy, providerOutcome, env) {
  const source = readFixture(path.join('ai-lead-qualification-assistant', 'normalize-ai-result.js'));
  const output = runCodeNode(source, [{
    json: {
      turn_policy: turnPolicy,
      ai_status_code: providerOutcome?.statusCode ?? 0,
      ai_response: providerOutcome?.body ?? null,
      ai_skipped: false,
    },
  }], env)[0].json;
  return output.ai_proposal;
}

// The ONLY function in this file that ever touches the network. Never
// invoked unless AI_REPLAY_LIVE=1 (see `main` below), and never invoked at
// all by tests/unit/v3-line-items-live-replay.test.js, which always injects
// a mocked `callModel`.
export async function defaultCallModel(aiRequest, env) {
  const apiKey = env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error('OPENAI_API_KEY is not set in this environment (run inside the n8n container)');
  }
  const response = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(aiRequest),
  });
  const body = await response.json();
  return { statusCode: response.status, body };
}

// Runs one turn for one version, then folds the authorized decision's
// mutations back into the quote (mirroring what `09_commit_v3_turn.sql`
// commits) so the NEXT turn in the transcript (confirmation, correction)
// sees the same state a real conversation would.
export async function runTurn({
  version, qualificationContext, grounding, text, pendingQuestionKey = null, recentMessages = [], env, callModel,
}) {
  const turnPolicy = buildTurnPolicy(version, qualificationContext, grounding, { text, pendingQuestionKey, recentMessages });
  const { ai_request: aiRequest } = buildAiRequestForTurn(turnPolicy, env);
  const providerOutcome = await callModel(aiRequest, env);
  const proposal = extractProposal(turnPolicy, providerOutcome, env);

  let validation = null;
  let decision = null;
  if (proposal) {
    validation = validateV3AiProposal(turnPolicy, proposal);
    decision = validation.valid ? authorizeV3ConversationDecision(turnPolicy, proposal, validation) : null;
  }
  const nextContext = decision
    ? reduceV3StateMutations(qualificationContext, decision.state_mutations)
    : qualificationContext;

  return {
    version, kind: undefined, text, turnPolicy, proposal, validation, decision,
    qualificationContext: nextContext,
  };
}

// Replays one scripted transcript through both v3 (baseline) and v3.1
// (branch), from a fresh empty quote, threading state turn to turn.
export async function runTranscript(transcript, { grounding = DEFAULT_GROUNDING, env = {}, callModel }) {
  const results = {};
  for (const version of ['v3', 'v3.1']) {
    let context = {};
    let pendingQuestionKey = null;
    const recentMessages = [];
    const turns = [];
    for (const turn of transcript.turns) {
      // eslint-disable-next-line no-await-in-loop -- turns are sequential by design
      const result = await runTurn({
        version, qualificationContext: context, grounding, text: turn.text,
        pendingQuestionKey, recentMessages: [...recentMessages], env, callModel,
      });
      context = result.qualificationContext;
      if (result.decision) pendingQuestionKey = result.proposal?.primary_request?.goal_id ?? null;
      recentMessages.push({ role: 'user', content: turn.text });
      if (result.proposal?.reply_text) recentMessages.push({ role: 'assistant', content: result.proposal.reply_text });
      turns.push({ ...turn, ...result });
    }
    results[version] = turns;
  }
  return { name: transcript.name, results };
}

// Pure aggregation over N repetitions x transcripts. Never inspects exact
// wording — only counts.
export function aggregateRuns(runResults) {
  const summary = {
    v3: { validationAttempts: 0, validationPasses: 0, contingencyCount: 0 },
    'v3.1': { validationAttempts: 0, validationPasses: 0, contingencyCount: 0 },
  };
  for (const run of runResults) {
    for (const version of ['v3', 'v3.1']) {
      for (const turn of run.results[version] ?? []) {
        summary[version].validationAttempts += 1;
        if (turn.validation?.valid) summary[version].validationPasses += 1;
        else summary[version].contingencyCount += 1;
      }
    }
  }
  for (const version of ['v3', 'v3.1']) {
    const bucket = summary[version];
    bucket.validationPassRate = bucket.validationAttempts
      ? bucket.validationPasses / bucket.validationAttempts
      : 0;
  }
  return summary;
}

// Property: once a v3.1 turn commits more than one item, the reply's
// `final_confirmation` summary must show exactly one "•" line per item
// (design.md's Supersession note + Testing Strategy row).
export function checkItemizedFinalConfirmation(turnResult) {
  if (!turnResult) return { checked: false, reason: 'no turn result' };
  const text = turnResult.decision?.reply?.text ?? turnResult.proposal?.reply_text ?? '';
  const bulletLines = text.split('\n').filter((line) => line.trim().startsWith('•'));
  const items = readLineItems(turnResult.qualificationContext ?? {});
  const applicable = items.length > 1;
  return {
    checked: applicable,
    itemCount: items.length,
    bulletCount: bulletLines.length,
    matches: !applicable || bulletLines.length === items.length,
  };
}

// Property: a correction turn's authorized mutations only ever target the
// item(s) the correction's own evidence named — never every item in the quote.
export function checkCorrectionScoping(afterTurnResult, allowedItemIds) {
  const mutations = Array.isArray(afterTurnResult?.decision?.state_mutations)
    ? afterTurnResult.decision.state_mutations
    : [];
  const touchedItemIds = [...new Set(mutations.map((mutation) => mutation.item_id).filter(Boolean))];
  const allowed = new Set(allowedItemIds ?? []);
  return {
    checked: touchedItemIds.length > 0,
    touchedItemIds,
    scoped: touchedItemIds.every((itemId) => allowed.has(itemId)),
  };
}

// Property: a fact evidenced for one item (by product name/label match) must
// land on that item, not on a different item in the same quote — the exact
// drift design.md's D5 exists to fix.
export function checkMeasurementAttribution(turnResult, expectations) {
  const items = readLineItems(turnResult?.qualificationContext ?? {});
  const mismatches = [];
  for (const expectation of expectations ?? []) {
    const item = items.find((candidate) => expectation.productMatches.test(
      String(candidate.product ?? candidate.requested_label ?? ''),
    ));
    if (!item) {
      mismatches.push({ expectation, reason: 'item not found' });
      continue;
    }
    if ('quantity' in expectation && item.quantity !== expectation.quantity) {
      mismatches.push({ expectation, field: 'quantity', actual: item.quantity });
    }
    if ('measurements' in expectation && item.measurements !== expectation.measurements) {
      mismatches.push({ expectation, field: 'measurements', actual: item.measurements });
    }
  }
  return { checked: (expectations ?? []).length > 0, mismatches, ok: mismatches.length === 0 };
}

export async function replay({
  runs = Number(process.env.AI_REPLAY_RUNS || 10),
  env = process.env,
  callModel = defaultCallModel,
  grounding = DEFAULT_GROUNDING,
  transcripts = buildScriptedTranscripts(),
} = {}) {
  const allRuns = [];
  for (let repetition = 0; repetition < runs; repetition += 1) {
    for (const transcript of transcripts) {
      // eslint-disable-next-line no-await-in-loop -- repetitions are sequential by design
      allRuns.push(await runTranscript(transcript, { grounding, env, callModel }));
    }
  }
  const summary = aggregateRuns(allRuns);
  const finalConfirmations = allRuns.map((run) => ({
    name: run.name,
    ...checkItemizedFinalConfirmation(run.results['v3.1']?.[run.results['v3.1'].length - 1]),
  }));
  return { runs: allRuns, summary, finalConfirmations };
}

// Per-run detail a human can judge: what each lane stored after every turn,
// and why an invalid turn failed. Codes and stored facts only.
export function summarizeRun(run) {
  const lane = (turns) => (turns ?? []).map((turn) => ({
    kind: turn.kind,
    valid: Boolean(turn.validation?.valid),
    errors: (turn.validation?.errors ?? []).map((error) => error.code),
    withheld: (turn.validation?.withheld_mutations ?? []).map((mutation) => mutation.field),
    items: readLineItems(turn.qualificationContext ?? {}).map((item) => ({
      product: item.product ?? null,
      requested_label: item.requested_label ?? null,
      quantity: item.quantity ?? null,
      measurements: item.measurements ?? null,
    })),
    commune: turn.qualificationContext?.commune ?? null,
  }));
  return { name: run.name, v3: lane(run.results.v3), 'v3.1': lane(run.results['v3.1']) };
}

async function main() {
  if (process.env.AI_REPLAY_LIVE !== '1') {
    console.log('[v3-line-items-live-replay] AI_REPLAY_LIVE is not "1" — opt-in only, doing nothing live.');
    return;
  }
  if (!process.env.OPENAI_API_KEY) {
    console.error('[v3-line-items-live-replay] OPENAI_API_KEY is not set (run this inside the n8n container).');
    process.exitCode = 1;
    return;
  }
  // The production catalog makes "pandereta" as ambiguous as it is live; the
  // built-in two-product grounding is only a fallback.
  const groundingFile = process.env.AI_REPLAY_GROUNDING_FILE;
  const grounding = groundingFile ? JSON.parse(fs.readFileSync(groundingFile, 'utf8')) : DEFAULT_GROUNDING;
  const report = await replay({ grounding });
  console.log(JSON.stringify({
    summary: report.summary,
    finalConfirmations: report.finalConfirmations,
    runs: report.runs.map((run) => summarizeRun(run)),
  }, null, 2));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error('[v3-line-items-live-replay] failed:', error);
    process.exitCode = 1;
  });
}
