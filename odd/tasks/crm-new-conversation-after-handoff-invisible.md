# CRM never sees a conversation the bot reopens after a handoff

**Status:** in progress on branch `feat/crm-returning-customer-same-opportunity`. Delivery: one PR.
Test runner: vitest (`npm run test:unit`, `npm run test:integration:postgres`, `npm run check:parity`).

## Specs

- **S1** — Owner rule (L2, verbatim): "a la misma oportunidad si es que no ha querido iniciar una
  nueva cotización". When the bot opens a new conversation for a contact and the customer did not
  ask for a new quote, the new conversation records the conversation it continues.
- **S2** — "Chose a new quote" means the turn accepted the quote follow-up offer
  (`acceptsNewQuoteOffer`) or carried an explicit new-request directive (`wantsNew`). Then no link.
- **S3** — The CRM dispatcher sends the messages of a linked conversation as `message.new` under the
  `conversation_id` of the conversation it continues, when that one was announced by a delivered
  `lead.qualified` and the linked conversation has no lead of its own.
- **S4** — A linked conversation that re-qualifies into its own lead is a new quote: its messages
  are no longer sent through the link (they follow its own `lead.qualified`, as today).
- **S5** — Existing behavior unchanged: announced conversations keep sending as before; conversations
  without a link stay invisible to the CRM.

## Problem

After a handoff, when no seller holds the chat and the customer writes again, the turn is not
control-only, so "Fix V3 Route" (`db/queries/n8n/wa-conversation-orchestrator/07_route_v3_turn.sql:72-110`)
creates a **new conversation**. It does this whenever the latest one is `handed_to_sales`, `closed` or
`inactive_timeout`.

The CRM dispatcher only sends `message.new` for conversations whose `lead.qualified` was delivered
(`db/queries/n8n/crm-events-dispatcher/05_select_message_candidates.sql:21-28`). The new
conversation never gets a `lead.qualified`, so none of its messages reach the CRM, however fast
they are written.

## Why it matters

The CRM Conversations page and the opportunity's WhatsApp tab would miss a returning customer's
messages. The seller would not see that the customer wrote again.

## Tasks

- [x] **T1** (S1-S5, inline; no writer trigger: one unit) — Migration 043 (`conversations.continues_conversation_id` +
      `conversation_continuation_target()`), rollback, evaluate step flag, Fix V3 Route and Persist
      Conversation State links, dispatcher 05, workflow sync, tests, CRM README.
- [ ] **T2** — Deploy to production after the owner approves (backup, migration, workflow import).

## Log

- **L1 (2026-11-21) — data check, read-only.** Production has a single delivered `lead.qualified`
  (event 1, lead 474, conversation 567; the CRM allowlist only lets test phones through). Only one
  later conversation exists for that phone: 582, created 2026-11-19 19:00 by the live test after 567
  was closed. 582 went through qualification again and got its **own new lead 488** with its own
  `lead.qualified` (event 53). That event is `parked` (`max_attempts_exhausted:network_error:timeout
  of 15000ms exceeded`): the CRM dev receiver could not be reached, so the 4 messages of 582 have no
  `message.new`. The cause in this case is delivery, not the candidate rule.
- The suspected gap is narrower than first described: it remains only for a returning customer
  whose new conversation does **not** qualify again (no new lead, so no `lead.qualified`). When they
  do qualify, the CRM gets a second lead/opportunity instead of the existing one. No production case
  of either with a real customer yet, because the allowlist is limited to test phones.
- **L2 (2026-11-23) — owner decision, verbatim:** "a la misma oportunidad si es que no ha querido
  iniciar una nueva cotización". A returning customer's messages go to the existing CRM
  opportunity unless the customer chose to start a new quote.
- **L3 (2026-11-23) — T1 evidence.** RED observed: dispatcher (2 new tests), route/persist (5), evaluate
  flag (unit). GREEN: `npm test` 2167 passed; `test:integration:postgres` 394 passed on a fresh test
  DB (migrations + `db/seeds/001-002`); `check:parity` OK. Found and fixed: the FK first blocked
  test cleanups that hard-delete conversations, so it is `ON DELETE SET NULL`. Pre-existing, not
  this change: several integration suites commit rows without cleanup, so the suite only passes
  once per fresh test DB. Risk: item 1 (migration 043 adds a column, a function and an index).
