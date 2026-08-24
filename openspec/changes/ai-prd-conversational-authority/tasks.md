# Tasks: AI-Led Conversation with Extensible Semantic Authority

## Review Workload Forecast

| Field | Value |
|---|---|
| Estimated changed lines | 1,800-3,000 including workflow JSON; 900-1,500 authored |
| 400-line budget risk | High |
| Chained PRs recommended | Yes |
| Suggested split | Contract/authorization -> Repair/effects -> Anti-loop/rollout |
| Delivery strategy | ask-on-risk (resolved) |
| Chain strategy | feature-branch-chain |

Decision needed before apply: No
Chained PRs recommended: Yes
Chain strategy: feature-branch-chain
400-line budget risk: High

## Suggested Work Units

| Unit | Goal | PR/base | Focused test | Runtime harness | Rollback boundary |
|---|---|---|---|---|---|
| 1 | Semantic contract and authorization | PR 1 -> tracker | `sh scripts/ops/test-ai-assistant-local.sh` | Commercial fixture replay | Proposal, policy, validator, and authorizer nodes |
| 2 | Repair and authorized effects | PR 2 -> PR 1 | `sh scripts/ops/test-handoff-routing-local.sh` | Invalid-repair/provider replay | Contingency and effect workflow branches |
| 3 | Anti-loop and rollout | PR 3 -> PR 2 | `sh scripts/ops/test-conversation-regression-local.sh` | `6 ml`, counts 2/3, shadow replay | Objective logic, mode wiring, telemetry, and docs |

## Phase 1: Contract RED

- [x] 1.1 Add failing strict-envelope, extensible-observation, evidence-offset, observation-reference, forbidden-mapping/effect, and unchanged-copy cases to `test-ai-assistant-local.sh`.
- [x] 1.2 Add failing `6 ml`, `son 6ml`, linear-meter, count, multi-fact, unknown-concept, ambiguity, and no-regex-override cases to commercial and conversation suites.
- [x] 1.3 Run focused suites and record expected RED failures before production edits.

## Phase 2: Semantic Proposal and Authorization

- [x] 2.1 Create `compile-turn-policy.js` with canonical `ai_prd_turn_policy/v2`, digest, accepted facts, objectives, allowed state fields, and compatible defaults.
- [x] 2.2 Modify `build-ai-request.js` and `normalize-ai-result.js` for initial/repair `ai_semantic_proposal/v2` with syntax-only normalization.
- [x] 2.3 Create `validate-ai-proposal.js` and `authorize-ai-turn.js` to validate evidence/references, preserve AI bytes, project allowlisted state, and authorize effects once.
- [x] 2.4 Map fixtures in `sync-workflow-nodes.mjs` and make Phase 1 contract/commercial tests green.

## Phase 3: Workflow Safety RED

- [ ] 3.1 Add failing initial-repair, second-failure, provider-outage, immutable-state, shadow-side-effect, and idempotent-handoff cases to `test-handoff-routing-local.sh`.
- [ ] 3.2 Add failing objective-count 2/3, legacy-resume, MINVU, Suministro, and flexible-amount cases to regression samples and harness.
- [ ] 3.3 Run both suites and record expected RED failures before workflow wiring.

## Phase 4: Workflow Integration

- [ ] 4.1 Create `build-contingency-handoff.js` preserving pre-turn facts while requesting durable `escalation_required` handoff.
- [ ] 4.2 Wire one repair, provider contingency, projection, authorization, objective counts, and `legacy|shadow|enforce` in both workflow JSON files.
- [ ] 4.3 Make Phase 3 suites green and prove shadow mode performs no v2 persistence, delivery, or effects.

## Phase 5: Refactor and Verification

- [ ] 5.1 Remove superseded regex-first/split-authorship branches and centralize syntax normalization without changing accepted behavior.
- [ ] 5.2 Update `docs/matriz-pruebas-conversacionales.md` with contracts, outcomes, telemetry, rollout, and rollback.
- [ ] 5.3 Run fixture parity plus all four focused suites; preserve U7/U8 exclusions and record runtime harness evidence per work unit.
