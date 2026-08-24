# Design: AI-Led Conversation with Extensible Semantic Authority

## Technical Approach

Refine the existing workflows into `policy -> proposal -> validation -> projection -> authorization`. `WA - Conversation Orchestrator` compiles immutable `ai_prd_turn_policy/v2`; `AI - Lead Qualification Assistant` returns `ai_semantic_proposal/v2`. The outer envelope is strict, while `observations[]` preserves extensible customer meaning. Deterministic nodes verify evidence, exact turn-scoped `concept -> field` mappings, accepted-fact immutability, generated-reply claim guards, PRD invariants, and effects without extracting a competing meaning from raw customer text. One invalid proposal gets one repair; provider outage or second failure triggers durable handoff with pre-turn commercial state unchanged.

## Architecture Decisions

| Decision | Choice | Alternatives / rationale |
|---|---|---|
| Semantic authority | AI owns normal reply, interpretation, objective answer, and next dialogue action | Reject split authorship and regex-first interpretation: production evidence showed they discard correct model understanding. |
| Contract shape | Strict versioned envelope plus extensible `observations[]` | Reject a fixed `understood_fields` map: it couples comprehension to today's persistence schema. Reject unstructured output: it cannot be validated safely. |
| Persistence boundary | `state_patch[]` references observations and must match an exact turn-scoped pair in `allowed_state_mappings[]` | A global field allowlist only constrains schema shape; executable pairs constrain semantic projection and exclude already accepted fields. Unknown observations may guide dialogue but cannot authorize effects. |
| Forbidden claims | One canonical `PRD_VALIDATORS` region is generated into legacy and semantic Code nodes; `forbidden_rule_ids[]` filters it for v2 | Legacy preserves all rules, official `price_context`, and `NO_FALSE_DERIVATION_PROMISE`; semantic mode selects policy IDs and may use stricter output-only variants without reinterpreting the customer's inbound message. Region parity runs before fixture-to-workflow parity. |
| Commercial amount | Observation normalization distinguishes count, length, area, volume, weight, and unknown while retaining `raw_value` | Avoid blindly merging `quantity` and `measurements`; a compatibility adapter projects accepted mappings into legacy fields. |
| Evidence | Quote, byte offsets, message ID, confidence, and optional grounding | Validation checks source identity and consistency; regex may validate syntax or normalize known units but never decide whether the client answered. |
| Repair and anti-loop | One repair; progress counted by objective and accepted observations | Prevent unbounded latency and repeated questions with different wording. |
| Compatibility | Add control metadata under `qualification_context._conversation_control`; run `legacy|shadow|enforce` | Avoid DB migration and protect downstream CRM, ClickUp, handoff, and WhatsApp contracts. |

## Data Flow

```text
Inbound -> Load state -> Compile v2 policy -> AI proposal
                                              |
                          +-------------------+-------------------+
                          v                                       v
                    Validate invalid                        Validate valid
                          |                                       |
                    One AI repair                    Project state_patch
                          |                                       |
             invalid/outage -> Contingency              Authorize effects
                          |                                       |
                  Durable handoff                   Persist + send AI bytes
```

Shadow mode executes validation and records differences but sends and persists through the legacy path. Enforce mode uses the authorized v2 result. Contingency may set `escalation_required` but copies pre-turn facts and confirmation unchanged.

## Interfaces / Contracts

```text
turn_policy/v2 = {
  version, turn_id, accepted_facts[], unresolved_objectives[], objective,
  catalog, modality_synonyms, allowed_state_fields,
  allowed_state_mappings[{concept, field}], allowed_dialogue_actions,
  forbidden_rule_ids, effect_permissions
}

ai_semantic_proposal/v2 = {
  version, contract_digest, reply_text, dialogue_action,
  observations[{id, concept, raw_value, normalized?, answers_objective?,
                evidence:{quote,start,end,message_id}, grounding?, confidence}],
  state_patch[{field, observation_id}], requested_effects[]
}

validation = {
  valid, rule_errors[], accepted_observations[], authorized_state_patch[],
  authorized_effects[], outcome
}
```

For `6 ml`, the proposal may emit `concept=commercial_amount`, `normalized={kind:length,value:6,unit:linear_meter}`, and `answers_objective=quantity`. When amount is unresolved, policy may expose `{concept:commercial_amount, field:measurements}`; authorization checks that exact pair and referenced evidence, not a unit-extraction regex. A field already present in `accepted_facts[]` is omitted from executable mappings and rejected if patched.

## File Changes

| File | Action | Description |
|---|---|---|
| `tests/fixtures/workflow-nodes/wa-conversation-orchestrator/{compile-turn-policy,validate-ai-proposal,authorize-ai-turn,build-contingency-handoff}.js` | Create | Policy v2, validation, projection, authorization, and immutable contingency. |
| `tests/fixtures/workflow-nodes/shared/prd-validators.js` | Create | Canonical PRD claim validators injected into self-contained n8n Code nodes. |
| `tests/fixtures/workflow-nodes/ai-lead-qualification-assistant/{build-ai-request,normalize-ai-result}.js` | Modify | Initial/repair request and semantic proposal normalization only. |
| `n8n/workflows/{wa-conversation-orchestrator,ai-lead-qualification-assistant}.json` | Modify | Add bounded repair, shadow/enforce, and authorization branches. |
| `tests/scripts/sync-workflow-nodes.mjs` | Modify | Generate and verify canonical PRD regions before mapping fixtures to embedded workflow nodes. |
| `scripts/ops/test-{ai-assistant,conversation-regression,intent-commercial-gate,handoff-routing}-local.sh` | Modify | Contract, safety, repair, anti-loop, and rollout regressions. |
| `n8n/samples/conversation_regression_cases.sample.json`, `docs/matriz-pruebas-conversacionales.md` | Modify | Real-language cases and operating runbook. |

## Testing Strategy

| Layer | Approach |
|---|---|
| Contract | Strict envelope, extensible concepts, evidence offsets, observation references, exact mapping pairs, immutable accepted facts, canonical generated-reply claim guards, generated-region drift, forbidden effects, unchanged valid AI bytes. |
| Conversation | `6 ml`, `son 6ml`, linear meters, counts, multiple facts, unknown units, ambiguity, and no regex override. |
| Workflow | One repair, provider failure, immutable contingency, idempotent effects, objective counts 2/3, and legacy resume. |
| Rollout | Shadow comparison records legacy/v2 divergence without v2 persistence; enforce and legacy rollback are deterministic. |

## Threat Matrix

| Boundary | Applicability | Reason |
|---|---|---|
| Documentation-like paths | N/A | No executable-file classification changes. |
| Git repository selection | N/A | No Git command or repository selection. |
| Commit state | N/A | No commit automation. |
| Push state | N/A | No push automation. |
| PR commands | N/A | No PR command composition. |

Workflow routing threats are covered by contract, repair-bound, state-immutability, effect-idempotency, and shadow-mode RED tests.

## Migration / Rollout

No database migration. Deploy `AI_PRD_CONVERSATION_MODE=shadow`, compare outcomes and accepted evidence, then enable `enforce` for controlled conversations before full rollout. Roll back to `legacy`; additive JSONB metadata remains backward-compatible.

## Open Questions

None.
