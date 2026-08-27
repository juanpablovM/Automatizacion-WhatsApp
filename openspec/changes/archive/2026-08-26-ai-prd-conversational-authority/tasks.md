# Tasks: Versioned AI Conversational Authority

## Review Workload Forecast

| Field | Value |
|---|---|
| Estimated changed lines | 2,200–3,600 total; 1,200–2,000 authored |
| 400-line budget risk | High |
| Chained PRs recommended | Yes |
| Suggested split | Contracts/ledger → saga/recovery → routing/rollout |
| Delivery strategy | ask-on-risk |
| Chain strategy | feature-branch-chain |

Decision needed before apply: Yes
Chained PRs recommended: Yes
Chain strategy: feature-branch-chain
400-line budget risk: High

### Suggested Work Units

| Unit | Goal | Likely PR/base | Focused test command | Runtime harness | Rollback boundary |
|---|---|---|---|---|---|
| 1 | v3 contracts and ledger | PR 1; feature/tracker branch | `sh scripts/ops/test-ai-assistant-local.sh` | `sh scripts/ops/test-intent-commercial-gate-local.sh` | Migration 018, SQL 07–10, and v3 contract fixtures |
| 2 | Durable saga and recovery | PR 2; PR 1 branch | `TEST_PG_INTEGRATION=1 npx vitest run tests/integration/conversation-turn-execution.postgres.test.js --globals` | `sh scripts/ops/test-handoff-routing-local.sh` | Saga/recovery nodes and orchestrator v3 branches |
| 3 | Routing and shadow | PR 3; PR 2 branch | `sh scripts/ops/test-conversation-regression-local.sh` | `legacy→shadow→canary→enforce→legacy` replay | Dispatcher, evaluator, links, rollout wiring |

### Work Unit 1 Packaging

The implemented Work Unit 1 snapshot was subdivided into the following local
feature-branch chain after its authored diff exceeded the 400-line budget:

```text
feat/ai-prd-v3-contract-ledger
└─ feat/ai-prd-v3-policy-kernel                  (291 lines)
   └─ feat/ai-prd-v3-proposal-validation        (321 lines)
      └─ feat/ai-prd-v3-decision-authorization  (160 lines)
         └─ feat/ai-prd-v3-assistant-dispatch   (291 total; 287 authored)
            └─ feat/ai-prd-v3-execution-ledger  (202 lines)
```

Each child targets its immediate parent. The assistant slice includes four
generated workflow JSON lines in its complete snapshot but excludes them from
the authored budget. No push or pull request has been created.

### Work Unit 2 Packaging

The implemented Work Unit 2 snapshot was subdivided into eight additional
local child branches:

```text
feat/ai-prd-v3-execution-ledger
└─ feat/ai-prd-v3-route-serialization          (196 lines)
   └─ feat/ai-prd-v3-state-delivery-commit     (393 lines)
      └─ feat/ai-prd-v3-effect-reconciliation (331 lines)
         └─ feat/ai-prd-v3-contingency-commit (278 lines)
            └─ feat/ai-prd-v3-bounded-recovery
               (455 total; 286 authored)
               └─ feat/ai-prd-v3-saga-no-effect-flow
                  (367 total; 363 authored)
                  └─ feat/ai-prd-v3-saga-effect-flow
                     (213 total; 210 authored)
                     └─ feat/ai-prd-v3-saga-recovery
                        (178 total; 175 authored)
```

Generated fixture/workflow lines remain in each complete snapshot but are
excluded from authored budgets. The final 19-file aggregate is byte-identical
to the verified Work Unit 2 implementation. No push or pull request has been
created.

### Work Unit 3 Packaging

The implemented Work Unit 3 snapshot was subdivided into eight additional
local child branches:

```text
feat/ai-prd-v3-saga-recovery
└─ feat/ai-prd-v3-rollout-runtime          (288 authored; ee322cd)
   └─ feat/ai-prd-v3-route-resolution      (229 total; 226 authored; 215c933)
      └─ feat/ai-prd-v3-policy-compilation (62 total; 61 authored; 9085731)
         └─ feat/ai-prd-v3-authorized-dispatch
            (179 total; 178 authored; 049428f)
            └─ feat/ai-prd-v3-authority-anchor
               (339 total; 337 authored; 509211f)
               └─ feat/ai-prd-v3-shadow-evaluator
                  (253 total; 248 authored; b06973d)
                  └─ feat/ai-prd-v3-shadow-dispatch
                     (355 total; 350 authored; 905fd3d)
                     └─ test/ai-prd-v3-semantic-journeys
                        (277 authored; ee553c7)
```

Generated workflow lines remain in each complete snapshot but are excluded
from authored budgets. The final 21-file aggregate contains 1,964 changed
lines (1,947 authored and 17 generated) and is byte-identical to the verified
Work Unit 3 implementation. Every authored child remains below 400 lines. No
push or pull request has been created.

## Phase 1: Apply Gate

- [x] 1.1 Before implementation, obtain explicit user authorization for apply under `feature-branch-chain`; documentation approval does not open this gate.

## Phase 2: Contracts and Ledger (RED → GREEN → REFACTOR)

- [x] 2.1 RED: Extend `scripts/ops/test-{ai-assistant,intent-commercial-gate}-local.sh` for v3 envelopes, multi-fact/correction evidence and UTF-8 offsets, one request, `service != product`, forbidden claims/effects, whole rejection, and unchanged bytes; record failures.
- [x] 2.2 GREEN: Add migration `infra/postgres/migrations/018_create_conversation_turn_executions.sql`, SQL `07_route_v3_turn.sql`–`10_transition_v3_execution.sql`, v3 orchestrator fixtures, and assistant version dispatch; pass Phase 2 commands.
- [x] 2.3 REFACTOR: Centralize digests, identities, allowlists, and mappings in `tests/scripts/sync-workflow-nodes.mjs`; rerun Phase 2 and `npm run check:parity`.

## Phase 3: Saga and Recovery (RED → GREEN → REFACTOR)

- [x] 3.1 RED: Create `tests/integration/conversation-turn-execution.postgres.test.js` for duplicate prepare/commit, stale snapshot/token, ordering/concurrency, immutability, receipts/replay, `unknown` without blind retry, exact-key reconciliation, and duplicate/inconclusive recovery.
- [x] 3.2 RED: Extend `scripts/ops/test-handoff-routing-local.sh` for one repair, preserved state, receipted contingency, outage, and idempotent handoff; record failures.
- [x] 3.3 GREEN: Wire preparation, effects, reconciliation, state/outbox commit, exact delivery, audit, repair, and contingency into `n8n/workflows/wa-conversation-orchestrator.json`; pass Phase 3 commands.
- [x] 3.4 REFACTOR: Remove v3 silent normalization and duplicate transitions while preserving legacy/v2; rerun Phase 3 and `npm run check:sql-references`.

## Phase 4: Routing and Rollout (RED → GREEN → REFACTOR)

- [x] 4.1 RED: Extend `n8n/samples/conversation_regression_cases.sample.json` and its harness for all modes, retry route drift, active-v3 rollback, post-delivery async failure, shadow mutation/effects/latency, and canary legacy reinterpretation; record failures before workflow edits.
- [x] 4.2 RED: In those files add journeys for questions/uncertainty/corrections/digressions/frustration/ambiguity, claims/effects, repair failure, replay/concurrency, and reordered facts.
- [x] 4.3 GREEN: Modify the three designed workflow JSONs; add `n8n/workflows/ai-prd-shadow-evaluator.json` and update `n8n/workflow-links.json` for fixed routes, post-delivery shadow, and new-turn-only rollback.
- [x] 4.4 REFACTOR: Remove deterministic v3 copy/question overrides, preserve legacy/v2, sync fixtures, and pass regression, parity, and rollout replay.

## Phase 5: Verification

- [x] 5.1 Run configured and remaining shell suites, PostgreSQL integration, parity, and SQL-reference checks; record each unit's runtime evidence and rollback boundary without deployment.
