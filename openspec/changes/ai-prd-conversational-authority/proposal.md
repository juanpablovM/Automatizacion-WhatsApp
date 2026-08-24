# Proposal: AI-Led Conversation with Extensible Semantic Authority

## Intent

Make the AI the sole normal conversational voice and semantic interpreter. Deterministic policy validates evidence, projects approved observations into state, and authorizes effects without re-interpreting customer language through field-specific regexes.

## Scope

### In Scope
- Compile an immutable turn contract from accepted facts, unresolved objectives, grounding, constraints, and effect permissions.
- Require a versioned proposal with extensible evidenced observations, `reply_text`, dialogue action, state mappings, and requested effects.
- Preserve observations without persistable targets for dialogue and audit; only allowlisted mappings may change state.
- Permit one repair; a second failure or provider outage creates durable handoff without commercial state advancement.
- Track progress by objective and support `legacy|shadow|enforce` rollout.

### Out of Scope
- U7, U8, multi-agent conversation, pricing/catalog redesign, database migration, or weakening `service != product`.
- Direct AI writes or effect execution.
- Templates as a normal conversational path.

## Capabilities

### New Capabilities
- `ai-prd-conversation-control`: Extensible AI understanding governed by evidence validation, authorized effects, anti-loop, repair, and fail-safe handoff.

### Modified Capabilities
None.

## Approach

Refine the two workflows into proposal, validation, projection, and authorization. The assistant returns a strict envelope with flexible `observations[]` carrying raw meaning, optional normalization, objective relationship, confidence, and message evidence. `state_patch[]` references observations and proposes allowlisted persistence targets. Code validates provenance and business invariants but never extracts a competing meaning. Valid AI copy is delivered unchanged.

## Affected Areas

| Area | Impact | Description |
|------|--------|-------------|
| `n8n/workflows/{wa-conversation-orchestrator,ai-lead-qualification-assistant}.json` | Modified | Policy, proposal, repair, projection, and authorization routing. |
| `tests/fixtures/workflow-nodes/` | Modified | Canonical request, validation, authorization, and contingency nodes. |
| `scripts/ops/test-*-local.sh` | Modified | Contract, conversation, safety, anti-loop, and handoff coverage. |
| `n8n/samples/`, `docs/` | Modified | Regressions, outcomes, rollout, and rollback. |

## Risks

| Risk | Likelihood | Mitigation |
|------|------------|------------|
| Semantic drift | Medium | Versioned envelope, provenance, confidence, and allowlisted projection. |
| Colloquial evidence rejected | Medium | Preserve raw observations; repair structure or unsafe effects, not unfamiliar wording. |
| Legacy regression | Medium | Compatible adapters, shadow comparison, and replay tests. |

## Rollback Plan

Switch `AI_PRD_CONVERSATION_MODE` to `legacy` and restore workflow snapshots through existing tooling. Additive JSONB control metadata requires no database rollback.

## Dependencies

- PRD, catalog aliases, B06 evidence gate, durable handoff, Gemini, workflow fixture sync.

## Success Criteria

- [ ] `6 ml`, `son 6ml`, and equivalent answers advance from grounded AI understanding.
- [ ] Regexes cannot override accepted observations or valid AI copy.
- [ ] Only evidenced mappings persist and authorized effects execute once.
- [ ] Repair, anti-loop, handoff, compatibility, shadow, and rollback regressions pass.
