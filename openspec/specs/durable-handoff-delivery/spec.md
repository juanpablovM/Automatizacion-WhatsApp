# Durable Handoff Delivery Specification

## Purpose

Define V1 Sales handoff delivery into ClickUp with deferral, idempotency, reconciliation, and evidence. It MUST NOT change dispatcher `791f9f3` or certified conversation behavior.

## Requirements

### Requirement: Sales-only task destination

The system MUST create V1 handoff tasks only for Sales handoffs and only in the dedicated ClickUp list named `Handoffs WhatsApp`.

#### Scenario: Sales handoff creates task in dedicated list

- GIVEN a recoverable Sales handoff ready for delivery
- WHEN the scheduler delivers it
- THEN exactly one ClickUp task SHALL exist in `Handoffs WhatsApp`

### Requirement: Per-item prepare output contract

The per-item prepare wrapper MUST emit exactly one output item per claimed input and MUST NOT finish successfully with zero items.

#### Scenario: Claimed item always yields one result

- GIVEN one claimed handoff operation enters prepare
- WHEN preparation completes
- THEN the prepare result SHALL contain exactly one item

### Requirement: Safe deferral without fallback

The system MUST defer missing assignees and unsupported areas without ClickUp POST, task creation, or Sales fallback; the operation MUST remain recoverable.

#### Scenario: Unsupported or unassigned area defers

- GIVEN a handoff has no configured supported assignee
- WHEN delivery is evaluated
- THEN no ClickUp POST SHALL occur
- AND the handoff SHALL be deferred with recoverable evidence

### Requirement: Stable one-handoff one-task idempotency

The system MUST bind each handoff to one stable operation identity using `operation_key` and idempotency evidence, and MUST NOT create more than one task for the same handoff.

#### Scenario: Duplicate attempt reuses identity

- GIVEN a handoff already has idempotency evidence
- WHEN delivery is retried
- THEN the system SHALL reconcile against that identity before creating anything

### Requirement: Ambiguous operation reconciliation

Ambiguous operations MUST perform GET-first reconciliation before any ClickUp POST and MUST NOT POST while prior external effect is unresolved.

#### Scenario: Ambiguous state blocks POST until reconciled

- GIVEN an operation is ambiguous or `reconciliation_required`
- WHEN the scheduler processes it
- THEN ClickUp state SHALL be fetched before any POST is allowed

### Requirement: Preserved test artifact closure

The preserved current test operation MUST be closed explicitly as a failed test artifact, with no ClickUp task creation and no replay.

#### Scenario: Preserved test operation is not replayed

- GIVEN the preserved ambiguous test operation is identified
- WHEN cleanup is applied
- THEN it SHALL be marked failed as a test artifact
- AND no task SHALL be created or replayed

### Requirement: Successful delivery persistence and audit

On ClickUp success, the system MUST persist `external_id` and URL, mark the external operation succeeded, mark the handoff notified, and write terminal audit evidence.

#### Scenario: Successful task closes operation

- GIVEN ClickUp confirms task creation
- WHEN delivery is finalized
- THEN external identity, success state, notification state, and terminal audit SHALL be persisted

### Requirement: ClickUp response error semantics

Retryable ClickUp failures MUST remain retryable without duplicate task risk; non-retryable failures MUST become terminal; ambiguous responses MUST require reconciliation.

#### Scenario: Response class determines terminality

- GIVEN ClickUp returns retryable, non-retryable, or ambiguous evidence
- WHEN the scheduler records the result
- THEN the operation SHALL be retryable, terminal failed, or reconciliation-required respectively

### Requirement: Deployment isolation

The implementation MUST deploy scheduler changes only and MUST leave dispatcher `791f9f3` and conversation behavior unchanged.

#### Scenario: Scheduler-only deployment preserves conversation path

- GIVEN the change is deployed
- WHEN regression evidence is collected
- THEN dispatcher identity and conversation behavior SHALL remain unchanged


### Requirement: Strict TDD acceptance evidence

Implementation MUST follow Strict TDD and MUST include evidence for happy paths, error classes, idempotent retries, deferral, no fallback, no replay, and no dispatcher/conversation mutation.

#### Scenario: Negative controls are required

- GIVEN verification runs for this change
- WHEN evidence is reviewed
- THEN negative controls SHALL prove no unsupported-area POST, duplicate task, replay, or dispatcher mutation occurred
