# Proposal: AI-Led Conversation with Executable PRD Authority

## Intent

Eliminate competing authorship and qualification loops. The AI is the sole normal customer-facing voice; deterministic policy enforces the PRD, validates evidence, and authorizes effects without replacing valid AI copy.

## Scope

### In Scope
- Compile a turn contract from accepted evidence, catalog, unresolved fields, objective, constraints, and effect permissions.
- Require AI proposals with evidenced fields, natural `reply_text`, dialogue action, and requested effects.
- Validate deterministically, preserve B06 evidence-first, and permit exactly one repair using immutable errors.
- After a second invalid proposal or provider outage, send brief contingency, immediately create durable human handoff, and leave commercial state unchanged.
- Track progress/anti-loop using `pending_question_key`, with audited product aliases and modality synonyms.
- Add regressions for the MINVU/supply loop, PRD violations, repair bounds, state immutability, and effects.

### Out of Scope
- U7, U8, multi-agent conversation, pricing/catalog redesign, or weakening `service != product` evidence rules.
- Templates as a normal conversational path.

## Capabilities

### New Capabilities
- `ai-prd-conversation-control`: AI dialogue governed by executable policy, evidence validation, one repair, authorized effects, anti-loop, and fail-safe handoff.

### Modified Capabilities
None.

## Approach

Refine the existing flow instead of adding another agent. The orchestrator compiles an immutable turn policy; the assistant proposes understanding, copy, and effects; validation accepts it unchanged or returns machine-readable errors for one repair. Only validated fields/effects persist. A second failure or outage triggers contingency and handoff without advancing qualification.

## Affected Areas

| Area | Impact | Description |
|------|--------|-------------|
| `n8n/workflows/{wa-conversation-orchestrator,ai-lead-qualification-assistant}.json` | Modified | Add policy, repair, authorization, and contingency routing. |
| `tests/fixtures/workflow-nodes/` | Modified | Canonicalize request, normalization, validation, and orchestration. |
| `scripts/ops/test-{ai-assistant,conversation-regression,intent-commercial-gate}-local.sh` | Modified | Prove B06, repair, anti-loop, and handoff. |
| `n8n/samples/`, `docs/` | Modified | Record regressions and executable PRD mapping. |

## Risks

| Risk | Likelihood | Mitigation |
|------|------------|------------|
| Colloquial evidence rejected | Medium | Catalog aliases, audited normalization, clarification tests. |
| Repair adds latency/cost | Medium | One-repair hard limit and outcome telemetry. |
| Legacy regressions | Medium | Compatible defaults and replay tests. |

## Rollback Plan

Restore prior workflows and fixtures through the existing n8n sync/rollback process; disable policy/repair routing and retain existing persisted fields.

## Dependencies

- PRD, catalog, B06 gate, durable handoff, Gemini.

## Success Criteria

- [ ] Customer responses are AI-authored and PRD-valid.
- [ ] MINVU and supply variants progress without repeated product questions or premature leads.
- [ ] Invalid output receives at most one repair; second failure/outage sends contingency, hands off immediately, and does not advance commercial state.
- [ ] All relevant local contract and regression suites pass without absorbing U7/U8.
