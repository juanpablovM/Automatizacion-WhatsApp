# Design: Multi-Product Quotes

## Technical Approach

Add a quote-level `line_items[]` model to `qualification_context` with a single source of truth for reducing mutations, and ship it in four auto-chain slices. JavaScript (`shared/v3-line-items.js`) and SQL (`apply_v3_state_mutations`) implement the same reducer, and a parity suite keeps them in lockstep. The reducer has to exist twice because `Build V3 Lead Effect` composes the lead from `qualification_context` plus the projected mutations *before* `09_commit_v3_turn.sql` persists them. The contract becomes item-aware under new artifact versions (`/v3.1`) inside the unchanged `v3` route family. A per-turn, phone-scoped switch (`AI_PRD_V3_LINE_ITEMS=disabled|canary|enabled`) keeps every slice dark until the output slice and the live gates pass.

## Architecture Decisions

| # | Decision | Choice | Rejected alternatives | Rationale |
|---|---|---|---|---|
| D1 | Item identity | The model uses handles (`new:1..k` for new items, the committed `item_id` for existing ones). `authorize` derives `li_` + `sha256("line_item/v1\0conv\0turn\0handle")[0:12]`. Flat rows map to the constant `li_0`. | Random UUIDs; ids written by the model | Ids are fixed inside the immutable decision, so replay and re-reads produce identical ids. The model never invents a persisted id: existing ids are enum-pinned in the schema, like `policy_digest`. |
| D2 | Flat projection | The primary item is the first item in array order. `product`, `quantity` and `measurements` mirror it, and are deleted when no items remain. A copy of the projection is kept in `line_items_projection`. | No projection; the projection as the source of truth | Old readers (a rolled-back compiler, legacy code) keep working. The stored copy detects writes made by a legacy writer. Multi-item renderers must not read the projection as if it described the whole quote (see D9). |
| D3 | Dual-read | `readLineItems(ctx)`: without `line_items`, flat fields become `[li_0]`. With `line_items` but a flat projection that differs from `line_items_projection`, a legacy writer ran after a rollback, so the flat values overwrite the primary item. | Backfill; ignoring flat values | No destructive migration. The reconcile rule is deterministic in both JS and SQL. |
| D4 | Item-scoped concepts | Only `product`, `quantity` and `measurements` (+ system `catalog_ref`, `requested_label`) are item fields. Everything else stays quote-level. | Everything per item (approach 2) | Owner decision 1. |
| D5 | Ambiguous or unsupported item | The v3.1 validator **withholds** the item's `product` mutation: it is dropped from the decision and listed in `validation.withheld_mutations` for audit. This is not an error, and v3's `catalog_resolution_conflict` (`v3-contract-runtime.js:620`) and the state-mutation branch of `catalog_resolution_action_forbidden` do not apply under v3.1. The item's evidenced `quantity` and `measurements` mutations are authorized. The item is stored with `product:null` and `requested_label`. Clear items in the same proposal commit normally, even with `quantity:null`, and quote-level facts (for example `commune`) commit too. `create_lead` stays blocked until every item has a product and a quantity. | Rejecting the whole proposal (v3); not storing the ambiguous item (the `c6d56c1` mitigation) | Required by the spec's per-item carve-out. It fixes the observed drift ("3 metros" landing on Adoquín) and satisfies owner decision 2. |
| D6 | Versioning | Upgrade at the turn boundary. New artifacts: `ai_prd_turn_policy/v3.1`, `ai_conversation_proposal/v3.1`, `conversation_validation_result/v3.1`, `validated_conversation_decision/v3.1`, `ai_conversation_repair_request/v3.1`. The route `contract_version` stays `v3`, and `system_contingency_decision/v3` is unchanged. Each turn's policy, proposal, repair, decision and replay share one version. | Pinning per conversation | Each turn's policy is compiled from committed state, and dual-read makes every row readable by v3.1, so there is no conversation-level version to pin. Pinning would need a new column and two permanent compilers. |
| D7 | Switch and canary | `compile-v3-turn.js` reads `$env.AI_PRD_V3_LINE_ITEMS` (`disabled` by default, or `canary` or `enabled`) and `$env.AI_PRD_V3_LINE_ITEMS_CANARY_PHONES` on every turn. `canary` compiles v3.1 only when the phone's digits appear in that list, following the `AI_PRD_CONTRACT_CANARY_PHONES` pattern in `resolve-conversation-contract-route.js:13-23`. Both variables pass through `docker-compose.yml` and `.env.example`. Changing them means recreating the n8n container (`docker compose up -d n8n`), with no workflow redeploy. | A global enabled/disabled switch; code revert only | This allows a production E2E on the controlled phone alone, and rolling back behavior takes one env change. |
| D8 | Down migration | `infra/postgres/rollback/025_item_aware_v3_state_mutations.down.sql` (outside `migrations/`, so `reset-test-db.mjs` never applies it) restores the 022 body. | Down file inside `migrations/` | The runner applies every `.sql` file in that directory. |
| D9 | Output rendering | One item keeps the exact legacy requirement string. Several items produce `• {product} — {quantity}[, {measurements}]` lines joined by `\n`, plus `Uso: …` when present. The seller notification renders `leads.requirement` verbatim. `Build ClickUp Payload` (`crm-clickup-sync-lead.json`) also renders flat `qualification_context` keys through `qualificationLabels` (`quantity: 'Cantidad'`, `measurements: 'Medidas'`), which would mislabel the primary item's values as the whole quote. It moves to the fixture `crm-clickup-sync-lead/build-clickup-payload.js` and skips `quantity`/`measurements` when `line_items` has more than one item. | Changing the ClickUp and seller SQL; rendering the flat keys as they are | The requirement already itemizes, so the SQL stays as it is. Skipping the flat labels removes the misattribution. |
| D10 | Internal keys | `requested_label`, `line_items_projection` and `line_items_schema` are system-derived and internal. They are never shown to the customer: `reply_text` is AI-written and the prompt presents items by product, quantity and measurements. They are never rendered in lead, ClickUp or seller text. | Exposing the label as a product name | This keeps an unresolved label from looking like a catalog product. |

**Supersession note:** the v3 prompt keeps rule `build-ai-request.js:436` verbatim. Only the v3.1 prompt replaces its "no product for either item" clause with item-scoped clarification. The brand-voice rules (398–409), the yes/no rule (425), the ambiguity definition (435) and the pinned `policy_digest` enum stay unchanged in both variants. The v3.1 prompt adds one rule: a `final_confirmation` summary lists one `•` line per item with that item's quantity and measurements, then one line per quote-level fact.

## Interfaces / Contracts (v3.1 deltas)

```js
// qualification_context (system keys; flat mutations on them are rejected)
line_items: [{ item_id, product|null, quantity|null, measurements|null, catalog_ref|null, requested_label|null }] // ≤10
line_items_projection: { product, quantity, measurements }   line_items_schema: 'line_items/v1'
// policy
facts[]:   item facts { fact_id:'fact:item:<id>:<field>', field, item_id, value }
goals[]:   quote goals as today minus product/quantity/measurements, plus
           { goal_id:'line_items', importance:'required_for_effect' } and per-item { goal_id:<field>, item_id }
state_authority.allowed_mutations: one entry per (op, field) with item_ids[]; { operation:'remove_item', item_ids[] }; max_new_items
// proposal
catalog_resolutions: [{ item_ref, status:'matched'|'unsupported'|'ambiguous', evidence_quote, evidence_occurrence, grounding_ref }] // [] = not applicable
observations[].item_ref: handle | null   // null = quote concept, or an item concept whose target is unclear
state_mutations[]: { operation:'set'|'replace'|'remove_item', field|null, item_ref|null, observation_id, replaces_fact_id }
primary_request: { goal_id, item_ref|null }
// validation: + withheld_mutations[] (product mutations of ambiguous/unsupported items)
// decision.state_mutations[]: { operation, field, item_id|null, projected_value, ... } (handles resolved to ids)
```

**Validator rules (v3.1).**

| Code / behavior | Rule |
|---|---|
| `mutation_target_duplicate` | Two mutations target the same `(item_ref, field)`. |
| `line_items_limit_exceeded` | More than 10 items after the reducer runs. The whole proposal is rejected. Allowed next step: ask the customer to prioritize, or hand off. |
| `item_identity_required` | A new item has neither a `matched` product nor an `ambiguous`/`unsupported` entry. |
| `item_target_required` | A mutation on an item concept has `item_ref:null` while the quote has two or more items: the correction target is unclear. The repair instruction is to drop the mutation and ask which item, via `primary_request={goal_id:<field>, item_ref:null}`. With exactly one item, `null` resolves to that item. |
| Withholding (not an error) | Per `item_ref`, an `ambiguous`/`unsupported` entry drops that item's `product` mutation into `withheld_mutations`. `quantity` and `measurements` stay authorized. |
| `catalog_resolution_clarification_required` | Evaluated per item. An ambiguous item requires `primary_request={goal_id:'product', item_ref}`. It never rejects mutations. |

Required goals reuse `effectiveRequiredGoalIds` (quote-level conditional rules) and replace `product`/`quantity` with `line_items`. `line_items` counts as resolved when the reducer's projected items number 1–10 and every item has a non-null `product` and a `quantity`. Unresolved parts surface as `product@<ref>` / `quantity@<ref>` in `allowed_values` for the repair. The validator runs the v3 path unchanged when `policy.version` is v3, which in-flight repairs need.

**SQL (`025_item_aware_v3_state_mutations.sql`).** The function stays `IMMUTABLE` and keeps its signature. It applies these steps in order:

1. Run the D3 reconcile.
2. Flat non-item fields keep `jsonb_set`. A flat mutation on `line_items`, `line_items_projection` or `line_items_schema` raises an error, just as `_`-prefixed fields do today.
3. An item field without `item_id` targets the primary item and materializes `li_0` from the flat values. This keeps v3 in-flight decisions working.
4. An item field with an `item_id` upserts that id: it updates in place, or appends when the id is absent.
5. `remove_item` removes the id, and is a no-op when the id is absent.
6. It raises an error above 10 items.
7. It recomputes the projection.

Reapplying the same decision yields the same JSON, because nothing is ever blindly appended. Replay is already guarded upstream (`09` skips `mutated` unless `ready_to_commit` and the snapshot matches `expected_snapshot`). `expected_snapshot_digest` keeps its formula `digest({revision, facts})`, and item facts are ordered by array position with stable ids.

## Data Flow: one multi-item turn

```
Customer ─▶ 01_load_active_context (qualification_context, v3_grounding = full active catalog)
   ─▶ Resolve Route (v3) ─▶ Compile V3 Turn Policy
        switch/canary(phone) ─▶ readLineItems ─▶ buildV3PolicyInput ─▶ compileV3TurnPolicy(v3|v3.1) ─▶ expected_snapshot_digest
   ─▶ 07_route_v3_turn (expected_snapshot = raw context)
   ─▶ Build AI Request (item_ref enums, pinned digest) ─▶ provider
   ─▶ Validate And Authorize V3
        per-item catalog (withhold ambiguous product) ─▶ dedupe/limit/target ─▶ required goals ─▶ derive item_ids
        invalid ─▶ one repair (same policy_digest) ─▶ still invalid ─▶ contingency
   ─▶ 16 persist authority ─▶ 08 prepare execution
   ─▶ [create_lead] 11 prepare effect ─▶ Build V3 Lead Effect
        reduce(context, decision.state_mutations) ─▶ itemized requirement ─▶ CRM lead ─▶ ClickUp + seller
   ─▶ 09 commit: apply_v3_state_mutations (upsert by item_id + projection) + outbox
   ─▶ outbound delivery
```

## File Changes

| File | Action | Slice |
|---|---|---|
| `tests/fixtures/workflow-nodes/shared/v3-line-items.js` | Create: `readLineItems`, `deriveItemId`, `reduceV3StateMutations`, `projectFlat`, `composeRequirement` (IIFE, n8n-safe) | 1 |
| `infra/postgres/migrations/025_item_aware_v3_state_mutations.sql` / `infra/postgres/rollback/025_…down.sql` | Create | 1 |
| `tests/scripts/sync-workflow-nodes.mjs` | Add `v3-line-items.js` to the runtimes of Compile V3 Turn Policy, Validate And Authorize V3, Build V3 Lead Effect and Prepare Shadow Evaluation. Register the `Build ClickUp Payload` fixture | 1, 3 |
| `shared/v3-policy-builder.js` | Read via `readLineItems`. Item facts, goals and authority are emitted only for v3.1 | 1, 2a |
| `shared/v3-contract-runtime.js` | `V3_CONTRACTS` v3.1, version-dispatched validator/authorizer, withholding, new codes | 2a |
| `shared/v3-saga-runtime.js`, `normalize-ai-result.js`, `normalize-delivery-result.js`, `record-shadow-evaluation.js`, `08/09/15/16_*.sql` | Accept the v3 and v3.1 version sets. `09` writes the decision's own version | 2a |
| `ai-lead-qualification-assistant/build-ai-request.js` | v3.1 schema and prompt variant, including the itemized summary rule | 2b |
| `wa-conversation-orchestrator/compile-v3-turn.js` | `disabled/canary/enabled` switch plus the canary phone list | 2b |
| `docker-compose.yml`, `.env.example` | Pass through `AI_PRD_V3_LINE_ITEMS` and `AI_PRD_V3_LINE_ITEMS_CANARY_PHONES` | 2b |
| `wa-conversation-orchestrator/build-v3-lead-effect.js` | Reducer plus itemized requirement | 3 |
| `crm-clickup-sync-lead/build-clickup-payload.js` | Create by extracting the inline node. Skip `quantity`/`measurements` labels when there is more than one item | 3 |
| `tests/ops/v3-line-items-live-replay.mjs` | Create: A/B real-model harness | 3 |
| n8n workflow JSON | Regenerated by `sync-workflow-nodes.mjs` | all |

## Slice Plan (auto-chain, ≤800 changed lines each)

| Slice | Scope | Est. lines | What its tests prove |
|---|---|---|---|
| 1 Foundation | Reducer, dual-read, migration 025 + down, builder reads through the adapter | ~690 | Single-item state writes `line_items[li_0]` and its projection. v3 policy digests and leads are byte-identical to `main`. JS/SQL parity. Replay and reapply idempotency. Reconcile after a legacy write. Flat mutations on `line_items*` keys are rejected. |
| 2a Contract (dark) | v3.1 policy and validator/authorizer, withholding, new codes, version sets | ~620 | Every existing v3 suite is unchanged. **Live scenario** ("pandereta de 3 metros de altura con alambre púa. Son aprox 500 ml en la comuna de Lo Prado", pandereta ambiguous): the decision holds a pandereta item with `quantity` "500 ml", `measurements` "3 metros de altura" and `product:null`; a wire item with product "Alambre de Púas" and `quantity:null`; and quote-level `commune` "Lo Prado". The pandereta product appears only in `withheld_mutations`, with no rejection. Duplicate, over-limit and missing-identity proposals are rejected. A correction with `item_ref:null` on two items raises `item_target_required`. A correction touches only the named item. |
| 2b Advisor (dark) | Schema and prompt variant, itemized-summary rule, switch/canary, compose/env | ~420 | Schema enums pin item refs and the digest. The v3 prompt is byte-identical, including rule 436. The v3.1 prompt contains the summary and item rules. `canary` compiles v3.1 only for listed phones, and `disabled` compiles v3. |
| 3 Output | Lead requirement, ClickUp fixture, A/B harness, E2E | ~700 | The single-item requirement and ClickUp payload are byte-identical. Multi-item: one requirement line per item, no flat `Cantidad`/`Medidas` lines in ClickUp, and one line per item in the seller text. The harness asserts one line per item in the `final_confirmation` reply. |

## Testing Strategy (strict TDD: RED first per task)

| Layer | What | How |
|---|---|---|
| Unit (`npm test`) | Reducer, dual-read, id derivation, validator codes and withholding, schema enums, prompt variants, switch/canary, requirement composer, ClickUp payload | Vitest, one table-driven case file shared with the parity suite |
| Parity | Workflow JSON matches the fixtures | `npm run check:parity`, `npm run check:sql-references` |
| Integration | SQL reducer equals the JS reducer on the shared cases. Commit replay. In-flight v3 decision committed by the 025 function. The down migration restores 022 behavior | `docker-compose.test.yml` → `npm run db:reset:test` → `npm run test:integration:postgres` |
| Live A/B | Baseline A (`main` checkout path) vs B (branch, v3.1). N ≥ 10 repetitions of scripted transcripts, including the 2026-09-26 message, a confirmation turn and correction turns | Opt-in `AI_REPLAY_LIVE=1 AI_REPLAY_RUNS=10`. Property assertions only, never exact wording: validation pass rate, contingency count, measurement-to-item attribution, correction scoping, and one `•` line per item in the `final_confirmation` reply |
| E2E | Live turn on `AI_PRD_CONTROLLED_PHONE_NUMBER` with `AI_PRD_V3_LINE_ITEMS=canary` and that phone listed | Replay the incident message through confirmation. Assert one lead and one ClickUp task listing Cierros de Hormigón and the wire, each with its own measurements, and no flat `Cantidad`/`Medidas` lines. Check `last_error` and `validation_errors` stay empty |

## Threat Matrix

N/A: the change has no routing, shell, subprocess, VCS/PR automation, executable-file classification or process-integration boundary. The switch only selects a pure in-process compiler.

## Migration / Rollout

1. Apply 025. It is a superset, so it is safe while v3 decisions are in flight. Then deploy each slice's workflows with `scripts/dev/sync-n8n-workflows.sh`. `AI_PRD_V3_LINE_ITEMS` stays `disabled`.
2. After slice 3, run the harness.
3. Set `AI_PRD_V3_LINE_ITEMS=canary` and `AI_PRD_V3_LINE_ITEMS_CANARY_PHONES=<controlled phone>`, then recreate n8n (`docker compose up -d n8n`). Run the E2E. Every other phone stays on v3.
4. Set `enabled` and recreate n8n.
5. Rollback, in order:
   1. Set `canary` (with an empty list) or `disabled`, then recreate n8n. New turns compile v3.
   2. Wait for executions whose decisions are `/v3.1` to leave their non-terminal states.
   3. Revert the workflows, then apply the down file.
   4. Rows keep their projection, and D3 reconciles on the next upgrade.

## Open Questions

- [ ] Does the ClickUp requirement custom field (`CLICKUP_CF_REQUIREMENT_ID`) accept newlines? The E2E verifies it. If it does not, the field gets a ` | ` join inside `build-clickup-payload.js`.
- [ ] Should the pending clarification persist its `item_id`? The current assumption is no: the item with `product:null` identifies it.
- [ ] Catalog seeds: v3 grounding ignores `service_keywords`, so "pandereta → Cierros de Hormigón after confirmation" is a v3.1 prompt rule. A seed edit only matters for the legacy route.
- [x] Version pinning: resolved. The delta spec's "Safe Versioned Rollout" allows a conversation to change contract version at a turn boundary, which matches D6.
