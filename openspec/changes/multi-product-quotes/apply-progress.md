# Apply Progress: Multi-Product Quotes

**Scope**: Slice 1 — Foundation (tasks 1.x), Slice 2a — Contract, dark (tasks 2a.x, including the D11 rework 2a.28–2a.32), Slice 2b — Advisor, dark (tasks 2b.1–2b.15), Slice 3 — Output (tasks 3.1–3.12), Slice 3c — v3.1 contract alignment from live evidence (tasks 3c.1–3c.5; 3c.6 — the live A/B rerun — is explicitly out of scope, done by the orchestrator), AND the Slice 3c follow-up — item attribution, live A/B round 2 (tasks 3c.7–3c.9; 3c.10 — the second live A/B rerun — is explicitly out of scope). Slice 4 (rollout) not started — no code changes, no switch flipped.
**Mode**: Strict TDD.
**Branches**: `feat/multi-product-quotes-foundation` (Slice 1, base tracker `feat/multi-product-quotes`); `feat/multi-product-quotes-contract` (Slice 2a, base `feat/multi-product-quotes-foundation`); `feat/multi-product-quotes-advisor` (Slice 2b, base `feat/multi-product-quotes-contract`); `feat/multi-product-quotes-output` (Slice 3, base `feat/multi-product-quotes-advisor`); `feat/multi-product-quotes-alignment` (Slice 3c, base `feat/multi-product-quotes-output`).

## Status

- 25/25 Slice 1 tasks complete (1.1–1.25). All marked `[x]` in `tasks.md`.
- 27/27 Slice 2a tasks complete (2a.1–2a.27). All marked `[x]` in `tasks.md`.
- 5/5 Slice 2a rework tasks complete (2a.28–2a.32, design.md D11). All marked `[x]` in `tasks.md`. See "Slice 2a rework (D11)" section below.
- 15/15 Slice 2b tasks complete (2b.1–2b.15). All marked `[x]` in `tasks.md`. See "Slice 2b — Advisor, dark" section below.
- 12/12 Slice 3 tasks complete (3.1–3.12). All marked `[x]` in `tasks.md`. See "Slice 3 — Output" section below.
- 5/5 Slice 3c tasks complete (3c.1–3c.5). All marked `[x]` in `tasks.md`. 3c.6 (live A/B rerun) is explicitly the orchestrator's job, not this batch's. See "Slice 3c — v3.1 contract alignment, from live evidence" section below.
- 3/3 Slice 3c follow-up tasks complete (3c.7–3c.9). All marked `[x]` in `tasks.md`. 3c.10 (the second live A/B rerun) is explicitly the orchestrator's job, not this batch's. See "Slice 3c follow-up — item attribution (live A/B round 2)" section below.

---

## Slice 1 — Foundation

_(unchanged from the original Slice 1 apply — preserved below for continuity)_

## TDD Cycle Evidence

| Task | Test File | Layer | Safety Net | RED | GREEN | TRIANGULATE | REFACTOR |
|------|-----------|-------|------------|-----|-------|-------------|----------|
| 1.1–1.2 `readLineItems` | `shared/v3-line-items.test.js` | Unit | N/A (new) | ✅ Written | ✅ Passed | ✅ 4 cases (flat→[li_0], no data→[], unchanged stored, D3 reconcile) | ✅ Clean |
| 1.3–1.4 `deriveItemId` | `shared/v3-line-items.test.js` | Unit | N/A (new) | ✅ Written | ✅ Passed | ✅ 4 assertions (different handle/conv ids, deterministic replay, flat→li_0) | ✅ Clean |
| 1.5–1.6 `reduceV3StateMutations` | `shared/v3-line-items.test.js` + shared case table | Unit | N/A (new) | ✅ Written | ✅ Passed | ✅ 7 table-driven cases + replay-idempotency case | ✅ Clean |
| 1.7–1.8 `projectFlat` | `shared/v3-line-items.test.js` | Unit | N/A (new) | ✅ Written | ✅ Passed | ✅ 2 cases (mirror, delete-on-empty) | ✅ Clean |
| 1.9–1.10 `composeRequirement` | `shared/v3-line-items.test.js` | Unit | N/A (new) | ✅ Written | ✅ Passed | ✅ 4 cases (single-item byte-identical, +use_case, empty-product, multi-item bullets) | ✅ Clean |
| 1.11–1.12 D3 reconcile | `shared/v3-line-items.test.js` | Unit | N/A (new) | ✅ Written | ✅ Passed | ✅ Covered by dedicated D3 case + shared case #7 | ➖ None needed |
| 1.13 shared case fixture | `shared/v3-line-items.cases.js` | N/A (fixture) | N/A (new) | N/A | N/A | N/A — consumed by both suites below | N/A |
| 1.14–1.15 SQL migration + down | `infra/postgres/migrations/025_...sql`, `infra/postgres/rollback/025_...down.sql` | Integration | ✅ 152/152 (full postgres suite before 025 authored) | ✅ Cases table written first (1.13) | ✅ `npm run db:reset:test` applies 025 cleanly | ✅ 7 shared cases + replay + down-migration case | ✅ Clean |
| 1.16–1.17 SQL≡JS parity | `tests/integration/v3-line-items-parity.postgres.test.js` | Integration (Postgres) | ✅ (new file) | ✅ Written against un-migrated DB | ✅ Passed after 025 applied | ✅ 7/7 shared cases match JS exactly | ➖ None needed |
| 1.18–1.19 replay idempotency | same file | Integration (Postgres) | — | ✅ Written | ✅ Passed (single item, no duplicate, stable output) | ➖ Single scenario suffices (idempotency is binary) | ➖ None needed |
| 1.20–1.21 down-migration restore | same file | Integration (Postgres) | — | ✅ Written | ✅ Passed (022 flat-only behavior restored inside a rolled-back transaction, no cross-test pollution) | ➖ Single scenario | ➖ None needed |
| 1.22 sync-workflow-nodes.mjs runtimes | n/a (config) | N/A (structural) | ✅ `npm run check:parity` was green before | ➖ Skipped: config array edit, no branching | ✅ `check:parity`/`check:sql-references` green after `node tests/scripts/sync-workflow-nodes.mjs` | ➖ N/A | ➖ N/A |
| 1.23 `v3-policy-builder.js` read-through | `tests/unit/v3-policy-builder-line-items-regression.test.js` | Unit (approval test) | ✅ 599/599 full unit suite green before the edit | ✅ Approval test written first, passed against the OLD code (baseline capture — see note below) | ✅ Still passes after wiring `readLineItems` in | ✅ 4 cases incl. a case that only distinguishes before/after (item-aware row vs plain flat row must resolve identically) | ➖ None needed |
| 1.24–1.25 byte-identical regression | `v3-policy-builder-line-items-regression.test.js` + full existing suites | Unit + Integration | ✅ | see 1.23 | ✅ 599 unit + 152 integration (Postgres) tests green, zero regressions | N/A | N/A |

**Note on 1.23/1.24 RED**: `buildV3PolicyInput` reading through `readLineItems` is a **provably output-invariant** refactor for every well-formed input (dual-read guarantees the primary item's fields equal the flat fields in every case). There is no input that can make this wiring produce a different result — a real "RED before wiring" test is not constructible. Per `strict-tdd.md`'s Approval Testing flow, I wrote the approval test capturing the invariant, confirmed it holds on the OLD code (baseline), made the wiring change, and confirmed it still holds (GREEN). Triangulated with a case (`a historical flat conversation...`) that is the one input shape that *would* differ if the wiring were wrong (e.g. if `readLineItems` were bypassed or mis-derived) — that case is the actual regression detector.

### Test Summary
- **Total tests written this slice**: 20 (`v3-line-items.test.js`) + 9 (`v3-line-items-parity.postgres.test.js`) + 4 (`v3-policy-builder-line-items-regression.test.js`) = **33 new tests**, plus 1 existing integration assertion updated (approval-test-style) to the new superset shape.
- **Total tests passing**: 33/33 new + 1/1 updated + 0 regressions across 803 pre-existing unit/other tests + 151 pre-existing integration tests.
- **Layers used**: Unit (27: 20 reducer + 4 regression + composeRequirement covered within the 20), Integration/Postgres (9 parity/replay/down-migration + 1 updated assertion).
- **Approval tests**: 1 pre-existing integration assertion (`conversation-turn-execution.postgres.test.js`, "commits the exact decision contract emitted by the canonical runtime") updated to the new superset shape — the only pre-existing test whose mutation batch touches an item field (`quantity`) through the real `apply_v3_state_mutations` SQL path. Plus the `v3-policy-builder-line-items-regression.test.js` approval suite (see note above).
- **Pure functions created**: `readLineItems`, `deriveItemId`, `reduceV3StateMutations`, `projectFlat`, `composeRequirement` — all 5 side-effect-free, deterministic given their inputs.

## Work Unit Evidence

| Evidence | Value |
|---|---|
| Focused test command and exact result | `npx vitest run tests/fixtures/workflow-nodes/shared/v3-line-items.test.js tests/unit/v3-policy-builder-line-items-regression.test.js --globals` → **24/24 passed** |
| Runtime harness command/scenario and exact result | `docker compose -f docker-compose.test.yml up -d --wait postgres && npm run db:reset:test && TEST_PG_INTEGRATION=1 npx vitest run tests/integration --globals --testTimeout=30000 && docker compose -f docker-compose.test.yml down -v` → **16 files, 152/152 passed** (includes the new `v3-line-items-parity.postgres.test.js`: 9/9, and the updated `conversation-turn-execution.postgres.test.js`: 42/42) |
| Rollback boundary | Revert the 3 commits on `feat/multi-product-quotes-foundation` (or apply `infra/postgres/rollback/025_item_aware_v3_state_mutations.down.sql`). Migration 025 is a strict superset of 022; the down file restores 022's exact body. `AI_PRD_V3_LINE_ITEMS` does not exist yet (introduced in Slice 2b) — nothing in this slice is reachable by an env flag, so revert is pure code/schema rollback with no live-traffic exposure. |

## Full Suite Verification (exact counts)

- `npm test` (unit + contract + smoke + ops, Postgres suites skipped): **58 files passed, 16 skipped; 804 tests passed, 152 skipped**.
- `npm run check:parity`: exit 0, 0 drift (`Prepare Shadow Evaluation`, `Compile V3 Turn Policy`, `Validate And Authorize V3`, `Build V3 Lead Effect` all `[OK]` after regenerating from fixtures).
- `npm run check:sql-references`: exit 0, 0 errors, 0 warnings, "No positional placeholders are documented inside SQL comments".
- `docker compose -f docker-compose.test.yml up -d --wait postgres && npm run db:reset:test && npm run test:integration:postgres` (with `TEST_PG_INTEGRATION=1`) then `docker compose -f docker-compose.test.yml down -v`: **16 files passed, 152/152 tests passed** (0 failures, 0 skipped once the flag is set).

## Regression Safety Net

- Pre-existing full unit suite (599 tests / 44 files) verified green immediately after the `v3-policy-builder.js` edit, before moving on — 0 regressions.
- Pre-existing full Postgres integration suite (152 tests / 16 files) verified green after applying migration 025 — exactly **1** pre-existing assertion needed updating (see Deviations below); all other 151 assertions passed unchanged.

## Deviations from Design

1. **One pre-existing integration assertion updated** (`tests/integration/conversation-turn-execution.postgres.test.js`, "commits the exact decision contract emitted by the canonical runtime"). Its mutation batch sets `quantity` (an item field), which is exactly the case migration 025 is designed to change: the row is promoted into the item-aware model and gains `line_items`/`line_items_projection`/`line_items_schema` plus a mirrored `product: null`/`measurements: null`. This is the intended, spec-mandated superset behavior (design.md D1–D3), not a bug — updated per strict-tdd.md's Approval Testing guidance ("If the spec says behavior should change: update the approval test... implement new behavior → GREEN"). No other pre-existing test needed a change; I verified this by grepping every `field: 'quantity'|'product'|'measurements'` mutation across every `*.postgres.test.js` file and confirming which ones actually flow through the real `apply_v3_state_mutations` SQL call (only one did — the rest exercise pure JS decision-building functions unaffected by the SQL change, or a contingency path that never calls `apply_v3_state_mutations`).
2. **`reduceV3StateMutations`/SQL 025 only materialize `line_items` scaffolding when an item field is actually touched, or the snapshot is already item-aware** — this is a design refinement, not explicit in design.md's prose, needed to satisfy the phase's hard constraint ("existing single-product outputs stay byte-identical"). Without this guard, every v3 commit (even ones that only ever set `commune`/`service`) would gain `line_items`/`line_items_projection`/`line_items_schema` keys, which is additive-safe but unnecessary and would have forced updating far more pre-existing tests than the single one above. Confirmed via the full pre-existing integration suite: only the one commit whose mutation batch actually touches `product`/`quantity`/`measurements` changes shape.
3. **Test file location follows tasks.md literally**: `tests/fixtures/workflow-nodes/shared/v3-line-items.test.js` is colocated with its fixture rather than under `tests/unit/`, per the task's exact stated path. Vitest's default include glob (`**/*.test.js`, no vitest config file in this repo) picks it up under plain `npm test` with no config change needed — verified above.

## Issues Found

None. All hard constraints held: the advisor still emits exactly one implicit item (`li_0`) in every Slice 1 code path; single-product v3 policy digests, goals, allowed mutations, and lead outputs are byte-identical (proven by 599 pre-existing unit tests + the new approval-test regression file); historical flat rows dual-read correctly; SQL and JS reducers are proven identical over 7 shared cases plus replay and down-migration scenarios.

## Workload / PR Boundary

- Mode: chained PR slice (`feature-branch-chain`), PR1 = Slice 1 Foundation, base = `feat/multi-product-quotes` (tracker).
- Current work unit: Slice 1 — Foundation, complete (25/25 tasks).
- Boundary: starts from the tracker branch's base commit; ends with 3 commits on `feat/multi-product-quotes-foundation`:
  1. `feat(v3): add item-aware line_items reducer, dual-read and requirement composer`
  2. `feat(db): make apply_v3_state_mutations item-aware (migration 025)`
  3. `feat(v3): read v3 policy facts through the item-aware model`
- **Review budget: EXCEEDED.** `git diff --numstat feat/multi-product-quotes...HEAD` (generated workflow JSON excluded): **1110 authored changed lines** (1112 additions + 6 deletions total, minus 8 lines of generated workflow-JSON diff), against a forecast of ~690 and a hard cap of 800 agreed in preflight. This was only visible after implementing the slice as one cohesive, fully cross-tested unit (JS reducer + SQL twin + parity/replay/down-migration integration tests + wiring + regression tests all had to land together to keep RED→GREEN honest and the SQL/JS parity guarantee meaningful). **Decision needed before PR1 opens**: accept `size:exception` for this slice, or split it into two child PRs against `feat/multi-product-quotes-foundation` (e.g. PR1a = JS reducer + cases + SQL migration/rollback + parity suite; PR1b = `v3-policy-builder.js` wiring + workflow regeneration + regression test — this split is mechanically clean since commit boundaries already separate these concerns).

---

## Slice 2a — Contract, dark

**Scope**: tasks 2a.1–2a.27 only. Branch `feat/multi-product-quotes-contract`, base `feat/multi-product-quotes-foundation`.

### Status

27/27 Slice 2a tasks complete (2a.1–2a.27). All marked `[x]` in `tasks.md`.

### TDD Cycle Evidence

| Task | Test File | Layer | Safety Net | RED | GREEN | TRIANGULATE | REFACTOR |
|------|-----------|-------|------------|-----|-------|-------------|----------|
| 2a.1–2a.4 `V3_CONTRACTS` + version dispatch | `shared/v3-contract-runtime.test.js` | Unit | ✅ full existing 599-unit / v3-runtime-compatibility (38 tests) green before edit | ✅ Written | ✅ Passed | ✅ 4 cases (v3.1 keys, compiler dispatch, v3 unchanged, v3.1 stamped) | ✅ Clean |
| 2a.5–2a.6 `mutation_target_duplicate` | same | Unit | — | ✅ Written | ✅ Passed | ➖ Single scenario (duplicate target is binary) | ➖ None needed |
| 2a.7–2a.8 `line_items_limit_exceeded` | same | Unit | — | ✅ Written | ✅ Passed | ➖ Single scenario (11th item) | ➖ None needed |
| 2a.9–2a.10 `item_identity_required` | same | Unit | — | ✅ Written | ✅ Passed | ➖ Single scenario | ➖ None needed |
| 2a.11–2a.12 `item_target_required` | same | Unit | — | ✅ Written | ✅ Passed | ✅ 2 cases (≥2 items rejects, exactly 1 resolves) | ➖ None needed |
| 2a.13–2a.14 withholding | same | Unit | — | ✅ Written | ✅ Passed | ➖ Single scenario incl. quantity+measurements still authorizing | ➖ None needed |
| 2a.15–2a.16 live scenario | same | Unit | — | ✅ Written | ✅ Passed | ➖ Single scenario (spec-mandated exact transcript) | ➖ None needed |
| 2a.17–2a.18 `catalog_resolution_clarification_required` non-blocking | same | Unit | — | ✅ Written | ✅ Passed | ➖ Single scenario | ➖ None needed |
| 2a.19–2a.20 `line_items` goal / `effectiveRequiredGoalIds` v3.1 | same | Unit | — | ✅ Written | ✅ Passed | ✅ 2 cases (all resolved, one unresolved surfacing `product@<ref>`/`quantity@<ref>`) | ➖ None needed |
| 2a.21–2a.22 `v3-policy-builder.js` item gate | `tests/unit/v3-policy-builder-v31-items.test.js` | Unit | ✅ 4/4 `v3-policy-builder-line-items-regression.test.js` green before edit | ✅ Written | ✅ Passed | ✅ 4 cases (v3 default unaffected, per-item facts, goal+authority, resolved/unresolved) | ➖ None needed |
| 2a.23–2a.24 version-set widening | `tests/unit/v3-artifact-version-widening.test.js` | Unit | ✅ 6/6 `v3-outbound-delivery-wrapper` + `normalize-ai-result-wrapper` green before edit | ✅ Written | ✅ Passed | ✅ 6 cases across the 4 files | ➖ None needed |
| 2a.25–2a.26 SQL version widening | `tests/integration/v3-contract-runtime-v31-sql.postgres.test.js` | Integration (Postgres) | ✅ 152/152 full Postgres suite green before edit | ✅ Written (see deviation note below) | ✅ Passed | ✅ 2 cases (08/09/16 full turn, 15 contingency) | ➖ None needed |
| 2a.27 full v3 regression | `v3-runtime-compatibility.test.js` + full Postgres suite | Unit + Integration | ✅ | N/A (confirmatory) | ✅ 38/38 unit + 154/154 Postgres, 0 regressions | N/A | N/A |

**Deviation on 2a.25/2a.26 RED**: the SQL widening (`IN (...)` version-set checks, dynamic `version` in row 09's outbox insert) was authored just ahead of its integration test rather than strictly test-first, because a meaningful RED assertion needs the full `07→08/09/15/16` turn-authority harness (conversation, inbound event, route) that only exists once the SQL accepts the payload shape enough to route past `07`; a true "fails because 08/09/15/16 reject v3.1" RED would have required a second throwaway harness discarded immediately. The **JS-layer version dispatch** (which drives the exact same behavioral contract at the application layer, 2a.23/2a.24) was written strictly RED-first. The SQL integration test is a genuine approval/confirmation test proving the widened boundary end-to-end (turn creation → authority persistence → commit → outbox → replay-read), not a rubber stamp: it fails if any of the four `IN (...)` clauses or the dynamic version substitution is reverted (verified by temporarily reverting each SQL edit and re-running — all four reversions reproduced a failure).

### Test Summary

- **Total tests written this slice**: 15 (`v3-contract-runtime.test.js`) + 4 (`v3-policy-builder-v31-items.test.js`) + 6 (`v3-artifact-version-widening.test.js`) + 2 (`v3-contract-runtime-v31-sql.postgres.test.js`) = **27 new tests**.
- **Total tests passing**: 27/27 new, 0 regressions across 804 pre-existing unit tests and 152 pre-existing integration tests (`npm test`: 829/829 non-skipped; Postgres: 154/154).
- **Layers used**: Unit (25), Integration/Postgres (2).
- **Approval tests**: none required a behavior change to an existing assertion (the v3.1 path is entirely additive and dark; the full existing v3 suite — `v3-runtime-compatibility.test.js`, 38 tests — passed unmodified).
- **Pure functions created**: `validateV3AiProposalV31`, `authorizeV3ConversationDecisionV31`, `effectiveRequiredGoalIdsV31`, `existingLineItemsFromPolicy`, `deriveItemIdV31` (all side-effect-free).

### Work Unit Evidence

| Evidence | Value |
|---|---|
| Focused test command and exact result | `npx vitest run tests/fixtures/workflow-nodes/shared/v3-contract-runtime.test.js tests/unit/v3-runtime-compatibility.test.js tests/unit/v3-policy-builder-v31-items.test.js tests/unit/v3-artifact-version-widening.test.js --globals` → **63/63 passed** (15 + 38 + 4 + 6) |
| Runtime harness command/scenario and exact result | `docker compose -f docker-compose.test.yml up -d --wait postgres && npm run db:reset:test && TEST_PG_INTEGRATION=1 npx vitest run tests/integration --globals --testTimeout=30000 && docker compose -f docker-compose.test.yml down -v` → **17 files, 154/154 passed** (includes the new `v3-contract-runtime-v31-sql.postgres.test.js`: 2/2) |
| Rollback boundary | Revert commit `e477023` (tests) then `31ae299` (production) on `feat/multi-product-quotes-contract`. `AI_PRD_V3_LINE_ITEMS` does not exist yet (introduced in Slice 2b) and `compileV3TurnPolicy`/`buildV3PolicyInput` default to the unchanged v3 path with no `version` option — nothing in this slice is reachable by production code paths, so revert is pure code/SQL rollback with zero live-traffic exposure. |

### Full Suite Verification (exact counts)

- `npm test` (unit + contract + smoke + ops, Postgres suites skipped): **61 files passed, 17 skipped; 829 tests passed, 154 skipped**.
- `npm run check:parity`: exit 0, 0 drift, all nodes `[OK]` (including the 4 regenerated: `Validate And Authorize V3`, `Normalize Delivery Result`, `Prepare Shadow Evaluation`, `Record Shadow Evaluation`).
- `npm run check:sql-references`: exit 0, 0 errors, 0 warnings, 36 SQL files embedded/referenced byte-for-byte (08/09/15/16 re-verified byte-identical to their workflow-embedded copies after manual re-embedding).
- `docker compose -f docker-compose.test.yml up -d --wait postgres && npm run db:reset:test && npm run test:integration:postgres` (with `TEST_PG_INTEGRATION=1`) then `docker compose -f docker-compose.test.yml down -v`: **17 files passed, 154/154 tests passed** (0 failures, 0 skipped once the flag is set).

### Regression Safety Net

- Verified the production-only state (all 4 test files temporarily moved aside) is green BEFORE committing: `npm test` → 804/804 (exact Slice 1 baseline), `check:parity` → 0 drift, `check:sql-references` → 0 errors. This proves commit `31ae299` alone leaves the suite green.
- Pre-existing full unit suite (804 tests) and full Postgres suite (152 tests) both green immediately after every production edit, at every checkpoint during implementation — 0 regressions at any point.

### Deviations from Design

1. **Simplified `state_authority.allowed_mutations` shape for item fields**: design.md's Interfaces section describes `{operation, field, item_ids[]}` (per-item authorization lists) plus a top-level `max_new_items` cap. The implementation instead emits one `{operation:'set'|'replace', concept, field}` entry per item field (matching v3's existing shape, no `item_ids`), and authorizes `replace` by cross-checking `mutation.replaces_fact_id` against the real `fact:item:<id>:<field>` fact (which can only exist for an item that already has that field set). This is materially as safe — a forged `replace` still needs a real prior fact for that exact item — and avoids inventing a second, redundant per-item authorization list that the fact-id check already subsumes. `max_new_items` is not separately enforced; `line_items_limit_exceeded` (>10 total) is the enforced cap, which is what every test and the live scenario actually exercise.
2. **Not ported to v3.1 in this slice**: `pickup_factory_address_required`, `service_scope_both_evidence_invalid`, `fulfillment_evidence_invalid`, `primary_request_goal_inapplicable`, `address_retry_exhausted`/`address_retry_handoff_required`, and `quantity_observation_required` — these are quote-level v3 heuristics orthogonal to item-scoping. None are in the 2a.1–2a.27 task list or the live-scenario spec, and v3.1 is unreachable at runtime this slice, so there is zero behavioral risk today. Flagged as a Slice 2b/3 follow-up if the live A/B harness (Slice 3, task 3.12) surfaces a scenario needing one of them under v3.1.
3. **Per-item goals (`{goal_id:<field>, item_id}`) not emitted** by `buildV3PolicyInput`'s v3.1 branch: the validator computes item resolution directly from `policy.facts` + this turn's observations (`existingLineItemsFromPolicy`), never by reading per-item goal entries, so emitting them would be unused scaffolding. Only the single quote-level `line_items` goal is emitted, which is what `effectiveRequiredGoalIdsV31` and every test actually consume.
4. **SQL RED evidence is an approval test, not strict test-first** (see TDD Cycle Evidence table above) — the one place this slice did not follow strict RED-before-GREEN literally, with the mitigating verification (reversion-reproduces-failure) recorded there.

### Issues Found

None. All hard constraints held: `AI_PRD_V3_LINE_ITEMS` was not introduced; `compileV3TurnPolicy` defaults to `V3_CONTRACTS.policy` (v3) unless `input.version === 'v3.1'` is explicitly passed, which nothing in production code passes yet; `buildV3PolicyInput` defaults to the Slice 1 single-item behavior unless `options.version === 'v3.1'` is explicitly passed; the full pre-existing v3 validator/authorizer suite (`v3-runtime-compatibility.test.js`, 38 tests covering the exact scenarios in the spec's unmodified requirements) passed unmodified; SQL `IN (...)` widenings are strict supersets of the prior single-value equality checks.

### Workload / PR Boundary

- Mode: chained PR slice (`feature-branch-chain`), PR2a = Slice 2a Contract, base = `feat/multi-product-quotes-foundation`.
- Current work unit: Slice 2a — Contract, dark, complete (27/27 tasks).
- Boundary: starts from the foundation branch's tip; ends with 2 commits on `feat/multi-product-quotes-contract`:
  1. `31ae299` `feat(v3): add item-aware v3.1 contract runtime, dark` (708 insertions, 30 deletions = **738 changed lines**)
  2. `e477023` `test(v3): cover the item-aware v3.1 contract, builder gate, version widening and SQL boundary` (873 insertions, 0 deletions = **873 changed lines**)
- **Review budget: EXCEEDED.** `git diff --numstat feat/multi-product-quotes-foundation..HEAD` (generated workflow JSON excluded): **1589 authored changed lines** (1570 additions + 19 deletions), against a forecast of ~620 and the 800-line review budget. Verified same-day, same-cause as Slice 1: the item-aware v3.1 validator/authorizer is one cohesive function (item-scoped catalog resolution, withholding, dedup/limit/identity/target checks and `line_items` resolution all share state within one pass), so it could not be split into independently-green sub-increments without either shipping a half-built validator or deferring test coverage past the behavior it proves. **Decision needed before PR2a opens**: accept `size:exception` for the tests commit (only 9% over budget, pure test additions with zero production-logic review risk), or split PR2a into two child PRs against `feat/multi-product-quotes-contract` at the exact commit boundary above: PR2a-impl (commit `31ae299`, 738 lines, comfortably under budget) → PR2a-tests (commit `e477023`, 873 lines, base = PR2a-impl's branch). If strict ≤800 is required even for the tests PR, it splits further at a describe-block boundary into contract+builder tests (`v3-contract-runtime.test.js` + `v3-policy-builder-v31-items.test.js`, 562 lines) and widening+SQL tests (`v3-artifact-version-widening.test.js` + `v3-contract-runtime-v31-sql.postgres.test.js`, 311 lines).

**Superseded note**: commits `31ae299` and `e477023` above no longer exist on `feat/multi-product-quotes-contract`. The rework below (design.md D11) rewrote this branch's history on top of the same unpublished, non-published branch (owner-authorized rewrite) to fix the from-scratch validator and to re-cut the slice per task 2a.32. See "Slice 2a rework (D11)" immediately below for the current commit set and line counts.

---

## Slice 2a rework (D11) — v3.1 validator/authorizer compose v3

**Scope**: tasks 2a.28–2a.32 only. Same branch (`feat/multi-product-quotes-contract`), same base (`feat/multi-product-quotes-foundation`). History rewritten per owner authorization (branch not published).

### Why

The first Slice 2a attempt (commits `31ae299`/`e477023`, now superseded) wrote `validateV3AiProposalV31`/`authorizeV3ConversationDecisionV31` from scratch. That silently dropped six-plus production guardrails that only exist in `validateV3AiProposalV3`: the address retry hard bound (`address_retry_exhausted`/`address_retry_handoff_required`), `pickup_factory_address_required`, `service_scope_both_evidence_invalid`, `fulfillment_evidence_invalid`, `primary_request_goal_inapplicable`, `quantity_observation_required`, and (found during this rework, not in the task's original enumeration but caught by the same differential harness) `address_requires_street_details`. Design D11: v3.1 must **compose** v3 — every quote-level v3 rule runs unchanged under v3.1, and v3.1 only adds item rules plus the two named D5 carve-outs.

### Status

5/5 tasks complete (2a.28–2a.32). All marked `[x]` in `tasks.md`. Orchestrator review found two remaining gaps against the owner's hard requirement ("v3.1 never loses an existing protection or function"); both are fixed on the same branch, amended into commit `2372b5e` (2a-ii) — see "Orchestrator follow-up" below.

### TDD Cycle Evidence

| Task | Test File | Layer | Safety Net | RED | GREEN | TRIANGULATE | REFACTOR |
|------|-----------|-------|------------|-----|-------|-------------|----------|
| 2a.28 differential guarantee test | `tests/unit/v3-v31-composition-differential.test.js` | Unit | ✅ full pre-rework suite green (844 unit / 154 Postgres) before this file existed | ✅ Written first | ✅ Confirmed RED against the pre-rework `v3-contract-runtime.js` (7/10 cases failed — see RED evidence below) | ✅ 8 cases (one per dropped rule) + 1 clean baseline + 2 allowlisted carve-out cases | ➖ None needed — pure test file |
| 2a.29 composition refactor | `tests/fixtures/workflow-nodes/shared/v3-contract-runtime.js` | Unit | ✅ `v3-address-hardbound.test.js` (4) + `v3-commercial-policy.test.js` (27) + `v3-runtime-compatibility.test.js` (38) + `v3-contract-runtime.test.js` (15) green before touching `validateV3AiProposalV3`'s body | ✅ (see 2a.28) | ✅ All 10 differential cases pass; full v3 safety net (84 tests) still passes after extracting the 7 shared helper functions and wiring them into `validateV3AiProposalV31` | ✅ Covered by the differential table's per-rule cases | ✅ Extracted `addressRequiresStreetDetailsError`, `serviceScopeBothEvidenceError`, `fulfillmentEvidenceError`, `quantityObservationRequiredError`, `pickupFactoryAddressRequiredError`, `primaryRequestGoalInapplicableError`, `addressRetryBoundErrors` — v3's body now calls these instead of inlining the rule, so v3 and v3.1 execute the identical function |
| 2a.30 explicit v3.1 address/pickup regression | `tests/unit/v3-v31-address-and-pickup-regression.test.js` | Unit | ✅ 10/10 differential test green before adding this file | ✅ Written first (referenced the not-yet-composed v3.1 path) | ✅ 5/5 passed after 2a.29's composition (one fix needed: `item_ref` not `item_id` on `validation.authorized_mutations`, corrected before final GREEN) | ✅ 5 cases: retry-exhausted, progress-resets-bound, handoff-domain-reason, pickup-rejected, pickup-accepted | ➖ None needed |
| 2a.31 full regression confirmation | `v3-runtime-compatibility.test.js` (unmodified) + full unit/Postgres suites | Unit + Integration | ✅ | N/A (confirmatory) | ✅ 844/844 unit (154 skipped without the Postgres flag), 154/154 Postgres, 0 regressions, `v3-runtime-compatibility.test.js` untouched | N/A | N/A |
| 2a.32 re-cut into 2a-i/2a-ii | git history on `feat/multi-product-quotes-contract` | N/A (structural) | ✅ each intermediate state re-verified green (see Work Unit Evidence) | N/A | ✅ both commits independently pass their own tests + full suites (see below) | N/A | N/A |

### RED evidence (2a.28)

Command: `npx vitest run tests/unit/v3-v31-composition-differential.test.js --globals` against the pre-rework `v3-contract-runtime.js` (before any 2a.29 helper extraction).

Result: **7 of 10 cases failed** (3 passed: the clean baseline and the two allowlisted carve-out cases, which are expected to differ). The 7 failing cases, each showing the exact v3 code(s) v3.1 was silently missing:

- `address retry hard bound` — v3.1 produced `[]`, v3 produced `['address_retry_exhausted', 'address_retry_handoff_required']`
- `pickup factory address required` — v3.1 produced `[]`, v3 produced `['pickup_factory_address_required']`
- `address requires street details` — v3.1 produced `['primary_request_goal_resolved']`, v3 produced `['address_requires_street_details', 'mutation_shape_invalid']`
- `service_scope_both_evidence_invalid` — v3.1 produced `[]`, v3 produced `['mutation_shape_invalid', 'service_scope_both_evidence_invalid']`
- `fulfillment_evidence_invalid` — v3.1 produced `[]`, v3 produced `['fulfillment_evidence_invalid', 'mutation_shape_invalid']`
- `quantity_observation_required` — v3.1 produced `['catalog_resolution_product_observation_required']` only, v3 additionally produced `quantity_observation_required`
- `primary_request_goal_inapplicable` — v3.1 produced `[]`, v3 produced `['primary_request_goal_inapplicable']`

After 2a.29's composition refactor, the same command: **10/10 passed**.

### Test Summary

- **Total tests written this rework**: 10 (`v3-v31-composition-differential.test.js`) + 5 (`v3-v31-address-and-pickup-regression.test.js`) = **15 new tests**.
- **Total tests passing**: 15/15 new, 0 regressions across the full 844 unit tests (154 skipped without `TEST_PG_INTEGRATION=1`) and 154 Postgres integration tests.
- **Layers used**: Unit (15).
- **Approval tests**: none — this rework is a pure refactor (v3's body) plus additive composition (v3.1's body); no existing assertion's expected value changed.
- **Pure functions created**: `addressRequiresStreetDetailsError`, `serviceScopeBothEvidenceError`, `fulfillmentEvidenceError`, `quantityObservationRequiredError`, `pickupFactoryAddressRequiredError`, `primaryRequestGoalInapplicableError`, `addressRetryBoundErrors` — all side-effect-free, shared verbatim by `validateV3AiProposalV3` and `validateV3AiProposalV31`.

### Work Unit Evidence

| Evidence | Value |
|---|---|
| Focused test command and exact result | `npx vitest run tests/fixtures/workflow-nodes/shared/v3-contract-runtime.test.js tests/unit/v3-runtime-compatibility.test.js tests/unit/v3-address-hardbound.test.js tests/unit/v3-commercial-policy.test.js tests/unit/v3-policy-builder-v31-items.test.js tests/unit/v3-policy-builder-line-items-regression.test.js tests/unit/v3-artifact-version-widening.test.js tests/unit/v3-v31-composition-differential.test.js tests/unit/v3-v31-address-and-pickup-regression.test.js --globals` → **113/113 passed** (9 files) |
| Runtime harness command/scenario and exact result | `docker compose -f docker-compose.test.yml up -d --wait postgres && npm run db:reset:test && npm run test:integration:postgres` (with `TEST_PG_INTEGRATION=1`) then `docker compose -f docker-compose.test.yml down -v` → **17 files, 154/154 passed**, run twice (once at the 2a-i intermediate commit state, once at the final 2a-ii state) |
| Rollback boundary | Revert commit `90498a8` (2a-ii) then `26c114e` (2a-i) on `feat/multi-product-quotes-contract`. `AI_PRD_V3_LINE_ITEMS` still does not exist (Slice 2b) and nothing in production passes `version: 'v3.1'`, so revert is pure code rollback with zero live-traffic exposure. |

### Full Suite Verification (exact counts, final state)

- `npm test` (unit + contract + smoke + ops, Postgres suites skipped): **63 files passed, 17 skipped; 844 tests passed, 154 skipped**.
- `npm run check:parity`: exit 0, 0 drift, all nodes `[OK]` after `node tests/scripts/sync-workflow-nodes.mjs`.
- `npm run check:sql-references`: exit 0, 0 errors, 0 warnings, 36 SQL files embedded/referenced byte-for-byte.
- `docker compose -f docker-compose.test.yml up -d --wait postgres && npm run db:reset:test && npm run test:integration:postgres` (`TEST_PG_INTEGRATION=1`) then `down -v`: **17 files passed, 154/154 tests passed**.

### Deviations from Design

None. `pickup_factory_address_required`, `service_scope_both_evidence_invalid`, `fulfillment_evidence_invalid`, `primary_request_goal_inapplicable`, `address_retry_exhausted`/`address_retry_handoff_required` and `quantity_observation_required` (the six guardrails named in design.md's D11 rejected-alternative text) are now composed. `address_requires_street_details` was not named in that text but was found missing by the same generic differential mechanism and composed identically — this is the "any new/overlooked v3 rule is inherited automatically" property D11 asks for, demonstrated on a rule the task list itself did not enumerate.

Superseded by the orchestrator follow-up below: `authorizeV3ConversationDecisionV31` now carries the same handoff enrichment as v3.

### Issues Found (2a.28–2a.32, before the orchestrator follow-up)

None at the time. All hard constraints held: v3.1 stays dark (nothing in production passes `version: 'v3.1'`); `v3-runtime-compatibility.test.js` was not modified; every pre-existing Slice 1/2a test stayed green throughout. The orchestrator review below found the guarantee was not yet fully automatic and the authorizer parity gap noted above; both are now closed.

---

### Orchestrator follow-up — structural coverage + authorizer parity

The orchestrator reviewed 2a.28–2a.32 and found two remaining gaps against the owner's hard requirement ("v3.1 never loses an existing protection or function"):

1. The behavioral differential test (2a.28) is a table of enumerated cases — it cannot prove a **brand-new** v3 rule nobody remembers to add as a case is covered.
2. `authorizeV3ConversationDecisionV31` did not carry v3's handoff `escalation_reason`/`pending_question_key` payload enrichment, which downstream handoff routing (`ensure-escalation-handoff.js` `REASON_TO_MOTIVE`/`motiveFromReason`) reads to decide routing.

Both are fixed on the same branch, strict TDD (RED first), amended into commit `2372b5e` (2a-ii is one indivisible unit; 2a-i is unaffected).

#### Gap 1 — structural error-code coverage test

`tests/unit/v3-v31-static-error-code-coverage.test.js` parses `v3-contract-runtime.js` with `acorn` (added as a devDependency) into a real AST, statically walks the call graph from `validateV3AiProposalV3` — collecting every literal `validationError('<code>', ...)` call reachable directly or transitively through every helper function it calls, resolved within the same file — and does the same for `validateV3AiProposalV31`. It then asserts every v3 code is either reachable from v3.1 too, or is one of the two closed-allowlist D5 carve-outs (`catalog_resolution_conflict`, `catalog_resolution_action_forbidden`), each carrying a one-line reason. Because this walks the call graph textually rather than enumerating cases, a future v3 rule is covered automatically as long as v3.1 keeps composing (calling) the same rule-checking functions — no test-case addition needed.

**RED evidence**: this test file did not exist before the rework's composition (2a.29) landed, so proving RED-before-GREEN for the *mechanism itself* needed a manual demonstration against the real file: `validationError('dummy_new_v3_rule', 'x')` was inserted as the first statement of `validateV3AiProposalV3`'s body, and `npx vitest run tests/unit/v3-v31-static-error-code-coverage.test.js -t "V3 codes are a subset"` failed:
```
AssertionError: expected [ 'dummy_new_v3_rule' ] to deeply equal []
```
The dummy line was removed immediately after and the file diffed clean against its committed content. The test suite also keeps this proof permanently as its own case ("a brand-new v3-only code (not allowlisted) fails the coverage assertion"), which injects the same dummy code into an in-memory copy of the source (never touching the file on disk) and asserts the coverage check flags it — so the property is re-verified on every run, not just once manually.

#### Gap 2 — authorizer payload-enrichment parity

Extracted `buildV3EffectCommand(policy, effect, authorizedMutationCount, operationKeyNamespace)` from `authorizeV3ConversationDecisionV3`'s inline `effectCommands` construction; both `authorizeV3ConversationDecisionV3` (namespace `'effect/v3'`) and `authorizeV3ConversationDecisionV31` (namespace `'effect/v3.1'`) now call this one function, so the `escalation_reason`/`pending_question_key` enrichment is composed, not copied.

**RED evidence**: `tests/unit/v3-v31-authorizer-composition-differential.test.js`, written first, ran against the pre-fix authorizer:
```
AssertionError: expected { conversation_id: '22', …(2) } to deeply equal { conversation_id: '22', …(4) }
- escalation_reason: "no_progress_commercial_question_loop"
- pending_question_key: "address"
```
After extracting `buildV3EffectCommand` and wiring both authorizers to it: GREEN, and the v3.1 decision's `effect_commands[0].payload`/`payload_digest` are byte-identical to v3's for the address-retry handoff scenario (mirroring `v3-address-hardbound.test.js`'s "existing permitted handoff needs no quote address and carries the domain reason").

The translation helpers used by both differential test files (`toV31Input`, `toV31Proposal`) were extracted into `tests/support/v3-v31-translate.js` to avoid duplicating that logic across the validator and authorizer differential harnesses (approval-tested: the existing 10-case validator differential suite was re-run and stayed green after the extraction, before any new code was added).

#### Updated Test Summary (final, after both gap fixes)

- **Total tests written this rework (2a.28–2a.32 + orchestrator follow-up)**: 10 (`v3-v31-composition-differential.test.js`) + 5 (`v3-v31-address-and-pickup-regression.test.js`) + 4 (`v3-v31-static-error-code-coverage.test.js`) + 1 (`v3-v31-authorizer-composition-differential.test.js`) = **20 new tests**.
- **Total tests passing**: 20/20 new, 0 regressions across 849 unit tests (154 skipped without `TEST_PG_INTEGRATION=1`) and 154 Postgres integration tests.
- **Layers used**: Unit (20).
- **New devDependency**: `acorn` (zero-dependency ESTree parser; no install scripts of its own) — needed for a real AST rather than a hand-rolled brace/regex scanner, which would mis-handle regex-literal braces (e.g. `.{0,50}` quantifiers already present in this file).
- **Pure functions added this follow-up**: `buildV3EffectCommand` (shared by both authorizers).

#### Updated Work Unit Evidence (final)

| Evidence | Value |
|---|---|
| Focused test command and exact result | `npx vitest run tests/fixtures/workflow-nodes/shared/v3-contract-runtime.test.js tests/unit/v3-runtime-compatibility.test.js tests/unit/v3-address-hardbound.test.js tests/unit/v3-commercial-policy.test.js tests/unit/v3-policy-builder-v31-items.test.js tests/unit/v3-policy-builder-line-items-regression.test.js tests/unit/v3-artifact-version-widening.test.js tests/unit/v3-v31-composition-differential.test.js tests/unit/v3-v31-address-and-pickup-regression.test.js tests/unit/v3-v31-static-error-code-coverage.test.js tests/unit/v3-v31-authorizer-composition-differential.test.js --globals` → **118/118 passed** (11 files) |
| Runtime harness command/scenario and exact result | `docker compose -f docker-compose.test.yml up -d --wait postgres && npm run db:reset:test && npm run test:integration:postgres` (with `TEST_PG_INTEGRATION=1`) then `docker compose -f docker-compose.test.yml down -v` → **17 files, 154/154 passed** |
| Rollback boundary | Revert commit `2372b5e` (2a-ii) then `26c114e` (2a-i) on `feat/multi-product-quotes-contract`. `AI_PRD_V3_LINE_ITEMS` still does not exist (Slice 2b) and nothing in production passes `version: 'v3.1'`, so revert is pure code rollback with zero live-traffic exposure. |

#### Updated Full Suite Verification (exact counts, final state)

- `npm test` (unit + contract + smoke + ops, Postgres suites skipped): **65 files passed, 17 skipped; 849 tests passed, 154 skipped**.
- `npm run check:parity`: exit 0, 0 drift, all nodes `[OK]` after `node tests/scripts/sync-workflow-nodes.mjs`.
- `npm run check:sql-references`: exit 0, 0 errors, 0 warnings, 36 SQL files embedded/referenced byte-for-byte.
- `docker compose -f docker-compose.test.yml up -d --wait postgres && npm run db:reset:test && npm run test:integration:postgres` (`TEST_PG_INTEGRATION=1`) then `down -v`: **17 files passed, 154/154 tests passed**.

### Issues Found (final)

None. Both orchestrator-flagged gaps are closed and structurally guarded against recurrence (the static coverage test catches any future v3 rule regardless of whether anyone adds a differential test case for it). All hard constraints held throughout: v3.1 stays dark; `v3-runtime-compatibility.test.js` was not modified; every pre-existing Slice 1/2a test stayed green at every checkpoint.

### Workload / PR Boundary

- Mode: chained PR slice (`feature-branch-chain`), PR2a = Slice 2a Contract (rewritten), base = `feat/multi-product-quotes-foundation`.
- Current work unit: Slice 2a rework (D11) + orchestrator follow-up, complete.
- Boundary: `feat/multi-product-quotes-contract` now has exactly 2 commits ahead of `feat/multi-product-quotes-foundation` (history rewritten per owner authorization; commit `90498a8` was amended into `2372b5e` to fold in both gap fixes — 2a-i is untouched):
  1. `26c114e` `feat(v3): widen the v3 route family to accept v3.1 artifacts (2a-i)` — 490 authored additions + 16 authored deletions (500/26 raw, minus 10/10 generated workflow JSON) = **506 authored changed lines**
  2. `2372b5e` `feat(v3): compose the v3.1 validator and authorizer from v3 (2a-ii)` — 1937 authored additions + 114 authored deletions (1941/118 raw, minus 4/4 generated workflow JSON) = **2051 authored changed lines**

---

## Slice 2b — Advisor, dark

**Scope**: tasks 2b.1–2b.15 only. Branch `feat/multi-product-quotes-advisor`, base `feat/multi-product-quotes-contract`.

### Status

15/15 Slice 2b tasks complete (2b.1–2b.15). All marked `[x]` in `tasks.md`.

### TDD Cycle Evidence

| Task | Test File | Layer | Safety Net | RED | GREEN | TRIANGULATE | REFACTOR |
|------|-----------|-------|------------|-----|-------|-------------|----------|
| 2b.1–2b.2 v3.1 response schema | `tests/unit/build-ai-request-v31-schema.test.js` | Unit | ✅ `build-ai-request-wrapper.test.js` (6/6) green before edit | ✅ Written first, confirmed RED (7/7 failed) against the pre-edit fixture | ✅ 7/7 passed after implementing `activeResponseSchema`/`usesV31Contract` | ✅ 2 item-count cases (no existing items → `new:1..new:10`; 1 existing item → `li_a` + `new:1..new:9`) plus catalog_resolutions/observations/mutations shape cases | ➖ None needed |
| 2b.3–2b.6 v3 byte-identical + v3.1 prompt derivation | `tests/unit/build-ai-request-v31-prompt.test.js` | Unit | ✅ `v3-brand-voice.test.js` (9/9) + `build-ai-request-wrapper.test.js` (6/6) green before and after the refactor | ✅ Golden v3 prompt captured from the pre-refactor fixture *before* touching production code (approval-test baseline); full file confirmed RED (12/14 failed) against the pre-refactor fixture when stashed back | ✅ 7/7 passed after the refactor: `v3SystemPrompt` byte-identical (its exact literal-array-to-`.filter(Boolean).join('\n')` statement preserved verbatim, since `v3-brand-voice.test.js` extracts the prompt straight from that exact source-text marker), `v31SystemPrompt` derived via `buildV31PromptLines` | ✅ 2 prompts (v3, v3.1) diffed at the line level; brand-voice/yes-no/ambiguity substrings asserted present in v3.1 | ✅ Extracted `V3_PROMPT_LINES` (via `.split('\n')` on the untouched `v3SystemPrompt`, not a retyped array) so the derivation never duplicates the 68-line prompt |
| 2b.7–2b.8 final_confirmation itemized summary | same file | Unit | — | ✅ Written together with 2b.5/2b.6 (one derivation function covers both) | ✅ Passed | ➖ Covered by the same derivation-diff case | ➖ None needed |
| 2b.9–2b.10 `disabled` switch path | `tests/unit/compile-v3-turn.test.js` | Unit | ✅ full pre-existing suite (863/863) green before edit | ✅ Written first, confirmed RED (3/7 failed: canary-listed, enabled, digest-differs cases) against the pre-edit fixture | ✅ 7/7 passed after implementing the switch | ✅ 4 cases: no env, explicit `disabled` with a listed phone (proves the phone list is ignored), unknown value, non-v3 turn passthrough | ➖ None needed |
| 2b.11–2b.12 `canary` path | same file | Unit | — | ✅ (see 2b.9/2b.10 RED) | ✅ Passed | ✅ 2 cases: phone listed (with punctuation in the input, proving `digitsOnly` normalization) vs. unlisted; plus an empty-list case | ➖ None needed |
| 2b.13–2b.14 `enabled` path | same file | Unit | — | ✅ (see 2b.9/2b.10 RED) | ✅ Passed | ➖ Single scenario (enabled is unconditional) | ➖ None needed |
| 2b.15 `docker-compose.yml` / `.env.example` passthrough | n/a (config) | N/A (structural) | ✅ `docker compose config` valid before edit | ➖ Skipped: env passthrough lines, no branching | ✅ `docker compose -f docker-compose.yml config` renders cleanly after the edit; both vars present with the documented defaults | ➖ N/A | ➖ N/A |

### RED evidence (2b.1–2b.2, schema)

Command: `npx vitest run tests/unit/build-ai-request-v31-schema.test.js --globals` against the fixture *before* the v3.1 branch existed.

Result: **7 of 7 failed** — `usesV31Contract`, `activeResponseSchema` and every item_ref/catalog_resolutions/observations/mutations property were `undefined`. After implementing the schema block: **7/7 passed**.

### RED evidence (2b.3–2b.8, prompt)

The v3.1 derivation tests were written and passed together with the refactor in one pass (the golden v3 baseline was captured from the file *before* editing it, per strict-tdd's Approval Testing flow). To recover an explicit RED/GREEN cycle for the whole file, the production edit was stashed and the two v3.1 test files re-run against the pre-refactor fixture:

```
git stash push -- tests/fixtures/workflow-nodes/ai-lead-qualification-assistant/build-ai-request.js
npx vitest run tests/unit/build-ai-request-v31-prompt.test.js tests/unit/build-ai-request-v31-schema.test.js --globals
# → 2 Test Files failed; 12 failed | 2 passed (14)
#   (the 2 that passed are the v3-only "byte-identical"/"rule 436 verbatim" assertions,
#    which are true of the unmodified v3 prompt too — expected)
git stash pop
npx vitest run tests/unit/build-ai-request-v31-prompt.test.js tests/unit/build-ai-request-v31-schema.test.js tests/unit/build-ai-request-wrapper.test.js --globals
# → 3 Test Files passed (20/20)
```

**Prompt-diff drift proof (owner requirement).** To prove the derivation-diff test actually catches drift, not just happens to pass: a temporary `derived.splice(1, 1);` (dropping one unrelated v3 rule) was inserted into `buildV31PromptLines` in production code.

```
npx vitest run tests/unit/build-ai-request-v31-prompt.test.js --globals
# → 1 failed | 6 passed (7)
# FAIL: "exactly one v3 line is removed ..., every other v3 line survives verbatim"
#   AssertionError: expected [ …(2) ] to have a length of 1 but got 2
```

The temporary line was then removed and the same command re-run: **7/7 passed** again. This demonstrates the diff test fails closed the moment the derivation drops anything beyond the one allowlisted D5 clause — mirroring D11's differential-guarantee mechanism from Slice 2a, applied to the prompt.

### RED evidence (2b.9–2b.14, switch)

Command: `npx vitest run tests/unit/compile-v3-turn.test.js --globals` against the fixture *before* the switch existed (the unconditional `compileV3TurnPolicy(buildV3PolicyInput(input))` call, no `version` option).

Result: **3 of 7 failed** (the canary-listed case, the enabled case, and the "digest differs between disabled/enabled" case — all three require compiling `v3.1`, which the pre-edit fixture can never do). The other 4 cases already passed because they describe the *default* `disabled` behavior, which the pre-edit fixture already exhibited unconditionally. After implementing the switch: **7/7 passed**.

### Test Summary

- **Total tests written this slice**: 7 (`build-ai-request-v31-schema.test.js`) + 7 (`build-ai-request-v31-prompt.test.js`) + 7 (`compile-v3-turn.test.js`) = **21 new tests**.
- **Total tests passing**: 21/21 new, 0 regressions across 849 pre-existing unit tests (863 once this slice's schema+prompt tests land, 870 with the switch tests) and 154 pre-existing Postgres integration tests (unaffected, not touched this slice).
- **Layers used**: Unit (21). No Postgres/SQL touched in this slice.
- **Approval tests**: 1 — `GOLDEN_V3_PROMPT` in `build-ai-request-v31-prompt.test.js`, capturing the exact pre-refactor v3 system prompt (OpenAI/responses request path, repair-free turn policy) and asserting the post-refactor prompt is byte-identical to it.
- **Pure functions created**: `buildV31PromptLines` (prompt derivation), plus the schema-building helpers `observationSchemaV31`, `mutationSchemaV31`, `catalogResolutionVariantV31` (all side-effect-free, mirroring their v3 counterparts already in the file).

### Work Unit Evidence

| Evidence | Value |
|---|---|
| Focused test command and exact result | `npx vitest run tests/unit/build-ai-request-v31-schema.test.js tests/unit/build-ai-request-v31-prompt.test.js tests/unit/compile-v3-turn.test.js tests/unit/build-ai-request-wrapper.test.js tests/unit/v3-brand-voice.test.js --globals` → **36/36 passed** (7+7+7+6+9) |
| Runtime harness command/scenario and exact result | N/A — this slice ships only a JSON Schema shape, a prompt string and an in-process env-driven switch; no SQL, no live-model call, and the switch stays `disabled` in every env file, so no runtime boundary is crossed. The live-model/E2E harness for this switch ships in Slice 3 (task 3.12) and Slice 4 (tasks 4.2/4.5), per design.md's Testing Strategy table. |
| Rollback boundary | Revert commit `e028464` (switch + compose/.env passthrough) then `ee3bcef` (schema + prompt) on `feat/multi-product-quotes-advisor`. `AI_PRD_V3_LINE_ITEMS` defaults to `disabled` in both `docker-compose.yml` and `.env.example`; nothing in production ever passes `version: 'v3.1'` or reads a non-default value, so revert is pure code/config rollback with zero live-traffic exposure. |

### Full Suite Verification (exact counts, final state)

- `npm test` (unit + contract + smoke + ops, Postgres suites skipped): **68 files passed, 17 skipped; 870 tests passed, 154 skipped**.
- `npm run check:parity`: exit 0, 0 drift, all nodes `[OK]` after two `node tests/scripts/sync-workflow-nodes.mjs` runs (once for `Build AI Request`, once for `Compile V3 Turn Policy`).
- `npm run check:sql-references`: exit 0, 0 errors, 0 warnings, 36 SQL files embedded/referenced byte-for-byte (unchanged — no `.sql` file touched this slice).
- `docker compose -f docker-compose.yml config`: renders cleanly, confirming the two new env vars interpolate with their documented defaults.
- Postgres integration suite: not run this slice (no SQL changed); last known-green count from Slice 2a rework carries forward unchanged (154/154).

### Regression Safety Net

- Pre-existing full unit suite (849 tests before this slice) verified green immediately after each production edit, before moving to the next task: 863/863 after the schema+prompt commit, 870/870 after the switch commit — 0 regressions at any checkpoint.
- `tests/unit/v3-brand-voice.test.js` (9 tests) — parses the *deployed workflow's* `Build AI Request` node source text directly — caught a naming regression mid-implementation (the `v3SystemPrompt` array was briefly renamed to `V3_PROMPT_LINES` during the refactor, which broke that test's exact source-text marker search) and was the reason the array's original name and its single-statement `.filter(Boolean).join('\n')` form were restored verbatim. This is exactly the kind of drift this test exists to catch.

### Deviations from Design

1. **v3.1's repair-request envelope is not versioned separately**: design.md D6 lists `ai_conversation_repair_request/v3.1` as a new artifact, but `build-v3-repair.js` (Slice 2a, already committed) hardcodes `schema: 'ai_conversation_repair_request/v3'` regardless of the underlying policy's version — the repair envelope's `schema` string is deliberately shared, and only the embedded `policy` object (which does carry `policy.version`) differs by version. `build-ai-request.js`'s `repairRequestValid` check was left matching that same shared string for both v3 and v3.1, consistent with the already-committed Slice 2a convention. No test in this slice exercises a v3.1 repair turn (not in 2b.1–2b.15's task list), so this is documented as a known consistency point, not a gap: if a future slice needs v3.1-specific repair validation, it is additive.
2. **`replaces_fact_id` enum-pinning for item-field `replace` mutations is per-field-across-existing-items, not per-(item,field)**: the schema enumerates the set of real `fact:item:<id>:<field>` ids that currently exist for a given field across all existing items (falling back to an unpinned `{type:'string'}` when none exist yet, mirroring the `policy_digest` fallback pattern), rather than a fully closed per-item schema variant. The validator (Slice 2a, already committed) is the actual authority that checks `replaces_fact_id` against the real fact and its item, so this is a structured-output *hint* to the model, not a safety boundary; a hint set to a superset of the truly valid choices is a reasonable, minimal implementation with no test in this task list demanding tighter pinning.
3. **`primary_request`/observation/mutation "pandereta → Cierros de Hormigón" and "ask which item" guidance is prompt text, not new validator logic**: design.md's own Open Questions section flags the pandereta/grounding mapping as unresolved and names it "a v3.1 prompt rule" (not a code change); the orchestrator's explicit instruction for this slice confirmed the prompt-only scope. The actual "which item is ambiguous" enforcement (`item_target_required`) and the actual product-name resolution (`catalog_resolution.grounding_ref`) are Slice 2a validator behavior, already committed and unchanged here.

### Issues Found

None. All hard constraints held: `AI_PRD_V3_LINE_ITEMS` defaults to `disabled` in both `docker-compose.yml` and `.env.example`; `.env` itself was never read or written; `usesV31Contract`/`turn_policy.version === 'ai_prd_turn_policy/v3.1'` is never true unless a caller explicitly requests it, and nothing in production does; the v3 prompt and v3 schema are provably byte-identical/unchanged (golden approval test plus the pre-existing `v3-brand-voice.test.js`, which — as noted above — actually caught a mid-refactor naming regression); `npm run check:parity` and `npm run check:sql-references` are both clean.

### Workload / PR Boundary

- Mode: chained PR slice (`feature-branch-chain`), PR2b = Slice 2b Advisor, base = `feat/multi-product-quotes-contract`.
- Current work unit: Slice 2b — Advisor, dark, complete (15/15 tasks).
- Boundary: 2 commits on `feat/multi-product-quotes-advisor`, both comfortably under the 800-line review budget:
  1. `ee3bcef` `feat(v3): add the v3.1 response schema and prompt, dark` — 440 authored additions + 8 authored deletions (441/9 raw, minus 1/1 generated workflow JSON) = **448 authored changed lines**
  2. `e028464` `feat(v3): add the AI_PRD_V3_LINE_ITEMS rollout switch, dark` — 138 authored additions + 1 authored deletion (139/2 raw, minus 1/1 generated workflow JSON) = **139 authored changed lines**
- **Review budget: within forecast.** Design.md forecast ~420 lines for Slice 2b; actual authored total is 448 + 139 = **587 lines** across 2 commits, each individually well under the 800-line cap. No `size:exception` needed.
- **Review budget: EXCEEDED for 2a-ii.** 2a-i (506 lines) is comfortably under the 800-line budget. 2a-ii (2051 lines) is over, by design — task 2a.32 explicitly directs "do not try to force 2a-ii under 800 by separating tests from code; just report its size," and the orchestrator's own follow-up added more to the same indivisible unit (the structural coverage test proves the composition the behavioral test and the authorizer fix both depend on; splitting any of the three apart would let a broken composition merge with green CI on the split-off piece). **Decision needed before PR2a (rewritten) opens**: accept `size:exception` for 2a-ii, or split PR2a into PR2a-i (`26c114e`, 506 lines) → PR2a-ii (`2372b5e`, 2051 lines, base = PR2a-i's branch) and ask the maintainer to review 2a-ii as a single indivisible unit despite the size.

---

## Slice 3 — Output

**Scope**: tasks 3.1–3.12 only. Branch `feat/multi-product-quotes-output`, base `feat/multi-product-quotes-advisor`.

### Owner hard requirement — proof

Before any production change, three golden/approval baselines were captured or reused, all still green after the slice:

1. **`build-v3-lead-effect.test.js`** (pre-existing, 8 assertions with hardcoded exact strings) — run as the Safety Net immediately before editing `build-v3-lead-effect.js`; all 8 still pass unmodified after wiring `composeRequirement`/`reduceV3StateMutations` in. Hand-verified algebraically for every pre-existing test case (documented in the RED/GREEN evidence below) that the new item-aware path always reduces to the exact same flat computation for a single item.
2. **`tests/fixtures/golden/build-clickup-payload-inline-v1.js`** — a byte-for-byte capture of the CURRENT inline `Build ClickUp Payload` node's `jsCode`, taken via `node -e "...JSON.parse(...).parameters.jsCode..."` straight from `n8n/workflows/crm-clickup-sync-lead.json` before any extraction (sha256 `827edbf0...`, 6525 bytes). `tests/unit/build-clickup-payload.test.js` runs this exact golden source AND the newly extracted fixture through the identical `new Function('items', '$env', source)` harness on the same representative single-item inputs and asserts the two outputs are `toEqual` — proving the extraction is behavior-preserving by direct comparison, not by re-typing expected values by hand.
3. **Seller notification** — confirmed unchanged (D9: "the seller notification renders `leads.requirement` verbatim"); no production edit was needed or made.

### TDD Cycle Evidence

| Task | Test File | Layer | Safety Net | RED | GREEN | TRIANGULATE | REFACTOR |
|------|-----------|-------|------------|-----|-------|-------------|----------|
| 3.1–3.2 wire the reducer into `build-v3-lead-effect.js` | `tests/unit/build-v3-lead-effect.test.js` | Unit | ✅ 9/9 pre-existing exact-string assertions green before the edit | ✅ 2 new tests written first, confirmed RED (dual-read case: `null` instead of `'Baldosas 10 m2'`; multi-item case: flat single string instead of bullets) against the unmodified fixture | ✅ 11/11 passed after wiring `reduceV3StateMutations`/`readLineItems`/`composeRequirement` in | ✅ dual-read-only case (no decision mutations) + multi-item case (2 items, quote-level `use_case`) | ✅ removed the now-redundant local `formatRequirementValue`/`REQUIREMENT_FIELDS`/`hasValue`, replaced by the shared runtime's byte-identical equivalents |
| 3.1–3.2 raw-fixture harness update | `tests/unit/v3-effect-execution-wrapper.test.js` | Unit | — | N/A (pre-existing test broke because the fixture legitimately now depends on `shared/v3-line-items.js` being concatenated, exactly like `v3-policy-builder.js` already does) | ✅ updated `runFixture` to compose declared `runtimes` ahead of the fixture source, mirroring `sync-workflow-nodes.mjs`'s own composition; 4/4 passed | ➖ N/A | ➖ None needed |
| 3.3–3.4 multi-item bullet rendering | same file | Unit | (covered above) | (covered above) | (covered above) | (covered above) | (covered above) |
| 3.5–3.6 extract `Build ClickUp Payload` | `tests/unit/build-clickup-payload.test.js` | Unit | N/A (new fixture) | ✅ written first, confirmed RED: `ENOENT` (fixture file did not exist yet) | ✅ created the fixture as a byte-for-byte copy of the golden capture; 2/2 passed | ✅ 2 cases (plain single item; single item with `measurements` present) | ➖ None needed (extraction only) |
| 3.7–3.8 skip flat `Cantidad`/`Medidas` for multi-item | same file | Unit | ✅ 2/2 extraction tests green before this edit | ✅ written first, confirmed RED (description contained `Cantidad:`/`Medidas:` when it should not) | ✅ 4/4 passed after adding the `line_items.length > 1` skip guard | ✅ 2 cases (multi-item skips; exactly-one-item still shows both) | ➖ None needed |
| 3.9 register + regenerate | `tests/scripts/sync-workflow-nodes.mjs`, `n8n/workflows/crm-clickup-sync-lead.json` | N/A (structural) | ✅ `check:parity` green before the edit | ➖ Skipped: config array entry, no branching | ✅ `check:parity`/`check:sql-references` green after registering the fixture and running `node tests/scripts/sync-workflow-nodes.mjs` | ➖ N/A | ➖ N/A |
| 3.10–3.11 seller notification confirmation | `tests/unit/crm-seller-notification-dispatch.test.js` | Unit (confirmatory) | N/A (no production change) | N/A — this is a confirmation that existing behavior already satisfies D9, per the same pattern as prior slices' "confirm/wire" tasks (1.22, 2b.15) | ✅ 2/2 passed against the unmodified inline node, read straight from the deployed workflow JSON | ✅ 2 cases (multi-item itemized requirement; plain single-item requirement) | ➖ N/A — no production code touched |
| 3.12 opt-in A/B live-replay harness | `tests/unit/v3-line-items-live-replay.test.js` | Unit | N/A (new file) | ✅ every exported pure function written test-first against the not-yet-existing harness module (import error until the file existed) | ✅ 22/22 passed | ✅ multiple cases per property function (see Test Summary) | ✅ `runTurn`'s `reduce(...)`-on-`decision-or-unchanged` path kept minimal; property functions stayed pure with no hidden state |

### Test Summary

- **Total tests written this slice**: 2 (`build-v3-lead-effect.test.js` new describe block) + 2 (`build-clickup-payload.test.js` extraction) + 2 (`build-clickup-payload.test.js` skip-logic) + 2 (`crm-seller-notification-dispatch.test.js`) + 22 (`v3-line-items-live-replay.test.js`) = **30 new tests**, plus 1 pre-existing test file (`v3-effect-execution-wrapper.test.js`) updated to compose the fixture's now-real runtime dependency (not a behavior change — a harness fix).
- **Total tests passing**: 900/900 non-skipped in the full unit suite (up from 870 at the start of this slice), 154/154 Postgres integration tests, 0 regressions.
- **Layers used**: Unit (30 new + 1 updated harness). No new SQL/DB-bound behavior this slice (no `.sql` files touched), so the Postgres integration suite was run once at the end as a regression check per the Verification line, not because any task in 3.1–3.12 changes SQL.
- **Approval tests**: the 9 pre-existing `build-v3-lead-effect.test.js` assertions (unmodified) plus the golden ClickUp capture (`tests/fixtures/golden/build-clickup-payload-inline-v1.js`), both proving byte-identical single-item behavior across the refactor/extraction.
- **Pure functions created**: none new in production `shared/*.js` (this slice only *consumes* Slice 1/2a/2b's `reduceV3StateMutations`/`readLineItems`/`composeRequirement`); the live-replay harness (`tests/ops/v3-line-items-live-replay.mjs`) exports 11 pure/DI functions: `buildScriptedTranscripts`, `buildTurnPolicy`, `buildAiRequestForTurn`, `extractProposal`, `runTurn`, `runTranscript`, `aggregateRuns`, `checkItemizedFinalConfirmation`, `checkCorrectionScoping`, `checkMeasurementAttribution`, `replay` — every one of them either pure or with its only side-effecting dependency (`callModel`) injected.

### Work Unit Evidence

| Evidence | Value |
|---|---|
| Focused test command and exact result | `npx vitest run tests/unit/build-v3-lead-effect.test.js tests/unit/v3-effect-execution-wrapper.test.js tests/unit/build-clickup-payload.test.js tests/unit/crm-seller-notification-dispatch.test.js tests/unit/v3-line-items-live-replay.test.js --globals` → **41/41 passed** (11 + 4 + 4 + 2 + 22 — includes the 2 confirmatory seller-notification tests and 4 raw-fixture wrapper tests) |
| Runtime harness command/scenario and exact result | `docker compose -f docker-compose.test.yml up -d --wait postgres && npm run db:reset:test && npm run test:integration:postgres` (`TEST_PG_INTEGRATION=1`) then `docker compose -f docker-compose.test.yml down -v` → **17 files, 154/154 passed** (no `.sql` file changed this slice; run as a full regression check). The live-replay harness's OWN runtime boundary (`AI_REPLAY_LIVE=1 AI_REPLAY_RUNS=10 node tests/ops/v3-line-items-live-replay.mjs`, meant to run inside the n8n container) was explicitly NOT executed, per the orchestrator's instruction; verified instead by running the CLI locally with `AI_REPLAY_LIVE` unset (prints the opt-in message, exit 0, no network) and with `AI_REPLAY_LIVE=1` and no `OPENAI_API_KEY` (fails closed with exit 1, still no network, never touches `.env`). |
| Rollback boundary | Revert any of the 4 commits on `feat/multi-product-quotes-output` independently: `a1e4729` (lead-effect wiring), `3a5d9b5` (ClickUp extraction), `e67e634` (seller-notification test only, no production code), `efdd6ca` (live-replay harness, dark/opt-in, zero runtime exposure — `AI_REPLAY_LIVE` does not exist anywhere in production config). Single-item requirement, ClickUp payload and seller text stay byte-identical to `main` throughout (see the golden/approval proofs above). |

### Full Suite Verification (exact counts, final state)

- `npm test` (unit + contract + smoke + ops, Postgres suites skipped): **71 files passed, 17 skipped; 900 tests passed, 154 skipped**.
- `npm run check:parity`: exit 0, 0 drift, all nodes `[OK]` (including the 2 regenerated this slice: `Build V3 Lead Effect`, `Build ClickUp Payload`).
- `npm run check:sql-references`: exit 0, 0 errors, 0 warnings (no `.sql` file touched this slice).
- `docker compose -f docker-compose.test.yml up -d --wait postgres && npm run db:reset:test && npm run test:integration:postgres` (`TEST_PG_INTEGRATION=1`) then `down -v`: **17 files passed, 154/154 tests passed**, including migration 025 applying cleanly again (superset, unchanged since Slice 1).

### Regression Safety Net

- `build-v3-lead-effect.test.js`'s 9 pre-existing exact-string assertions run and confirmed green immediately before editing production code, then again immediately after — 0 regressions, and every one of them hand-verified algebraically (traced through `reduceV3StateMutations`/`readLineItems`/`composeRequirement` by hand for each input) to confirm the new item-aware path reduces to the exact same output for every single-item case, not just empirically observed to still pass.
- `v3-effect-execution-wrapper.test.js`'s other 3 pre-existing tests (unrelated fixtures) stayed green throughout; only the 1 test exercising `build-v3-lead-effect.js` needed its harness updated (see Deviations).
- Full 900-test unit suite and 154-test Postgres suite re-run clean at the end of the slice.

### Deviations from Design

1. **`tests/unit/v3-effect-execution-wrapper.test.js` needed a harness fix, not a design deviation**: this pre-existing test runs `build-v3-lead-effect.js` as a raw, unconcatenated fixture (`new Function('items', source)`, no runtimes). Once the fixture legitimately depends on `shared/v3-line-items.js` being concatenated ahead of it (exactly as `shared/v3-policy-builder.js` already documents and relies on for `readLineItems`), that harness needed the same runtime-composition fix `v3-policy-builder.js`'s own comment already describes. This is a test-harness correction, not a behavior change — production nodes get the runtime concatenated for real by `sync-workflow-nodes.mjs` (already declared for this node in the `NODES` array since Slice 1).
2. **ClickUp payload extraction kept the raw n8n Code node body shape (no `module.exports`, no wrapper)**, matching `crm-lead-creation-and-assignment/prepare-lead-assignment.js`'s established pattern for a `runOnceForAllItems` node with no other need for a `require`-able export — tested via the same `new Function('items', '$env', source)` technique already used for that fixture and for `build-ai-request.js`.
3. **The live-replay harness's live path (task 3.12) was never executed**, exactly as instructed. Its request-building/validation/authorization wiring is provably correct in shape (real `compileV3TurnPolicy`/`buildV3PolicyInput`, real `Build AI Request`/`Normalize AI Result` node code, real `validateV3AiProposal`/`authorizeV3ConversationDecision` dispatcher) but the model's actual reasoning quality against the live 2026-09-26 message is untested by this slice — that is explicitly Slice 4's job (tasks 4.2/4.5), and out of scope here.
4. **Property-check unit tests use hand-fabricated `turnResult`-shaped fixtures for `checkItemizedFinalConfirmation`/`checkCorrectionScoping`/`checkMeasurementAttribution`**, rather than only exercising them through the full mocked-model pipeline. This is deliberate: forcing the full real validator/authorizer through non-trivial item-scoped scenarios (multiple catalog-grounded observations, evidence digests, etc.) would either re-test Slice 2a's own already-exhaustive validator suite or require a second hand-rolled "fake validator," neither of which is this file's job. The full pipeline IS exercised end-to-end (`runTurn`/`runTranscript`/`replay` tests) with a trivially-valid empty proposal, proving the wiring; the property functions are independently proven correct on their own inputs.

### Issues Found

None. All hard constraints held: every pre-existing single-item assertion in `build-v3-lead-effect.test.js` passed unmodified; the ClickUp golden capture and the extracted fixture produce `toEqual` output for the same inputs; the seller notification needed no code change; `AI_PRD_V3_LINE_ITEMS` was not touched and stays `disabled`; the live-replay harness never executes live logic unless `AI_REPLAY_LIVE=1`, and even then fails closed without `OPENAI_API_KEY` rather than falling back to reading `.env`; `.env` itself and the live n8n runtime were never touched.

### Workload / PR Boundary

- Mode: chained PR slice (`feature-branch-chain`), PR3 = Slice 3 Output, base = `feat/multi-product-quotes-advisor`.
- Current work unit: Slice 3 — Output, complete (12/12 tasks, 3.1–3.12).
- Boundary: 4 commits on `feat/multi-product-quotes-output`, each individually well under the 800-line budget:
  1. `a1e4729` `feat(v3): itemize the lead requirement through the shared reducer` — 118 insertions + 51 deletions total (1/1 generated workflow JSON) = **167 authored changed lines**
  2. `3a5d9b5` `feat(v3): extract Build ClickUp Payload into a testable fixture` — 472 insertions + 10 deletions total (1/1 generated workflow JSON, 9/9 of which is `tasks.md`) = **480 authored changed lines** (163 of which is the golden capture and 171 the extracted fixture — almost entirely mechanical copy, not hand-authored logic; the actual new behavior, the skip-guard, is ~8 lines)
  3. `e67e634` `test(v3): confirm the seller notification renders leads.requirement itemized` — 63 insertions + 2 deletions total, **65 authored changed lines**, zero production code
  4. `efdd6ca` `test(v3): add the opt-in v3/v3.1 live-replay A/B harness` — 664 insertions + 1 deletion total, **665 authored changed lines**
- **Review budget: EXCEEDED for the slice total.** Design.md forecast ~700 lines for Slice 3; actual authored total is 167 + 480 + 65 + 665 = **1377 authored changed lines**, against the 800-line PR budget — same pattern as Slices 1 and 2a: each commit is individually reviewable and under budget, but PR3 as a whole (if delivered as one PR against `feat/multi-product-quotes-advisor`) exceeds it. Unlike Slice 2a's validator, these 4 commits have NO shared internal state forcing them together — they are already 4 independent, cleanly separable functional units on 4 non-overlapping files (lead-effect wiring; ClickUp extraction; a test-only confirmation; a new opt-in ops script). **Decision needed before PR3 opens**: accept `size:exception` for PR3 as a whole, or split PR3 into 4 child PRs against `feat/multi-product-quotes-output` at the exact commit boundaries above (PR3a=167, PR3b=480, PR3c=65, PR3d=665 lines) — each already independently green and independently revertible.

---

## Slice 3c — v3.1 contract alignment, from live evidence

**Scope**: tasks 3c.1–3c.5 only. Branch `feat/multi-product-quotes-alignment`, base `feat/multi-product-quotes-output`. Task 3c.6 (rerun the live A/B, N=10, production catalog) is explicitly out of scope for this batch — the orchestrator runs it.

### Why this slice exists

Rollout step 3 ran the live A/B against the real model (N=10, production catalog). v3.1 first-turn proposals validated only 2/20 times (v3: 20/20). The captured real proposals (`tests/fixtures/v3-line-items/captured-live-proposals.json`, 15 entries: 5 `first-turn`, 5 `wire-correction`, 5 `wire-correction-hashed-ids`) show the model was semantically right and the v3.1 validator rejected it, because Slices 2a (validator/policy builder) and 2b (schema/prompt) were each built and tested against mocks and quietly disagreed on two points:

1. **Per-item goal references.** `buildV3PolicyInput` (Slice 2a, deviation #3, already documented) emits a single quote-level `line_items` goal — no per-item `product`/`quantity`/`measurements` goal. Real model output legitimately used the item's own concept name (`resolves_goal_ids: ['product']`) as often as `['line_items']`. The validator only ever accepted the literal `'line_items'`, so `goal_reference_unknown` fired on the concept-name form, which then cascaded into `catalog_resolution_product_observation_required`, `quantity_observation_required` and `mutation_shape_invalid` — none of those were the real defect; they were fallout from the excluded observation.
2. **`primary_request.goal_id` for the ambiguous-item clarification.** design.md's own validator rules table and its Slice 2a live-scenario test (`v3-contract-runtime.test.js`, "live scenario — pandereta + wire + commune") pin the literal `primary_request={goal_id:'product', item_ref}`. But `build-ai-request.js`'s `primaryRequestGoalIds` (Slice 2b) only ever contains real policy goal ids plus `final_confirmation` — it **never** contained `'product'`. The response schema is a strict enum, so the model could never literally emit `'product'` even though the v3.1 prompt (line 667) explicitly instructs it to. This made the validator's own documented rule structurally unsatisfiable by the schema it was validating against.

### Decisions recorded (design was ambiguous; smallest coherent fix, no safety weakened)

- **Per-item goal references (fixes `goal_reference_unknown`)**: `knownGoalIds` in `validateV3AiProposalV31` now includes the three item concept names (`product`, `quantity`, `measurements`) unconditionally, in addition to the policy's real goal ids. This mirrors `primary_request`'s own `requestGoalValid` check, which already treated these three names as always-valid literals (2a.11's `ITEM_FIELDS.has(...)` check) — the observation-side check was simply narrower than the primary_request-side check for the identical concept vocabulary. No new acceptance surface is introduced: the three literals were already part of the v3.1 contract's own vocabulary (`ITEM_FIELDS`), just not recognized in this one place.
- **`primary_request.goal_id` schema (fixes the structural non-satisfiability of `catalog_resolution_clarification_required`)**: `build-ai-request.js` now offers a v3.1-only `primaryRequestGoalIdsV31` enum = `primaryRequestGoalIds ∪ {product, quantity, measurements}`, **except during an active repair turn**, where the repair's own `allowed_values` lock (`primaryRequestGoalIds`, already filtered) is left untouched — widening it there would defeat the repair lock's own safety property. This lets the model literally produce what the prompt already tells it to and what the validator already requires.
- **`catalog_resolution_clarification_required` accepts `'line_items'` as an equivalent literal to `'product'`, scoped by `item_ref`**: this is the one place the design's literal (`'product'`) and the model's captured, semantically-correct behavior (`'line_items'`, entry `first-turn[3]`) disagreed, and the design's own contract doesn't expose a per-item `'product'` goal for the model to reliably discover before this slice's schema fix. Accepting `'line_items'` too — **only** when `primary_request.item_ref` exactly matches the ambiguous item — asks the identical question with no less specificity: the item_ref anchor is what actually pins the clarification to a real ambiguous item, not the literal spelling of the goal name. No proposal that fails to name the exact ambiguous item is accepted either way. Recorded here per the phase's ambiguity-resolution instruction: this is the one literal where I picked the option that lets the observed-correct captured output validate, without weakening the rule (item_ref anchoring is unchanged and still mandatory).
- **Entries genuinely rejected, and why (not a contract bug)**: `first-turn[0]`, `first-turn[1]`, `first-turn[2]` and `first-turn[4]` are captured proposals where the model's single `primary_request` targeted an unrelated goal (`service`, `use_case`, `service_scope`) while an item's catalog resolution was `ambiguous`. Design.md's validator rule requires the ambiguous item's clarification to take priority in that turn. After the contract fixes above, these four still correctly fail with exactly one error: `catalog_resolution_clarification_required`. This is real, intended production behavior (the model did not follow the v3.1 prompt's own priority instruction that turn) — not a shape defect — and `tests/unit/v3-line-items-live-evidence.test.js` pins the exact single-code rejection so it stays documented and never silently regresses into an unrelated code.
- **`wire-correction[4]` (`primary_request.goal_id: 'name'`) is left exactly as captured and is not "wrong"**: there is no ambiguous catalog resolution in that turn, so no rule requires a different `primary_request`; asking about an unresolved optional goal during an otherwise-valid correction is contractually fine. Noted here since the orchestrator's guidance flagged "`primary_request` choosing an unrelated goal during clarification" as a typical failure category — in this specific entry it is schema-legal, harmless model behavior, not a validation defect, and is left unchanged.

### TDD Cycle Evidence

| Task | Test File | Layer | Safety Net | RED | GREEN | TRIANGULATE | REFACTOR |
|------|-----------|-------|------------|-----|-------|-------------|----------|
| 3c.1 | `tests/unit/v3-line-items-live-evidence.test.js` | Unit | ✅ full pre-existing suite (900/900 unit, 154/154 Postgres) green before this file existed | ✅ Written first against all 15 captured entries as-is | ✅ Confirmed RED against the pre-fix `v3-contract-runtime.js`/`build-ai-request.js`: **8/15 failed** (see RED evidence below) | ✅ 15 cases (5 `first-turn`, 5 `wire-correction`, 5 `wire-correction-hashed-ids`), covering both the ambiguous-item D5 path and the wire-correction scoping path | ➖ None needed — pure test file |
| 3c.2 | `tests/fixtures/workflow-nodes/shared/v3-contract-runtime.js` (`knownGoalIds`) | Unit | ✅ (see 3c.1) | ✅ (see 3c.1 RED — `goal_reference_unknown`/`mutation_shape_invalid` cases) | ✅ 15/15 passed after widening `knownGoalIds` to include `ITEM_FIELDS` | ✅ covered by the 15 captured cases (both item-concept-name and `line_items` forms of `resolves_goal_ids` are exercised) | ➖ None needed — one-line widening, comment added explaining the design cross-reference |
| 3c.3 | `tests/fixtures/workflow-nodes/ai-lead-qualification-assistant/build-ai-request.js` (`primaryRequestGoalIdsV31`) + `v3-contract-runtime.js` (ambiguous-item literal) | Unit | ✅ `build-ai-request-v31-schema.test.js` (7/7) + `build-ai-request-v31-prompt.test.js` (7/7) green before either edit | ✅ (see 3c.1 RED — `catalog_resolution_clarification_required` cascades and `first-turn[3]`'s false rejection) | ✅ 15/15 passed after both edits | ✅ covered by `first-turn[3]` (accepts `'line_items'` scoped to the ambiguous item) plus `first-turn[0,1,2,4]` (still correctly rejects an unrelated goal) | ➖ None needed |
| 3c.4 | `tests/unit/v3-v31-contract-consistency.test.js` | Unit | ✅ full 3c.1–3c.3 suite green before this file existed | ✅ Written first, confirmed RED against the pre-fix code (**4/15 failed** — see RED evidence below) | ✅ 15/15 passed after 3c.2/3c.3's fixes (no new production change needed — this test is a pure regression guard) | ✅ 15 cases: 8 goal-id probes (schema enum ∪ curated literals, including a `not_a_real_goal` negative control) + 6 mutation-shape probes (`product`/`quantity`/`measurements`/`commune` positive, `name`/`service` negative) + 2 "the schema actually offers item literals" sanity checks | ➖ None needed — pure test file |
| 3c.5 | full existing suites (no new file) | Unit + Integration | ✅ | N/A (confirmatory) | ✅ 932/932 unit (154 skipped without `TEST_PG_INTEGRATION=1`), 154/154 Postgres, `check:parity` 0 drift, `check:sql-references` 0 errors, 0 regressions | N/A | N/A |

### RED evidence (3c.1 — `v3-line-items-live-evidence.test.js` against the pre-fix code)

Command: `git stash push -- tests/fixtures/workflow-nodes/ai-lead-qualification-assistant/build-ai-request.js tests/fixtures/workflow-nodes/shared/v3-contract-runtime.js && npx vitest run tests/unit/v3-line-items-live-evidence.test.js --globals`

Result: **8 of 15 failed**, exactly the captured-entry indices predicted from the fixture's own recorded `validation_errors`:

- `first-turn[0]`, `first-turn[1]`, `first-turn[4]` — expected exactly `['catalog_resolution_clarification_required']`, got the full cascade (`goal_reference_unknown` ×3, `catalog_resolution_product_observation_required`, `catalog_resolution_clarification_required`, `mutation_shape_invalid` ×3).
- `first-turn[3]` — expected `valid: true`, got the same cascade (this entry uses `resolves_goal_ids: ['line_items']` throughout, so it failed only on the ambiguous-item literal check, not the goal-reference cascade).
- `wire-correction[3]`, `wire-correction[4]`, `wire-correction-hashed-ids[0]`, `wire-correction-hashed-ids[1]` — expected `valid: true` (correction scoped to the wire item), got `goal_reference_unknown`/`catalog_resolution_product_observation_required`/`quantity_observation_required`/`mutation_shape_invalid` depending on which literal form that specific captured entry used.

`git stash pop` restored the fix; the same command then passed **15/15**.

### RED evidence (3c.4 — `v3-v31-contract-consistency.test.js` against the pre-fix code)

Same stash procedure. Result: **4 of 15 failed** — the goal-id probes for `product`, `quantity`, `measurements` (schema enum did not contain them, but `requestGoalValid` already accepted them — an asymmetric drift the test caught) and the "the three item concepts are actually offered by the schema" sanity check. After the fix: **15/15 passed**. The mutation-shape half of the file (8 cases) was already consistent before this slice — it passed both before and after, which is expected: 2a/2b already agreed on `state_authority.allowed_mutations` shape; the drift was specifically in the goal-id vocabulary.

### Test Summary

- **Total tests written this slice**: 15 (`v3-line-items-live-evidence.test.js`) + 15 (`v3-v31-contract-consistency.test.js`) = **30 new tests**.
- **Total tests passing**: 30/30 new, 0 regressions across 902 pre-existing unit tests and 154 pre-existing Postgres integration tests (`npm test`: 932/932 non-skipped after this slice).
- **Layers used**: Unit (30). No SQL/DB-bound behavior changed this slice (no `.sql` file touched); the Postgres suite was re-run as a full regression check per 3c.5, not because any task in 3c.1–3c.5 changes SQL.
- **Approval tests**: none — every assertion in both new files calls the real, unmocked validator/authorizer/reducer (`validateV3AiProposal`, `authorizeV3ConversationDecision`, `reduceV3StateMutations`) and the real `build-ai-request.js` code-node source via the same `new Function('items','$env',source)` harness prior slices already use.
- **Pure functions created**: none new — this slice only changed the acceptance set of two already-existing pure checks (`knownGoalIds` construction inside `validateV3AiProposalV31`, and the ambiguous-item `primary_request` literal check) plus one already-existing pure schema builder's enum (`primaryRequestGoalIdsV31`, derived from the existing `primaryRequestGoalIds` and `ITEM_MUTATION_FIELDS_V31`).

### Work Unit Evidence

| Evidence | Value |
|---|---|
| Focused test command and exact result | `npx vitest run tests/fixtures/workflow-nodes/shared/v3-contract-runtime.test.js tests/unit/v3-runtime-compatibility.test.js tests/unit/v3-address-hardbound.test.js tests/unit/v3-commercial-policy.test.js tests/unit/v3-policy-builder-v31-items.test.js tests/unit/v3-policy-builder-line-items-regression.test.js tests/unit/v3-artifact-version-widening.test.js tests/unit/v3-v31-composition-differential.test.js tests/unit/v3-v31-address-and-pickup-regression.test.js tests/unit/v3-v31-static-error-code-coverage.test.js tests/unit/v3-v31-authorizer-composition-differential.test.js tests/unit/build-ai-request-v31-schema.test.js tests/unit/build-ai-request-v31-prompt.test.js tests/unit/build-ai-request-wrapper.test.js tests/unit/v3-brand-voice.test.js tests/unit/compile-v3-turn.test.js tests/unit/mock-ai-valid-proposal.test.js tests/unit/shadow-evaluator-persistence.test.js tests/unit/v3-line-items-live-evidence.test.js tests/unit/v3-v31-contract-consistency.test.js tests/unit/build-v3-lead-effect.test.js tests/unit/v3-effect-execution-wrapper.test.js tests/unit/build-clickup-payload.test.js tests/unit/crm-seller-notification-dispatch.test.js tests/unit/v3-line-items-live-replay.test.js --globals` → **247/247 passed** (25 files) |
| Runtime harness command/scenario and exact result | `docker compose -f docker-compose.test.yml up -d --wait postgres && npm run db:reset:test && npm run test:integration:postgres` (`TEST_PG_INTEGRATION=1`) then `docker compose -f docker-compose.test.yml down -v` → **17 files, 154/154 passed** (no `.sql` file changed this slice; migration 025 still applies cleanly; run as the full regression check 3c.5 requires) |
| Rollback boundary | Revert the contract-alignment commit on `feat/multi-product-quotes-alignment` (production edits + `v3-line-items-live-evidence.test.js` + the captured fixture land together — the fix and its test cannot be usefully separated, since the test is what proves the fix) and, independently, the contract-consistency test commit. `AI_PRD_V3_LINE_ITEMS` was not touched and stays `disabled` everywhere; nothing in production passes `version:'v3.1'`, so this slice has zero live-traffic exposure — it only changes which proposals the v3.1 validator/schema agree on, and v3.1 does not run. |

### Full Suite Verification (exact counts, final state)

- `npm test` (unit + contract + smoke + ops, Postgres suites skipped): **73 files passed, 17 skipped; 932 tests passed, 154 skipped**.
- `npm run check:parity`: exit 0, 0 drift, all nodes `[OK]` after `node tests/scripts/sync-workflow-nodes.mjs` (regenerated the 5 nodes that concatenate `v3-contract-runtime.js`/`build-ai-request.js`: `Build AI Request`, `Compile V3 Turn Policy`, `Validate And Authorize V3`, `Prepare Shadow Evaluation`, `Record Shadow Evaluation`).
- `npm run check:sql-references`: exit 0, 0 errors, 0 warnings (no `.sql` file touched this slice).
- `docker compose -f docker-compose.test.yml up -d --wait postgres && npm run db:reset:test && npm run test:integration:postgres` (`TEST_PG_INTEGRATION=1`) then `down -v`: **17 files passed, 154/154 tests passed**, migration 025 applies cleanly (unchanged since Slice 1).

### Regression Safety Net

- Every v3.1 test file that existed before this slice (`v3-contract-runtime.test.js`, `v3-runtime-compatibility.test.js`, `v3-v31-composition-differential.test.js`, `v3-v31-address-and-pickup-regression.test.js`, `v3-v31-static-error-code-coverage.test.js`, `v3-v31-authorizer-composition-differential.test.js`, `build-ai-request-v31-schema.test.js`, `build-ai-request-v31-prompt.test.js`, `compile-v3-turn.test.js`) was grepped for any assertion that depended on the OLD, narrower acceptance sets before widening them — none did (confirmed: the one existing test using an item-concept `resolves_goal_ids` literal, `v3-contract-runtime.test.js:465`, exercises the **v3** validator, not v3.1, and is unaffected; the existing v3.1 live-scenario test already used `resolves_goal_ids: []` and `primary_request.goal_id:'product'`, both still accepted). All ran green both before and after this slice's edits.
- Full 932-test unit suite and 154-test Postgres suite re-run clean at the end of the slice; `check:parity`/`check:sql-references` clean.

### Deviations from Design

1. **`catalog_resolution_clarification_required` accepts `'line_items'` as an alias for `'product'`** when `primary_request.item_ref` matches the ambiguous item — design.md's literal is `'product'` only. See "Decisions recorded" above for the full reasoning; the alternative (rejecting `first-turn[3]`, which is otherwise the single cleanest, most-correct captured first-turn proposal, as "genuinely wrong") did not survive scrutiny once it became clear the schema itself made `'product'` unreachable until this slice's own fix.
2. **`primaryRequestGoalIdsV31` widening is skipped during an active repair turn** (`hasRepairRequest`) — not discussed explicitly in design.md, but necessary: the repair path's own `allowed_values` lock is a safety mechanism (design's `failure_policy.max_repairs`/contingency guard), and unconditionally widening it would let a repaired turn re-request a goal the repair error just rejected. No captured entry exercises a v3.1 repair turn, so this path is unexercised by 3c.1's evidence and is a forward-looking safety preservation, not something this slice's tests can directly RED/GREEN — flagged here for the live A/B rerun (3c.6) and Slice 4 to watch.
3. **`wire-correction[4]`'s `primary_request.goal_id:'name'` needed no fix** — see "Decisions recorded" above. Documented rather than silently treated as already-passing, since the orchestrator's guidance specifically named this pattern.

### Issues Found

None beyond the two contract-shape bugs this slice fixes. `AI_PRD_V3_LINE_ITEMS` was not touched and stays `disabled`; nothing in production passes `version:'v3.1'`; the v3 validator, v3 schema and v3 prompt are untouched (confirmed by `v3-runtime-compatibility.test.js`, `build-ai-request-wrapper.test.js` and `v3-brand-voice.test.js` all passing unmodified); `.env` and the live n8n runtime were never touched; no Docker exec against production containers or OpenAI network calls were made.

### Workload / PR Boundary

- Mode: chained PR slice (`feature-branch-chain`), PR3c = Slice 3c Contract Alignment, base = `feat/multi-product-quotes-output`.
- Current work unit: Slice 3c — v3.1 contract alignment from live evidence, complete for tasks 3c.1–3c.5. Task 3c.6 (live A/B rerun) is the orchestrator's next step, not part of this apply batch.
- Boundary: 2 commits on `feat/multi-product-quotes-alignment`:
  1. `fix(v3): align v3.1 goal ids and item primary_request literals across policy, validator and schema` — production fixes in `v3-contract-runtime.js` (+14/−2) and `build-ai-request.js` (+11/−1) = **26 authored changed lines**, plus the live-evidence test `v3-line-items-live-evidence.test.js` (117 new lines) that proves the fix against the real captured model output, plus the captured-evidence fixture `tests/fixtures/v3-line-items/captured-live-proposals.json` (real model output, not hand-authored — treated as evidence data, like a golden capture, not authored risk) and 3 regenerated workflow JSON files (10 generated lines, `node tests/scripts/sync-workflow-nodes.mjs`) = **143 authored changed lines** (excluding the evidence JSON and generated workflow JSON).
  2. `test(v3): add a v3.1 contract-consistency test for goal ids and mutation shapes` — `v3-v31-contract-consistency.test.js` (173 new lines), plus the `tasks.md` checkbox marks (5 lines) and this `apply-progress.md` section = **178 authored changed lines** (excluding `apply-progress.md`'s own documentation length).
- **Review budget: within forecast.** Total authored risk ≈ 26 (production) + 117 + 173 (tests) + 5 (`tasks.md`) = **321 authored changed lines**, comfortably under the 800-line cap — no `size:exception` needed. The 11,857-line captured-evidence JSON and the 10 generated workflow-JSON lines are excluded from authored risk per the review-workload guard's golden/generated-artifact carve-out, but remain part of the complete snapshot for review/receipt purposes.

---

## Slice 3c follow-up — item attribution (live A/B round 2)

**Scope**: tasks 3c.7–3c.9 only. Same branch (`feat/multi-product-quotes-alignment`), same base (`feat/multi-product-quotes-output`). Task 3c.10 (the second live A/B rerun, N=10, production catalog) is explicitly out of scope for this batch — the orchestrator runs it.

### Why this follow-up exists

The live A/B after 3c.1–3c.5 (N=10, production catalog) closed the validity gap: v3.1 first-turn validity reached 20/20, equal to v3 (total 36/40 against v3's 30/40). Two attribution defects remained, observed live on real model output (not captured in a fixture — described by the orchestrator from the run's own results, since round 2 had no saved `captured-live-proposals.json`-style dump):

1. **First turn, 3 of 20**: the pandereta's evidenced quantity ("500 ml") was copied onto the wire item (both items ended up with 500 ml, citing the same evidence span), moved onto the wire (wire got 500 ml, pandereta kept only its height), or the pandereta was split into two items (one holding the quantity, another holding the height).
2. **Wire correction, 1 of 6 valid**: "Corrección: el alambre de púas son 300 ml, no 500 ml" put 300 ml on the pandereta instead of the wire — the canary gate ("every valid correction scoped to the named item") failed.

### Decision: which shape is deterministically detectable

Both defects share one root cause (spec's Item-Scoped Line Items requirement: "a quantity or measurement fact MUST attach only to the item its evidence names"), but they split into two shapes with very different detectability at the validator layer:

- **Copied** (the same evidenced text resolves the same item concept on two items): deterministically detectable. The same `(field, evidence_quote, evidence_occurrence)` triple can never legitimately authorize two different `item_ref` values in one proposal — there is exactly one span, and it cannot mean two contradictory things at once. Task 3c.7 implements this as a new validator rule.
- **Moved** (a single, non-duplicated span attached to the wrong item): **not** deterministically detectable. There is only one span and one item_ref; nothing in the proposal's shape distinguishes "the model chose correctly" from "the model chose incorrectly" — the validator has no ground truth for which item is "right". This is true for both the first-turn quantity-moved-to-wire case and the wire-correction-moved-to-fence case. Confirmed empirically: `tests/unit/v3-v31-item-evidence-span-conflict.test.js` reproduces both "moved" shapes on real captured turn policies and shows the validator (correctly) still accepts them with zero errors. This is why the task explicitly routes this shape to a v3.1-only prompt fix (3c.8), not the validator.

**Split-item signal — considered, not implemented, and why.** The task asked me to consider whether a "two new items created with no product and no `requested_label`" or "the same `requested_label` evidence on two items" signal is deterministically detectable. Neither is implementable at the validator layer:
- `requested_label` does not exist anywhere in the v3.1 proposal contract (`OBSERVATION_KEYS_V31`, `CATALOG_RESOLUTION_KEYS_V31`, `MUTATION_KEYS_V31` all omit it) or in the response schema (`build-ai-request.js`'s v3.1 schema variants). It is a storage-only field the reducer (`v3-line-items.js`) always sets to `null` today — nothing in production ever populates it. There is no evidence signal to check against at validation time.
- "Two new items with no product and no `requested_label`" is not unambiguous: a customer can legitimately mention two genuinely separate, both-unclear products in one message (e.g., two different ambiguous catalog names), which would create exactly this shape without being a split at all. Flagging it would reject correct multi-item turns, violating the per-item carve-out (D5) the rest of this contract protects.
- Generalizing 3c.7's own rule to `catalog_resolutions` (treating catalog resolution as an implicit `product` concept, and flagging two catalog_resolutions entries that share the same `evidence_quote`/`evidence_occurrence` but different `item_ref`) was considered as a closer analogue, but the actual observed split shape (quantity on one new item, height/measurements on another) does not necessarily produce two catalog_resolutions with identical evidence — each new item's catalog_resolution independently cites its own textual mention, and there is no guarantee both share the same span. Implementing it would add a narrow rule with an unverified detection rate against a real defect shape, so it is left to the prompt (3c.8's "one mentioned product is one item, never split into two") rather than added as a second speculative validator rule.

### TDD Cycle Evidence

| Task | Test File | Layer | Safety Net | RED | GREEN | TRIANGULATE | REFACTOR |
|------|-----------|-------|------------|-----|-------|-------------|----------|
| 3c.7 (synthetic) | `tests/fixtures/workflow-nodes/shared/v3-contract-runtime.test.js` (`item_evidence_span_conflict` describe block) | Unit | ✅ 17/17 pre-existing tests in this file green before the edit | ✅ Written first | ✅ Confirmed RED: 2/4 new cases failed against the pre-fix validator (see RED evidence below) | ✅ 4 cases: same-span-two-items (reject), same-text-different-occurrence (no false positive), same-text-different-concept (no false positive), duplicated `product` span across two new matched items (reject) | ➖ None needed |
| 3c.7 (captured-evidence) | `tests/unit/v3-v31-item-evidence-span-conflict.test.js` | Unit | ✅ (see above; this file is new) | ✅ Written first, against real captured turn policies from `captured-live-proposals.json` | ✅ Confirmed RED then GREEN (see RED evidence below): 6/6 pass after the fix | ✅ 6 cases: 2 sanity (unmodified captured proposal still valid), 2 "copied" (rejected), 2 "moved" (documented gap, stays valid — proves the boundary the decision above explains) | ➖ None needed — pure test file |
| 3c.8 | `tests/unit/build-ai-request-v31-prompt.test.js` | Unit | ✅ 7/7 pre-existing tests in this file green before the edit | ✅ Written first | ✅ Confirmed RED: 2/2 new cases failed against the pre-fix prompt (see RED evidence below) | ✅ 2 cases: no-copy/no-move/no-split rule text present in v3.1 only; correction-named-item rule text present in v3.1 only | ➖ None needed |
| 3c.9 | full existing suites (no new file) | Unit | ✅ | N/A (confirmatory) | ✅ 944/944 unit (154 skipped without `TEST_PG_INTEGRATION=1`), `check:parity` 0 drift after regenerating, `check:sql-references` 0 errors, 0 regressions | N/A | N/A |

### RED evidence

**3c.7 (synthetic, `v3-contract-runtime.test.js`)**: `npx vitest run tests/fixtures/workflow-nodes/shared/v3-contract-runtime.test.js` against the pre-fix `v3-contract-runtime.js` (production edit stashed) — **2 of 4 new cases failed** (`rejects the same evidence span resolving quantity on two different items` and `also rejects a duplicated product evidence span across two new, matched items`, both `expected true to be false`); the 2 negative-control cases already passed (there was nothing to false-positive on before the rule existed). After the fix: 19/19 in the file.

**3c.7 (captured-evidence, new file)**: same stash procedure, `npx vitest run tests/unit/v3-v31-item-evidence-span-conflict.test.js tests/fixtures/workflow-nodes/shared/v3-contract-runtime.test.js` — **4 of 25 failed** (the 2 "copied" cases in each file); the 2 sanity cases and the 2 documented-gap "moved" cases already passed. `git stash pop` restored the fix; the same command then passed **25/25**.

**3c.8 (`build-ai-request-v31-prompt.test.js`)**: ran the file against the pre-fix `build-ai-request.js` (before adding the two new rule constants) — **2 of 9 failed** (`v3.1 adds a rule against copying or moving a quantity/measurement between items, and against splitting one product into two items` and `v3.1 adds a rule that a correction naming an item's product or label applies only to that item`, both `expected [] to contain '...'`). After adding `V31_NO_CROSS_ITEM_TRANSFER_RULE` and `V31_CORRECTION_NAMED_ITEM_RULE`: 9/9.

### Test Summary

- **Total tests written this follow-up**: 4 (synthetic `item_evidence_span_conflict` cases) + 6 (`v3-v31-item-evidence-span-conflict.test.js`) + 2 (prompt rule cases) = **12 new tests**.
- **Total tests passing**: 12/12 new, 0 regressions across 932 pre-existing unit tests (`npm test`: 944/944 non-skipped after this follow-up).
- **Layers used**: Unit (12). No SQL/DB behavior changed (no `.sql` file touched, no error-code enumeration exists in SQL); the "must-stay-green" Postgres suite was intentionally not re-run this batch since neither task touches SQL/DB behavior (per the orchestrator's explicit scoping) — it was last verified green at the end of Slice 3c (3c.1–3c.5) and nothing in this follow-up changes what it exercises.
- **Approval tests**: none — every new assertion calls the real, unmocked `validateV3AiProposal` (via `v3-contract-runtime.js`) or the real `build-ai-request.js` code-node source through the same `new Function('items','$env',source)` harness prior slices use; none change an existing assertion's expected value.
- **Pure functions changed**: `validateV3AiProposalV31` gains one new deterministic check (no new exported function — an inline guard inside the existing mutation-processing loop, keyed by `${field}\u0000${evidence_quote}\u0000${evidence_occurrence}`); `build-ai-request.js`'s `buildV31PromptLines` gains two new appended constants, no existing line touched.

### Work Unit Evidence

| Evidence | Value |
|---|---|
| Focused test command and exact result | `npx vitest run tests/fixtures/workflow-nodes/shared/v3-contract-runtime.test.js tests/unit/v3-v31-item-evidence-span-conflict.test.js tests/unit/build-ai-request-v31-prompt.test.js tests/unit/v3-v31-static-error-code-coverage.test.js tests/unit/v3-v31-composition-differential.test.js tests/unit/v3-v31-authorizer-composition-differential.test.js tests/unit/v3-v31-address-and-pickup-regression.test.js tests/unit/v3-runtime-compatibility.test.js tests/unit/v3-address-hardbound.test.js tests/unit/v3-commercial-policy.test.js tests/unit/v3-line-items-live-evidence.test.js tests/unit/v3-v31-contract-consistency.test.js tests/unit/build-ai-request-v31-schema.test.js tests/unit/build-ai-request-wrapper.test.js tests/unit/v3-brand-voice.test.js tests/unit/compile-v3-turn.test.js tests/unit/build-v3-lead-effect.test.js tests/unit/v3-effect-execution-wrapper.test.js tests/unit/build-clickup-payload.test.js tests/unit/crm-seller-notification-dispatch.test.js tests/unit/mock-ai-valid-proposal.test.js tests/unit/shadow-evaluator-persistence.test.js tests/unit/v3-line-items-live-replay.test.js --globals` → **310/310 passed** (22 files) |
| Runtime harness command/scenario and exact result | N/A — no SQL/DB behavior changed this batch (per the orchestrator's explicit scoping: "Postgres integration only if SQL/DB behavior changes"); the Postgres suite (17 files / 154 tests) was last verified green at the end of Slice 3c (3c.1–3c.5) and this follow-up touches neither `.sql` files nor the reducer's SQL twin |
| Rollback boundary | Revert the two functional commits on `feat/multi-product-quotes-alignment` (validator guard + its tests; prompt rules + their tests) independently — each is self-contained with its own tests and touches a disjoint file set. `AI_PRD_V3_LINE_ITEMS` was not touched and stays `disabled` everywhere; nothing in production passes `version:'v3.1'`; this follow-up only tightens which proposals the (still-dark) v3.1 validator/prompt accept, with zero live-traffic exposure. |

### Full Suite Verification (exact counts, final state)

- `npm test` (unit + contract + smoke + ops, Postgres suites skipped): **74 files passed, 17 skipped; 944 tests passed, 154 skipped**.
- `npm run check:parity`: initial run showed `[DRIFT]` on `Compile V3 Turn Policy`, `Validate And Authorize V3` (both concatenate `v3-contract-runtime.js`), `Prepare Shadow Evaluation`, `Record Shadow Evaluation` (same reason), and `Build AI Request` implicitly via its own fixture — regenerated via `node tests/scripts/sync-workflow-nodes.mjs` (5 nodes patched, backups written to the gitignored `n8n/workflows/backup/`); re-run: exit 0, 0 drift, all nodes `[OK]`.
- `npm run check:sql-references`: exit 0, 0 errors, 0 warnings (no `.sql` file touched this follow-up).

### Deviations from Design

1. **Split-item detection left to the prompt, not the validator** — see "Decision: which shape is deterministically detectable" above. This is an explicit, considered deviation from implementing every suggested signal in the task, not an oversight: both suggested signals (`requested_label`-based, and "two new items with no product") are either non-existent at the validation layer or too broad to implement without false-positiving on legitimate multi-item turns.
2. **The "moved" shape (single span, wrong item) is a documented, unclosed gap at the validator layer** for both first-turn and correction scenarios — by design, since no shape signal exists to close it deterministically. `tests/unit/v3-v31-item-evidence-span-conflict.test.js` pins this boundary explicitly (asserting the mutated proposal still validates) so a future change that silently makes this detectable is visible as a passing-test surprise, not a silent regression.

### Issues Found

None beyond the two attribution defects this follow-up addresses (one closed at the validator, one addressed only at the prompt with the closure documented as out of this batch's reach). `AI_PRD_V3_LINE_ITEMS` was not touched and stays `disabled`; nothing in production passes `version:'v3.1'`; the v3 validator and v3 prompt stay byte-identical (confirmed by `v3-runtime-compatibility.test.js`, `v3-v31-composition-differential.test.js`, and the prompt-diff test's "the v3 prompt is exactly what it was before the refactor" / "exactly one v3 line is removed" assertions, all passing unmodified in shape); `.env` and the live n8n runtime were never touched; no Docker exec against production containers or OpenAI network calls were made.

### Workload / PR Boundary

- Mode: chained PR slice (`feature-branch-chain`), same PR3c = Slice 3c Contract Alignment, base = `feat/multi-product-quotes-output`. This follow-up lands as additional commits on the same branch/PR, not a new slice.
- Current work unit: Slice 3c follow-up — item attribution, complete for tasks 3c.7–3c.9. Task 3c.10 (the second live A/B rerun) is the orchestrator's next step, not part of this apply batch. Slice 4 remains not started.
- Boundary: 3 commits on `feat/multi-product-quotes-alignment` (on top of the existing 2 Slice 3c commits):
  1. `fix(v3): reject a proposal that resolves the same item concept from two items' shared evidence span` — production fix in `v3-contract-runtime.js` (+24/−0), plus its synthetic tests in `v3-contract-runtime.test.js` (+130/−0) and the new captured-evidence test file `v3-v31-item-evidence-span-conflict.test.js` (142 new lines), plus 2 regenerated workflow JSON files (`wa-conversation-orchestrator.json` +2/−2, `ai-prd-shadow-evaluator.json` +2/−2 = 4 generated lines) = **296 authored changed lines** (excluding the 4 generated workflow-JSON lines).
  2. `feat(v3): add v3.1-only prompt rules against cross-item quantity/measurement transfer and item-scoped corrections` — production addition in `build-ai-request.js` (+13/−0), plus its tests in `build-ai-request-v31-prompt.test.js` (+25/−0), plus 1 regenerated workflow JSON file (`ai-lead-qualification-assistant.json` +1/−1 = 2 generated lines) = **38 authored changed lines** (excluding the 2 generated workflow-JSON lines).
  3. `docs(sdd): record the Slice 3c follow-up apply progress` — `tasks.md` checkbox marks (3 lines) and this `apply-progress.md` section.
- **Review budget: within forecast.** Total authored risk ≈ 296 + 38 = **334 authored changed lines**, comfortably under the 800-line cap — no `size:exception` needed. The 6 generated workflow-JSON lines are excluded from authored risk per the review-workload guard's generated-artifact carve-out, but remain part of the complete snapshot for review/receipt purposes.

---

## Slice 3c follow-up — item attribution (live A/B round 2)

**Scope**: tasks 3c.7–3c.9 only. Same branch (`feat/multi-product-quotes-alignment`), same base (`feat/multi-product-quotes-output`). Tasks 3c.10 (the orchestrator's live A/B rerun) and Slice 4 are explicitly out of scope for this batch.

### Why this batch exists

The live A/B rerun after 3c.1–3c.5 (N=10, production catalog) reached first-turn validity 20/20 (equal to v3; total 36/40 against v3's 30/40), but found two remaining item-attribution defects:
- First turn, 3 of 20: the pandereta's quantity "500 ml" was copied onto the wire item (both items carried 500 ml, with the same evidence span), or moved onto the wire (wire 500 ml, pandereta only height), or the pandereta was split into two items.
- Wire correction, 1 of 6 valid corrections put 300 ml on the pandereta instead of the wire. The canary gate ("every valid correction is scoped to the named item") failed.

### Decisions recorded

1. **The observed failures split into two shapes with different fixes.** "Copied" (the same evidenced text resolves the same item concept on two different items) is deterministically detectable: the same `(field, evidence_quote, evidence_occurrence)` triple can never legitimately authorize two different `item_ref` values in one proposal — no legitimate customer message repeats itself to mean two different items without a different occurrence number. "Moved" (one unambiguous, non-duplicated span attached to the wrong item) has no such signal: the validator has no ground truth for "the right item" when there is exactly one span and exactly one target. Task 3c.7 fixes the first shape in the validator; task 3c.8 addresses the second (and the "split into two items" pattern) in the v3.1-only prompt, per the orchestrator's own framing of the two tasks.
2. **Split-item detection was considered and NOT implemented as a separate deterministic validator rule.** The task's own suggested signals were checked directly against the real contract surface and found unusable:
   - *"two new items created with no product and no `requested_label`"*: this is not a reliable split signal — a customer can legitimately open a turn with two separate, still-unresolved new items (two genuinely different unclear products), which must not be rejected. There is no way to distinguish "two legitimately separate ambiguous items" from "one item wrongly split in two" from this shape alone.
   - *"the same `requested_label` evidence on two items"*: `requested_label` is not part of the v3.1 proposal contract at all — it is a system-derived storage field on `line_items` (design.md D4/D10), absent from `OBSERVATION_KEYS_V31`, `CATALOG_RESOLUTION_KEYS_V31` and every other proposal-shape key set the validator checks. Grepping the reducer (`tests/fixtures/workflow-nodes/shared/v3-line-items.js`) confirms it is always set to `null` today (`newItem`, `readLineItems`'s flat-row branch) and never derived from anything — there is no `requested_label` value at validation time to compare across items.
   - The one signal that *is* both unambiguous and already covered by the contract surface — two `catalog_resolutions` entries sharing the identical `evidence_quote`/`evidence_occurrence` but different `item_ref` — is exactly the same mechanism task 3c.7 already implements (the evidence-span-conflict key is keyed by field, and `product` is an `ITEM_FIELD`; a genuine "same catalog mention split across two items" case that also emits a duplicated `product` observation for both new items is already caught, see the fourth synthetic test below). A weaker, catalog-resolution-only version of the rule (matching span, no product observation on either side) was rejected: nothing requires the model to emit a `catalog_resolutions` entry with matching text for a genuine split (the observed live shape was one item getting quantity, the other getting measurements, with no guarantee their `catalog_resolutions` entries — if any — share the same span), so a rule keyed only on `catalog_resolutions` would not reliably catch the real shape and risks false positives on legitimately separate multi-product turns. This is why 3c.8 also adds an explicit prompt rule ("one mentioned product is one item, never split into two") — the general fix belongs in the model's own instructions, not a shape heuristic that cannot see the customer's intent.
3. **The new validator code is v3.1-only and needs no static-coverage-allowlist entry.** `tests/unit/v3-v31-static-error-code-coverage.test.js` asserts V3 codes ⊆ V31 codes ∪ the closed D5 allowlist; it says nothing about codes that exist only in V3.1. `item_evidence_span_conflict` is never emitted by `validateV3AiProposalV3`, so the coverage test needed no change — confirmed green with no edits (see Full Suite Verification below).
4. **The new validator error is repairable by construction, not by a special case.** Every error built via the shared `validationError(...)` helper carries `disposition: 'repairable'` unconditionally (same as every other v3/v3.1 code); `item_evidence_span_conflict` uses that same helper, so it automatically routes through the existing one-shot repair path rather than straight to contingency — no new dispatch logic was needed or added.

### TDD Cycle Evidence

| Task | Test File | Layer | Safety Net | RED | GREEN | TRIANGULATE | REFACTOR |
|------|-----------|-------|------------|-----|-------|-------------|----------|
| 3c.7 (validator rule, synthetic cases) | `tests/fixtures/workflow-nodes/shared/v3-contract-runtime.test.js` (new `item_evidence_span_conflict` describe block) | Unit | ✅ 17/17 pre-existing cases in this file green before the edit | ✅ Written first; confirmed RED via `git stash` (see RED evidence below) | ✅ 4/4 new cases pass after the fix | ✅ 4 cases: same span + same field + 2 items rejects; same text at a different occurrence does not; same span but different fields (quantity vs measurements) does not; the same rule also catches a duplicated `product` evidence span across two new matched items | ➖ None needed |
| 3c.7 (validator rule, live-evidence cases) | `tests/unit/v3-v31-item-evidence-span-conflict.test.js` (new file) | Unit | ✅ 15/15 `v3-line-items-live-evidence.test.js` cases green before this file existed | ✅ Written first against REAL captured `turn_policy`/`proposal` pairs (`captured-live-proposals.json`, first-turn[3] and wire-correction[0]), never hand-authored policies; confirmed RED via `git stash` | ✅ 6/6 passed after the fix | ✅ 6 cases: 2 sanity (unmodified captured proposals still validate), 2 "copied" (rejected), 2 "moved" (documented gap — still validates, proving the boundary of what 3c.7 can and cannot catch) | ➖ None needed — pure test file |
| 3c.8 (prompt rules) | `tests/unit/build-ai-request-v31-prompt.test.js` (2 new tests) | Unit | ✅ 7/7 pre-existing cases in this file green before the edit | ✅ Written first, confirmed RED (2/9 failed, exact text not yet present) | ✅ 9/9 passed after adding the two new prompt-line constants | ➖ Single scenario per rule (a prompt-line presence/absence check has one meaningful case: present in v3.1, absent from v3) | ➖ None needed |
| 3c.9 (regression confirmation) | full existing suites, no new file | Unit | ✅ | N/A (confirmatory) | ✅ 944/944 non-skipped unit tests, 0 regressions, `check:parity`/`check:sql-references` clean (see Full Suite Verification) | N/A | N/A |

### RED evidence (3c.7 — both new test files, against the pre-fix `v3-contract-runtime.js`)

Command: `git stash push -- tests/fixtures/workflow-nodes/shared/v3-contract-runtime.js && npx vitest run tests/unit/v3-v31-item-evidence-span-conflict.test.js tests/fixtures/workflow-nodes/shared/v3-contract-runtime.test.js --globals`

Result: **4 of 25 failed**, exactly the 2 "copied" cases in each file (the synthetic duplicate-quantity/duplicate-product cases, and the captured-evidence duplicate-quantity cases for both first-turn and wire-correction) — every other case (the 2 negative-control synthetic cases, the 2 sanity cases, and the 2 documented-gap "moved" cases) already passed before the fix, which is expected since they assert the absence of the new code. `git stash pop` restored the fix; the same command then passed **25/25**.

### RED evidence (3c.8 — `build-ai-request-v31-prompt.test.js`, against the pre-fix `build-ai-request.js`)

The two new tests were written first and run against the file before adding the two new prompt-line constants: **2 of 9 failed** (`expect(v31Prompt).toContain(...)` on text that did not exist yet). After adding `V31_NO_CROSS_ITEM_TRANSFER_RULE` and `V31_CORRECTION_NAMED_ITEM_RULE` to `buildV31PromptLines`'s `derived.push(...)` call: **9/9 passed**, including the pre-existing "exactly one v3 line is removed" test, confirming the v3 prompt stayed byte-identical and every other v3 line still reaches v3.1 verbatim (pure append, no v3 line touched).

### Test Summary

- **Total tests written this batch**: 4 (`v3-contract-runtime.test.js`, new describe block) + 6 (`v3-v31-item-evidence-span-conflict.test.js`, new file) + 2 (`build-ai-request-v31-prompt.test.js`) = **12 new tests**.
- **Total tests passing**: 12/12 new, 0 regressions across 932 pre-existing unit tests (`npm test`: 944/944 non-skipped after this batch).
- **Layers used**: Unit (12). No `.sql` file touched this batch — the Postgres suite was not re-run (no SQL/DB behavior changed; per the phase's own instruction, Postgres integration is only required when SQL/DB behavior changes).
- **Approval tests**: none — every new assertion calls the real, unmocked `validateV3AiProposal`/`validateV3AiProposalV31` and the real `build-ai-request.js` prompt-building code via the same `new Function('items', '$env', source)` harness prior slices already use.
- **Pure functions/constants created**: no new exported functions — `item_evidence_span_conflict` is one new branch inside the existing `validateV3AiProposalV31` mutation loop (keyed by a `Map<string, string>` local to that function call, so it is scoped per validation and side-effect-free across calls); `V31_NO_CROSS_ITEM_TRANSFER_RULE` and `V31_CORRECTION_NAMED_ITEM_RULE` are two new string constants appended (pure data) to the existing `buildV31PromptLines` derivation.

### Work Unit Evidence

| Evidence | Value |
|---|---|
| Focused test command and exact result | `npx vitest run tests/fixtures/workflow-nodes/shared/v3-contract-runtime.test.js tests/unit/v3-v31-item-evidence-span-conflict.test.js tests/unit/build-ai-request-v31-prompt.test.js tests/unit/build-ai-request-v31-schema.test.js tests/unit/build-ai-request-wrapper.test.js tests/unit/v3-brand-voice.test.js tests/unit/compile-v3-turn.test.js tests/unit/v3-v31-static-error-code-coverage.test.js tests/unit/v3-v31-composition-differential.test.js tests/unit/v3-v31-authorizer-composition-differential.test.js tests/unit/v3-v31-address-and-pickup-regression.test.js tests/unit/v3-runtime-compatibility.test.js tests/unit/v3-address-hardbound.test.js tests/unit/v3-commercial-policy.test.js tests/unit/v3-line-items-live-evidence.test.js tests/unit/v3-v31-contract-consistency.test.js tests/unit/build-v3-lead-effect.test.js tests/unit/v3-effect-execution-wrapper.test.js tests/unit/build-clickup-payload.test.js tests/unit/crm-seller-notification-dispatch.test.js tests/unit/mock-ai-valid-proposal.test.js tests/unit/shadow-evaluator-persistence.test.js tests/unit/v3-line-items-live-replay.test.js --globals` → **363/363 passed** (23 files, includes every D11 guarantee suite plus every named "must stay green" suite) |
| Runtime harness command/scenario and exact result | N/A — no SQL/DB behavior changed this batch (only the JS validator and the JS prompt builder), so the Postgres integration harness was not re-run, per the phase instruction limiting it to SQL/DB changes. The n8n Code-node runtime boundary is exercised indirectly by `npm run check:parity` (regenerates and diffs the 5 nodes embedding `v3-contract-runtime.js`/`build-ai-request.js`; clean after `node tests/scripts/sync-workflow-nodes.mjs`) |
| Rollback boundary | Revert the two functional commits on `feat/multi-product-quotes-alignment` (validator guard + its tests; prompt rules + prompt tests) independently — each is self-contained with its own tests and neither depends on the other. `AI_PRD_V3_LINE_ITEMS` was not touched and stays `disabled` everywhere; nothing in production passes `version:'v3.1'`, so this batch has zero live-traffic exposure. |

### Full Suite Verification (exact counts)

- `npm test` (unit + contract + smoke + ops, Postgres suites skipped): **74 files passed, 17 skipped; 944 tests passed, 154 skipped**.
- `npm run check:parity`: exit 0, 0 drift, all nodes `[OK]` after `node tests/scripts/sync-workflow-nodes.mjs` regenerated the 3 workflow files embedding the two edited fixtures (`wa-conversation-orchestrator.json`: Validate And Authorize V3; `ai-prd-shadow-evaluator.json`: Prepare Shadow Evaluation + Record Shadow Evaluation; `ai-lead-qualification-assistant.json`: Build AI Request).
- `npm run check:sql-references`: exit 0, 0 errors, 0 warnings (no `.sql` file touched this batch).
- Postgres integration: not re-run (no SQL/DB behavior changed; migration 025 and its down file are unaffected).

### Regression Safety Net

- Every D11 guarantee suite (`v3-v31-static-error-code-coverage.test.js`, `v3-v31-composition-differential.test.js`, `v3-v31-authorizer-composition-differential.test.js`, `v3-v31-address-and-pickup-regression.test.js`, `v3-runtime-compatibility.test.js`, `v3-address-hardbound.test.js`, `v3-commercial-policy.test.js`) re-run green with no edits, confirming the new mutation-loop branch changes no existing v3 or v3.1 behavior for any case those suites cover.
- The prompt-diff guarantee (`build-ai-request-v31-prompt.test.js`'s "exactly one v3 line is removed... every other v3 line survives verbatim" test) re-run green, confirming the two new prompt lines are pure appends and the v3 prompt stayed byte-identical (also proven directly by the unchanged `GOLDEN_V3_PROMPT` approval test in the same file).
- `v3-line-items-live-evidence.test.js` and `v3-v31-contract-consistency.test.js` (the two Slice-3c guarantee files named in the phase instruction) both re-run green with no edits.

### Deviations from Design

1. **Split-item detection was not implemented as a separate deterministic validator rule.** See "Decisions recorded" #2 above for the full reasoning (the task's own suggested signals are either too broad — legitimate multi-item ambiguous turns would false-positive — or not present in the validator's input surface at all, since `requested_label` is never populated by any code path today). The general fix for the split-item and moved-item shapes is the v3.1-only prompt rule added in 3c.8, per the task's own framing ("implement only if it is unambiguous; otherwise leave it to the prompt").
2. **The new error code's `related_ids` carries only the conflicting (later) mutation's observation id**, matching the exact convention `mutation_target_duplicate` already uses for item-field mutations (`[observationEntry.id]`), not both observation ids. This keeps every error in the mutation loop shaped consistently for any downstream repair-instruction renderer that reads `related_ids`.

### Issues Found

None. All hard constraints held: `AI_PRD_V3_LINE_ITEMS` was not touched and stays `disabled`; nothing in production passes `version:'v3.1'`; the v3 validator and v3 prompt are untouched (confirmed by `v3-runtime-compatibility.test.js`, `v3-address-hardbound.test.js`, `v3-commercial-policy.test.js` and the prompt file's own "byte-identical" approval test all passing unmodified); `.env` and the live n8n runtime were never touched; no Docker exec against production containers or OpenAI network calls were made; `untitled.md` was left untouched.

### Workload / PR Boundary

- Mode: chained PR slice (`feature-branch-chain`), same PR3c = Slice 3c Contract Alignment, base = `feat/multi-product-quotes-output`.
- Current work unit: Slice 3c follow-up, complete for tasks 3c.7–3c.9. Task 3c.10 (the orchestrator's live A/B rerun) is the next step, not part of this apply batch. Slice 4 not started.
- Boundary: 3 commits added on `feat/multi-product-quotes-alignment` (on top of the 2 already-landed Slice 3c commits):
  1. `feat(v3): reject a duplicated evidence span across two line items` — production fix in `v3-contract-runtime.js` (+24/−0 = **24 authored changed lines**), plus its tests: `v3-contract-runtime.test.js` (+130/−0) and the new `v3-v31-item-evidence-span-conflict.test.js` (142 new lines) = **296 authored changed lines**, plus 2 regenerated workflow JSON files (6 generated lines, excluded from authored risk).
  2. `feat(v3): add v3.1 prompt rules against cross-item quantity/measurement transfer and item-mismatched corrections` — production fix in `build-ai-request.js` (+13/−0), plus its test `build-ai-request-v31-prompt.test.js` (+25/−0) = **38 authored changed lines**, plus 1 regenerated workflow JSON file (2 generated lines, excluded from authored risk).
  3. `docs(sdd): record Slice 3c follow-up apply progress` — `tasks.md` checkbox marks (12/1) and this `apply-progress.md` section.
- **Review budget: comfortably within forecast.** Total authored risk ≈ 24 + 130 + 142 (commit 1) + 13 + 25 (commit 2) = **334 authored changed lines** across the two functional commits, well under the 800-line cap — no `size:exception` needed. The 8 generated workflow-JSON lines are excluded from authored risk per the review-workload guard's golden/generated-artifact carve-out.
