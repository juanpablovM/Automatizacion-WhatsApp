# OpenAI API Migration

## Objective

Prepare the local n8n AI integration to use the OpenAI Responses API with `gpt-6-luna` while preserving the current Gemini path until an explicitly authorized runtime cutover.

## Problem and why

The user selected OpenAI and placed a key in the ignored local `.env`, but the current AI caller reads only `AI_DIRECT_API_KEY`. The v3 Responses request also emits `temperature`, which is incompatible with GPT-6 when reasoning is not `none`. Changing environment values alone would not provide a safe migration.

## Authorized scope

- Change local source, generated workflow, tests, and documentation needed for provider-aware key routing and a GPT-6-compatible v3 request.
- Validate with offline fixtures and configured local test commands.
- Preserve unrelated in-progress checkout changes and the existing Gemini configuration for rollback.

## Out of scope

- Any live request to OpenAI, live n8n runtime operation, deployment, push, pull request, or merge without separate authorization.
- Printing, copying, committing, or otherwise exposing the user's API key.
- Changing unrelated conversation orchestration behavior.

## Constraints and design

- Use the canonical fixture-to-workflow synchronization pattern already in this repository.
- Select `OPENAI_API_KEY` only for `AI_PROVIDER=openai`; preserve `AI_DIRECT_API_KEY` for the current provider.
- Forward `OPENAI_API_KEY` through local Docker Compose so the n8n process can read it after cutover.
- Preserve strict v3 JSON Schema, `store: false`, fallback handling, and local rollback path.
- Rewrite the exact OpenAI origin to the internal mock in isolated v3 canary imports; retain the unknown-origin rejection gate.
- Use English in technical artifacts.
- Route: delegated direct. Mapping/preparation crossed four or more files; behavior, tests, generated workflow, and documentation require multiple non-trivial edits.
- Strict TDD enabled by `openspec/config.yaml:9`; configured runner: `sh scripts/ops/test-ai-assistant-local.sh && sh scripts/ops/test-conversation-regression-local.sh`. Observe RED, GREEN, then REFACTOR for behavior changes.
- RDD: disabled by clone-local preference (`gentle-ai review mode status`); ordinary checks still apply.
- Delivery strategy: `ask-on-risk`. Forecast: about 250–400 authored changed lines, generated workflow excluded. Monitor actual authored lines before commit; no PR requested.

## Tasks

- [x] **OAM-1 — Prepare an offline-safe OpenAI provider path**
  - Route: delegated direct writer; mapping, preparation, and multi-file writer triggers apply.
  - Add failing regression coverage for provider-specific key selection, GPT-6 Responses request compatibility, output normalization, and existing Gemini behavior.
  - Implement the smallest changes in canonical AI node fixtures, synchronize generated workflow, forward the variable through Docker Compose, and update environment example and setup documentation without editing the user's secret.
  - Acceptance: OpenAI selects `OPENAI_API_KEY`, Responses `/v1/responses`, `gpt-6-luna`, strict v3 schema, `store: false`, and no unsupported `temperature`; Gemini still uses `AI_DIRECT_API_KEY` and its prior request behavior. Isolated canary imports redirect OpenAI to mock without allowing unknown origins.
  - Checks: focused RED/GREEN tests; canonical node parity; configured local AI and conversation regression runner; applicable npm checks; secret-safety and diff review.
  - Live API and n8n runtime checks: pending separate explicit authorization.
  - Work-unit commit: `f8f234c` (`feat(ai): prepare OpenAI Responses provider path`), 317 authored changed lines excluding generated workflow.
  - RDD outcome: disabled/unmanaged.

## Progress

- Key presence verified without reading its value; `.env` is ignored by Git.
- Checkout contains unrelated pre-existing edits to the conversation orchestrator and conversation scenario files; do not stage or alter them.
- Writer observed RED for provider route and isolated canary import, then GREEN after the scoped implementation.
- Local AI contract, Compose, node parity, full `npm test` (619 passed, 138 skipped), and `git diff --check` passed.
- Configured combined runner remains failed: `test-conversation-regression-local.sh` exits 1 on the pre-existing `service=Baldosas` versus expected null assertion in unrelated conversation behavior; the new OpenAI path did not alter that node.
- Live OpenAI and n8n runtime validation remain pending explicit remote-operation authorization.
- No live validation, n8n cutover, push, or PR was attempted. The provider remains Google until an explicitly authorized cutover.
- Next: obtain explicit authorization for destination, live test operation, and credential/session before any paid OpenAI probe or n8n deployment; then validate the exact dynamic schema and conversational outcomes.
