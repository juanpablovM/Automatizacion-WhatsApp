# Post-archive findings — read this before trusting the PASS

**Status of this change: frozen. Implementation complete, not wired, not delivered.**

`verify-report.md` in this folder records a genuine PASS: 13/13 tasks, 7/7
requirements, 9/9 scenarios, zero blockers, zero critical findings. That report
is accurate about what it measured. This note records what it could not
measure, discovered on 2026-08-27, after the archive.

## The v3 lane is not connected to the conversational output

In `n8n/workflows/wa-conversation-orchestrator.json` at
`fix/ai-prd-v3-verification-regressions@805aba2`, `Use V3 Contract?` splits on
`$json.contract_version === 'v3'`:

- output 0 (true) enters the v3 lane
- output 1 (false) goes to `Apply AI Assistance`

The entire delivery chain hangs off output 1:

```
Apply AI Assistance
  → Prepare Durable Turn Result
  → Persist Conversation State
  → Build Quotation
  → Merge Conversation Output
  → Prepare Conversation Output      (6383 characters — the caller's contract)
```

Every exit from the v3 lane is a dead end:

- `Prepare V3 Saga Result` has **no outgoing connection**, and its entire body
  is 70 characters:
  `return items.map(item => ({ json: { ...item.json, v3_saga: true } }));`
  A passthrough that tags the item. It does not build the output contract.
- `V3 Route Fixed?` wires only output 0. The false branch dangles.
- `V3 Recovery Is Contingency?` output 1 loops back through
  `Execute AI Lead Qualification → Merge AI Assistance → Use V3 Contract?`, but
  `contract_version` is still `'v3'`, so it re-enters the same lane rather than
  falling back. `Fix V3 Route` is an advisory-lock serializer; it does not
  change the route.

`WA - Inbound Entry` pipes the orchestrator result straight into
`WA - Inbound Downstream Dispatcher`, whose `Normalize Durable Dispatch` reads
`phone_number`, `processing_token`, `conversation_id`, `escalation_area`,
`commercial_missing_fields`, `handoff_*`, `opportunity_*` and `follow_up_*`.
`escalation_area` and `commercial_missing_fields` are produced only by
`Prepare Conversation Output`, and no v3 fixture emits them.

**Consequence:** in `canary` or `enforce` a turn would reach the dispatcher
without the dispatch contract — no reply, no handoff, no follow-up.

## Why no gate caught it

`tests/scripts/sync-workflow-nodes.mjs` (`npm run check:parity`) validates the
`jsCode` and SQL *inside* nodes against their fixtures. It never inspects the
`connections` graph. Every fixture in this change was correct; the wiring was
not, and nothing was looking at the wiring.

The verify report flagged the shape of the blind spot in its own warnings: the
eleven semantic journeys are "property-oriented corpus entries backed by shared
direct runtime probes, not eleven separate live-provider end-to-end
conversations".

`tests/smoke/workflow-connections.test.js` now closes that gap. Dropping this
change's orchestrator into `n8n/workflows/` makes it fail on two rules: the
extra terminal, and `V3 Route Fixed?` wiring output 0 alone.

## Limits of this finding

This is static analysis of the connection graph, traced node by node in both
directions. No v3 turn was executed against a live n8n. The wiring conclusion is
firm; the runtime behaviour was never observed.

## Before resuming

1. Wire the v3 lane into `Prepare Conversation Output`, or give it an equivalent
   node that emits the same dispatch contract.
2. Wire the false branch of `V3 Route Fixed?`.
3. Run a `canary` turn end to end on the isolated `docker-compose.test.yml`
   stack and confirm an outbound message actually reaches the mock provider.
4. Declare `AI_PRD_CONTRACT_MODE` in `.env.example` with `legacy` as the default.
5. Only then publish `openspec/specs/ai-prd-conversation-control/`, which is
   deliberately untracked until the capability it describes actually runs.

## What is safe about leaving it frozen

`resolve-conversation-contract-route.js` defaults to `legacy`, and
`v3-rollout-runtime.js` maps only `canary` and `enforce` to v3. Unset, the
contract is inert. The code costs nothing where it sits.
