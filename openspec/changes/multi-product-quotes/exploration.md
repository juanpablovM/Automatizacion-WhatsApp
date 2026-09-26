# Exploration: multi-product-quotes

## Business problem

Customers ask for several products in one quote, for example "una pandereta de 3 metros con alambre de púas, 500 ml en Lo Prado". A pandereta itself is concrete plates plus posts. The v3 conversation contract models exactly one product per quote. Two behaviors were observed live on 2026-09-26:

- The advisor recorded a second product in the same turn as an ambiguous one. The validator rejected it twice, and the turn fell to contingency. Commit `c6d56c1` mitigates this in the prompt: when a product is ambiguous, the advisor records no product and clarifies first.
- A second product mentioned in the same conversation replaced `product`, but the first product's `measurements` stayed. "3 metros de altura" ended up attached to Adoquín. "Alambre de púas" was never stored as data; it was only mentioned in the reply text.

## Current state: a flat, single-slot-per-field model end to end

1. **Policy builder.** `tests/fixtures/workflow-nodes/shared/v3-policy-builder.js` defines `POLICY_FIELDS` as scalar fields (`product`, `quantity`, `measurements`, ...). It emits one fact, one goal and one allowed mutation per field (`set` or `replace`). `requiredGoals` derives from the quote-level `service_scope` and `fulfillment`.
2. **Contract runtime.** `shared/v3-contract-runtime.js`:
   - `CONCEPT_TO_FIELD` is a strict 1:1 map.
   - `catalog_resolution` is a single object per proposal.
   - `catalog_resolution_conflict` rejects any `product` observation while the catalog resolution is `ambiguous` or `unsupported`.
   - Mutation validation does not deduplicate several mutations of the same field.
3. **SQL commit (the mechanism of the observed bug).** `infra/postgres/migrations/022_restore_conversation_turn_executions.sql`, `apply_v3_state_mutations`, runs `jsonb_set(v_result, ARRAY[v_field], projected_value)`. That is last-write-wins per top-level key, with no link between `product` and `measurements`.
4. **Lead effect.** `wa-conversation-orchestrator/build-v3-lead-effect.js` concatenates `REQUIREMENT_FIELDS = ['product','quantity','measurements','use_case']` into one `requirement` string.
5. **Lead creation.** `leads.service`, `leads.city` and `leads.requirement` are scalar columns (`db/queries/n8n/crm-lead-creation-and-assignment/02_create_lead.sql`, `prepare-lead-assignment.js`). `qualification_context` (jsonb) is carried opaquely.
6. **AI schema.** `build-ai-request.js` already accepts an array of observations. The single-product constraint lives in `CONCEPT_TO_FIELD` and the flat fact and mutation model, not in the AI-facing schema shape.
7. **Catalog.** `db/seeds/006_catalogo_hormiglass.sql` and `007_catalogo_hormiglass_actualizacion.sql` attach the keyword `pandereta` to six products: four plate variants, `placas-imitacion-madera` and `cierros-hormigon`. Posts (`postes-rectos`, `postes-curvos`) and wire (`alambre-puas`, `alambre-concertina`) are separate products. There is no composite or bundle concept.
8. **Confirmation and seller summaries.** The confirmation summary is AI-written `reply_text` and is not contract-enforced. The seller sees `leads.requirement` and the ClickUp task built from it.

## Affected areas

- **Contract core:** `v3-policy-builder.js`, `v3-contract-runtime.js`, `build-ai-request.js` (schema and prompt).
- **SQL:** `apply_v3_state_mutations` (migration 022), `09_commit_v3_turn.sql`, `11_prepare_v3_effect.sql`.
- **Lead path:** `build-v3-lead-effect.js`, `02_create_lead.sql`, `prepare-lead-assignment.js`, ClickUp lead/task summary, seller notification.
- **Catalog:** catalog seeds (keyword overlap, no bundles).
- **Tests:** about 14 test files bind the policy builder and contract runtime directly, plus workflow-node fixtures and the postgres integration suites.

## Approaches

1. **`line_items` array, quote-level modality (recommended).** `qualification_context.line_items = [{ item_id, product, quantity, measurements, catalog_ref }]`, while `service_scope`, `fulfillment`, `commune` and `address` stay quote-level. This matches how the business quotes.
   - Needs item-aware facts, goals and mutations (`field + item_id`), per-item catalog resolution, and an array-aware, replay-safe `apply_v3_state_mutations`.
   - Needs a per-item requirement composer and a dual-read path for historical flat rows.
   - Effort: high, likely above the 800-line budget, so chained PRs.
2. **Everything per item (including scope and fulfillment).** Fully general, but no evidence of demand. It roughly doubles the required-goal complexity and the room for hallucinated combinations. Effort: higher than approach 1.
3. **Keep a single product and open one lead per product.** No contract change. The cost is a poor customer experience and N leads or ClickUp tasks per real order, and it still does not solve catalog-level ambiguity. Effort: low to medium. Only valid as an explicit stopgap.

## Risks

- **Shape changes mid-conversation.** In-flight conversations must survive the change in `qualification_context` shape. `policy_digest` is content-derived and remains valid, but replay (`expected_snapshot_digest`) assumes a stable shape inside a conversation.
- **Replay determinism.** Array mutations must stay idempotent: replaying must not append duplicate items.
- **Default route.** v3 is the default production route, so the change is not opt-in. Historical rows without `line_items` must keep working (dual-read, no destructive backfill).
- **Catalog ambiguity.** Ambiguity such as "pandereta" is structural and coupled to this change.
- **Blast radius and size.** Test blast radius is wide, and the size exceeds the review budget, so chained PRs (`auto-chain`).

## Open business questions (to resolve before the proposal locks scope)

1. Does every item carry its own quantity and measurements?
2. Are installation and pickup/delivery decided for the whole quote, or per item?
3. Is there a maximum number of items per quote?
4. With one ambiguous item and one clear item, is the clear one recorded immediately?
5. Is there one lead and one ClickUp task per quote, or one per item?
6. How do the confirmation summary and the seller notification list the items?
7. Is "pandereta" resolved to one catalog product (for example "Cierros de Hormigón"), treated as a bundle (plates + posts), or asked component by component?
8. How is a correction scoped to the right item ("mejor 4 metros" for the fence, not the wire)?

## Recommendation

Approach 1, scoped after the product owner answers the questions above.

## Product owner decisions (2026-09-26)

1. Installation and pickup/delivery are decided for the whole quote, with one address (quote-level modality, approach 1).
2. With one clear item and one ambiguous item, the clear item is recorded immediately and only the ambiguous one is clarified.
3. One lead and one ClickUp task per quote, listing every item.
4. Once confirmed, "pandereta" is one catalog product, "Cierros de Hormigón", with its own length and height; the seller breaks it into plates and posts when quoting. No catalog bundles.

The following were proposed by the orchestrator as defaults. The owner may still change them in the proposal review:

5. Every item has its own quantity and optional measurements.
6. A quote holds at most 10 items.
7. The confirmation summary and the seller notification list items one per line, each with its quantity and measurements.
8. A correction applies to the item the customer names. If it is unclear which item it refers to, the advisor asks.
