# Tasks: Complete Durable Handoff Delivery

## Review Workload Forecast

| Field | Value |
|-------|-------|
| Estimated changed lines | 500-700 |
| 400-line budget risk | High |
| Chained PRs recommended | Yes |
| Suggested split | PR 1 audit/adopt wrappers → PR 2 RED tests + state/authorization → PR 3 scheduler/config/deploy + verification |
| Delivery strategy | auto-chain |
| Chain strategy | feature-branch-chain |

Decision needed before apply: No
Chained PRs recommended: Yes
Chain strategy: feature-branch-chain
400-line budget risk: High

### Suggested Work Units

| Unit | Goal | Likely PR | Focused test command | Runtime harness | Rollback boundary |
|------|------|-----------|----------------------|-----------------|-------------------|
| 1 | Audit/adopt the 3 existing GREEN wrapper-fix files without changing exact behavior. | PR 1 | `sh scripts/ops/test-handoff-routing-local.sh` | N/A — preserve current wrapper semantics only; no runtime mutation | `tests/fixtures/workflow-nodes/ops-handoff-notification-scheduler/*.js` |
| 2 | Add RED coverage for assignee validation, GET-first reconciliation/no-effect authorization, state/audit transitions, and preserved test closure. | PR 2 | `sh scripts/ops/test-handoff-routing-local.sh && sh scripts/ops/test-conversation-regression-local.sh` | N/A — read-only evidence only | `db/queries/n8n/handoff-routing/*.sql`, `db/queries/ops/*.sql`, `scripts/ops/test-handoff-routing-local.sh` |
| 3 | Wire scheduler-only deploy/configuration for the dedicated ClickUp list after read-only validation, then verify conversation/dispatcher regression. | PR 3 | `sh scripts/ops/test-ai-assistant-local.sh && sh scripts/ops/test-conversation-regression-local.sh` | Scheduler snapshot/import/activate/rollback only; no dispatcher change | `scripts/ops/configure-handoff-clickup.sh`, `scripts/ops/deploy-handoff-scheduler.sh`, `n8n/workflows/ops-handoff-notification-scheduler.json` |

## Phase 1: Foundation / Audit

- [x] 1.1 Review the three existing GREEN wrapper-fix files and codify their exact current behavior as the baseline.
- [x] 1.2 Keep the per-item `$json`/`$env` wrapper contract unchanged while documenting the preserved output shape.

## Phase 2: Strict TDD RED Coverage

- [x] 2.1 Add RED tests for assignee validation: invalid JSON, missing Sales mapping, inactive/unassignable assignee, and zero POST on defer.
- [x] 2.2 Add RED tests for GET-first reconciliation and bound no-effect authorization: zero/one/multiple exact-marker matches and stale/consumed authorization rejection.
- [x] 2.3 Add RED tests for state/audit transitions: claim CAS, succeeded/notified audit persistence, failed/unknown terminality, and no replay of the preserved test operation.

## Phase 3: Core Wiring

- [x] 3.1 Implement the dedicated ClickUp list/config path only after read-only validation, writing assignee config only when preflight passes.
- [x] 3.2 Implement scheduler-only deployment and rollback around the exported scheduler identity, leaving dispatcher `791f9f3` untouched.
- [x] 3.3 Close the preserved `unknown/reconciliation_required` operation as failed test artifact with no task replay.

## Phase 4: Verification / Cleanup

> Current apply status: the prior failed acceptance is terminally closed as a no-recovery test artifact. The one authorized controlled acceptance reached terminal ClickUp delivery and persisted exactly one `outgoing` message row. Its provider HTTP 500 leaves that row `unknown` and `reconciliation_required`; delivery is indeterminate and MUST NOT be replayed. Final read-only evidence and regressions passed.

- [x] 4.1 Prove exactly one task and terminal DB/audit evidence for the happy path, plus conversation/dispatcher regression. (Read-only DB snapshots and ClickUp GET confirmed one task, one succeeded operation, external identity, notified handoff, terminal audit, zero duplicates, and `outgoing_rows=1, sent=0, unknown=1`; no retry or replay.)
- [x] 4.2 Re-run strict TDD regression for sales-only mapping and deferred unsupported areas before marking the slice done. (Focused ops/handoff/dispatcher checks and the 9-scenario AI plus 33-case conversation regressions passed.)
