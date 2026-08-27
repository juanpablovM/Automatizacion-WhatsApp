## Exploration: complete-durable-handoff-delivery

### Current State
The handoff flow is already durable up to the scheduler boundary: the conversation/orchestrator path can produce a preserved handoff operation, and the scheduler claims `external_operations` for ClickUp dispatch. The current blocker is inside `Prepare Handoff ClickUp Task`, which is configured as `runOnceForEachItem` but still reads `items`, so it can emit zero items and stop the durable delivery path.

The ClickUp prep/dispatch fixtures already encode the core behavior:
- `prepareHandoffClickup()` builds the ClickUp task payload, validates token/list/assignee config, and carries idempotency hints.
- `dispatchHandoffClickup()` interprets ClickUp responses and records success/unknown/failed outcomes.
- The orchestrator has anti-repeat handoff logic, but the preserved operation still needs reconciliation before any POST when the outcome is `unknown/reconciliation_required`.

### Affected Areas
- `tests/fixtures/workflow-nodes/ops-handoff-notification-scheduler/prepare-handoff-clickup-task.js` — current wrapper mismatch; must return one item per input row for `runOnceForEachItem`.
- `tests/fixtures/workflow-nodes/ops-handoff-notification-scheduler/dispatch-handoff-clickup-task.js` — defines the terminal ClickUp outcome contract and external ID capture.
- `tests/fixtures/workflow-nodes/wa-conversation-orchestrator/apply-ai-assistance.js` — holds anti-repeat handoff state and progress semantics.
- `n8n/workflows/ops-handoff-notification-scheduler.json` (or embedded equivalent) — runtime scheduler wiring that consumes the per-item wrapper.
- `openspec/changes/complete-durable-handoff-delivery/` — artifact home for proposal-adjacent exploration.

### Approaches
1. **Minimal wrapper correction** — keep the scheduler design, fix only the per-item output contract, and preserve existing handoff semantics.
   - Pros: Lowest risk; directly resolves the zero-item failure; preserves deployed flow and dispatcher.
   - Cons: Does not address pending decision ownership or reconciliation policy by itself.
   - Effort: Low

2. **Wrapper correction plus explicit reconciliation gate** — fix per-item output and add a deterministic GET-first reconciliation path for exactly one preserved `unknown/reconciliation_required` operation before any POST.
   - Pros: Matches the durable handoff requirement; keeps idempotency explicit; avoids duplicate ClickUp tasks.
   - Cons: Requires careful state handling and clearer operational ownership per area.
   - Effort: Medium

3. **Broader scheduler refactor** — redesign the scheduler around a dedicated operation state machine and separate ClickUp handoff queue.
   - Pros: Stronger long-term structure; clearer recovery semantics.
   - Cons: Higher blast radius; unnecessary for the confirmed blocker; risks changing already-verified behavior.
   - Effort: High

### Recommendation
Use Approach 2 as the eventual implementation target, but keep the immediate change narrowly scoped: first formalize the three already-verified local fixes without mutating them, then deploy only the corrected scheduler, and reconcile exactly one preserved `unknown/reconciliation_required` operation with GET-before-POST idempotency. This preserves the deployed dispatcher `791f9f3` and the certified conversation flow while closing the durable handoff gap safely.

### Risks
- A second POST before reconciliation could duplicate a ClickUp task if `operation_key` is not preserved exactly.
- The newly dedicated ClickUp list may still be misconfigured or lack the expected assignee mapping for one area.
- Ownership for pending decisions can be blurred if areas are assigned implicitly instead of by explicit validated responsibility.

### Ready for Proposal
Yes, but only after the orchestrator confirms the exact names of the three verified local fixes to formalize and the single preserved operation to reconcile. No functional edits are required in exploration.
