# Apply Progress: Multi-Product Quotes

**Scope**: Slice 1 — Foundation (tasks 1.x), Slice 2a — Contract, dark (tasks 2a.x, including the D11 rework 2a.28–2a.32), Slice 2b — Advisor, dark (tasks 2b.1–2b.15), AND Slice 3 — Output (tasks 3.1–3.12). Slice 4 (rollout) not started — no code changes, no switch flipped.
**Mode**: Strict TDD.
**Branches**: `feat/multi-product-quotes-foundation` (Slice 1, base tracker `feat/multi-product-quotes`); `feat/multi-product-quotes-contract` (Slice 2a, base `feat/multi-product-quotes-foundation`); `feat/multi-product-quotes-advisor` (Slice 2b, base `feat/multi-product-quotes-contract`); `feat/multi-product-quotes-output` (Slice 3, base `feat/multi-product-quotes-advisor`).

## Status

- 25/25 Slice 1 tasks complete (1.1–1.25). All marked `[x]` in `tasks.md`.
- 27/27 Slice 2a tasks complete (2a.1–2a.27). All marked `[x]` in `tasks.md`.
- 5/5 Slice 2a rework tasks complete (2a.28–2a.32, design.md D11). All marked `[x]` in `tasks.md`. See "Slice 2a rework (D11)" section below.
- 15/15 Slice 2b tasks complete (2b.1–2b.15). All marked `[x]` in `tasks.md`. See "Slice 2b — Advisor, dark" section below.
- 12/12 Slice 3 tasks complete (3.1–3.12). All marked `[x]` in `tasks.md`. See "Slice 3 — Output" section below.

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
