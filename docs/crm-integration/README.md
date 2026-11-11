# CRM integration (ClickUp replacement)

Status (2026-11-11): the bot → CRM contract (v1 + revision 1.1) is agreed and live in
the CRM **development** project. Transport is verified end to end. The bot-side
sender for `lead.qualified` is built (see [Bot sender](#bot-sender)) and off by
default. The CRM → bot endpoints are not built yet.

## Scope

The new Hormiglass CRM replaces **only ClickUp** as the seller notification and
management platform. Evolution API, n8n and PostgreSQL stay as they are. There is
no move to the official WhatsApp Cloud API, so Meta's 24-hour template window does
not apply.

## Decisions

- **Integration shape:** two-way webhooks through n8n. No shared database: PostgreSQL
  stays private, and the handoff/lease rules keep living in our SQL.
- **Seller assignment:** stays in our rotation (`crm-lead-creation-and-assignment`).
  The CRM only receives `crm_seller_id`, the seller's `usuarios.id` UUID, stored next to
  the current `clickup_user_id`.
- **Customer creation:** `lead.qualified` reuses the customer that matches the phone, or
  creates one, and creates a new opportunity. Idempotent by `event_id`; the CRM returns
  `crm_customer_id` and `crm_opportunity_id`, stored like the ClickUp task id today.
- **RUT is optional (2026-11-06, owner).** The bot does not ask a natural person for
  their RUT. It sends `rut` only when it has a `company_rut`. The seller completes the
  RUT in the CRM later. `clientes.rut` is nullable in CRM dev and production since
  2026-11-10.
- **Transition:** ClickUp and the CRM run in parallel until the CRM is proven.

## Contract

The source of truth lives in the CRM repository (`hormiglass-cl/hormiglass-system`),
on branch `feat/whatsapp-webhook-receiver`. It is not merged to `main` yet.

- Contract: `docs/integrations/whatsapp-events.md`
- CRM reply to our review: `docs/integrations/whatsapp-events-crm-response.md`
- Receiver: `app/api/integrations/whatsapp/events/route.ts`, `lib/integrations/whatsapp/`
- Migrations: `supabase/migrations/20261104120000_whatsapp_events_receiver.sql`,
  `20261104130000_whatsapp_events_v1_1.sql`

The CRM's contract text still says `clientes.rut` is NOT NULL. That part is outdated.
The receiver reads the column's nullability at runtime, so `rut_required` no longer
fires.

Our review and requests: `.orca/drops/whatsapp-events-bot-response.md`.

### Transport

- `POST /api/integrations/whatsapp/events`, JSON, at most 65,536 raw bytes. Unknown
  fields are rejected, both at the top level and inside `data`.
- `X-WhatsApp-Timestamp` (Unix seconds) and `X-WhatsApp-Signature: v1=<hex>`, an
  HMAC-SHA256 over `timestamp + "." + raw body`. The timestamp must be within ±300 s.
- A retry keeps the same `event_id` and **byte-identical body**, with a fresh
  timestamp and signature. Changed bytes under the same `event_id` return 409.
- Retry 503 and network errors with backoff. Park 400, 401, 409 and 422 for
  reconciliation.

### Events sent to the CRM

Envelope: `schema_version: 1`, `protocol_revision: "1.1"`, `event_id`, `type`,
`conversation_id`, `data`.

| Event | Replaces today | Notes |
|---|---|---|
| `lead.qualified` | ClickUp task creation (`crm-clickup-sync-lead`) | `lead_id`, `revision`, `phone` (`+56…`), `name`, optional `rut`, `crm_seller_id`, `title`, `requirement`. A correction sends a higher `revision` |
| `handoff.created` | Handoff task dispatch | `kind` is `commercial` (`area` sales or management), `operational` or `complaint`. Always sends `reason` (snake_case) and `priority` (urgente, alta, media, baja) |
| `message.new` | — (new: integrated chat) | Text only. Media goes as a placeholder text until a `media` contract exists |
| `ownership.taken` | ClickUp status moved to "in progress" | `version`, `crm_seller_id` (uuid or null), `source: "clickup"` |
| `ownership.released` | Lease restoration (`dispatch-lead-chat-restoration`) | Shares the `version` sequence with `ownership.taken` |

Handoffs to `management`, `finance`, `scheduling` and `claims` return
`pending_routing` until the CRM maps recipients per area.

### Endpoints the CRM calls (n8n webhooks) — not built

| Endpoint | Replaces today |
|---|---|
| `take` | ClickUp status moved to "in progress" (ownership acquisition) |
| `release` / `close` | ClickUp resolved statuses (`normalize-clickup-closure`) |
| `send` | — (new: reply goes out through `wa-outbound-messages`) |
| `history` | — (new: reads conversation messages from PostgreSQL) |

Proposed signing: the same scheme with `X-CRM-Timestamp` / `X-CRM-Signature` and a
separate secret.

## Bot sender

`lead.qualified` goes out through an outbox. The ClickUp path is untouched and keeps
running in parallel.

- Migration `038_create_crm_outbox.sql` (rollback in `infra/postgres/rollback/`):
  table `crm_events`, `sellers.crm_user_id`, and on `leads` the columns
  `crm_customer_id`, `crm_opportunity_id`, `crm_revision`, `crm_enqueued_requirement`
  and `crm_blocked_reason`.
- Workflow `n8n/workflows/crm-events-dispatcher.json` (`CRM - Events Dispatcher`,
  inactive on import). It runs every 30 s in two stages:
  - **Enqueue.** It picks leads that have a seller and were created at or after
    `CRM_EVENTS_SINCE`, and whose requirement differs from the last one enqueued. It
    builds the body once and stores the exact string in `crm_events.body`. A trigger
    keeps that body immutable. A correction to the requirement creates the next
    `revision` as a new event.
  - **Deliver.** It claims due events with `FOR UPDATE SKIP LOCKED` and a
    `claim_token`, then signs and POSTs the stored body unchanged with a fresh
    timestamp. A 200 marks the event `delivered` and writes the CRM ids on the lead.
    503, other 5xx, 408, 429 and network errors go back to `pending` with exponential
    backoff and jitter. Other statuses are `parked`. A row stuck in `processing`
    longer than `CRM_EVENTS_STALE_SECONDS` is claimed again; the CRM answers a
    duplicate with its stored result.
- Logic lives in `tests/fixtures/workflow-nodes/crm-events-dispatcher/` and
  `db/queries/n8n/crm-events-dispatcher/` (synced by `npm run check:parity`).

### Configuration (n8n service)

| Variable | Default | Meaning |
|---|---|---|
| `CRM_EVENTS_ENABLED` | `false` | Only `true` turns the dispatcher on |
| `CRM_EVENTS_URL` | `__PENDIENTE__` | Full URL including `/api/integrations/whatsapp/events` |
| `CRM_EVENTS_HMAC_SECRET` | `__PENDIENTE__` | Shared HMAC secret. Never logged |
| `CRM_EVENTS_SINCE` | `__PENDIENTE__` | ISO instant. Older leads are never sent |
| `CRM_EVENTS_ID_PREFIX` | `__PENDIENTE__` (`test` in the test stack) | Environment namespace for every id, 1-16 lowercase letters or digits |
| `CRM_EVENTS_PROTOCOL_REVISION` | `1.1` | Only `1.1` is supported |
| `CRM_EVENTS_BATCH_SIZE` | `20` | Leads enqueued and events delivered per pass |
| `CRM_EVENTS_STALE_SECONDS` | `900` | Age at which a `processing` claim is taken back |
| `CRM_EVENTS_TIMEOUT_MS` | `15000` | HTTP timeout per delivery |
| `CRM_EVENTS_RETRY_BASE_SECONDS` / `_MAX_SECONDS` | `30` / `3600` | Backoff base and cap |
| `CRM_EVENTS_MAX_ATTEMPTS` | `20` | Retryable failures beyond this are parked |

When it is enabled but a required variable is missing, uses `__PENDIENTE__`, or the
protocol revision is unsupported, the execution fails with the variable names and
nothing is enqueued or sent.

`CRM_EVENTS_ID_PREFIX` is required when enabled. Ids sent to the CRM are
`wa-<prefix>-lead-<id>`, `wa-<prefix>-lead-<id>-r<rev>` and
`wa-<prefix>-conversation-<id>`, where `<id>` is the local database id. The CRM
treats ids as global and answers `409 identity_conflict` when a known id
arrives with different content, so a prefix must never be reused across
environments or after a database reset. Use `prod` for production, `test` for
the test stack, and a unique value per developer machine (e.g. `devjp`); pick a
new prefix whenever a database that already sent events is reset.

### Mapping sellers

Set each seller's CRM `usuarios.id`:

```sql
UPDATE sellers SET crm_user_id = '<crm usuarios.id uuid>' WHERE id = <seller id>;
```

Until a seller is mapped, their leads stay blocked with `seller_not_mapped`. The
next pass after the mapping enqueues them.

### Ops queries

```sql
-- Parked events (need reconciliation)
SELECT id, event_id, lead_id, revision, attempt_count, last_http_status, last_error, updated_at
FROM crm_events WHERE status = 'parked' ORDER BY updated_at DESC;

-- Leads blocked before enqueue
SELECT id, assigned_seller_id, crm_blocked_reason, created_at
FROM leads WHERE crm_blocked_reason IS NOT NULL AND deleted_at IS NULL ORDER BY created_at DESC;

-- Queue health
SELECT status, count(*), min(next_attempt_at) FROM crm_events GROUP BY status;

-- Re-send a parked event after fixing the cause (same event_id, same bytes)
UPDATE crm_events SET status = 'pending', next_attempt_at = NOW(), attempt_count = 0, updated_at = NOW()
WHERE event_id = '<event_id>' AND status = 'parked';
```

## Development environment

- CRM dev Supabase project: `whbqrracrxmeuyerrbdg`. Its schema matches production since
  2026-11-10.
- The endpoint is a Cloudflare quick tunnel. Its URL changes on every restart, and the
  CRM team shares the current one out of band.
- The HMAC secret lives only in the bot's `.env`. It was shared in chat for dev and must
  be rotated before production.
- 2026-11-04 probe: an unsigned request returned 401, and a signed `{}` returned 400
  `invalid_event`. Both are the expected results, and nothing was written.
- Dev sellers: the final UUID list is pending confirmation from the CRM after the
  2026-11-10 production copy.

## Open items

- Bot sender rollout: apply migration 038, import `crm-events-dispatcher`, map
  `sellers.crm_user_id`, set the `CRM_EVENTS_*` variables, then activate. Only
  `lead.qualified` is sent. `handoff.created`, `message.new` and `ownership.*` are
  not built yet.
- Confirmed dev seller UUIDs.
- Phones duplicated among the imported Dolibarr customers return 422
  `ambiguous_customer`.
- CRM → bot endpoints (`take`, `release`/`close`, `send`, `history`).
- Media messages, structured lead fields (city, commune, service, items).
- Customer corrections after confirmation reach the CRM through `revision`.
- Re-enable handoff delivery: since 2026-10-14 it is off in ClickUp.

## Design

Canvas: https://claude.ai/artifact/4VkZuqvA2wRTsHM7RWiivE (private; share it from its
Share menu). Source copy in [`design/`](design/):

- `Main.dc.html`: opportunity modal with the Actividad / WhatsApp switch in the panel header.
- `Inbox.dc.html`: conversation inbox (list, chat, customer and opportunity context).
- `States.dc.html`: conversation states, message types and seller notifications.
