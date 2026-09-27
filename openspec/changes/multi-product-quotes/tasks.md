# Tasks: Multi-Product Quotes

## Review Workload Forecast

| Field | Value |
|-------|-------|
| Estimated changed lines | ~690 + ~620 + ~420 + ~700 = ~2430 total, ≤800/slice |
| 400-line budget risk | High (3 of 4 slices exceed the skill's default 400; preflight review_budget_lines=800 covers each slice) |
| Chained PRs recommended | Yes |
| Suggested split | Tracker `feat/multi-product-quotes` → PR1 Foundation → PR2a Contract → PR2b Advisor → PR3 Output |
| Delivery strategy | auto-chain |
| Chain strategy | feature-branch-chain |

Decision needed before apply: No
Chained PRs recommended: Yes
Chain strategy: feature-branch-chain
400-line budget risk: High

Tracker branch `feat/multi-product-quotes` is cut from `feat/afinar-hormi-atencion` (current branch) and never merges to main until PR3 lands. Only the tracker PR merges to main. Each child PR base is the previous child's branch; if GitHub shows a prior slice's diff on a child PR, retarget/rebase before review.

### Suggested Work Units

| Unit | Goal | Likely PR | Focused test command | Runtime harness | Rollback boundary |
|------|------|-----------|----------------------|-----------------|-------------------|
| 1 Foundation | `line_items[]` reducer, dual-read, migration 025+down, builder read-through | PR1 (base: tracker) | `npm test` (v3-line-items cases) + `npm run check:parity` + `npm run check:sql-references` | `docker compose -f docker-compose.test.yml up -d --wait postgres && npm run db:reset:test && npm run test:integration:postgres` (SQL/JS parity, replay, down-migration) | Revert PR1; migration 025 is a superset, its down file (D8) restores 022, no data loss |
| 2a Contract | v3.1 validator/authorizer, withholding, version sets | PR2a (base: PR1 branch) | `npm test` (validator codes, live-scenario case) + `npm run check:parity` | Postgres integration compose (08/09/15/16 version-set acceptance) | Revert PR2a; `AI_PRD_V3_LINE_ITEMS` still `disabled`, v3.1 path unreachable at runtime |
| 2b Advisor | v3.1 schema/prompt, switch/canary, env passthrough | PR2b (base: PR2a branch) | `npm test` (schema pin, prompt-diff, switch/canary) | N/A — live-model harness ships in PR3; switch stays `disabled` so no live traffic exercises v3.1 | Revert PR2b; env vars default `disabled`, no runtime impact |
| 3 Output | Itemized lead effect, ClickUp fixture, A/B harness, E2E | PR3 (base: PR2b branch) | `npm test` (requirement composer, ClickUp payload) + `npm run check:parity` + `npm run check:sql-references` | `AI_REPLAY_LIVE=1 AI_REPLAY_RUNS=10 node tests/ops/v3-line-items-live-replay.mjs` (real-model A/B) | Revert PR3; single-item requirement/ClickUp output stays byte-identical, canary still opt-in |

Dependency diagram (📍 = current unit while executing):

```
main ── feat/afinar-hormi-atencion ── feat/multi-product-quotes (tracker, no-merge)
                                          └─ PR1 foundation 📍
                                               └─ PR2a contract
                                                    └─ PR2b advisor
                                                         └─ PR3 output → tracker → main
```

Every task below is RED (failing test) → GREEN (implementation) → REFACTOR when noted, per strict TDD. Run `node tests/scripts/sync-workflow-nodes.mjs` after any fixture edit, then `npm run check:parity && npm run check:sql-references` before opening/updating a PR.

## Slice 1 — Foundation (branch `feat/multi-product-quotes-foundation`, base `feat/multi-product-quotes`)

Proves: *Idempotent Item Replay and Legacy Compatibility* — "Replay and legacy reads stay correct"; regression baseline for all other requirements (v3 digests/leads byte-identical).

- [x] 1.1 RED `tests/fixtures/workflow-nodes/shared/v3-line-items.test.js`: `readLineItems` maps flat `qualification_context` to `[li_0]`
- [x] 1.2 GREEN implement `readLineItems` in `tests/fixtures/workflow-nodes/shared/v3-line-items.js`
- [x] 1.3 RED: `deriveItemId` = `li_` + `sha256("line_item/v1\0conv\0turn\0handle")[0:12]`; `li_0` for flat rows
- [x] 1.4 GREEN implement `deriveItemId`
- [x] 1.5 RED: `reduceV3StateMutations` upserts by `item_id` (no duplicate on replay), rejects flat mutations on `line_items*` keys, errors above 10 items
- [x] 1.6 GREEN implement `reduceV3StateMutations`
- [x] 1.7 RED: `projectFlat` mirrors first item in array order, deletes flat fields when no items remain
- [x] 1.8 GREEN implement `projectFlat`
- [x] 1.9 RED: `composeRequirement` single-item output is byte-identical to current legacy requirement string
- [x] 1.10 GREEN implement `composeRequirement` (single-item path; multi-item branch scaffolded per D9, wired in Slice 3)
- [x] 1.11 RED: D3 reconcile — flat projection differs from `line_items_projection` ⇒ legacy writer ran after rollback ⇒ flat values overwrite the primary item
- [x] 1.12 GREEN implement D3 reconcile inside `readLineItems`
- [x] 1.13 Create shared table-driven case fixture consumed by both the Vitest suite and the SQL parity suite
- [x] 1.14 Create `infra/postgres/migrations/025_item_aware_v3_state_mutations.sql` (`IMMUTABLE`, same signature; steps: D3 reconcile → flat `jsonb_set` / reject `line_items*` → primary-item materialize `li_0` → upsert by `item_id` → `remove_item` no-op-safe → >10 items error → recompute projection)
- [x] 1.15 Create `infra/postgres/rollback/025_item_aware_v3_state_mutations.down.sql` restoring the 022 body (outside `migrations/`, per D8)
- [x] 1.16 RED integration: SQL reducer equals JS reducer on the shared cases
- [x] 1.17 GREEN fix SQL until parity passes
- [x] 1.18 RED integration: replaying a committed turn is idempotent (no duplicate item, stable `expected_snapshot_digest`)
- [x] 1.19 GREEN fix
- [x] 1.20 RED integration: applying the down migration restores 022 behavior
- [x] 1.21 GREEN verify/fix
- [x] 1.22 Update `tests/scripts/sync-workflow-nodes.mjs`: add `v3-line-items.js` to the runtimes of Compile V3 Turn Policy, Validate And Authorize V3, Build V3 Lead Effect, Prepare Shadow Evaluation
- [x] 1.23 Update `shared/v3-policy-builder.js` to read through `readLineItems` (no version gating yet — output unchanged)
- [x] 1.24 RED regression: existing single-item v3 policy digests and leads are byte-identical to `main`
- [x] 1.25 GREEN confirm/adjust builder wiring until green

Verification: `npm test`; `npm run check:parity`; `npm run check:sql-references`; `docker compose -f docker-compose.test.yml up -d --wait postgres && npm run db:reset:test && npm run test:integration:postgres && docker compose -f docker-compose.test.yml down -v`.

**Apply note (2026-09-26):** all 25 tasks complete, full verification green (see apply-progress.md). Actual authored diff vs the tracker branch is **1110 changed lines** (`git diff --numstat feat/multi-product-quotes...HEAD`, generated workflow JSON excluded), above the preflight forecast (~690) and the 800-line review budget. This was discovered only after the slice was implemented as one cohesive, fully-tested unit; splitting it further post hoc would separate the SQL migration from the JS reducer it must stay in lockstep with. Flagged for an owner decision before opening PR1 (accept as `size:exception`, or split into two child PRs against `feat/multi-product-quotes-foundation`).

## Slice 2a — Contract, dark (branch `feat/multi-product-quotes-contract`, base `feat/multi-product-quotes-foundation`)

Proves: live scenario in *Item-Scoped Line Items, Goals, and Catalog Resolution*; *Item-Scoped Corrections*; *Evidenced Semantic Proposal* — "Correction target is unclear"; *Atomic Grounded Authorization* — "One member is invalid", "Ambiguous item retains its evidenced facts", "Eleventh item is rejected"; *Safe Versioned Rollout* — version dispatch half of "Shape change is versioned".

- [x] 2a.1 RED `shared/v3-contract-runtime.test.js`: `V3_CONTRACTS` adds the v3.1 artifact versions (version strings ending in v3.1); `v3` entries unchanged
- [x] 2a.2 GREEN add v3.1 to `V3_CONTRACTS`
- [x] 2a.3 RED: version-dispatched validator/authorizer runs the unchanged v3 path when `policy.version` is `v3` (full existing v3 suite still green)
- [x] 2a.4 GREEN implement dispatch
- [x] 2a.5 RED: `mutation_target_duplicate` — two mutations target the same `(item_ref, field)`
- [x] 2a.6 GREEN implement
- [x] 2a.7 RED: `line_items_limit_exceeded` — an 11th item rejects the whole proposal
- [x] 2a.8 GREEN implement
- [x] 2a.9 RED: `item_identity_required` — new item has neither a matched product nor an ambiguous/unsupported entry
- [x] 2a.10 GREEN implement
- [x] 2a.11 RED: `item_target_required` — `item_ref:null` correction with ≥2 items asks which item; with exactly 1 item resolves to it
- [x] 2a.12 GREEN implement
- [x] 2a.13 RED: withholding — ambiguous/unsupported item's `product` mutation drops into `withheld_mutations` (not an error); its `quantity` and `measurements` still authorize
- [x] 2a.14 GREEN implement
- [x] 2a.15 RED live-scenario: "pandereta de 3 metros de altura con alambre púa. Son aprox 500 ml en la comuna de Lo Prado" ⇒ wire item commits product "Alambre de Púas" with no invented quantity; pandereta item commits quantity "500 ml" + measurements "3 metros de altura", `product:null`, withheld; `commune` "Lo Prado" commits at quote level
- [x] 2a.16 GREEN implement full validator/authorizer path until the live-scenario test passes
- [x] 2a.17 RED: `catalog_resolution_clarification_required` per item — ambiguous item requires `primary_request={goal_id:'product', item_ref}`, never rejects mutations
- [x] 2a.18 GREEN implement
- [x] 2a.19 RED: `line_items` counts resolved with 1–10 items each having `product`+`quantity`; unresolved surfaces `product@<ref>` and `quantity@<ref>`
- [x] 2a.20 GREEN implement v3.1 `effectiveRequiredGoalIds`
- [x] 2a.21 RED: `shared/v3-policy-builder.js` emits item facts/goals/authority only when `policy.version` is v3.1
- [x] 2a.22 GREEN implement version gate
- [x] 2a.23 RED: `v3-saga-runtime.js`, `normalize-ai-result.js`, `normalize-delivery-result.js`, `record-shadow-evaluation.js` accept the v3.1 version string alongside v3
- [x] 2a.24 GREEN implement version-set widening
- [x] 2a.25 RED integration: `08/09/15/16_*.sql` accept v3 and v3.1; `09` persists the decision's own version
- [x] 2a.26 GREEN implement SQL changes
- [x] 2a.27 Run the full existing v3 regression suite to confirm it is unchanged

Verification: `npm test`; `npm run check:parity`; `npm run check:sql-references`; Postgres integration compose sequence (as Slice 1).

**Apply note (2026-09-26):** all 27 tasks complete, full verification green (see apply-progress.md). Actual authored diff vs `feat/multi-product-quotes-foundation` is **1589 changed lines** (`git diff --numstat`, generated workflow JSON excluded), above the preflight forecast (~620) and the 800-line review budget, split across two commits (738 production + 873 tests — the tests commit is itself ~9% over 800). Same pattern as Slice 1: the item-aware validator/authorizer is one cohesive function that could not be meaningfully implemented or tested in smaller independently-green increments without either duplicating a half-built validator or deferring RED coverage past GREEN. Flagged for an owner decision before opening PR2a (accept as `size:exception` for the tests commit, or split PR2a into two child PRs against `feat/multi-product-quotes-contract`: PR2a-impl = production commit `31ae299` [738 lines]; PR2a-tests = test commit `e477023` [873 lines], further splittable into contract+builder tests [562] and widening+SQL tests [311] if strict ≤800 is required).

### Slice 2a rework — v3.1 as a superset of v3 (design D11)

The first implementation wrote the v3.1 validator from scratch and dropped six v3 guardrails (address retry bound, pickup factory address, service_scope and fulfillment evidence, primary_request applicability, quantity observation). The owner requires that v3.1 never removes an existing protection.

- [x] 2a.28 RED: differential guarantee test. Run every v3 validator case from the existing suites against v3.1 on single-item input, and require identical error codes except a closed allowlist of the two D5 carve-outs (`catalog_resolution_conflict`, and the state-mutation branch of `catalog_resolution_action_forbidden`). It must fail on the current branch.
- [x] 2a.29 GREEN: refactor `validateV3AiProposalV31` and `authorizeV3ConversationDecisionV31` to compose the v3 validator and authorizer. Remove the duplicated quote-level rules; keep only item rules and the two carve-outs.
- [x] 2a.30 RED then GREEN: explicit v3.1 regression tests for the address retry hard bound (third repeated address request is rejected and hands off) and the pickup factory address rule, mirroring `tests/unit/v3-address-hardbound.test.js`.
- [x] 2a.31 Keep every existing Slice 2a test green (live pandereta scenario, item targeting, 10-item cap, version widening, SQL boundary) and `v3-runtime-compatibility.test.js` unmodified.
- [x] 2a.32 Re-cut the slice into functional work units, each with its own tests: 2a-i (version widening, SQL version sets and builder gate) and 2a-ii (v3.1 validator composing v3, with the differential test). Report changed lines per unit.

## Slice 2b — Advisor, dark (branch `feat/multi-product-quotes-advisor`, base `feat/multi-product-quotes-contract`)

Proves: schema/prompt half of *Safe Versioned Rollout* — "Shape change is versioned"; enables the live-scenario end to end once wired with 2a/3.

- [x] 2b.1 RED `build-ai-request.test.js`: v3.1 schema pins `item_ref` enums and `policy_digest` (same pattern as v3)
- [x] 2b.2 GREEN implement v3.1 schema
- [x] 2b.3 RED: v3 prompt stays byte-identical, including rule `build-ai-request.js:436` verbatim
- [x] 2b.4 GREEN guard/refactor so v3 prompt is untouched
- [x] 2b.5 RED: v3.1 prompt replaces rule 436's "no product for either item" clause with item-scoped clarification; rules 398–409, 425, 435 and the `policy_digest` enum stay unchanged in both variants
- [x] 2b.6 GREEN implement v3.1 prompt variant
- [x] 2b.7 RED: v3.1 prompt adds a `final_confirmation` rule — one `•` line per item (quantity+measurements), then one line per quote-level fact
- [x] 2b.8 GREEN implement the summary rule
- [x] 2b.9 RED `compile-v3-turn.test.js`: `disabled` compiles v3 for every phone
- [x] 2b.10 GREEN implement disabled path
- [x] 2b.11 RED: `canary` compiles v3.1 only when the phone's digits appear in `AI_PRD_V3_LINE_ITEMS_CANARY_PHONES` (mirrors `resolve-conversation-contract-route.js:13-23`), else v3
- [x] 2b.12 GREEN implement canary path
- [x] 2b.13 RED: `enabled` compiles v3.1 for every phone
- [x] 2b.14 GREEN implement enabled path
- [x] 2b.15 Update `docker-compose.yml` and `.env.example` to pass through `AI_PRD_V3_LINE_ITEMS` (default `disabled`) and `AI_PRD_V3_LINE_ITEMS_CANARY_PHONES`

Verification: `npm test`; `npm run check:parity`; `npm run check:sql-references`.

**Apply note (2026-09-27):** all 15 tasks complete, full verification green (see apply-progress.md). Two functional commits on `feat/multi-product-quotes-advisor` (base `feat/multi-product-quotes-contract`): schema+prompt (441/9, `ee3bcef`) and the switch+compose passthrough (139/2, `e028464`), both comfortably under the 800-line review budget. The v3.1 prompt is derived programmatically from the v3 prompt array (never retyped); a differential test plus a manual drift-injection proof (documented in apply-progress.md) confirm it only ever removes the one D5-allowlisted clause.

## Slice 3 — Output (branch `feat/multi-product-quotes-output`, base `feat/multi-product-quotes-advisor`)

Proves: *Itemized Lead, Task, and Notification Effects* — "One quote, one lead, itemized everywhere".

- [x] 3.1 RED `build-v3-lead-effect.test.js`: `reduce(context, decision.state_mutations)` produces the single-item requirement byte-identical to today
- [x] 3.2 GREEN wire `composeRequirement` and `reduceV3StateMutations` into `wa-conversation-orchestrator/build-v3-lead-effect.js`
- [x] 3.3 RED: multi-item requirement renders `• {product} — {quantity}[, {measurements}]` lines joined by `\n`, plus `Uso: …` when present
- [x] 3.4 GREEN implement the multi-item branch consumption
- [x] 3.5 RED `build-clickup-payload.test.js`: extracted fixture's single-item output is byte-identical to the current inline node
- [x] 3.6 GREEN create `crm-clickup-sync-lead/build-clickup-payload.js` by extracting the inline node, preserving behavior
- [x] 3.7 RED: `build-clickup-payload.js` skips the flat `Cantidad` and `Medidas` labels when `line_items` has more than one item
- [x] 3.8 GREEN implement the skip logic
- [x] 3.9 Register the `Build ClickUp Payload` fixture in `tests/scripts/sync-workflow-nodes.mjs`; regenerate workflow JSON
- [x] 3.10 RED: seller-notification template shows one line per item (via `leads.requirement` verbatim)
- [x] 3.11 GREEN confirm/wire
- [x] 3.12 Create `tests/ops/v3-line-items-live-replay.mjs`: opt-in A/B harness (`AI_REPLAY_LIVE=1 AI_REPLAY_RUNS=10`) comparing baseline (main path) vs branch (v3.1) over scripted transcripts including the 2026-09-26 message, a confirmation turn, and correction turns; property assertions only — validation pass rate, contingency count, measurement-to-item attribution, correction scoping, one `•` line per item in `final_confirmation`

Verification: `npm test`; `npm run check:parity`; `npm run check:sql-references`; Postgres integration compose sequence.

## Slice 3c — v3.1 contract alignment, from live evidence (branch `feat/multi-product-quotes-alignment`, base `feat/multi-product-quotes-output`)

Rollout step 3 (live A/B, N=10, production catalog) blocked the canary: v3.1 first-turn proposals were valid only 2/20 times against 20/20 for v3. Captured real proposals show the model is semantically right (wire and pandereta as separate items, 500 ml and 3 m on the pandereta, commune at quote level, a clarification question), and the v3.1 validator rejects them. Slices 2a and 2b were built against mocks and disagree. Evidence: `tests/fixtures/v3-line-items/captured-live-proposals.json` (15 real proposals with their turn policies and validation errors).

- [x] 3c.1 RED: a live-evidence test feeds every captured proposal through the real v3.1 validator with its captured turn policy. Every semantically correct proposal must validate, or fail only on the documented clarification rule. The wire correction must stay scoped to the wire item. It must fail on the current code with `goal_reference_unknown` and `mutation_shape_invalid`.
- [x] 3c.2 GREEN: make the v3.1 goals, allowed mutations and item mutation shape one contract shared by the policy builder, the validator and the response schema. Resolve `goal_reference_unknown` (per-item product, quantity and measurements goals, or goal references the validator maps to `line_items`) and `mutation_shape_invalid` for item mutations.
- [x] 3c.3 RED then GREEN: resolve `catalog_resolution_product_observation_required` for an ambiguous item with no product observation, consistent with D5 (withholding, not rejecting), and make the ambiguous-item clarification select `primary_request` product rather than an unrelated goal.
- [x] 3c.4 Add a contract-consistency test: the v3.1 response schema, the policy builder output and the validator accept the same goal ids and mutation shapes, so the three cannot drift again.
- [x] 3c.5 Keep every D11 guarantee green: static error-code coverage, behavioral and authorizer differentials, the prompt-diff test, v3 byte-identity, and all existing suites.
- [x] 3c.6 (ran 2026-09-27: first-turn validity 20/20, equal to v3; the correction-scoping gate failed in 1 of 6 valid corrections, so it was not passed; follow-up in 3c.7–3c.10) Rerun the live A/B (N=10, production catalog). Gate for canary: v3.1 first-turn validity is at least v3 first-turn validity, and every valid correction is scoped to the named item.

### Slice 3c follow-up — item attribution (live A/B round 2)

Live A/B after 3c.1–3c.5 (N=10, production catalog): v3.1 first-turn validity 20/20 (equal to v3), total 36/40 against v3 30/40. Remaining defects, observed live:
- First turn, 3 of 20: the pandereta quantity "500 ml" was copied or moved onto the wire item, or the pandereta was split into two items.
- Wire correction, 1 of 6 valid: 300 ml landed on the pandereta instead of the wire. The canary gate (every valid correction scoped to the named item) failed.

- [x] 3c.7 RED then GREEN: a deterministic v3.1 validator rule rejects a proposal where one evidence span (the same `evidence_quote` and `evidence_occurrence`) resolves the same item concept on two different items. The error is repairable, and its code joins the v3.1-only allowlist rationale in the static coverage test if needed.
- [x] 3c.8 RED then GREEN: v3.1 prompt rules (v3.1-only, the prompt-diff allowlist updated): never copy or move a quantity or measurement from one item to another; one mentioned product is one item, never split into two; a correction applies to the item whose product or label the customer names in that message, and a correction that names no item asks which item.
- [x] 3c.9 Keep every guarantee green: D11 static coverage and differentials, the prompt-diff test, the v3 request byte-identical, and the live-evidence and consistency tests.
- [x] 3c.10 (ran 2026-09-27, gate passed: first-turn validity 20/20, equal to v3; first-turn attribution 20/20; valid corrections 10/10, all scoped to the wire item; v3.1 total 40/40 with 0 contingencies against v3 35/40) Rerun the live A/B (N=10, production catalog). Gate for canary: first-turn validity at least v3; first-turn item attribution correct in at least 19 of 20 runs; every valid correction scoped to the named item.

### Slice 3c bounded follow-up — unscoped item field in a first-turn multi-item proposal

- [x] 3c.11 RED then GREEN: use the captured first-turn proposal to reject an item-field observation or mutation with `item_ref:null` when the proposal introduces two items, instead of creating a headless `li_0`; retain the 0/1-item fallback, quote-level fields, and `item_target_required` for two preexisting items. Sync embedded workflow nodes and run focused plus full local checks. This is contract-alignment work only; rollout tasks 4.x remain pending.

### Slice 3c owner-rule follow-up — installation requires delivery

- [x] 3c.12 RED then GREEN: reject projected `service_scope=installation|both` with `fulfillment=pickup` in the shared v3/v3.1 validator; verify persisted and same-turn combinations, correction to delivery or material-only, material-only pickup, installation-only without explicit fulfillment, authorizer protection, and v3.1-only prompt guidance. Sync workflow nodes and run local checks. No live deployment in this task.
- [x] 3c.13 RED then GREEN: keep repair `allowed_values` in the `fulfillment` domain, and allow a narrow mutation-free/effect-free clarification when the invalid combination was already committed. New invalid assertions and effects remain blocked in v3 and v3.1. No live deployment in this task.

## Slice 4 — Rollout & Verification (tracker `feat/multi-product-quotes`, no code changes)

- [ ] 4.1 Apply migration 025 (safe superset while v3 decisions are in flight); deploy the four slices' workflows via `scripts/dev/sync-n8n-workflows.sh`; keep `AI_PRD_V3_LINE_ITEMS=disabled`
- [ ] 4.2 Run `AI_REPLAY_LIVE=1 AI_REPLAY_RUNS=10 node tests/ops/v3-line-items-live-replay.mjs` against the real model, N≥10, including the live 2026-09-26 pandereta message, a confirmation turn, and correction turns; assert the itemized `final_confirmation` property (one `•` line per item) and no measurement misattribution
- [x] 4.3 Check whether `CLICKUP_CF_REQUIREMENT_ID` accepts newlines; if not, join requirement lines with ` | ` in `build-clickup-payload.js` and re-run 3.5–3.9
- [ ] 4.4 Set `AI_PRD_V3_LINE_ITEMS=canary` and `AI_PRD_V3_LINE_ITEMS_CANARY_PHONES=56997093038`; recreate n8n (`docker compose up -d n8n`)
- [x] 4.5 Run the canary E2E on `56997093038`: replay the incident message through confirmation; assert one lead + one ClickUp task listing Cierros de Hormigón and the wire item with their own measurements, no flat `Cantidad` and `Medidas` lines, and empty `last_error` and `validation_errors`
- [x] 4.5a Deploy the installation-delivery guard to the controlled canary and verify a factory-pickup plus installation request is declined without a lead or ClickUp effect (conversation 332; see `apply-progress.md`)

- [ ] 4.6 Set `AI_PRD_V3_LINE_ITEMS=enabled`; recreate n8n
- [ ] 4.7 Monitor `conversation_turn_executions.last_error` and `advisor_decisions.validation_errors` for multi-product rejections; merge tracker → main once stable

Verified 2026-09-27 on conversation 330; see `apply-progress.md` for evidence. Tasks 4.1, 4.2, 4.4, 4.6, and 4.7 remain open; the existing canary state is not proof that their prescribed transitions occurred. Installation requiring delivery is now covered by a local validator guard and tests, but its negative path is not yet verified on the live canary.

Rollback drain (ordered, per slice, latest first):
- [ ] 4.8 Set `AI_PRD_V3_LINE_ITEMS=canary` (empty phone list) or `disabled`; recreate n8n — new turns compile v3
- [ ] 4.9 Wait for in-flight v3.1 decisions to leave their non-terminal states
- [ ] 4.10 Revert the workflows (`scripts/dev/sync-n8n-workflows.sh --rollback <pre-deploy snapshot>`), then apply `infra/postgres/rollback/025_item_aware_v3_state_mutations.down.sql`
- [ ] 4.11 Confirm rows keep their flat projection and D3 reconciles on the next upgrade
