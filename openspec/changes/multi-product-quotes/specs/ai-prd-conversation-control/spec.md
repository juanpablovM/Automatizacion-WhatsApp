# Delta for AI PRD Conversation Control

## ADDED Requirements

### Requirement: Item-Scoped Line Items, Goals, and Catalog Resolution

A quote's qualification context MUST support `line_items[]`, each with `item_id`, `product`, a required `quantity`, optional `measurements`, and a `catalog_ref` resolved independently per item. An item MAY carry additional system-derived internal fields beyond those listed; such fields MUST NOT be shown to the customer. `service_scope`, `fulfillment`, `commune`, `address`, and access facts MUST stay single per quote, never per item. A quote MUST NOT exceed 10 items; each item's required goals are its own resolved `product` and `quantity`. A quantity or measurement fact MUST attach only to the item its evidence names; the system MUST NOT copy one item's quantity or measurements to another item without explicit evidence for that item. Once confirmed, "pandereta" MUST resolve to the single catalog product "Cierros de Hormigón" with its own length and height, never a bundle of plates and posts.

#### Scenario: Live case — evidenced facts commit per item, no cross-item invention
- GIVEN "pandereta de 3 metros de altura con alambre púa. Son aprox 500 ml en la comuna de Lo Prado" and "pandereta" is unconfirmed
- WHEN the turn is processed
- THEN the wire item commits with product "Alambre de Púas" and no invented quantity, leaving its quantity goal unresolved; the pandereta item commits with quantity "500 ml" and measurements "3 metros de altura" while only its product is left for clarification; `commune` "Lo Prado" commits at quote level

### Requirement: Item-Scoped Corrections

A correction MUST apply only to the line item its evidence names, and MUST NOT alter another item's `product`, `quantity`, or `measurements`. If the target item is unclear, the system MUST ask which item before applying any mutation.

#### Scenario: Correction stays on the named item
- GIVEN item A is "Adoquín" and item B is an unmeasured fence item, and the customer says "mejor 3 metros de altura" about the fence
- WHEN the correction is authorized
- THEN only item B's measurements change; item A is unaffected

### Requirement: Idempotent Item Replay and Legacy Compatibility

Replaying a committed turn MUST upsert `line_items` by `item_id` without duplicating items, keeping `expected_snapshot_digest` stable. The system MUST read a historical flat `qualification_context` as one implicit item, and every write MUST also persist a derived flat projection of the primary item so flat-only readers and historical conversations keep working unchanged.

#### Scenario: Replay and legacy reads stay correct
- GIVEN a turn already committed two items, and a separate historical conversation has flat `qualification_context`
- WHEN the turn replays after duplicate delivery and the historical conversation continues
- THEN no duplicate item is created, and the historical conversation resumes and creates its lead unchanged

### Requirement: Itemized Lead, Task, and Notification Effects

Each quote MUST produce exactly one lead and one ClickUp task listing every line item's product, quantity, and measurements. The confirmation summary and the seller notification MUST list one line per item with that item's own quantity and measurements.

#### Scenario: One quote, one lead, itemized everywhere
- GIVEN a quote is confirmed with a fence item and a wire item
- WHEN the lead effect and messaging run
- THEN one lead and one ClickUp task list both items, and the confirmation summary and seller notification each show one line per item

## MODIFIED Requirements

### Requirement: Evidenced Semantic Proposal

A proposal **MUST** include exact reply text, zero or one primary request, and observations citing quote plus occurrence. The system **MUST** derive offsets and evidence digests; confidence **MUST NOT** authorize behavior. Multiple facts **MAY** progress together. A customer-correctable fact **MAY** be replaced only with evidence naming the prior fact. When a quote has multiple line items, a fact or correction observation **MUST** cite the `item_id` it targets, or cite quote-level scope when it names no item; a correction **MUST NOT** be authorized against an item unless its evidence unambiguously identifies that item.
(Previously: correction evidence named only the prior fact, with no item targeting.)

#### Scenario: Facts and correction are evidenced
- GIVEN one message provides several facts and corrects a prior fact
- WHEN observations cite each value and the replaced fact
- THEN all allowlisted, unambiguous changes are eligible together

#### Scenario: Evidence is unsafe
- GIVEN a quote is absent, ambiguous, or ungrounded
- WHEN validation runs
- THEN no related state or effect is authorized

#### Scenario: Correction target is unclear
- GIVEN a quote has two items and a correction's evidence names neither one
- WHEN validation runs
- THEN no item is mutated and the system asks which item the correction refers to

### Requirement: Atomic Grounded Authorization

Validation **MUST** reject the whole proposal when any reference, mapping, claim, prerequisite, permission, or effect is invalid, except for the per-item carve-out below. Service **MUST NOT** satisfy product. Sensitive claims and effects **MUST** be grounded and authorized. Operational payloads and identities **MUST** be system-derived. When a quote has multiple line items, one item's invalid catalog reference or product observation **MUST NOT** block authorization of other items' unambiguous, evidenced facts and mutations in the same proposal; only the invalid item's product mutation is withheld, and that item's own evidenced quantity and measurements **MUST** still commit normally. A proposal that would push a quote past 10 items **MUST** be rejected as a whole.
(Previously: any single invalid proposal member rejected the entire proposal, with no per-item carve-out, no retained-facts guarantee for the ambiguous item, and no item-count limit.)

#### Scenario: One member is invalid
- GIVEN one proposed member outside the item catalog-ambiguity carve-out is invalid
- WHEN validation runs
- THEN nothing commits and machine-readable errors are returned

#### Scenario: Ambiguous item retains its evidenced facts
- GIVEN a quote has a clear wire item and a pandereta item with evidenced quantity and measurements but an unconfirmed product
- WHEN validation runs
- THEN the wire item's facts commit, and the pandereta item's quantity and measurements commit too, while only its product mutation is withheld pending clarification

#### Scenario: Eleventh item is rejected
- GIVEN a quote already has 10 line items
- WHEN a proposal would add an 11th
- THEN the proposal is rejected as a whole and the customer is asked to prioritize or is handed off

### Requirement: Safe Versioned Rollout

Each turn **MUST** retain one `legacy`, `shadow`, `canary`, or `enforce` route. Shadow **MUST** run asynchronously after legacy delivery with no v3 mutation, effects, or visible latency. Canary and enforce **MUST** use v3 recovery, not legacy reinterpretation. Rollback **MUST** affect only new turns while active v3 decisions finish or reconcile. A change to the persisted conversation-state shape, such as introducing `line_items`, **MUST** be accompanied by a contract version change; `policy_digest` stays content-derived. Each turn **MUST** validate, repair and replay against the single contract version its policy was compiled with; a conversation **MAY** move to a newer contract version, or back to an older one on rollback, only at a turn boundary, and its committed state **MUST** remain readable by the version it moves to.
(Previously: no link between a conversation-state shape change and a contract version, and version consistency within a conversation was unstated.)

#### Scenario: Shadow and rollback stay isolated
- GIVEN shadow diverges and an active v3 turn faces rollback
- WHEN both routes execute
- THEN shadow stays invisible and effect-free while the active turn remains v3 and later turns use legacy

#### Scenario: Shape change is versioned
- GIVEN the item-aware `line_items` shape ships as a new contract version, and a conversation started before the change is mid-turn
- WHEN that turn is validated and replayed, and the conversation later crosses a turn boundary
- THEN the mid-turn validates and replays against its own compiled version with no digest mismatch, and the conversation moves to the newer version only at that later turn boundary while its already-committed state stays readable under it
