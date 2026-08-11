# Tasks: AI-Led Conversation with Executable PRD Authority

## Review Workload Forecast

| Field | Value |
|---|---|
| Estimated changed lines | 1,800–3,000 including embedded n8n JSON; 700–1,100 authored |
| 400-line budget risk | High |
| Chained PRs recommended | Yes |
| Suggested split | PR 1 contract/grounding → PR 2 repair/effects → PR 3 anti-loop/rollout |
| Delivery strategy | ask-on-risk (resolved) |
| Chain strategy | feature-branch-chain |

Decision needed before apply: No
Chained PRs recommended: Yes
Chain strategy: feature-branch-chain
400-line budget risk: High

### Suggested Work Units

| Unit | Goal | Likely PR | Focused test command | Runtime harness | Rollback boundary |
|---|---|---|---|---|---|
| 1 | Policy, evidence, unchanged AI voice | PR 1 | `sh scripts/ops/test-ai-assistant-local.sh` | `sh scripts/ops/test-intent-commercial-gate-local.sh` | Policy/assistant fixtures, mappings, embedded nodes |
| 2 | Bounded repair and authorized effects | PR 2 | `sh scripts/ops/test-handoff-routing-local.sh` | Provider-failure/invalid-repair conversation harness | Repair/authorization nodes and graph edges |
| 3 | Objective anti-loop, compatibility, rollout | PR 3 | `sh scripts/ops/test-conversation-regression-local.sh` | Controlled shadow replay plus `node tests/scripts/sync-workflow-nodes.mjs --check` | Samples, metadata logic, mode flag, docs |

## Phase 1: RED — Contract and Grounding

- [ ] 1.1 Extend `scripts/ops/test-ai-assistant-local.sh` with failing strict-schema, digest, evidence-offset, unchanged-copy, repair-request, and invalid-provider cases.
- [ ] 1.2 Extend `scripts/ops/test-intent-commercial-gate-local.sh` with failing active alias, ambiguous alias, modality-synonym, `service != product`, forbidden-claim, and premature-lead cases.
- [ ] 1.3 Run both scripts and record expected failures before production edits.

## Phase 2: GREEN — Policy and AI Proposal

- [ ] 2.1 Create `compile-turn-policy.js` with canonical `ai_prd_turn_policy/v1`, SHA-256 digest, legacy-safe defaults, aliases, synonyms, and mode gating.
- [ ] 2.2 Modify `build-ai-request.js` and `normalize-ai-result.js` for initial/repair requests and evidenced `ai_proposal` normalization only.
- [ ] 2.3 Create `validate-ai-proposal.js` and `authorize-ai-turn.js` to accept grounded facts, preserve AI bytes, and authorize each effect once.
- [ ] 2.4 Map fixtures in `tests/scripts/sync-workflow-nodes.mjs`, sync both workflow JSON files, and make Phase 1 tests green.

## Phase 3: RED — Repair, Handoff, and Anti-Loop

- [ ] 3.1 Add failing initial-repair, second-failure, outage, immutable-state, and idempotent-handoff cases to `scripts/ops/test-handoff-routing-local.sh`.
- [ ] 3.2 Add failing MINVU, MINVU 0, Suministro, ambiguity, count-2 clarification, count-3 handoff, and legacy-resume cases to `n8n/samples/conversation_regression_cases.sample.json` and `test-conversation-regression-local.sh`.
- [ ] 3.3 Run both scripts and record expected failures before workflow wiring.

## Phase 4: GREEN — Repair and Runtime Wiring

- [ ] 4.1 Create `build-contingency-handoff.js` preserving pre-turn commercial facts while requesting durable `escalation_required` handoff.
- [ ] 4.2 Wire exactly one repair edge, provider contingency, validation outcomes, authorized persistence, audit metadata, and objective counts in both workflow JSON files.
- [ ] 4.3 Make Phase 3 tests green; run `test-intent-commercial-gate-local.sh` to prove B06 and lead prerequisites remain intact.

## Phase 5: REFACTOR and Verification

- [ ] 5.1 Remove superseded split-authorship branches and deduplicate policy helpers without changing green behavior.
- [ ] 5.2 Update `docs/matriz-pruebas-conversacionales.md` with PRD rules, outcomes, evidence, shadow/enforce rollout, and rollback.
- [ ] 5.3 Run `node tests/scripts/sync-workflow-nodes.mjs --check` plus all three configured suites and the handoff harness; preserve U7/U8 expectations unchanged.
