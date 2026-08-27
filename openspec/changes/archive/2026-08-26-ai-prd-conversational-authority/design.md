# Design: Versioned AI Conversational Authority

## Technical Approach

Add v3 beside legacy/v2. The orchestrator fixes a route, compiles non-prescriptive policy, obtains one complete AI proposal, validates it atomically, and persists an immutable decision. PostgreSQL then drives a resumable saga: blocking effects, state-plus-delivery-intent commit, exact-byte delivery, and audit. Legacy/v2 remain unchanged for rollback; shadow starts only after legacy delivery.

## Architecture Decisions

| Decision | Choice | Alternatives / rationale |
|---|---|---|
| Voice and meaning | AI owns normal interpretation, wording, order, and zero/one `primary_request`; goals only block effects | Reject deterministic questions/copy and regex-first meaning because they recreate the form behavior. |
| Evidence and authority | AI supplies quote plus occurrence; code derives message ID, UTF-8 offsets/digest, mappings, claims, payloads, and keys | Removes provider arithmetic and self-reported confidence from authorization. `service != product` remains enforced. |
| Atomicity | Reject an invalid proposal wholly; execute an authorized decision as a durable saga | Partial validation can make reply, state, and effects contradict. Distributed ACID is unavailable. |
| Physical ledger | Add `conversation_turn_executions`; keep immutable artifacts in `advisor_decisions`, effect receipts in `external_operations`, delivery in `messages`, and transitions in `audit_logs` | Reusing mutable `inbound_events.downstream_payload` is not queryable enough; mutating `advisor_decisions` would mix decision and execution. The ledger has one row per `inbound_event_id`, nullable unique `decision_id`, route, state, snapshot/delivery digests, attempt/error, and receipt references. Existing per-queue inbound claiming serializes conversations; commit rechecks processing token and pre-turn digest. |
| Recovery | One full repair under identical policy; terminal failure preserves commercial state; unknown effects reconcile by exact key | No silent normalization or blind retries. Contingency text is released only after its durable handoff receipt. |
| Shadow | Fire-and-forget evaluator from the downstream dispatcher after successful legacy delivery | Removes v3 provider latency and effects from the visible path. |

## Sequence

```text
Inbound -> Route/Policy -> AI -> Validate -> Persist decision+ledger(prepared)
                                   | invalid -> one repair -> contingency
Ledger -> blocking effects -> receipts -> transaction(state + outgoing message)
       -> send exact bytes -> delivery receipt -> audit(delivered)
Legacy delivery -> async shadow evaluator -> advisor audit only
```

## Interfaces / Contracts

```text
conversation_contract_route/v1 = {turn_id, contract_version, mode, rule_id}
ai_prd_turn_policy/v3 = {turn, history, facts, goals, conversation_policy,
  state_authority, grounding, claim_authority, effect_authority, commit_policy, failure_policy}
ai_conversation_proposal/v3 = {policy_digest, reply_text, primary_request?,
  observations[{id,concept,raw_value,normalized_value?,evidence_quote,evidence_occurrence}],
  state_mutations[{operation,field,observation_id,replaces_fact_id?}], effect_requests[]}
conversation_validation_result/v3 = {valid, errors[{code,path,disposition}],
  accepted_observations, authorized_mutations, authorized_effect_requests}
validated_conversation_decision/v3 = {decision_id, expected_snapshot_digest,
  reply{text,sha256,delivery_key,primary_request?}, mutations,
  effect_commands[{type,operation_key,payload,payload_digest,required_before_reply}]}
conversation_turn_execution/v3 = {decision_id,state,attempt,effect_receipt_refs,
  state_receipt,delivery_receipt_ref,last_error}
ai_conversation_repair_request/v3, system_contingency_decision/v3,
operation_reconciliation/v3, conversation_turn_audit/v3 retain those identifiers and digests.
```

## File Changes

| File | Action | Purpose |
|---|---|---|
| `infra/postgres/migrations/018_create_conversation_turn_executions.sql` | Create | Add ledger, constraints, indexes, and transition checks. |
| `db/queries/n8n/wa-conversation-orchestrator/{07_route_v3_turn,08_prepare_v3_decision,09_commit_v3_turn,10_transition_v3_execution}.sql` | Create | Idempotent route/prepare/commit/transition transactions. |
| `tests/fixtures/workflow-nodes/wa-conversation-orchestrator/*-v3.js` | Create | Policy, proposal validation, decision, repair, contingency, and reconciliation logic. |
| `tests/fixtures/workflow-nodes/ai-lead-qualification-assistant/{build-ai-request,normalize-ai-result}.js` | Modify | Version-dispatch strict v3 request/response without changing legacy/v2. |
| `n8n/workflows/{wa-conversation-orchestrator,wa-inbound-downstream-dispatcher,ai-lead-qualification-assistant}.json` | Modify | Route v3 and execute the ledger saga. |
| `n8n/workflows/ai-prd-shadow-evaluator.json`, `n8n/workflow-links.json`, `tests/scripts/sync-workflow-nodes.mjs` | Create/Modify | Post-delivery shadow workflow and canonical fixture parity. |
| `scripts/ops/test-{ai-assistant,conversation-regression,intent-commercial-gate}-local.sh`, `tests/integration/conversation-turn-execution.postgres.test.js`, `n8n/samples/conversation_regression_cases.sample.json` | Modify/Create | Contract, saga, and semantic journeys. |

## Testing Strategy

Strict TDD: RED contract tests cover evidence occurrence/offsets, corrections, multiple facts, one request, forbidden claims, whole-proposal rejection, and unchanged bytes. PostgreSQL integration tests cover duplicate prepare/commit, stale snapshots, ordering, effect `unknown`, reconciliation, receipts, replay, and concurrent claims. Workflow journeys cover questions, uncertainty, digressions, frustration, repair/contingency, canary, shadow latency/effect isolation, and rollback.

## Threat Matrix

| Boundary | Applicability | Safe/failure behavior and RED boundary |
|---|---|---|
| Workflow routing/process handoff | Applicable | Persist route once; reject route drift; shadow starts post-delivery and cannot mutate. RED: all modes, retry, rollback, async failure. |
| Documentation-like paths | N/A | No executable classification. |
| Git repository selection | N/A | No Git execution. |
| Commit state | N/A | No commit automation. |
| Push state | N/A | No push automation. |
| PR commands | N/A | No PR automation. |

## Rollout / Rollback

Apply additive migration, deploy disabled, then `shadow -> controlled canary -> enforce` using measured safety/latency gates. Kill conditions include unauthorized mutation/effect, duplicate effect, changed reply bytes, false claim, inconsistent receipt, ordering breach, or blind retry. Rollback routes only new turns to legacy; active v3 rows finish or reconcile, and additive data remains.

## Open Questions

None. Numeric rollout SLOs are deployment configuration, not contract decisions.
