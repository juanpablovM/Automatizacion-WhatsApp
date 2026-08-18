# Apply Progress: Complete Durable Handoff Delivery

## Cumulative Completed Tasks

- [x] 1.1 Review the three existing GREEN wrapper-fix files and codify their exact current behavior as the baseline.
- [x] 1.2 Keep the per-item `$json`/`$env` wrapper contract unchanged while documenting the preserved output shape.
- [x] 2.1 Add RED tests for assignee validation: invalid JSON, missing Sales mapping, inactive/unassignable assignee, and zero POST on defer.
- [x] 2.2 Add RED tests for GET-first reconciliation and bound no-effect authorization: zero/one/multiple exact-marker matches and stale/consumed authorization rejection.
- [x] 2.3 Add RED tests for state/audit transitions: claim CAS, succeeded/notified audit persistence, failed/unknown terminality, and no replay of the preserved test operation.
- [x] 3.1 Implement the dedicated ClickUp list/config path only after read-only validation, writing assignee config only when preflight passes.
- [x] 3.2 Implement scheduler-only deployment and rollback around the exported scheduler identity, leaving dispatcher `791f9f3` untouched.
- [x] 3.3 Close the preserved `unknown/reconciliation_required` operation as failed test artifact with no task replay.

## Previous Work Unit: Fix Scheduler Normalizer and Deploy

**Delivery**: `auto-chain` / `feature-branch-chain` — PR 3 slice, `fix-scheduler-normalizer-and-deploy`; one authorized scheduler-only deployment attempt. No direct ClickUp task POST command, dispatcher/orchestrator edit, inbound/acceptance execution, preserved-operation replay, commit, push, or PR occurred.

### Task State

- [x] 3.1 Previously complete; not rerun.
- [x] 3.2 Completed: Strict-TDD scheduler projection removes runtime-only metadata, preserves semantic nodes/connections/settings/tags/pinData, canonicalizes with `jq -cS`, resolves `errorWorkflow` from `workflow-links.json` before import, and writes a source-free bounded diagnostic before rollback on parity failure. Activation uses `n8n update:workflow`; one scheduler-only transaction passed exact scheduler parity and dispatcher parity before/after.
- [x] 3.3 Previously complete; not rerun.
- [x] 4.1 Completed later by the final evidence-only unit; see the current work unit below.
- [x] 4.2 Completed later by the final evidence-only unit; see the current work unit below.

### TDD Cycle Evidence

| Task | Test File | Layer | Safety Net | RED | GREEN | TRIANGULATE | REFACTOR |
|---|---|---|---|---|---|---|---|
| 3.2 | `scripts/ops/test-handoff-delivery-ops-local.sh` | Ops contract + runtime deploy | PASS — focused guard passed before changes. | PASS — added failing scheduler-parity tests before production code for reordered keys/runtime fields and supported activation. | PASS — focused guard passed after projection, errorWorkflow resolution, diagnostic, and CLI activation changes. | PASS — equivalent reordered export passes; changed wrapper, connection, and errorWorkflow each fail. | PASS — one projection is shared by comparison; diagnostic retains only bounded shape/hashes. |

### Work Unit Evidence

| Evidence | Result |
|---|---|
| Focused test command and exact result | `sh scripts/ops/test-handoff-delivery-ops-local.sh && sh scripts/ops/test-handoff-routing-local.sh` → exit 0; logical scheduler parity plus routing integrity passed. |
| Full test command and exact result | `sh scripts/ops/test-ai-assistant-local.sh && sh scripts/ops/test-conversation-regression-local.sh` → exit 0; 9 simulated AI scenarios plus fallback and 33 conversation cases passed. |
| Runtime harness command/scenario and exact result | One `sh scripts/ops/deploy-handoff-scheduler.sh deploy` → exit 0: fresh scheduler snapshot, pause, import manifest-resolved candidate, exact post-import logical parity, post-import dispatcher parity, then n8n CLI activation. |
| Deployment and rollback result | Deployment succeeded; rollback remained armed until scheduler and dispatcher parity completed, then was disarmed. On a future parity failure, the snapshot is restored with prior active state and the sanitized diagnostic remains. |
| Dispatcher negative control | PASS before and after import — logical parity to certified `791f9f3` passed; no dispatcher write command ran. |
| Static integrity and stack health | `sync-n8n-workflows.sh --preflight`, `jq -e`, `sh -n`, and `git diff --check` → exit 0. Compose config passed; n8n, PostgreSQL, Redis, and Evolution API run; scheduler active state is `true`. |
| Rollback boundary | Runtime: the ignored scheduler snapshot restored by `scripts/ops/deploy-handoff-scheduler.sh`; source: `scripts/ops/deploy-handoff-scheduler.sh`, `scripts/ops/test-handoff-delivery-ops-local.sh`, and `n8n/workflows/ops-handoff-notification-scheduler.json`. No dispatcher behavior is in the rollback boundary. |

### Result Contract

- **Sanitized structural parity**: PASS. The logical projection compares canonical JSON while retaining semantic nodes, connections, settings, tags, and pinData; only runtime fields are removed. Failure evidence is source-free bounded shapes and hashes.
- **Deploy/activation**: PASS. Exactly one authorized scheduler-only deployment resolved candidate `errorWorkflow` from the manifest, imported, re-exported, compared equal, and activated with `n8n update:workflow`.
- **Scheduler identity/active state**: PASS. Exact runtime identity was confirmed; current scheduler state is `active=true`.
- **Dispatcher proof**: PASS before and after mutation against `791f9f3`; no dispatcher write occurred.
- **Rollback**: AVAILABLE. The fresh scheduler snapshot and prior active state are restored automatically on any failure before disarm.
- **Churn**: 2 production/test files changed in this work unit; no commit was created.
- **Stop condition**: 3.2 is complete. STOP before 4.1–4.2; no direct ClickUp task POST command, acceptance, inbound activity, dispatcher/orchestrator change, commit, push, or PR work was started.

## Current Work Unit: Correct Acceptance Evidence and Complete Regression

**Delivery**: `auto-chain` / `feature-branch-chain` — final PR 3 evidence-only slice; maximum 40 changed lines; one native read-only attempt. No external event, retry, replay, message, ClickUp POST, deploy, runtime/production-DB mutation, code behavior change, commit, push, or PR was made.

> Warning: the explicitly requested `test-handoff-routing-local.sh` regression uses its built-in disposable PostgreSQL harness, which creates and drops an isolated `crm_whatsapp_handoff_<pid>` database. No persistent application data was mutated, but this is technically a temporary DB mutation.

### Task State

- [x] 4.1 Completed: the existing authorized acceptance has exactly one Sales handoff, one succeeded operation with one attempt, one external task identity, notified handoff, terminal audit, and zero duplicate handoffs/operations. Read-only ClickUp GET reconfirmed the task in the dedicated list with the configured owner and exactly one matching task row.
- [x] 4.2 Completed: focused ops/handoff/dispatcher checks, full AI (9 scenarios) and conversation (33 cases) regressions, source checks, stack health, and runtime scheduler/dispatcher logical parity all passed.

### Corrected Acceptance Interpretation

- The accepted conversation scope contains `incoming_rows=1` and `outgoing_rows=1`; schema direction is `incoming|outgoing`, never `outbound`.
- The outgoing row is `sent=0, unknown=1` because the provider returned HTTP 500. It is `reconciliation_required`, so delivery is indeterminate and MUST NOT be replayed.
- This does not invalidate the terminal handoff criteria: task delivery, external identity, notification, audit, ownership/list, and zero-duplicate requirements all passed. Confirmed WhatsApp delivery is not a proposal/spec/design requirement; outbound state is an informative regression observation.

### TDD Cycle Evidence

| Task | Test File | Layer | Safety Net | RED | GREEN | TRIANGULATE | REFACTOR |
|---|---|---|---|---|---|---|---|
| 4.1 | No production change | Read-only runtime evidence | PASS — existing focused contracts passed before evidence review. | N/A — no behavior was added. | PASS — DB snapshot before/after and ClickUp GET retained the same successful handoff/task evidence. | N/A — no second event is authorized; no replay is permitted. | N/A — no code change. |
| 4.2 | `scripts/ops/test-handoff-delivery-ops-local.sh`, `scripts/ops/test-handoff-routing-local.sh`, `scripts/ops/test-dispatcher-runtime-integrity-local.sh` | Integration/contract | PASS — focused checks passed. | N/A — no production behavior was added. | PASS — focused checks plus AI 9 and conversation 33 regressions passed. | PASS — Sales success, validation deferral, error classes, stale closure, scheduler parity, and dispatcher parity covered. | N/A — no code change. |

### Work Unit Evidence

| Evidence | Result |
|---|---|
| Focused test command and exact result | `sh scripts/ops/test-handoff-delivery-ops-local.sh && sh scripts/ops/test-handoff-routing-local.sh && sh scripts/ops/test-dispatcher-runtime-integrity-local.sh all` → exit 0. The routing test created/dropped only its isolated disposable test database. |
| Runtime harness command/scenario and exact result | Read-only DB snapshot → ClickUp task/list GET → same DB snapshot: task list/owner/exact-row invariants passed; handoff/task evidence was unchanged. No event, message, retry, replay, scheduler invocation, or ClickUp POST ran. |
| Full regression | `sh scripts/ops/test-ai-assistant-local.sh && sh scripts/ops/test-conversation-regression-local.sh` → exit 0; 9 simulated AI scenarios and 33 conversation cases passed. |
| Static/runtime checks | `sh scripts/dev/sync-n8n-workflows.sh --preflight && sh scripts/dev/sync-n8n-workflows.sh --verify-remote`, `jq`, `sh -n`, and `git diff --check` → exit 0; all four stack services running. |
| Scheduler/dispatcher parity | Read-only exports passed logical scheduler parity and logical dispatcher parity against certified `791f9f3`. |
| Exact-one observed counts | handoff_rows=1, operation_rows=1, operation_succeeded=true, attempts=1, external_identity=true, notified=true, terminal_audit=true, incoming_rows=1, outgoing_rows=1, sent=0, unknown=1, duplicate_handoffs=0, duplicate_operations=0. |
| Scheduler execution evidence | Existing successful acceptance executed `Should Send Response` and `Execute Outbound Response`; the outbound workflow queued/sent its one attempt, then the provider returned HTTP 500. The persisted outgoing row is therefore unknown/reconciliation-required, not absent. |
| Rollback boundary | Only `openspec/changes/complete-durable-handoff-delivery/{tasks,apply-progress}.md` evidence text changed. Revert those two artifact edits to undo this work; no runtime or behavior change exists. |

### Result Contract

- **Acceptance**: PASS. The successful terminal Sales handoff has exactly one task in the correct list/owner context, with succeeded operation, external identity, notified state, terminal audit, and zero duplicates.
- **Outbound observation**: INFORMATIVE / INDETERMINATE. `outgoing_rows=1, sent=0, unknown=1`; HTTP 500 requires reconciliation and prohibits replay.
- **Regression**: PASS. Focused ops/handoff/dispatcher, 9+33 full regressions, source/stack checks, and scheduler/dispatcher parity all passed.
- **Safety**: PASS with warning. No external event, retry, replay, message, ClickUp POST, deploy, production-data mutation, code behavior change, commit, push, or PR occurred. The requested routing test's isolated disposable DB was created and dropped.
- **Completion**: 10/10 tasks complete; ready for `sdd-verify`.

## Focused Strict-TDD Remediation: Failed Evidence `sha256:30715ec9309fff545bfbab26f7afc2733dd70c9361cbb323cd2386b268408fce`

**Scope**: One bounded correction for the four critical verification findings only. The candidate changes Sales-only preparation, exact `Operation key:` payload identity, and the scheduler's authorization-gated GET-first reconciliation. No dispatcher, conversation, runtime, external API, acceptance, scheduler invocation, replay, deployment, commit, push, or PR action was performed.

### Cumulative Task State

The prior 10 completed tasks remain checked in `tasks.md`; this correction does not reopen or add a delivery task. Native settlement is intentionally not attempted: the orchestrator-provided attempt token is preserved, and the required native lineage/generation/fix-batch tuple was not supplied to this executor.

### TDD Cycle Evidence

| Task | Test File | Layer | Safety Net | RED | GREEN | TRIANGULATE | REFACTOR |
|---|---|---|---|---|---|---|---|
| Focused remediation | `scripts/ops/test-handoff-routing-local.sh` | Fixture contract + disposable PostgreSQL integration | PASS — baseline exited 0. | PASS — changed the normative assertions first; the command failed at the former `claims` dispatch assertion. | PASS — after the smallest scheduler correction, the focused command exited 0. | PASS — `claims` mapped/no-POST; exact marker; zero/one/multiple GET outcomes; denied/consumed authorization; and SQL claim after `authorize-handoff-no-effect.sql` are covered. | PASS — added one typed sync entry so scheduler SQL and its canonical query cannot drift. |

### Work Unit Evidence

| Evidence | Result |
|---|---|
| RED command | `sh scripts/ops/test-handoff-routing-local.sh` → exit 1 at the previous `claims` dispatch expectation (`actual: true`, `expected: false`). |
| GREEN focused command | `sh scripts/ops/test-handoff-routing-local.sh` → exit 0; the disposable `crm_whatsapp_handoff_<pid>` database was dropped by its EXIT trap. |
| Required regression | `sh scripts/ops/test-ai-assistant-local.sh && sh scripts/ops/test-conversation-regression-local.sh` → exit 0; AI 9 scenarios and conversation 33 cases passed. |
| Static/sync checks | `git diff --check && node tests/scripts/sync-workflow-nodes.mjs --check && jq empty n8n/workflows/ops-handoff-notification-scheduler.json && sh -n scripts/ops/test-handoff-routing-local.sh` → exit 0. |
| Cleanup | Disposable PostgreSQL harness database count is `0`; no external ClickUp or WhatsApp action ran. |
| Rollback boundary | Revert only `db/queries/n8n/handoff-routing/02_claim_notification.sql`, scheduler workflow/fixture sources, `scripts/ops/test-handoff-routing-local.sh`, and `tests/scripts/sync-workflow-nodes.mjs`; no dispatcher or conversation behavior is included. |

### Native Attempt Boundary

- Failed evidence revision: `sha256:30715ec9309fff545bfbab26f7afc2733dd70c9361cbb323cd2386b268408fce`.
- Preserved native attempt token: `sha256:f79f52da7391f9b4d71e17b3b5a324a6adfafab6addd644344221eb049bda5fb`.
- No native attempt was acquired or settled. Because no native lineage, generation, and fix-batch status was provided, no remediation settlement envelope is asserted here.
