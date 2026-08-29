# Proposal: Versioned AI Conversational Authority

## Intent

Make the AI the sole voice and interpreter while deterministic code controls evidence, grounding, state, claims, effects, persistence, and delivery. Remove deterministic questions and copy overrides without weakening safeguards.

## Scope

### In Scope
- Add v3 contracts for routing, immutable policy, AI proposal, validation, authorized decision, durable execution, repair, contingency, reconciliation, and audit.
- Accept multiple evidenced observations and customer corrections; only allowlisted mappings may mutate state.
- Validate proposals all-or-nothing, allow one repair, and preserve pre-turn commercial state after terminal failure.
- Derive and persist decision, operation, and delivery identities with receipts; reconcile ambiguous effects.
- Route each turn through `legacy`, nonblocking `shadow`, `canary`, or `enforce`.
- Add semantic journeys for dialogue, corrections, uncertainty, claims, replay, concurrency, and rollout.

### Out of Scope
- U7, U8, multi-agent conversation, pricing/catalog redesign, or weakening `service != product`.
- Direct AI persistence, effect execution, operational payloads, or idempotency keys.
- Deterministic normal-path copy or question ordering.

## Capabilities

### New Capabilities
- `ai-prd-conversation-control`: Versioned AI-led conversation with deterministic validation, execution, recovery, rollout, and audit.

### Modified Capabilities
None.

## Approach

Compile a policy exposing facts, goals, grounding, claim rules, and permitted changes/effects without prescribing dialogue. The AI returns evidenced observations and exact reply text with at most one primary request. The system validates the proposal, derives stable identities, resolves blocking effects, commits state plus delivery intent, then sends authorized bytes unchanged. Contingency copy requires its supporting receipt. Shadow runs after legacy delivery without mutations or visible latency.

## Affected Areas

| Area | Impact |
|------|--------|
| `n8n/workflows/` | v3 routing and lifecycle |
| `tests/fixtures/workflow-nodes/` | Policy through recovery logic |
| `scripts/ops/`, `n8n/samples/` | Contracts and semantic journeys |
| PostgreSQL audit/operation records | Decisions, receipts, and delivery references |

## Risks

| Risk | Mitigation |
|------|------------|
| Semantic or claim drift | Evidence, grounding, allowlists, and immutable audit |
| Duplicate or ambiguous effects | Derived keys, receipts, serialization, reconciliation |
| Latency regression | One-repair budget, async shadow, canary gates |

## Rollback Plan

Route new turns to `legacy` and restore workflow snapshots. Active v3 decisions finish or reconcile under v3; rollback never switches a turn mid-execution. Additive audit data needs no destructive rollback.

## Dependencies

- Gemini, PRD/catalog grounding, B06 evidence gate, durable handoff, PostgreSQL, Evolution API, and fixture synchronization.

## Success Criteria

- [ ] Valid AI replies are delivered unchanged without deterministic normal-path overrides.
- [ ] Only evidenced, authorized state/effects commit; replay and concurrency produce no duplicates.
- [ ] Repair, contingency, reconciliation, audit, and semantic journeys pass.
- [ ] Shadow adds no visible latency or v3 effects; rollback preserves active-turn integrity.
