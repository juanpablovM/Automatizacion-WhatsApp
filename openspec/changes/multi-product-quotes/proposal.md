# Proposal: Multi-Product Quotes

## Intent

Customers ask for several products in one message ("una pandereta de 3 metros con alambre de púas, 500 ml en Lo Prado"). The v3 contract stores exactly one `product`/`quantity`/`measurements` per quote. Two live incidents on 2026-09-26:

- A second product recorded next to an ambiguous one was rejected twice by the validator and the turn fell to contingency (mitigated only by the prompt in `c6d56c1`).
- A second product replaced `product` while the first product's `measurements` stayed: "3 metros de altura" ended up on Adoquín, and "alambre de púas" was never stored as data.

v3 is the default production route, so each multi-product request today risks contingency or a wrong lead. The seller gets a requirement that does not match what the customer asked for.

## Scope

### In Scope
- `qualification_context.line_items[]`: `{ item_id, product, quantity, measurements?, catalog_ref }`.
- Quote-level facts stay single: `service_scope`, `fulfillment`, `commune`, `address`, access facts.
- Clear items are recorded immediately. Only the ambiguous item is clarified.
- "Pandereta", once the customer confirms it, resolves to the single catalog product "Cierros de Hormigón", with its own length and height.
- One lead and one ClickUp task per quote, listing every item.
- An itemized confirmation summary and seller notification.
- Corrections apply only to the item the customer names.
- Dual-read of historical flat `qualification_context`.

### Out of Scope
- Per-item `service_scope`, `fulfillment` or address.
- Catalog bundles or composites, such as plates + posts.
- One lead or task per item.
- Backfilling historical rows into `line_items`.

### Defaults for owner review (decisions 5–8, changeable)
5. Every item has its own quantity. Measurements are optional.
6. A quote holds at most 10 items. Beyond that, the advisor asks the customer to prioritize, or hands off.
7. The summary and the seller notification show one line per item, with its quantity and measurements.
8. When the item a correction refers to is unclear, the advisor asks.

## Capabilities

### New Capabilities
None.

### Modified Capabilities
- `ai-prd-conversation-control`: evidenced proposals, grounded authorization and audit become item-aware. Changes include per-item catalog resolution, item-scoped mutations and itemized lead effects. The contract version changes under the existing Safe Versioned Rollout rules.

## Approach

Approach 1 from the exploration (a `line_items` array with quote-level modality):
- **Contract.** The policy builder and runtime get item-aware facts, goals and mutations keyed by `field + item_id`. `catalog_resolution` becomes per item, so an ambiguous item no longer blocks a clear one. The runtime rejects duplicate mutations on the same item field and rejects quotes over 10 items.
- **SQL.** `apply_v3_state_mutations` becomes array-aware and replay-idempotent: upsert by `item_id`, never a blind append. Replaying a committed turn produces the same `expected_snapshot_digest`.
- **Compatibility.** A dual-read adapter maps flat rows to a single implicit item. The writer also keeps a derived flat projection so older code can still read new rows.
- **Versioning.** The schema and contract version strings change. `policy_digest` stays content-derived. The design phase must choose whether in-flight conversations stay pinned to their version or upgrade at a turn boundary.
- **Output.** The lead requirement and the ClickUp task are built from items. The prompt and schema teach the advisor item-scoped observations.

## Affected Areas

| Area | Impact |
|------|--------|
| `tests/fixtures/workflow-nodes/shared/v3-policy-builder.js`, `shared/v3-contract-runtime.js` | Modified: item-aware model |
| `build-ai-request.js` (schema and prompt) | Modified |
| `infra/postgres/migrations/` (new migration replacing `apply_v3_state_mutations`), `09_commit_v3_turn.sql`, `11_prepare_v3_effect.sql` | Modified |
| `wa-conversation-orchestrator/build-v3-lead-effect.js`, `02_create_lead.sql`, `prepare-lead-assignment.js`, ClickUp summary, seller notification | Modified |
| Catalog seeds (`pandereta` keyword) | Modified: resolve to `cierros-hormigon` after confirmation |
| About 14 unit test files, workflow-node fixtures, Postgres integration suites | Modified |

## Risks

| Risk | Likelihood | Mitigation |
|------|------------|------------|
| Regression on the default v3 route | High | Dual-read, a derived flat projection, and each slice deployable on its own |
| Replay appends duplicate items | Med | Upsert by `item_id`; replay integration tests |
| Shape change mid-conversation breaks the digest | Med | The design phase picks the version-pinning strategy; tests cover in-flight conversations |
| Model misattributes a correction to the wrong item | Med | Clarify when the item is unclear; A/B replay harness with N repetitions |
| Wide test blast radius and size above 800 lines | High | `auto-chain` slices |

## Rollout (auto-chain)

1. **Foundation.** Add the item model to the contract and SQL behind the dual-read adapter, with the flat projection still written. The advisor still emits one item, so behavior does not change.
2. **Advisor.** Change the prompt and schema to emit several items, add per-item catalog resolution, clarify only the ambiguous item, and scope corrections to the named item.
3. **Output.** Compose the lead, ClickUp task and seller notification from items.

## Rollback Plan

- **Per slice.** Revert the slice PR, starting from the latest slice. Each slice is backward-compatible with the previous one.
- **Runtime.** Run `scripts/dev/sync-n8n-workflows.sh --rollback <pre-deploy snapshot>` to restore the workflows from the deploy snapshot.
- **SQL.** A down migration restores the previous `apply_v3_state_mutations` definition. No columns are dropped.
- **Data.** Rows written with `line_items` keep the flat projection, so old code keeps working. It sees only the first or primary item, which is acceptable degradation. There is no destructive migration and no backfill to undo.

## Success Criteria

- [ ] A live E2E run on the controlled test phone replays the 2026-09-26 message and produces one lead and one ClickUp task listing the Cierros de Hormigón item and the wire item, each with the correct measurements.
- [ ] Clear item + ambiguous item: the clear item is recorded in the same turn, and there is no contingency.
- [ ] A/B replay with the real model over N ≥ 10 repetitions: no measurements attached to the wrong item, and corrections change only the named item.
- [ ] Contingency diagnostics on `conversation_turn_executions.last_error` and `advisor_decisions.validation_errors` show no multi-product rejection after the rollout.
- [ ] Historical flat conversations resume and create leads unchanged.
- [ ] `npm test`, `npm run check:parity`, `npm run check:sql-references` and the Postgres integration suite pass.
