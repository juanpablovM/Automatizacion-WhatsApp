# Design: Complete Durable Handoff Delivery

## Technical Approach

Keep dispatcher `791f9f3` and the certified conversation path unchanged. Adopt the current wrapper corrections, then extend only `OPS - Handoff Notification Scheduler` for Sales-only delivery, stable identity, guarded reconciliation, and transactional evidence. No non-Sales routing is added.

## Architecture Decisions

| Option | Tradeoff | Decision and rationale |
|---|---|---|
| Per-item Code wrappers | n8n and CommonJS expose different globals | Export pure functions; runtime uses only `$json`, `$env`, and `$helpers`, returning one `{ json: output }`. No legacy `helpers` fallback: the current Code-node contract does not require it. |
| Stable identity | GET-first work is slower than blind retry | Use unique `operation_key = handoff-clickup:{handoff_id}` and exact task marker `Operation key: {operation_key}` in request, response, and audit evidence; identity prevents per-attempt creation. |
| Bounded ambiguity resolution | A zero-match search cannot prove no effect | Search exact markers across every active/closed and archived list-task page. One match reconciles success; multiple matches produce a terminal duplicate incident; zero remains `reconciliation_required` unless specifically authorized as described below. |
| Sales assignee preflight | Deployment blocks on invalid ownership | Before configuration or deploy, read-only ClickUp calls prove every Sales assignee ID resolves to a joined, active workspace member assignable in the target list context. Invalid, inactive, inaccessible, or unresolvable results invalidate configuration and defer with no POST. |
| Scheduler-only deployment | Requires a narrow operator path | Snapshot, import, verify, activate, and roll back only the scheduler by exact runtime identity, preserving dispatcher and conversation behavior. |

The dedicated list is created or reused at the root of the same accessible Space through the folderless Space endpoint. This authorized rescope replaces the hidden Folder parent only; it does not change Sales-only delivery scope or ownership.

## Data Flow and State

```text
pending/retry-safe -> claim/CAS -> Sales + validated-config gate -> guarded POST
unknown/reconciliation_required -> paginated exact-marker GET
  one -> succeeded | multiple -> terminal duplicate incident
  zero -> reconciliation_required
       -> bound maintainer authorization -> consume by CAS -> one guarded POST
```

Defer restores `pending` without spending an attempt. Retryable failures become `failed+retry_safe`; non-retryable failures become terminal `failed`; ambiguous results become `unknown+reconciliation_required`. Success atomically stores `external_id/url`, marks the handoff `notified`, and writes audit evidence. Claim tokens reject stale completion.

For a future zero-match case, the maintainer records a no-effect authorization bound to `operation_key`, internal list identity, completed search horizon, and evidence revision. The horizon records exhaustive active/closed and archived pages; the revision binds the evidence set. A transaction consumes the authorization once, makes `unknown` reclaimable, and permits one guarded POST. Missing, mismatched, stale, or consumed authorization leaves `reconciliation_required`. The current test operation is ineligible and closes failed with no replay.

## Interfaces / Contracts

The preflight reads list/parent/workspace membership context, rejects invitations, inactive membership, and insufficient list access, and performs no POST. Stdout, stderr, artifacts, and audit metadata expose only redacted outcomes—never workspace, list, assignee, task, or token values. `HANDOFF_CLICKUP_ASSIGNEES_JSON` is written only after validation.

## File Impact

| File | Action |
|---|---|
| `tests/fixtures/workflow-nodes/ops-handoff-notification-scheduler/{prepare,dispatch}-handoff-clickup-task.js` | Modify wrappers, Sales gate, marker search, and guarded POST. |
| `n8n/workflows/ops-handoff-notification-scheduler.json` | Modify scheduler wiring only. |
| `db/queries/n8n/handoff-routing/{02_claim_notification,03_complete_notification}.sql` | Modify state/CAS/audit transitions. |
| `db/queries/ops/authorize-handoff-no-effect.sql` | Create bounded, one-use maintainer authorization. |
| `db/queries/ops/close-preserved-handoff-test-artifact.sql` | Create exact guarded terminal closure. |
| `scripts/ops/configure-handoff-clickup.sh` | Create/reuse list, perform read-only assignee preflight, then write ignored config. |
| `scripts/ops/deploy-handoff-scheduler.sh` | Create allowlisted scheduler-only deploy/rollback. |
| `scripts/ops/test-handoff-routing-local.sh` | Add Strict TDD coverage. |

No schema migration is required; existing JSONB/audit fields hold authorization evidence.

## Strict TDD Strategy

RED tests cover CommonJS plus `$json/$env/$helpers`, one output, Sales success, all invalid assignee classes with zero POSTs, redaction, stable markers, error classes, GET-before-POST, all search pages, and zero/one/multiple matches. State tests cover claim-token CAS, authorization binding/revision/one-use consumption, one authorized POST, audits, success, and test-artifact exclusion. Deployment and regression tests prove scheduler-only change and rollback.

## Threat Matrix

| Boundary | Applicability | Safe/failure behavior | Planned RED tests |
|---|---|---|---|
| Documentation-like paths | Applicable: deploy script accepts a workflow path | Only the exact scheduler JSON reaches Docker; reject before subprocess execution | Reject `requirements.txt`, `CMakeLists.txt`, executable Markdown/MDX, and `README.sh` |
| Git repository selection | N/A: no deploy-time Git selection | — | — |
| Commit state | N/A: no commit automation | — | — |
| Push state | N/A: no push automation | — | — |
| PR commands | N/A: no PR automation | — | — |

## Rollout / Rollback

Create or reuse the dedicated list; run read-only Sales assignee validation; only then write configuration and validate. Snapshot, pause, import, verify, and reactivate only the scheduler. Close the preserved test operation failed/no-replay, then run one controlled Sales acceptance. Rollback restores the scheduler snapshot and prior ignored configuration and never replays ambiguity.

## Open Questions

None.
