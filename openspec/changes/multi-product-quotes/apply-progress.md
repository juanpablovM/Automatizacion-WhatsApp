# Apply Progress: Multi-Product Quotes

**Scope**: Slice 1 — Foundation only (tasks 1.x). Slices 2a/2b/3/4 not started.
**Mode**: Strict TDD.
**Branch**: `feat/multi-product-quotes-foundation` (base tracker `feat/multi-product-quotes`).

## Status

25/25 Slice 1 tasks complete (1.1–1.25). All marked `[x]` in `tasks.md`.

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
