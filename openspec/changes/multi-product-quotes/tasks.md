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

- [ ] 1.1 RED `tests/fixtures/workflow-nodes/shared/v3-line-items.test.js`: `readLineItems` maps flat `qualification_context` to `[li_0]`
- [ ] 1.2 GREEN implement `readLineItems` in `tests/fixtures/workflow-nodes/shared/v3-line-items.js`
- [ ] 1.3 RED: `deriveItemId` = `li_` + `sha256("line_item/v1\0conv\0turn\0handle")[0:12]`; `li_0` for flat rows
- [ ] 1.4 GREEN implement `deriveItemId`
- [ ] 1.5 RED: `reduceV3StateMutations` upserts by `item_id` (no duplicate on replay), rejects flat mutations on `line_items*` keys, errors above 10 items
- [ ] 1.6 GREEN implement `reduceV3StateMutations`
- [ ] 1.7 RED: `projectFlat` mirrors first item in array order, deletes flat fields when no items remain
- [ ] 1.8 GREEN implement `projectFlat`
- [ ] 1.9 RED: `composeRequirement` single-item output is byte-identical to current legacy requirement string
- [ ] 1.10 GREEN implement `composeRequirement` (single-item path; multi-item branch scaffolded per D9, wired in Slice 3)
- [ ] 1.11 RED: D3 reconcile — flat projection differs from `line_items_projection` ⇒ legacy writer ran after rollback ⇒ flat values overwrite the primary item
- [ ] 1.12 GREEN implement D3 reconcile inside `readLineItems`
- [ ] 1.13 Create shared table-driven case fixture consumed by both the Vitest suite and the SQL parity suite
- [ ] 1.14 Create `infra/postgres/migrations/025_item_aware_v3_state_mutations.sql` (`IMMUTABLE`, same signature; steps: D3 reconcile → flat `jsonb_set` / reject `line_items*` → primary-item materialize `li_0` → upsert by `item_id` → `remove_item` no-op-safe → >10 items error → recompute projection)
- [ ] 1.15 Create `infra/postgres/rollback/025_item_aware_v3_state_mutations.down.sql` restoring the 022 body (outside `migrations/`, per D8)
- [ ] 1.16 RED integration: SQL reducer equals JS reducer on the shared cases
- [ ] 1.17 GREEN fix SQL until parity passes
- [ ] 1.18 RED integration: replaying a committed turn is idempotent (no duplicate item, stable `expected_snapshot_digest`)
- [ ] 1.19 GREEN fix
- [ ] 1.20 RED integration: applying the down migration restores 022 behavior
- [ ] 1.21 GREEN verify/fix
- [ ] 1.22 Update `tests/scripts/sync-workflow-nodes.mjs`: add `v3-line-items.js` to the runtimes of Compile V3 Turn Policy, Validate And Authorize V3, Build V3 Lead Effect, Prepare Shadow Evaluation
- [ ] 1.23 Update `shared/v3-policy-builder.js` to read through `readLineItems` (no version gating yet — output unchanged)
- [ ] 1.24 RED regression: existing single-item v3 policy digests and leads are byte-identical to `main`
- [ ] 1.25 GREEN confirm/adjust builder wiring until green

Verification: `npm test`; `npm run check:parity`; `npm run check:sql-references`; `docker compose -f docker-compose.test.yml up -d --wait postgres && npm run db:reset:test && npm run test:integration:postgres && docker compose -f docker-compose.test.yml down -v`.

## Slice 2a — Contract, dark (branch `feat/multi-product-quotes-contract`, base `feat/multi-product-quotes-foundation`)

Proves: live scenario in *Item-Scoped Line Items, Goals, and Catalog Resolution*; *Item-Scoped Corrections*; *Evidenced Semantic Proposal* — "Correction target is unclear"; *Atomic Grounded Authorization* — "One member is invalid", "Ambiguous item retains its evidenced facts", "Eleventh item is rejected"; *Safe Versioned Rollout* — version dispatch half of "Shape change is versioned".

- [ ] 2a.1 RED `shared/v3-contract-runtime.test.js`: `V3_CONTRACTS` adds the v3.1 artifact versions (version strings ending in v3.1); `v3` entries unchanged
- [ ] 2a.2 GREEN add v3.1 to `V3_CONTRACTS`
- [ ] 2a.3 RED: version-dispatched validator/authorizer runs the unchanged v3 path when `policy.version` is `v3` (full existing v3 suite still green)
- [ ] 2a.4 GREEN implement dispatch
- [ ] 2a.5 RED: `mutation_target_duplicate` — two mutations target the same `(item_ref, field)`
- [ ] 2a.6 GREEN implement
- [ ] 2a.7 RED: `line_items_limit_exceeded` — an 11th item rejects the whole proposal
- [ ] 2a.8 GREEN implement
- [ ] 2a.9 RED: `item_identity_required` — new item has neither a matched product nor an ambiguous/unsupported entry
- [ ] 2a.10 GREEN implement
- [ ] 2a.11 RED: `item_target_required` — `item_ref:null` correction with ≥2 items asks which item; with exactly 1 item resolves to it
- [ ] 2a.12 GREEN implement
- [ ] 2a.13 RED: withholding — ambiguous/unsupported item's `product` mutation drops into `withheld_mutations` (not an error); its `quantity` and `measurements` still authorize
- [ ] 2a.14 GREEN implement
- [ ] 2a.15 RED live-scenario: "pandereta de 3 metros de altura con alambre púa. Son aprox 500 ml en la comuna de Lo Prado" ⇒ wire item commits product "Alambre de Púas" with no invented quantity; pandereta item commits quantity "500 ml" + measurements "3 metros de altura", `product:null`, withheld; `commune` "Lo Prado" commits at quote level
- [ ] 2a.16 GREEN implement full validator/authorizer path until the live-scenario test passes
- [ ] 2a.17 RED: `catalog_resolution_clarification_required` per item — ambiguous item requires `primary_request={goal_id:'product', item_ref}`, never rejects mutations
- [ ] 2a.18 GREEN implement
- [ ] 2a.19 RED: `line_items` counts resolved with 1–10 items each having `product`+`quantity`; unresolved surfaces `product@<ref>` and `quantity@<ref>`
- [ ] 2a.20 GREEN implement v3.1 `effectiveRequiredGoalIds`
- [ ] 2a.21 RED: `shared/v3-policy-builder.js` emits item facts/goals/authority only when `policy.version` is v3.1
- [ ] 2a.22 GREEN implement version gate
- [ ] 2a.23 RED: `v3-saga-runtime.js`, `normalize-ai-result.js`, `normalize-delivery-result.js`, `record-shadow-evaluation.js` accept the v3.1 version string alongside v3
- [ ] 2a.24 GREEN implement version-set widening
- [ ] 2a.25 RED integration: `08/09/15/16_*.sql` accept v3 and v3.1; `09` persists the decision's own version
- [ ] 2a.26 GREEN implement SQL changes
- [ ] 2a.27 Run the full existing v3 regression suite to confirm it is unchanged

Verification: `npm test`; `npm run check:parity`; `npm run check:sql-references`; Postgres integration compose sequence (as Slice 1).

## Slice 2b — Advisor, dark (branch `feat/multi-product-quotes-advisor`, base `feat/multi-product-quotes-contract`)

Proves: schema/prompt half of *Safe Versioned Rollout* — "Shape change is versioned"; enables the live-scenario end to end once wired with 2a/3.

- [ ] 2b.1 RED `build-ai-request.test.js`: v3.1 schema pins `item_ref` enums and `policy_digest` (same pattern as v3)
- [ ] 2b.2 GREEN implement v3.1 schema
- [ ] 2b.3 RED: v3 prompt stays byte-identical, including rule `build-ai-request.js:436` verbatim
- [ ] 2b.4 GREEN guard/refactor so v3 prompt is untouched
- [ ] 2b.5 RED: v3.1 prompt replaces rule 436's "no product for either item" clause with item-scoped clarification; rules 398–409, 425, 435 and the `policy_digest` enum stay unchanged in both variants
- [ ] 2b.6 GREEN implement v3.1 prompt variant
- [ ] 2b.7 RED: v3.1 prompt adds a `final_confirmation` rule — one `•` line per item (quantity+measurements), then one line per quote-level fact
- [ ] 2b.8 GREEN implement the summary rule
- [ ] 2b.9 RED `compile-v3-turn.test.js`: `disabled` compiles v3 for every phone
- [ ] 2b.10 GREEN implement disabled path
- [ ] 2b.11 RED: `canary` compiles v3.1 only when the phone's digits appear in `AI_PRD_V3_LINE_ITEMS_CANARY_PHONES` (mirrors `resolve-conversation-contract-route.js:13-23`), else v3
- [ ] 2b.12 GREEN implement canary path
- [ ] 2b.13 RED: `enabled` compiles v3.1 for every phone
- [ ] 2b.14 GREEN implement enabled path
- [ ] 2b.15 Update `docker-compose.yml` and `.env.example` to pass through `AI_PRD_V3_LINE_ITEMS` (default `disabled`) and `AI_PRD_V3_LINE_ITEMS_CANARY_PHONES`

Verification: `npm test`; `npm run check:parity`; `npm run check:sql-references`.

## Slice 3 — Output (branch `feat/multi-product-quotes-output`, base `feat/multi-product-quotes-advisor`)

Proves: *Itemized Lead, Task, and Notification Effects* — "One quote, one lead, itemized everywhere".

- [ ] 3.1 RED `build-v3-lead-effect.test.js`: `reduce(context, decision.state_mutations)` produces the single-item requirement byte-identical to today
- [ ] 3.2 GREEN wire `composeRequirement` and `reduceV3StateMutations` into `wa-conversation-orchestrator/build-v3-lead-effect.js`
- [ ] 3.3 RED: multi-item requirement renders `• {product} — {quantity}[, {measurements}]` lines joined by `\n`, plus `Uso: …` when present
- [ ] 3.4 GREEN implement the multi-item branch consumption
- [ ] 3.5 RED `build-clickup-payload.test.js`: extracted fixture's single-item output is byte-identical to the current inline node
- [ ] 3.6 GREEN create `crm-clickup-sync-lead/build-clickup-payload.js` by extracting the inline node, preserving behavior
- [ ] 3.7 RED: `build-clickup-payload.js` skips the flat `Cantidad` and `Medidas` labels when `line_items` has more than one item
- [ ] 3.8 GREEN implement the skip logic
- [ ] 3.9 Register the `Build ClickUp Payload` fixture in `tests/scripts/sync-workflow-nodes.mjs`; regenerate workflow JSON
- [ ] 3.10 RED: seller-notification template shows one line per item (via `leads.requirement` verbatim)
- [ ] 3.11 GREEN confirm/wire
- [ ] 3.12 Create `tests/ops/v3-line-items-live-replay.mjs`: opt-in A/B harness (`AI_REPLAY_LIVE=1 AI_REPLAY_RUNS=10`) comparing baseline (main path) vs branch (v3.1) over scripted transcripts including the 2026-09-26 message, a confirmation turn, and correction turns; property assertions only — validation pass rate, contingency count, measurement-to-item attribution, correction scoping, one `•` line per item in `final_confirmation`

Verification: `npm test`; `npm run check:parity`; `npm run check:sql-references`; Postgres integration compose sequence.

## Slice 4 — Rollout & Verification (tracker `feat/multi-product-quotes`, no code changes)

- [ ] 4.1 Apply migration 025 (safe superset while v3 decisions are in flight); deploy the four slices' workflows via `scripts/dev/sync-n8n-workflows.sh`; keep `AI_PRD_V3_LINE_ITEMS=disabled`
- [ ] 4.2 Run `AI_REPLAY_LIVE=1 AI_REPLAY_RUNS=10 node tests/ops/v3-line-items-live-replay.mjs` against the real model, N≥10, including the live 2026-09-26 pandereta message, a confirmation turn, and correction turns; assert the itemized `final_confirmation` property (one `•` line per item) and no measurement misattribution
- [ ] 4.3 Check whether `CLICKUP_CF_REQUIREMENT_ID` accepts newlines; if not, join requirement lines with ` | ` in `build-clickup-payload.js` and re-run 3.5–3.9
- [ ] 4.4 Set `AI_PRD_V3_LINE_ITEMS=canary` and `AI_PRD_V3_LINE_ITEMS_CANARY_PHONES=56997093038`; recreate n8n (`docker compose up -d n8n`)
- [ ] 4.5 Run the canary E2E on `56997093038`: replay the incident message through confirmation; assert one lead + one ClickUp task listing Cierros de Hormigón and the wire item with their own measurements, no flat `Cantidad` and `Medidas` lines, and empty `last_error` and `validation_errors`
- [ ] 4.6 Set `AI_PRD_V3_LINE_ITEMS=enabled`; recreate n8n
- [ ] 4.7 Monitor `conversation_turn_executions.last_error` and `advisor_decisions.validation_errors` for multi-product rejections; merge tracker → main once stable

Rollback drain (ordered, per slice, latest first):
- [ ] 4.8 Set `AI_PRD_V3_LINE_ITEMS=canary` (empty phone list) or `disabled`; recreate n8n — new turns compile v3
- [ ] 4.9 Wait for in-flight v3.1 decisions to leave their non-terminal states
- [ ] 4.10 Revert the workflows (`scripts/dev/sync-n8n-workflows.sh --rollback <pre-deploy snapshot>`), then apply `infra/postgres/rollback/025_item_aware_v3_state_mutations.down.sql`
- [ ] 4.11 Confirm rows keep their flat projection and D3 reconciles on the next upgrade
