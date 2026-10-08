# Commercial Pending Recontact

## Objective

Improve repeat-contact handling after a quotation request reaches `handed_to_sales` without changing the human ownership contract.

## Problem

The current terminal guard uses the same six-hour cooldown for commercial review and escalation. Commercial status detection is phrase-fragile, and substantive messages can reset the previous lead unexpectedly. Customers may therefore receive no reply for six hours or accidentally enter a new quotation flow while the existing request is still waiting for sales review.

## Why

A pending commercial request is a normal completed bot flow, not an exceptional human escalation. The bot should provide a useful status acknowledgement at a reasonable cadence, preserve the existing request unless the customer explicitly asks for a new one, and remain fully silent whenever human ownership is active.

## Authorized scope

- Use a one-hour cooldown for `commercial_review_pending` replies.
- Keep the existing six-hour cooldown for `escalation_already_required` replies.
- Broaden deterministic recognition of status inquiries about the pending request.
- Improve the pending-review message so it explains the current state and gives explicit instructions for correcting the prior request or starting a new quotation.
- Preserve the existing conversation and lead for correction messages; record corrections for later human review without creating a duplicate lead or claiming that ClickUp fields were updated.
- Preserve explicit `nueva cotización` behavior and human ownership suppression.
- Regenerate the canonical n8n workflow from source fixtures and verify parity.

## Out of scope

- Updating an existing lead row or ClickUp task fields from a correction message.
- Adding a pre-claim sales SLA, reminder, reassignment, or supervisor escalation.
- Changing the two-hour human ownership lease.
- Changing escalation/handoff semantics beyond retaining the six-hour guard.
- Deploying n8n, pushing the branch, creating a pull request, or merging.

## Constraints

- Work only in `/home/agentesai/Automatizacion-WhatsApp-worktrees/commercial-pending-recontact` on `feat/commercial-pending-recontact`.
- Preserve the product-bound technical-sheet behavior at base commit `b899ba7`.
- Technical artifacts remain in English; customer-facing copy follows the repository's Chilean Spanish convention.
- Generated workflow JSON must be synchronized from canonical SQL/fixture sources, never edited independently.
- Keep each work unit reviewable and include tests with behavior.

## TDD

- Mode: test-first for deterministic behavior.
- Observe focused RED for the one-hour commercial boundary, expanded status intent, correction capture, and no-duplicate invariants.
- Implement GREEN in the canonical evaluator fixture.
- Regenerate workflow JSON and run parity plus PostgreSQL integrations.

## Forecast

- Estimated authored diff: 280–390 lines including generated workflow changes and tests.
- Planned as two work-unit commits; no chained PR expected unless the actual diff exceeds the review threshold.

## Tasks

- [x] **CPR-1 — Define and implement commercial recontact behavior**
  - Route: delegated bounded writer.
  - Add failing unit tests before behavior changes.
  - Separate commercial and escalation cooldown boundaries.
  - Recognize broader status inquiries deterministically.
  - Add a correction-request/correction-recorded control path that preserves `conversation_id` and `lead_id`, creates no lead/effect, and does not claim ClickUp mutation.
  - Improve the commercial pending copy with explicit `modificar solicitud` and `nueva cotización` instructions.
  - Acceptance criteria:
    - First commercial status inquiry receives the improved status response.
    - Repeated commercial status inquiry is suppressed inside one hour and answered after one hour.
    - Escalation remains suppressed inside six hours.
    - Explicit new quotation bypasses cooldown and resets identity.
    - Explicit correction and its next detail message preserve the existing conversation/lead and remain V3 control-only, including details phrased with “cambiar/modificar/corregir”.
    - Human ownership still suppresses all automated responses/effects and must also prevent new-request identity reset while ownership is active.
  - Checks:
    - Focused unit suites for commercial continuity, terminal guard, formatting, reengagement, and contact-context recovery.
  - Work-unit commit: `4773735` (`feat(conversation): improve pending quote recontacts`).
  - Verification: writer RED observed 2 targeted failures before correction; GREEN 140/140 focused tests. Independent verifier passed 140/140 tests plus 15/15 adversarial assertions.

- [x] **CPR-2 — Synchronize runtime artifacts and verify persistence**
  - Route: delegated bounded writer followed by independent verification as required by native assessment.
  - Add PostgreSQL integration coverage for distinct cooldown boundaries and correction persistence.
  - Regenerate `wa-conversation-orchestrator.json` from fixtures.
  - Update relevant behavior documentation if an existing canonical document describes terminal recontact.
  - Acceptance criteria:
    - Generated workflow embeds the verified evaluator behavior.
    - Two correction turns persist on the same conversation and lead with zero additional leads.
    - Cooldown receipt behavior passes against PostgreSQL.
    - Workflow parity and SQL-reference checks pass.
    - Technical-sheet product binding regressions remain green.
  - Checks:
    - Focused PostgreSQL integrations.
    - `npm run check:parity`.
    - `npm run check:sql-references`.
    - Focused technical-sheet regression suite.
  - Work-unit commit: `466081e` (`feat(conversation): sync pending recontact workflow`).
  - Verification: independent unit run 160/160, PostgreSQL integrations 12/12, parity 79/79, SQL references clean, JSON parse and canonical evaluator equality passed; no skips or failures.

## Progress

- Dedicated worktree and branch created from verified base `b899ba7`.
- Current implementation map confirms there is no safe existing route to mutate the same lead/ClickUp task; corrections will remain attached to the existing conversation and lead for human review.
- CPR-1 writer added test-first evaluator and unit changes; focused suites reached GREEN.
- Independent verification found two blockers: a correction detail beginning with modification language re-prompts instead of recording, and `nueva cotización` under active human ownership suppresses output but still resets conversation/lead identity.
- Both independent verification findings were fixed: human ownership now prevents identity reset, and natural correction details consume the pending correction instead of re-prompting.
- CPR-1 closed in commit `4773735` after independent re-verification.
- CPR-2 synchronized the generated orchestrator, added exact persisted cooldown boundaries and correction identity coverage, and updated the flow documentation.
- CPR-2 closed in commit `466081e` after independent verification; live PostgreSQL remained untouched and isolated test infrastructure was removed.

## Verification evidence

- Base technical-sheet verification: 166 focused tests, 25 cooldown tests, 37 PostgreSQL integrations, parity, and SQL references passed before branch creation.
- Existing evaluator currently applies one six-hour cooldown to commercial review and escalation.

## Next step

Run the native review preflight for the completed candidate if the user-owned RDD switch is enabled, then report the branch and delivery options without pushing or merging.
