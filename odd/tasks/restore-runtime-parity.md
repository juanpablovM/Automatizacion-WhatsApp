# Restore Runtime Parity

## Objective

Restore and certify the n8n runtime workflow topology, then update the canonical project status with observed evidence.

## Problem

The repository already declares and validates `OPS - Error Handler`, but the running n8n workflows lack the required `settings.errorWorkflow` linkage. Remote verification therefore fails even though local source and regression gates pass.

## Why

Runtime parity must be trustworthy before the two local fixes can be deployed or represented as delivered.

## Authorized scope

- Prepare and execute the existing guarded n8n synchronization flow after explicit remote-operation authorization.
- Verify remote workflow parity and controlled acceptance.
- Update `docs/estado-actual.md` from observed results.
- Keep the existing commits `01a5c0d` and `1426f83` unchanged.

## Out of scope

- Direct n8n database patches.
- Push, pull request creation, or merge without separate authorization.
- Unrelated B2B, ClickUp closure, U7/U8, or orphan-workflow backlog changes.

## Constraints

- Use the guarded sync script; do not bypass rollback, acceptance, or parity checks.
- Remote work requires explicit destination, operation, and credential/session authorization.
- Technical artifacts remain in English.
- RDD is enabled globally; assess each work-unit commit through the native review flow.
- Delivery strategy: `ask-on-risk` (default).

## TDD

- Mode: strict TDD enabled.
- Source: `openspec/config.yaml` and Engram testing-capabilities observation #2.
- Configured runner: `sh scripts/ops/test-ai-assistant-local.sh && sh scripts/ops/test-conversation-regression-local.sh`.
- This repair changes no behavior code. Existing regression coverage already proves the expected link contract, so no synthetic RED will be fabricated; operational and documentation checks apply.

## Forecast

- Estimated authored changes: 100–160 lines, excluding runtime state.
- Below the ~400-line delivery threshold; no chained delivery is currently required.

## Tasks

- [x] **RRP-1 — Restore and certify runtime topology**
  - Route: direct inline operational execution.
  - Trigger evidence: preparation was delegated because the required understanding crossed four files and prepared a runtime mutation.
  - Preconditions: explicit authorization naming the runtime destination, guarded deploy operation, and credential/session to use.
  - Run the guarded synchronization with the authorized controlled test number.
  - Re-run remote verification and record all pass/fail/rollback evidence.
  - Acceptance criteria:
    - Exactly one error-handler workflow exists.
    - Every non-handler workflow points to its exact runtime ID.
    - All declared Execute Workflow links resolve exactly.
    - Declared workflow activation and webhook readiness checks pass.
    - Controlled acceptance passes, or rollback is observed and reported.
  - Checks:
    - `sh scripts/dev/sync-n8n-workflows.sh --preflight` — observed PASS during preparation.
    - `sh scripts/ops/test-dispatcher-runtime-integrity-local.sh sync` — observed PASS: 1 valid case and 9 rejected invalid cases.
    - `npm run test:smoke` — observed PASS: 76/76.
    - `scripts/dev/sync-n8n-workflows.sh --verify-remote` — observed PASS before acceptance, after acceptance, and after activation.
  - Runtime receipt:
    - Guarded deploy exited `0` after importing 17 workflows through bootstrap, resolved-link, isolated-acceptance, and post-acceptance candidate stages.
    - Controlled acceptance created lead `220` in `assigned` state and the replay passed its idempotency check.
    - The ClickUp synchronization audit was observed, declared workflows were reactivated, and Entry POST/health webhooks passed readiness.
    - Non-blocking warnings: Node emitted `DEP0040` for `punycode`; readiness retries observed one connection reset and one transient `404` before the gate passed.
  - Work-unit commit: `286adb9` (`docs(ops): record restored runtime parity`).
  - RDD outcome: medium risk, `under_budget`.

- [x] **RRP-2 — Publish an evidence-backed status cut**
  - Route: delegated writer.
  - Trigger evidence: substantial work includes the feature document plus canonical status documentation; preparation was already delegated.
  - Update `docs/estado-actual.md` only after RRP-1 produces current evidence.
  - Record the two branch-only commits, actual remote-verification result, acceptance result, and every failed, skipped, or pending check.
  - Acceptance criteria:
    - No stale claim that remote verification passes when it does not.
    - Runtime, repository, and delivery state are clearly separated.
    - Historical backlog is labelled as needing revalidation.
  - Checks:
    - Documentation claims match the RRP-1 receipt and current Git state.
    - Focused documentation diff review.
  - Work-unit commit: `0b726e3` (`docs(status): publish certified runtime state`).
  - RDD outcome: medium risk, `under_budget` (199 accumulated changed lines from boundary `1426f83`).

## Progress

- Preparation confirmed the repository source is already correct; no source fix is justified.
- Local preflight, topology regression, and smoke checks pass.
- Runtime synchronization completed successfully with explicit authorization.
- RRP-1 acceptance, replay, activation, webhook readiness, and final remote verification passed.
- RRP-1 was recorded in `286adb9`; native RDD assessment returned medium risk and `under_budget`.
- RRP-2 updated the canonical status cut in `0b726e3` and passed focused documentation checks.
- Native RDD assessment remains medium risk and `under_budget`; no review transition is due yet.

## Verification evidence

- `n8n/workflow-links.json` declares `OPS - Error Handler`.
- `scripts/dev/sync-n8n-workflows.sh` resolves and injects the runtime error-handler ID, verifies exact links, performs controlled acceptance, and rolls back on failure.
- Current branch: `feat/afinar-hormi-atencion`; it started this change clean with two delivery commits ahead and remains one merge commit behind `main`.

## Next step

Reconcile the branch with `main` before delivery, then obtain explicit GitHub authorization before push or pull-request creation.
