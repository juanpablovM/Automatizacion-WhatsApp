# Proposal: Complete Durable Handoff Delivery

## Intent

Close the Sales handoff delivery gap: qualified WhatsApp conversations can persist handoff operations, but ClickUp delivery can stop at the scheduler or become ambiguous. V1 must make Sales handoffs operationally reliable without changing the certified conversation flow or deployed dispatcher commit `791f9f3`.

## Business Problem

Operators need exactly one actionable Sales task when a customer asks for a human. Silent fallback, duplicate ClickUp tasks, or unresolved ambiguous operations create missed follow-up, support confusion, and unreliable CRM accountability.

## Goals / Non-Goals

- Goal: deliver Sales handoffs into a dedicated ClickUp list with deterministic ownership and idempotency.
- Goal: formally validate and later commit/deploy the three existing local per-item wrapper corrections.
- Non-goal: enable non-Sales area handoffs in V1.
- Non-goal: mutate runtime, ClickUp, or DB during proposal/spec/design/tasks.
- Non-goal: alter dispatcher `791f9f3` or certified conversation behavior.

## Scope

### In Scope
- Sales-only operational handoff path.
- Dedicated ClickUp List: `Handoffs WhatsApp` at the root of the validated accessible Space during apply; the previously selected Folder is hidden.
- Explicit defer-without-task behavior for areas lacking configured assignees.
- Stable idempotency: at most one ClickUp task per handoff.
- Close the preserved `unknown/reconciliation_required` test operation as failed test artifact, without task creation.

### Out of Scope
- Silent fallback from unknown/unassigned areas to Sales.
- Per-attempt ClickUp task creation.
- New non-Sales routing policy.

## Capabilities

### New Capabilities
- `durable-handoff-delivery`: Sales handoff task delivery, deferral, idempotency, and reconciliation behavior.

### Modified Capabilities
- None.

## Approach

Use the exploration recommendation: formalize existing local wrapper corrections, then add specs/design/tasks for GET-first reconciliation and guarded ClickUp dispatch. Apply must create `Handoffs WhatsApp`, validate assignees, preserve `operation_key`, avoid duplicate POSTs, and deploy only the corrected scheduler after focused checks pass.

## Safety and Idempotency

- One handoff maps to one stable operation/task identity.
- Reconciliation runs before POST when state is ambiguous.
- Unconfigured areas defer safely and produce no ClickUp task.
- The preserved test artifact is explicitly failed/closed, never replayed into ClickUp.

## Affected Areas

| Area | Impact | Description |
|------|--------|-------------|
| `tests/fixtures/workflow-nodes/ops-handoff-notification-scheduler/prepare-handoff-clickup-task.js` | Modified | Existing local wrapper fix to validate/formalize. |
| `n8n/workflows/ops-handoff-notification-scheduler.json` | Modified | Existing local scheduler wrapper alignment and future deployment unit. |
| `scripts/ops/test-handoff-routing-local.sh` | Modified | Existing focused check for wrapper/defer behavior. |
| `openspec/changes/complete-durable-handoff-delivery/` | New | SDD artifacts for proposal/spec/design/tasks/verification. |

## Risks

| Risk | Likelihood | Mitigation |
|------|------------|------------|
| Duplicate ClickUp task | Medium | GET-first reconciliation and stable idempotency key. |
| Missing assignee config | Medium | Defer without task; no Sales fallback. |
| Runtime drift | Low | Validate, commit, deploy scheduler only. |

## Rollback Plan

Revert the scheduler deployment to the prior workflow export, remove/disable the new ClickUp list usage, and keep affected operations deferred/failed rather than replaying ambiguous handoffs.

## Dependencies

- Valid ClickUp token, accessible Space, and Sales assignee mapping.
- Strict TDD checks before implementation and verification.

## Success Criteria

- [ ] Sales handoff creates exactly one task in `Handoffs WhatsApp`.
- [ ] Missing assignee area defers with no ClickUp task.
- [ ] Preserved ambiguous test operation is closed as failed artifact.
- [ ] Existing local wrapper corrections are formally validated, committed, and scheduler-deployed without touching dispatcher `791f9f3`.
