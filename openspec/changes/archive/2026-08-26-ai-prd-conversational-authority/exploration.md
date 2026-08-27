## Exploration: AI-led conversation with executable PRD authority

### Current State
The intended architecture already appears in the earlier `conversation-flow-v2` SDD: Gemini should be the only customer-facing author while deterministic code validates state, PRD invariants, escalation, and lead creation. The current implementation only partially realizes it.

`AI - Lead Qualification Assistant` makes one model call and returns strict JSON containing `reply_text`, field updates, question keys, confidence, commercial context, and recommended effects. However, PRD compliance is still split between prompt instructions, model self-reporting (`prd_validated`), normalization, and `Apply AI Assistance`. The normalizer's local PRD validator is intentionally a pass-through; the effective deterministic validator lives in the orchestrator.

`WA - Conversation Orchestrator` still has two authors. `Evaluate Conversation Step` generates `deterministic_reply`; `selectResponseText()` may choose AI text, deterministic fallbacks, or PRD fallback text; and a later `advisorQuestion(requiredQuestionKey)` unconditionally replaces an otherwise valid AI reply whenever the commercial gate requires a field. There is no AI repair pass after validation rejects a reply.

The production loop is a consequence of this split authority and split state. The B06 evidence-first gate correctly refuses to infer `product` from `service`, but the AI may understand “Baldosa MINVU” or “Suministro” without emitting an accepted `field_updates.product`/`modality`. The orchestrator then forces the deterministic product question. Its anti-loop counter only tracks legacy `current_step` fields (`service`, `city`, `requirement`, `confirm`), not the commercial `pending_question_key=product`, so repeated commercial questions do not advance retries or escalate.

### Affected Areas
- `n8n/workflows/wa-conversation-orchestrator.json` — currently selects and later overrides the speaking voice; its DAG has one AI pass and needs proposal validation, bounded repair, final authorization, and unified progress tracking.
- `n8n/workflows/ai-lead-qualification-assistant.json` — owns the AI request/response contract and must support an initial proposal plus repair mode using immutable policy errors.
- `tests/fixtures/workflow-nodes/ai-lead-qualification-assistant/build-ai-request.js` — defines the prompt and strict schema; it needs a per-turn executable contract, evidenced candidates, proposed effects, and repair input.
- `tests/fixtures/workflow-nodes/ai-lead-qualification-assistant/normalize-ai-result.js` — sanitizes model output; it needs typed evidence/provenance and repair metadata without becoming a second policy authority.
- `tests/fixtures/workflow-nodes/wa-conversation-orchestrator/apply-ai-assistance.js` — contains the effective B06 gate, PRD validators, `selectResponseText()`, deterministic commercial questions, and the response override that must become validate/authorize logic.
- `tests/scripts/sync-workflow-nodes.mjs` — source synchronization covers Apply/Build/Normalize but not `Evaluate Conversation Step`; any change there needs a canonical fixture before editing embedded workflow code.
- `scripts/ops/test-ai-assistant-local.sh` — contract tests must cover evidenced product/modality candidates, immutable repair constraints, malformed repair, and exactly one repair attempt.
- `scripts/ops/test-conversation-regression-local.sh` — must prove AI-only normal responses, deterministic effect authorization, repair behavior, contingency fallback, and commercial anti-loop progression.
- `scripts/ops/test-intent-commercial-gate-local.sh` — must retain B06 evidence-first guarantees while accepting grounded catalog aliases and modality synonyms.
- `n8n/samples/conversation_regression_cases.sample.json` and `docs/matriz-pruebas-conversacionales.md` — need end-to-end turns based on the observed “Baldosa MINVU” / “Minvu 0” / “Suministro” loop.
- `docs/prd-agente-whatsapp-hormiglass.md` — remains normative; its field requirements, forbidden promises, escalation rules, and acceptance criteria must be mapped into executable rule identifiers rather than duplicated prose.

### Approaches
1. **Prompt-only compliance** — strengthen the existing system prompt and add examples telling the model to populate product/modality and obey the PRD.
   - Pros: Small change; low latency; preserves natural model output.
   - Cons: Cannot guarantee PRD invariants or effects; does not remove deterministic voice overrides; prompt/model drift can recreate the same loop.
   - Effort: Low

2. **AI proposal + executable turn contract + bounded repair** — the system compiles accepted facts with provenance, missing PRD fields, the single turn objective, allowed/forbidden actions, catalog context, and effect permissions. The AI proposes evidenced understanding, one dialogue action, `reply_text`, and effect requests. Deterministic policy validates evidence/catalog/PRD/state but does not normally write customer copy. Invalid proposals receive machine-readable errors and immutable constraints for exactly one AI repair; only a second failure or provider outage uses a static contingency without advancing state.
   - Pros: Preserves one natural voice; makes PRD compliance testable; keeps B06 evidence-first; separates language understanding from business authorization; directly fixes product/modality loops and competing response authors.
   - Cons: Requires orchestrator DAG and contract changes; invalid turns can add one model call, latency, and cost; validators and repair semantics need careful versioning and audit.
   - Effort: High

3. **Deterministic dialogue planner with AI paraphrasing** — deterministic code chooses every question and effect; AI only rewrites approved templates.
   - Pros: Strong control; simple effect authorization; predictable tests and rollback.
   - Cons: Understanding and dialogue remain constrained by deterministic state; paraphrasing can still violate constraints; normal interactions risk sounding mechanical and do not meet the selected product goal.
   - Effort: Medium

### Recommendation
Choose Approach 2 and treat it as a focused completion/refinement of `conversation-flow-v2`, not a parallel conversational architecture.

Use one canonical per-turn policy object as the source of truth: accepted facts with client evidence/provenance, unresolved PRD requirements, `objective`/`pending_question_key`, permitted dialogue actions, forbidden claims, catalog grounding, and effect permissions. Extend the AI output so every proposed field has `value`, normalized value, quoted/located evidence, confidence, and catalog/alias match where applicable. The deterministic layer validates those proposals and is the only component allowed to persist fields, create leads, or request handoffs.

When the first proposal is invalid, send only structured validation errors plus the unchanged turn policy back to the same assistant for one repair. Revalidate the repair. On success, deliver the AI's text unchanged and authorize only validated effects. On a second failure or provider outage, send a minimal static contingency and do not advance business state; use durable handoff when the PRD requires it. Templates therefore remain a technical safety net, not a competing normal voice.

Make `pending_question_key` (including commercial fields) the canonical progress objective and persist a question fingerprint/no-progress counter independently of the legacy base-field `current_step`. This allows the policy engine to detect a repeated commercial objective even when the wording changes. Keep B06 intact: never restore `service => product`; accept product aliases only when grounded against the loaded catalog and direct client evidence, and accept modality synonyms through an explicit auditable normalization policy. Ambiguous interpretations should trigger an AI-authored clarification under the same contract.

Implementation should begin with executable characterization tests for the observed conversation, PRD forbidden claims, lead/effect authorization, one-repair maximum, and fallback state immutability. U7 and U8 remain separate pending work and must not be absorbed into this change.

### Risks
- A validator that is too lexical can reject correct colloquial interpretations; evidence plus catalog/alias grounding must be semantic enough to accept real customer language without weakening B06.
- The repair path can increase latency and model cost on invalid turns; instrumentation must distinguish first-pass acceptance, repaired acceptance, fallback, and handoff.
- A second model call can accidentally become an unbounded loop unless the DAG encodes an explicit maximum of one repair attempt.
- Active conversations use legacy `current_step`; progress-state changes need backward-compatible parsing and safe defaults.
- PRD prose duplicated across prompt and code will drift unless rule identifiers and the turn-policy compiler become the canonical executable mapping.
- Existing tests assert an eight-message context despite prompt text and older SDD stating three to four; the next phases must explicitly resolve this inconsistency rather than silently changing it.

### Ready for Proposal
Yes. The direction is product-approved and evidence-backed. The proposal should scope this change to conversational authority, executable per-turn PRD policy, evidenced understanding, one repair pass, contingency fallback, unified anti-loop state, and regression coverage; it should explicitly preserve B06 and exclude U7/U8.
