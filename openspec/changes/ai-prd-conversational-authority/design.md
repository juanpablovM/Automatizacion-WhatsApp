# Design: AI-Led Conversation with Executable PRD Authority

## Technical Approach

Refine the existing two workflows into proposal/validation/authorization. `WA - Conversation Orchestrator` compiles one immutable `ai_prd_turn_policy/v1`; `AI - Lead Qualification Assistant` returns an evidenced proposal. Deterministic nodes validate it, execute only authorized effects, and deliver valid `reply_text` byte-for-byte. One invalid proposal gets exactly one repair with the same contract. Provider outage or a second invalid proposal emits a brief contingency and immediately requests the existing durable handoff, without accepting facts, confirming, or creating a lead. U7/U8 remain excluded.

## Architecture Decisions

| Decision | Choice | Alternatives / rationale |
|---|---|---|
| Conversational authority | AI authors every normal reply; code validates and authorizes | Reject prompt-only and deterministic paraphrasing: neither removes split authority. |
| Canonical policy | One versioned, canonical-JSON contract plus SHA-256 digest per turn | Avoid duplicated PRD prose/state across prompt and validators; repair receives identical bytes. |
| Repair bound | Initial proposal + exactly one repair; no provider retry counts as conversational repair | Prevent unbounded latency/cost while allowing one natural correction. |
| Evidence-first grounding | Evidence quote/offset/message ID plus active catalog ID or audited alias; explicit modality synonym IDs | Preserves B06: `service` never satisfies `product`; ambiguity persists nothing and requires clarification. |
| Anti-loop | Track consecutive no-progress by objective, not wording: count 2 permits only contextual clarification; count 3 requires handoff | Preserves the current three-turn escalation tolerance while catching commercial questions. |
| Compatibility | Store control metadata in `qualification_context._conversation_control`; absent metadata initializes from accepted legacy state | Avoid schema migration and never infer effect permission from missing metadata. |

## Data Flow

```text
Inbound -> Load state -> Compile policy -> AI initial -> Validate
                                                   | valid -> Authorize -> Persist/send
                                                   ` invalid -> AI repair -> Validate
                                                                     | valid -> Authorize
                                                                     ` invalid -> Contingency + durable handoff
Provider outage ----------------------------------------------------> Contingency + durable handoff
```

The contingency path may change operational status to `escalation_required`, but copies pre-turn commercial facts and confirmation unchanged. Existing downstream idempotency creates one `handoffs` record.

## Interfaces / Contracts

`turn_policy`: `{version, turn_id, accepted_facts[{field,value,provenance}], unresolved_fields, objective:{key,no_progress_count,mode}, catalog:{active_items,aliases}, modality_synonyms, allowed_dialogue_actions, forbidden_rule_ids, effect_permissions}`.

`ai_proposal`: `{contract_digest, reply_text, dialogue_action, understood_fields:{field:{value,evidence:{quote,start,end,message_id},grounding:{kind,id},confidence}}, requested_effects[]}`.

Validation returns `{valid, rule_errors[{rule_id,path,code}], accepted_fields, authorized_effects, outcome}`. Outcomes are `accepted_initial`, `accepted_repair`, `contingency_provider`, or `contingency_invalid`.

## File Changes

| File | Action | Description |
|---|---|---|
| `tests/fixtures/workflow-nodes/wa-conversation-orchestrator/{compile-turn-policy,validate-ai-proposal,authorize-ai-turn,build-contingency-handoff}.js` | Create | Canonical policy, validator, authorization, and immutable contingency logic. |
| `tests/fixtures/workflow-nodes/ai-lead-qualification-assistant/{build-ai-request,normalize-ai-result}.js` | Modify | Initial/repair input and evidenced proposal schema; syntax normalization only. |
| `n8n/workflows/{wa-conversation-orchestrator,ai-lead-qualification-assistant}.json` | Modify | Add bounded repair branches and synchronized Code nodes. |
| `tests/scripts/sync-workflow-nodes.mjs` | Modify | Map every new canonical fixture to embedded workflow nodes. |
| `scripts/ops/test-{ai-assistant,conversation-regression,intent-commercial-gate}-local.sh` | Modify | RED/contract/regression coverage. |
| `n8n/samples/conversation_regression_cases.sample.json`, `docs/matriz-pruebas-conversacionales.md` | Modify | MINVU/supply and policy outcomes. |

## Testing Strategy

| Layer | Approach |
|---|---|
| Contract | Strict schema, digest immutability, evidence offsets, alias ambiguity, forbidden claims/effects, unchanged valid text. |
| Workflow | Assert one repair edge only; provider failure/second invalid creates immediate idempotent handoff and preserves commercial state. |
| Regression | Replay “Baldosa MINVU”, “MINVU 0”, “Suministro”; objective count 2 clarifies, count 3 hands off; legacy rows resume; B06 and lead prerequisites remain green. |

Strict TDD runs the configured AI and conversation suites plus the commercial-gate suite and workflow-node sync check.

## Observability

Reuse `advisor_decisions` and audit metadata for policy version/digest, attempt, outcome, rule IDs, accepted provenance, objective count, effect decisions, latency, and contingency reason. Never log hidden reasoning; retain evidence already present in customer messages.

## Threat Matrix

| Boundary | Applicability |
|---|---|
| Documentation-like paths | N/A — no executable-file classification. |
| Git repository selection | N/A — no Git execution. |
| Commit state | N/A — no commit automation. |
| Push state | N/A — no push automation. |
| PR commands | N/A — no PR automation. |

## Migration / Rollout

No database migration. Add `AI_PRD_CONVERSATION_MODE=legacy|shadow|enforce`: deploy in `shadow`, compare validation/loop telemetry, then enable `enforce` for a controlled number before full rollout. Roll back by switching to `legacy` and restoring workflow snapshots; JSONB metadata remains backward-compatible.

## Open Questions

None.
