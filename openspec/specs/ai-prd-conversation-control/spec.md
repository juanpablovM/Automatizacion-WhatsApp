# Delta for AI PRD Conversation Control

## ADDED Requirements

### Requirement: AI-Led Versioned Conversation

For v3, the AI **MUST** be the sole interpreter and voice; accepted reply bytes **MUST** ship unchanged. Goals **MAY** block effects but **MUST NOT** prescribe copy or request order. Each reply **MAY** declare at most one primary request.

#### Scenario: Natural progression
- GIVEN known facts and unresolved goals
- WHEN a valid proposal answers and advances naturally
- THEN it ships unchanged without repeated facts or injected requests

### Requirement: Evidenced Semantic Proposal

A proposal **MUST** include exact reply text, zero or one primary request, and observations citing quote plus occurrence. The system **MUST** derive offsets and evidence digests; confidence **MUST NOT** authorize behavior. Multiple facts **MAY** progress together. A customer-correctable fact **MAY** be replaced only with evidence naming the prior fact.

#### Scenario: Facts and correction are evidenced
- GIVEN one message provides several facts and corrects a prior fact
- WHEN observations cite each value and the replaced fact
- THEN all allowlisted, unambiguous changes are eligible together

#### Scenario: Evidence is unsafe
- GIVEN a quote is absent, ambiguous, or ungrounded
- WHEN validation runs
- THEN no related state or effect is authorized

### Requirement: Atomic Grounded Authorization

Validation **MUST** reject the whole proposal when any reference, mapping, claim, prerequisite, permission, or effect is invalid. Service **MUST NOT** satisfy product. Sensitive claims and effects **MUST** be grounded and authorized. Operational payloads and identities **MUST** be system-derived.

#### Scenario: One member is invalid
- GIVEN one proposed member is invalid
- WHEN validation runs
- THEN nothing commits and machine-readable errors are returned

### Requirement: Durable Serialized Execution

An authorized decision **MUST** be immutable. Execution **MUST** persist stable decision, operation, and delivery keys; serialize turns per conversation; record receipts; durably commit supported mutations and delivery intent; and replay without regenerating replies or duplicating effects.

#### Scenario: Execution and replay
- GIVEN a decision has blocking effects and duplicate processing occurs
- WHEN required receipts succeed and execution resumes
- THEN one ordered commit and exact delivery use the original decision and keys

### Requirement: Bounded Recovery

A repairable proposal **MUST** receive at most one complete repair under identical policy and machine errors. Terminal failure **MUST** preserve pre-turn commercial state. Contingency copy **MUST** claim only receipted facts. An unknown effect **MUST NOT** retry until exact-key reconciliation proves no effect; inconclusive or duplicate results **MUST** require recovery.

#### Scenario: Repair succeeds
- GIVEN an initial proposal has repairable errors
- WHEN one valid complete repair is returned
- THEN authorization resumes under the original policy

#### Scenario: Failure remains honest
- GIVEN repair fails or an effect outcome is unknown
- WHEN recovery runs
- THEN state is preserved and no unreceipted claim or blind retry occurs

### Requirement: Safe Versioned Rollout

Each turn **MUST** retain one `legacy`, `shadow`, `canary`, or `enforce` route. Shadow **MUST** run asynchronously after legacy delivery with no v3 mutation, effects, or visible latency. Canary and enforce **MUST** use v3 recovery, not legacy reinterpretation. Rollback **MUST** affect only new turns while active v3 decisions finish or reconcile.

#### Scenario: Shadow and rollback stay isolated
- GIVEN shadow diverges and an active v3 turn faces rollback
- WHEN both routes execute
- THEN shadow stays invisible and effect-free while the active turn remains v3 and later turns use legacy

### Requirement: Complete Audit and Semantic Journeys

The system **MUST** recover policy, exchange, proposal, validation, decision, transitions, receipts, route, and delivery references with integrity digests. Acceptance **MUST** test properties, not exact wording, across multi-fact answers, questions, uncertainty, corrections, digressions, frustration, ambiguity, claims, effects, failures, replay, concurrency, shadow, and rollback.

#### Scenario: Audit and generated journeys
- GIVEN any interrupted turn and journeys varying wording and fact order
- WHEN audit and contract suites run
- THEN transitions are attributable and authority, evidence, one-request, safety, idempotency, and rollout properties hold
