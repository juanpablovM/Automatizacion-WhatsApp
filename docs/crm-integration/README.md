# CRM integration (ClickUp replacement)

Status (2026-11-11): the bot → CRM contract (v1 + revision 1.1) is agreed and live in
the CRM **development** project. Transport is verified end to end. The bot-side
sender for `lead.qualified` is built (see [Bot sender](#bot-sender)) and off by
default. Revision 1.2a (full lead record and `message.new`) is built behind
`CRM_EVENTS_PROTOCOL_REVISION=1.2` (see [Revision 1.2a](#revision-12a)); 1.1 stays the
default. Revision 1.2b (`ownership_version`, `ownership.taken` / `ownership.released`
and the CRM → bot `chat.take` / `chat.release` webhook) is built behind the same
switch and `CRM_INBOUND_ENABLED` (see [Revision 1.2b](#revision-12b)). The CRM → bot
`message.send` (a seller replies from the CRM) is built behind
`CRM_INBOUND_MESSAGE_SEND_ENABLED` (see [message.send](#messagesend-crm--customer)).
Revision 1.2d (contingency handoffs: `handoff.created`, the `conversation_id` identity and
`handoff.acknowledged` / `handoff.resolved`) is built behind `CRM_EVENTS_HANDOFFS_ENABLED` and
`CRM_INBOUND_HANDOFFS_ENABLED` (see [Revision 1.2d](#revision-12d)). The CRM → bot
`opportunity.*` events are not built yet.

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
| `handoff.created` | Handoff task dispatch | 1.2d only. `kind`/`area` is `complaint`/`claims` or `commercial`/`sales`, with `reason` (snake_case), `priority` and exactly one routing key. See [Revision 1.2d](#revision-12d) |
| `message.new` | — (new: integrated chat) | Text only. Media goes as a placeholder text until a `media` contract exists |
| `ownership.taken` | ClickUp status moved to "in progress" | 1.2 only. `version`, `crm_seller_id` (uuid or null), `source` (`clickup` or `crm`). See [Revision 1.2b](#revision-12b) |
| `ownership.released` | Lease restoration (`dispatch-lead-chat-restoration`) | 1.2 only. `version`, `reason`. Shares the `version` sequence with `ownership.taken` |

Under 1.1, handoffs to `management`, `finance`, `scheduling` and `claims` return
`pending_routing`; the bot never sends 1.1 handoffs. Revision 1.2d routes every handoff
to one seller.

### Endpoint the CRM calls (n8n webhook)

One endpoint, `POST <bot n8n>/webhook/crm-events`, takes every CRM → bot event.
`chat.take` and `chat.release` are built (1.2b), see
[Inbound webhook](#inbound-webhook-crm--bot), `message.send`, see
[message.send](#messagesend-crm--customer), and the 1.2d handoff events, see
[Revision 1.2d](#revision-12d). `opportunity.*` comes later:

| Event | Replaces today | Status |
|---|---|---|
| `chat.take` | ClickUp status moved to "in progress" (ownership acquisition) | Built (1.2b) |
| `chat.release` | ClickUp leaving "in progress" (`normalize-clickup-closure`) | Built (1.2b) |
| `opportunity.quote_sent`, `opportunity.closed`, `opportunity.reopened` | ClickUp quote statuses | 1.2c, answers `400 invalid_event` today |
| `handoff.acknowledged`, `handoff.resolved` | ClickUp handoff closure | Built (1.2d), behind `CRM_INBOUND_HANDOFFS_ENABLED` (off: `400 invalid_event`) |
| `message.send` | — (new: a seller replies from the CRM) | Built, behind `CRM_INBOUND_MESSAGE_SEND_ENABLED` (off: `400 invalid_event`) |

## Bot sender

`lead.qualified` goes out through an outbox. The ClickUp path is untouched and keeps
running in parallel.

- Migration `038_create_crm_outbox.sql` (rollback in `infra/postgres/rollback/`):
  table `crm_events`, `sellers.crm_user_id`, and on `leads` the columns
  `crm_customer_id`, `crm_opportunity_id`, `crm_revision`, `crm_enqueued_requirement`
  and `crm_blocked_reason`.
- Workflow `n8n/workflows/crm-events-dispatcher.json` (`CRM - Events Dispatcher`,
  active like the other schedulers; it does nothing unless `CRM_EVENTS_ENABLED=true`).
  It runs every minute in three stages:
  - **Enqueue.** It picks leads that have a seller and were created at or after
    `CRM_EVENTS_SINCE`, and whose requirement differs from the last one enqueued. It
    builds the body once and stores the exact string in `crm_events.body`. A trigger
    keeps that body immutable. A correction to the requirement creates the next
    `revision` as a new event. Under 1.2 any change in the record the CRM receives
    is a correction (see [Revision 1.2a](#revision-12a)).
  - **Enqueue messages (1.2 only).** Chat messages of conversations the CRM already
    knows become `message.new` events. Under 1.1 this stage selects nothing.
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
| `CRM_EVENTS_PHONE_ALLOWLIST` | empty (no filter) | Comma-separated phones (spaces and a leading `+` are ignored, each 8-15 digits). When set, only leads with one of these phones are sent. See [Phone allowlist](#phone-allowlist) |
| `CRM_EVENTS_ID_PREFIX` | `__PENDIENTE__` (`test` in the test stack) | Environment namespace for every id, 1-16 lowercase letters or digits |
| `CRM_EVENTS_PROTOCOL_REVISION` | `1.1` | `1.1` or `1.2`. Switch to `1.2` only after the CRM confirms it in that environment |
| `CRM_EVENTS_BATCH_SIZE` | `20` | Leads enqueued per pass; under 1.1 also events delivered per pass |
| `CRM_EVENTS_DELIVER_BATCH_SIZE` | empty (1.1: `CRM_EVENTS_BATCH_SIZE`, 1.2: `100`) | Events delivered per pass. 1.2 sends one event per chat message, so 100 per minute keeps bursts from lagging |
| `CRM_EVENTS_MESSAGE_BATCH_SIZE` | `100` | Messages enqueued per pass (1.2 only) |
| `CRM_EVENTS_DELIVER_BUDGET_SECONDS` | `450` | A pass never starts a POST that could outlive this budget (the workflow times out at 600 s). Rows it does not reach go back to `pending` in 1 s with `last_error = deferred:execution_budget` |
| `CRM_EVENTS_STALE_SECONDS` | `900` | Age at which a `processing` claim is taken back |
| `CRM_EVENTS_TIMEOUT_MS` | `15000` | HTTP timeout per delivery |
| `CRM_EVENTS_RETRY_BASE_SECONDS` / `_MAX_SECONDS` | `30` / `3600` | Backoff base and cap |
| `CRM_EVENTS_MAX_ATTEMPTS` | `20` | Retryable failures beyond this are parked |
| `CRM_EVENTS_HANDOFFS_ENABLED` | `false` | Only `true` sends handoffs as `handoff.created`. Ignored unless the protocol revision is `1.2` |

| `CRM_INBOUND_ENABLED` | `false` | Only `true` turns the `/webhook/crm-events` receiver on. Otherwise it answers `503 receiver_unavailable` |
| `CRM_INBOUND_HMAC_SECRET` | `__PENDIENTE__` | Secret the CRM signs `X-CRM-Signature` with. Must differ from `CRM_EVENTS_HMAC_SECRET` (the receiver answers 503 if they are equal). Never logged |
| `CRM_INBOUND_HANDOFFS_ENABLED` | `false` | Only `true` accepts `handoff.acknowledged` / `handoff.resolved` and the `conversation_id` identity; otherwise they answer exactly as before (`400 invalid_event`). Needs a valid `CRM_EVENTS_ID_PREFIX` (else those requests answer 503) |
| `CRM_INBOUND_MESSAGE_SEND_ENABLED` | `false` | Only `true` accepts `message.send`; otherwise it answers `400 invalid_event` (type not built). Needs a valid `CRM_EVENTS_ID_PREFIX` (else `message.send` answers 503) and the `EVOLUTION_API_*` variables the bot already uses |

When it is enabled but a required variable is missing, uses `__PENDIENTE__`, or the
protocol revision is unsupported, the execution fails with the variable names and
nothing is enqueued or sent.

### Phone allowlist

`CRM_EVENTS_PHONE_ALLOWLIST` lets production send events to the CRM's dev
environment for test phones only, never for real customers. Leads whose phone is
not listed are not selected at all: no `lead.qualified`, and they are not marked
blocked. Messages and ownership events follow the lead filter, because both are
only sent for conversations already announced by a delivered `lead.qualified`.
An entry that is not 8-15 digits fails the execution
(`CRM_EVENTS_PHONE_ALLOWLIST_invalid`) and nothing is sent. Remove the variable
when going live against the CRM production environment.

`CRM_EVENTS_ID_PREFIX` is required when enabled. Ids sent to the CRM are
`wa-<prefix>-lead-<id>`, `wa-<prefix>-lead-<id>-r<rev>` and
`wa-<prefix>-conversation-<id>`, where `<id>` is the local database id. The CRM
treats ids as global and answers `409 identity_conflict` when a known id
arrives with different content, so a prefix must never be reused across
environments or after a database reset. Use `prod` for production, `test` for
the test stack, and a unique value per developer machine (e.g. `devjp`); pick a
new prefix whenever a database that already sent events is reset.

### Revision 1.2a

Revision 1.2 is live on CRM dev. The receiver rejects any unknown key or invalid
value with 400, so the bot **omits** an optional key whenever its value does not map
cleanly; it never sends an empty string or `null` for an optional key. Free text is
cut to the CRM maximum; identifiers (`rut`, `purchase_order`) are omitted instead of
cut. Migration `039_crm_events_messages.sql` (rollback in `infra/postgres/rollback/`)
backs it.

#### `lead.qualified` fields under 1.2

The 1.1 fields (`lead_id`, `revision`, `phone`, `name`, `rut`, `crm_seller_id`,
`title`, `requirement`) are unchanged. `qc` is `leads.qualification_context`.

| CRM field | Bot source | Mapping |
|---|---|---|
| `customer_type` | `qc.customer_type` | `b2c`, `particular`, `persona`, `natural` → `natural`; `b2b`, `contractor`, `empresa`, `constructora`, `company` → `company`; anything else omitted |
| `company` | `qc.company` | Text, 200 |
| `tax_document` | `qc.invoice_required` | `true` → `factura`, `false` → `boleta` (booleans only, as the ClickUp label) |
| `purchase_order` | `qc.purchase_order` | Omitted if longer than 100 |
| `service` | `leads.service` | Text, 100 |
| `fulfillment` | `qc.service_scope`, `qc.fulfillment`, `qc.modality`, `leads.service` | Factory pickup (same rule as the title) → `pickup`; `service_scope` installation/both or `modality` installation → `install`; `fulfillment`/`modality` delivery → `delivery`; else omitted |
| `city` | `leads.city` | Text, 100. Omitted for a pickup |
| `commune` | `qc.commune` | Text, 100. Omitted for a pickup |
| `address` | `qc.address` | Text, 300 |
| `use_case` | `qc.use_case` | Text, 200 |
| `urgency` | `qc.urgency` | `urgente`/`urgent`, `alta`/`high`, `media`/`medium`, `baja`/`low` (case and accents ignored); else omitted |
| `desired_date` | `qc.desired_date` | `YYYY-MM-DD`, or day-first `DD/MM/YYYY` / `DD-MM-YYYY`, only if it is a real calendar date. Free text ("el lunes") is omitted |
| `source_number` | `whatsapp_numbers.phone_number` of `leads.source_number_id` | `+` and 8–15 digits, else omitted |
| `site` | `qc.terrain` (100), `qc.truck_access` (bool), `qc.debris_removal` (bool), `qc.access_restrictions` (500) | Only the keys present; non-boolean access values omitted; no `site` if none |
| `items` | `qc.line_items[]` (or the flat `qc.product`/`quantity`/`measurements` of a historical quote) | Up to 50; items without a product skipped. `quantity` is a number when the bot value is a positive number or "number + one unit word" (`"20 m3"` → `20`, `unit: "m3"`); anything else (`"1.500"`, `"unas cuantas"`) is `null`, the full text stays in `requirement`. `variant`/`measurements` text 200 or `null`; `unit` from the item or the parsed word, `null` if over 20 |
| `ai_summary` | newest `advisor_decisions.output_payload` of the lead | `lead_class` (except `none`), `next_best_action`, `executive_summary`, `diagnostic_datos.pain/scope/timing/obstacle`; text 4000; omitted if empty. Dropped first if the body would exceed 65,536 bytes |

**Corrections.** Under 1.2 a new `revision` is sent when the record the CRM would
receive changes, not only the requirement. `leads.crm_enqueued_record_hash` holds the
sha256 of every `data` field except `lead_id`, `revision` and `ai_summary`, so AI
summary churn never creates a revision. To avoid rebuilding every lead each minute,
`crm_lead_source_hash()` fingerprints the raw inputs (lead columns,
qualification context, conversation, seller mapping, source number) and
`leads.crm_checked_source_hash` records the last one examined; a lead is rebuilt
only when its inputs changed, and enqueued only when its record hash changed.

Switching an environment from 1.1 to 1.2 sends each lead already enqueued under 1.1
once more, as its next revision with the full record (the CRM answers `updated`).
Switching back to 1.1 does not re-send them.

#### `message.new`

Sent only under 1.2. A message is enqueued when its conversation was announced by a
**delivered** `lead.qualified` (so the CRM knows the conversation), it was created at
or after `CRM_EVENTS_SINCE`, and it is not deleted. The whole chat of that
conversation goes, including messages from before the lead qualified. Messages of
the lead's other conversations do not, with one exception below.

**Returning customer (migration 043).** After a handoff the bot opens a new
conversation for most turns. Owner rule: the customer stays on the same
opportunity unless they asked for a new quote. When the bot opens a conversation
and the customer did not accept the quote follow-up offer nor wrote an explicit
new-request directive ("nueva cotización", "otra cotización", …), the new
conversation records `conversations.continues_conversation_id`. Its messages are
sent under the **announced** conversation id, with that lead's seller, while it
has no lead of its own. Once it re-qualifies into its own lead it is a new quote:
it follows its own `lead.qualified`, and its earlier messages stay where they
were sent. A customer who asked for a new quote gets no link, so their new
conversation reaches the CRM only once it qualifies.

| CRM field | Bot source |
|---|---|
| `message_id` | `wa-<prefix>-message-<messages.id>` (event id: `…-e1`) |
| `conversation_id` | `wa-<prefix>-conversation-<messages.conversation_id>` (same as the lead events); for a linked conversation, the announced one it continues |
| `direction` / `sender` | `incoming` → `inbound` / `customer`. `outgoing` → `outbound` with `sender_type` `bot` → `bot`, `system` → `system`, `human` → `seller` |
| `crm_seller_id` | Only for `seller`: `sellers.crm_user_id` of the seller assigned to the conversation's lead |
| `text` | `text_body`. Media becomes `[image]`, `[audio]`, `[video]`, `[location]` or `[document] <file name>`, followed by the caption on a new line when there is one. Empty text is `[empty message]`, other types `[unsupported message]`. Cut to 16,000 |
| `sent_at` | `external_timestamp`, else `created_at`, as UTC `YYYY-MM-DDTHH:MM:SS.mmmZ` |

- Outgoing messages go only once `delivery_status = 'sent'` (the rule the
  conversation history uses); queued, failed, cancelled or unknown sends never do.
- `sender_type` is `NOT NULL` with a check (`customer`, `bot`, `human`, `system`) since
  migration 018, and its historic rows were backfilled from `direction`. A value
  outside that set, or an outgoing `customer`, is blocked rather than guessed.
- A seller reply whose seller has no `crm_user_id` is blocked, never sent as `bot`.
  Mapping the seller sends it on the next pass.
- A message event has `lead_id` NULL; delivering it never touches `leads`. The CRM
  result (`crm_message_id`, `status` `created` or `duplicate`) is kept in
  `crm_events.response`.

#### Blocked reasons

| Where | Reason | Fix |
|---|---|---|
| `leads.crm_blocked_reason` | `seller_not_mapped`, `invalid_seller_uuid` | Map `sellers.crm_user_id` |
| `leads.crm_blocked_reason` | `invalid_phone`, `conversation_missing`, `invalid_revision`, `invalid_id`, `payload_too_large` | Fix the lead data; under 1.2 the change is picked up automatically |
| `crm_message_blocks.reason` | `seller_not_mapped`, `invalid_seller_uuid` | Map the conversation seller's `crm_user_id` |
| `crm_message_blocks.reason` | `sender_direction_mismatch`, `unknown_sender_type`, `invalid_direction`, `invalid_sent_at`, `conversation_missing`, `invalid_id`, `payload_too_large` | Data defect in `messages`; investigate before fixing |

Blocked messages are retried every pass, after fresh ones.

#### Switching to 1.2

1. The CRM confirms revision 1.2 in that environment.
2. Apply migration 039.
3. Import the updated `crm-events-dispatcher` workflow.
4. Set `CRM_EVENTS_PROTOCOL_REVISION=1.2` and restart n8n.

To go back, set `CRM_EVENTS_PROTOCOL_REVISION=1.1`: message enqueue stops, and
pending `message.new` rows keep being delivered (they are already stored as 1.2).

### Revision 1.2b

Migration `040_crm_ownership_and_inbound.sql` (rollback in `infra/postgres/rollback/`)
backs it. ClickUp keeps running in parallel and **no ClickUp query or workflow
changed** (owner decision 2026-11-11, option 1).

#### `ownership_version`

- One monotonic `ownership_version` per conversation, in
  `crm_conversation_ownership` (with the last change: owner `bot`/`seller`,
  `seller_id`, `source` `clickup`/`crm`/`bot`, `reason`, `changed_at`). Every version is
  a row of `crm_ownership_changes`.
- A trigger on `lead_chat_ownerships` advances it on **every** acquisition (a live row
  inserted) and **every** release (`released_at` set), whoever wrote it: the ClickUp
  webhook, the CRM webhook, the SLA sweeper, a seller's own WhatsApp reply, or the
  customer asking for a new quote. ClickUp and the CRM share one sequence. A ClickUp
  re-delivery of the same take does not advance it.
- The trigger never fails the write that fired it. An error is logged as a PostgreSQL
  `WARNING` and only the tracking is skipped. A lead without a conversation is not
  versioned.
- The conversation is the one the lead is announced under (`leads.source_conversation_id`,
  else its newest conversation), the same as `lead.qualified`.

#### `ownership.taken` / `ownership.released`

Sent only under 1.2, one event per version, for conversations announced by a
**delivered** `lead.qualified`, changes at or after `CRM_EVENTS_SINCE`, in version
order (changes from before the lead qualified are included). The dispatcher stage
`Select Ownership Candidates` → `Build Ownership Events` → `Insert Ownership Events`
enqueues them; delivery is the shared stage. Event id:
`wa-<prefix>-ownership-<conversation id>-v<version>`.

```json
{"schema_version":1,"protocol_revision":"1.2","event_id":"wa-prod-ownership-812-v3","type":"ownership.taken","conversation_id":"wa-prod-conversation-812","data":{"version":3,"crm_seller_id":"6f1c2a34-5b6d-4e7f-8a9b-0c1d2e3f4a5b","source":"crm"}}
{"schema_version":1,"protocol_revision":"1.2","event_id":"wa-prod-ownership-812-v4","type":"ownership.released","conversation_id":"wa-prod-conversation-812","data":{"version":4,"reason":"sla_expired"}}
```

| Field | Source |
|---|---|
| `version` | `crm_ownership_changes.ownership_version` (1 … 2,147,483,647) |
| `crm_seller_id` | `sellers.crm_user_id` of the taking seller: the CRM seller for a CRM take, else the lead's assigned seller. `null` when unmapped (the key is always sent) |
| `source` | `crm` for a CRM `chat.take`, else `clickup` (a ClickUp take or a seller's late WhatsApp reply) |
| `reason` | `release_reason` `sla_expired` → `sla_expired`; `customer_new_quote` → `customer_new_quote`; `clickup_released`, `manual` (CRM `chat.release`, ops archive) and anything else → `seller_released`. `opportunity_closed` comes with 1.2c |

The CRM answers `200 {event_id, ownership_version, owner}`, also for a stale version
(it keeps its newer state). Any 200 echoing the `event_id` is `delivered`; nothing is
written on the lead. A change that cannot be built (for example a version over the
int32 range) records `crm_ownership_changes.crm_blocked_reason` and is retried after
fresh ones.

#### Inbound webhook (CRM → bot)

Workflow `n8n/workflows/crm-inbound-events.json` (`CRM - Inbound Events`), webhook
`POST /webhook/crm-events`. Logic lives in
`tests/fixtures/workflow-nodes/crm-inbound-events/` and
`crm_inbound_apply_chat_event()` (migration 040), called from
`db/queries/n8n/crm-inbound-events/01_apply_crm_chat_event.sql`.

Request:

```http
POST /webhook/crm-events
Content-Type: application/json
X-CRM-Timestamp: 1794409200
X-CRM-Signature: v1=<lowercase hex HMAC-SHA256(CRM_INBOUND_HMAC_SECRET, timestamp + "." + raw body)>

{"schema_version":1,"protocol_revision":"1.2","event_id":"crm-evt-01HF","type":"chat.take","occurred_at":"2026-11-11T15:00:00Z","data":{"crm_opportunity_id":"66666666-7777-4888-9999-aaaaaaaaaaaa","crm_seller_id":"6f1c2a34-5b6d-4e7f-8a9b-0c1d2e3f4a5b","ownership_version":2}}
```

- The webhook runs with n8n's Raw Body option; the HMAC is checked over the exact
  bytes with a constant-time compare, never over the parsed JSON. Timestamp: 10
  digits, within ±300 s. Body: at most 65,536 bytes of UTF-8 JSON.
- Envelope keys only `schema_version` (1), `protocol_revision` (`"1.2"`), `event_id`
  (`^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$`), `type`, `occurred_at` (UTC ISO with `Z`),
  `data`. `chat.take` / `chat.release` data keys only `crm_opportunity_id` (uuid),
  `crm_seller_id` (uuid), `ownership_version` (integer ≥ 0; `0` when the CRM never
  saw one). Anything else is `400 invalid_event`.
- Idempotency: `crm_inbound_events` keeps each `event_id` with the sha256 of the raw
  body and the response it got. The same id with the same bytes returns that stored
  response (status and body); the same id with other bytes is `409 event_conflict`.
  Only responses decided by the database (200, 409 `ownership_conflict`, 422) are
  stored; 400/401/413/503 are not.
- The conversation comes from `leads.crm_opportunity_id`; the seller from an active
  `sellers.crm_user_id`.
- `chat.take` uses the ClickUp acquire semantics (copied, not shared): the bot goes
  silent, the newest customer message is pending and opens a 2-hour window (no
  message, no deadline yet), `sla_mode` standard. The row has no ClickUp task
  (`clickup_task_id` NULL, `acquired_via = 'crm'`, `owner_seller_id`). A lease whose SLA
  already expired but was not swept yet is first released as `sla_expired`.
- `chat.release` is allowed only to the holder; it releases with `release_reason
  'manual'`, `released_via = 'crm'`, and the bot resumes.
- Both changes go through the version trigger, so the bot echoes them back as
  `ownership.taken` (`source: "crm"`) / `ownership.released` (`seller_released`).

Responses (JSON, `Cache-Control: no-store`):

| Status | Body | When |
|---|---|---|
| 200 | `{"event_id":"crm-evt-01HF","result":"applied","ownership_version":3}` | Applied. A take by the seller who already holds the chat is also `applied`, with the unchanged version |
| 200 | `{"event_id":"crm-evt-01HF","result":"ignored_stale","ownership_version":5}` | `data.ownership_version` is lower than the bot's, or a release of a chat the bot already owns. Nothing changes |
| 409 | `{"error":"ownership_conflict","holder_crm_seller_id":"7a2d3b45-6c7e-4f80-9bac-1d2e3f4a5b6c","ownership_version":3}` | Another seller holds the chat (`holder_crm_seller_id` is `null` for a seller without a CRM mapping). The bot never reassigns silently |
| 409 | `{"error":"event_conflict","event_id":"crm-evt-01HF"}` | Same `event_id`, different bytes |
| 422 | `{"error":"invalid_opportunity","event_id":"crm-evt-01HF"}` / `{"error":"invalid_seller","event_id":"crm-evt-01HF"}` | Unknown opportunity (or its lead has no conversation) / seller not mapped or inactive |
| 400 | `{"error":"invalid_event","details":["data.note: unknown"]}` | Envelope or data invalid, or a type not built yet. `details` names fields, never values |
| 401 | `{"error":"unauthorized"}` | Missing, malformed, wrong or stale signature or timestamp |
| 413 | `{"error":"payload_too_large"}` | Body over 65,536 bytes |
| 503 | `{"error":"receiver_unavailable"}` | `CRM_INBOUND_ENABLED` is not `true`, the secret is missing or equals the outbound one, or the database failed. Retry with backoff |

Neither the secret nor the raw body is ever logged or returned.

#### `message.send` (CRM → customer)

A seller replies to the customer from the CRM. Same endpoint, signature, timestamp,
size and idempotency rules as `chat.take`; off until
`CRM_INBOUND_MESSAGE_SEND_ENABLED=true`. Logic: `crm_inbound_claim_message_send()` and
`crm_inbound_complete_message_send()` (migration 041), called from
`db/queries/n8n/crm-inbound-events/02_claim_crm_message_send.sql` and
`03_complete_crm_message_send.sql`; the Evolution call is
`tests/fixtures/workflow-nodes/crm-inbound-events/send-crm-message.js`.

```json
{"schema_version":1,"protocol_revision":"1.2","event_id":"crm-evt-02AB","type":"message.send","occurred_at":"2026-11-18T15:00:00Z","data":{"crm_opportunity_id":"66666666-7777-4888-9999-aaaaaaaaaaaa","crm_seller_id":"6f1c2a34-5b6d-4e7f-8a9b-0c1d2e3f4a5b","client_message_id":"0b6f7a1e-2c3d-4e5f-8a9b-1c2d3e4f5a6b","ownership_version":4,"text":"Hola, le escribo de Hormiglass"}}
```

- `data` keys only `crm_opportunity_id` (uuid), `crm_seller_id` (uuid, the sender's
  own id), `client_message_id` (uuid, one per message), `ownership_version` (integer
  ≥ 0) and `text` (string; trimmed, 1–4,096 characters, no NUL). The trimmed text is
  what the customer receives. Anything else is `400 invalid_event` naming the field.
- Opportunity and seller resolve exactly as `chat.take` (422 in the same cases).
- Ownership: the sender holds the chat → send. The bot holds it → the chat is first
  taken for the sender by `crm_inbound_apply_chat_event()` itself (the same effect as
  an applied `chat.take`: bot silent, 2-hour window, version advanced,
  `ownership.taken` with `source: "crm"`; its inbox row is
  `message.send/<event_id>/take-<attempt>`), then the message is sent. Another seller
  holds it → `409 ownership_conflict`, nothing sent. `data.ownership_version` is
  validated but never blocks a send (a seller replying is attending); responses carry
  the current version.
- Exactly once toward the customer: the intent is stored and claimed in
  `crm_outbound_messages` (status `sending`) **before** Evolution is called, and
  Evolution is called once per claim (it has no idempotency key). Outcome:
  - 2xx with a nonblank string message id in `body.key.id` or `body.data.key.id` →
    `sent`; no other id format is assumed. The message is stored in `messages` as
    outgoing, `sender_type 'human'` (the same shape as a seller's reply from their
    phone), with that Evolution id. The seller's reply satisfies the 2-hour window
    of a live lease, as `04_register_human_reply.sql` does. The dispatcher then sends
    the usual `message.new` with `sender: "seller"` and the **sender's**
    `crm_seller_id` (an admin is not the assigned seller).
  - 2xx without a usable id → `unknown`, `503`. The provider status is retained,
    the provider id stays null, and the fixed diagnostic is
    `evolution_message_id_missing`; the provider response body is not stored. Never
    resent automatically (see [Stuck message.send](#stuck-messagesend)).
  - 4xx, a refused connection, or 5xx "Connection Closed" (WhatsApp unlinked) →
    `failed`, `503`. A retry with the same bytes sends again.
  - Any other 5xx, a timeout or a reset → `unknown`, `503`. Never resent
    automatically (see [Stuck message.send](#stuck-messagesend)).
- The fromMe echo Evolution sends for that message is recognized by its
  `external_message_id` in `08_persist_own_message_from_evolution.sql` (unchanged) and
  is not stored again; it runs the seller-reply path like any phone reply. If the echo
  is processed before the completion, the completion adopts the row the echo stored.
- `CRM_EVENTS_PHONE_ALLOWLIST` only filters bot → CRM events. It does not restrict
  `message.send`: the CRM can only address opportunities it received, which the
  allowlist already limits. The `message.new` of a CRM-sent message is emitted only
  for conversations whose `lead.qualified` was delivered, like every message.

Responses (besides the 400/401/413 of every event):

| Status | Body | When |
|---|---|---|
| 200 | `{"event_id":"crm-evt-02AB","result":"sent","message_id":"wa-prod-message-4871","ownership_version":5}` | Evolution accepted it and returned a usable provider message id. `message_id` is the one the later `message.new` carries |
| 409 | `{"error":"ownership_conflict","holder_crm_seller_id":"…","ownership_version":5}` | Another seller holds the chat. Nothing sent |
| 409 | `{"error":"event_conflict","event_id":"crm-evt-02AB"}` | Same `event_id`, other bytes; or the `client_message_id` was already used by another `event_id` |
| 422 | `invalid_opportunity` / `invalid_seller` | As `chat.take` |
| 503 | `{"error":"receiver_unavailable"}` | Not sent (Evolution failed or WhatsApp is down; retry the same bytes), Evolution returned 2xx without a usable provider message id (`unknown`, never resent), an earlier attempt is still `sending` / `unknown`, the database failed, or `CRM_EVENTS_ID_PREFIX` is invalid |

Retries with the same `event_id` and bytes: `sent` returns the stored 200;
`failed` sends again; `sending` / `unknown` answer 503 and send nothing. 409
(`ownership_conflict`) and 422 are stored and replayed like `chat.take`'s.

#### Stuck `message.send`

A `sending` row older than a minute (the n8n execution died between the claim and
the completion, or the completion's database write failed) or an `unknown` row
(ambiguous Evolution result) needs an operator: the bot cannot tell whether the
customer got the message, so it never resends it.

```sql
SELECT id, event_id, conversation_id, status, attempt_count, provider_status, last_error, claimed_at
FROM crm_outbound_messages
WHERE status IN ('sending', 'unknown') AND claimed_at < NOW() - INTERVAL '1 minute'
ORDER BY claimed_at;
```

Check the chat in WhatsApp (or `messages` for an outgoing row with the same text
around `claimed_at`, which the fromMe echo stores as `sender_type 'human'`). Then:

- **It reached the customer:** link it and mark it sent:
  `UPDATE crm_outbound_messages SET status = 'sent', message_id = <messages.id>, sent_at = NOW(), completed_at = NOW() WHERE id = <id>;`
  and store the answer the CRM will get on its next retry:
  `UPDATE crm_inbound_events SET http_status = 200, response = jsonb_build_object('event_id', '<event_id>', 'result', 'sent', 'message_id', 'wa-<prefix>-message-<messages.id>', 'ownership_version', <current version>) WHERE event_id = '<event_id>';`
- **It did not:** `UPDATE crm_outbound_messages SET status = 'failed', last_error = 'operator: not delivered', completed_at = NOW() WHERE id = <id>;`
  The next CRM retry with the same bytes sends it.

#### SLA expiry and the ClickUp path during the parallel run

- A CRM-held chat follows the same 2-hour rule. The existing lease sweeper
  (`06_claim_expired_ownerships.sql`) releases it as `sla_expired`; with no ClickUp task
  and no previous status it queues no ClickUp call (`restoration_state
  'skipped_no_previous_status'`, whose `restoration_error` text is expected for these
  rows). The trigger emits `ownership.released` (`sla_expired`).
- A seller replying from their phone after the CRM released the chat takes it back as
  today (`04_register_human_reply.sql`); the ClickUp reacquisition is skipped because
  the row has no task (`clickup_task_id_missing`).
- **ClickUp shows stale status for CRM-driven actions.** A CRM take or release never
  moves the ClickUp task. A ClickUp transition still acts on the chat, whichever side
  took it: the most recent action wins, and both share `ownership_version`.
- Shared-schema change: `lead_chat_ownerships.clickup_task_id` is now nullable (the
  `<> ''` check stays). Every ClickUp query keeps writing a task id.

#### Switching message.send on

1. Apply migration 041, then import `crm-inbound-events` **and** `crm-events-dispatcher`
   (its message query reads `crm_outbound_messages`, so it needs 041 first).
2. Check `CRM_EVENTS_ID_PREFIX` is the dispatcher's prefix, set
   `CRM_INBOUND_MESSAGE_SEND_ENABLED=true` and restart n8n.
3. Rollback: `CRM_INBOUND_MESSAGE_SEND_ENABLED=false`, re-import the previous two
   workflows, then `infra/postgres/rollback/041_crm_message_send.down.sql`.

#### Switching 1.2b on

1. Apply migration 040 and import `crm-events-dispatcher` and `crm-inbound-events`.
2. Expose `/webhook/crm-events` the same way as the ClickUp webhook (stable HTTPS
   hostname) and share the URL and a new `CRM_INBOUND_HMAC_SECRET` out of band.
3. Set `CRM_INBOUND_HMAC_SECRET`, then `CRM_INBOUND_ENABLED=true`, and restart n8n.
   Ownership events go out once `CRM_EVENTS_PROTOCOL_REVISION=1.2`.

### Revision 1.2d

Contingency handoffs (a complaint, the customer asks for a person, the bot cannot
continue) reach the CRM with one owner each. Agreed in `.orca/drops/whatsapp-events-1.2d-*.md`;
feature document `odd/tasks/crm-1-2d-contingency-handoffs.md`.

**Owner rules (2026-11-23):** complaints go to post-sale and everything else to sales.
Post-sale is the sales team. Each handoff has one owner: the seller of the customer's
opportunity, otherwise the next seller in the lead rotation. A re-escalation (a new
handoff while one is still open, after 48 h) goes back to the same seller.

#### handoff.created (bot → CRM)

- **Area.** A v3 handoff whose reason names an `issue_description` observation is a
  complaint: stored as `area = 'claims'` (`17_persist_v3_handoff_effect.sql`) and sent as
  `kind: complaint, area: claims`. Every other handoff is `kind: commercial, area: sales`.
- **Routing** (`crm_route_handoff`, migration 045), decided once and stored on the handoff
  (`crm_opportunity_id` or `crm_routing_seller_id`, migration 044):
  1. another open, routed handoff of the same conversation: the same key;
  2. the newest live lead of that phone with an opportunity: `crm_opportunity_id`;
  3. a test phone (`LEAD_TEST_PHONE_NUMBERS`): `LEAD_TEST_SELLER_ID`;
  4. the lead rotation (same lock, pointer and order as leads), among active sellers
     with a `crm_user_id`: `crm_seller_id` plus `phone` and `name` when known.
  All routing takes one lock (`crm-handoff-routing`) before the rotation lock, so two
  overlapping dispatcher passes never deadlock.
- **Responses.** 200 stores `crm_case_id`. `422 invalid_seller` parks the event and the
  next pass sends revision + 1 (same `handoff_id`, new `event_id` `...-r<revision>`) to the
  next seller; once every eligible seller was rejected the handoff is blocked
  (`crm_blocked_reason = 'no_eligible_seller'`).
- **Messages.** A delivered `handoff.created` announces the conversation like a delivered
  `lead.qualified`: earlier messages are backfilled as `message.new`, then live ones and
  ownership changes follow.
- Handoffs stay `estado = 'pending'` after delivery; the ClickUp handoff path is untouched.

#### conversation_id identity and closure (CRM → bot)

- `chat.take`, `chat.release` and `message.send` carry exactly one of
  `crm_opportunity_id` or `conversation_id` (`wa-<prefix>-conversation-<id>`); both or
  neither is `400 invalid_event`. A conversation not handed off by the bot, or one with
  an opportunity, answers `422 unknown_conversation`.
- The acting `crm_seller_id` must be an active seller, except the seller the handoff was
  routed to (migration 048): the configured test seller (`LEAD_TEST_SELLER_ID`) stays
  inactive so the rotation never picks it, yet it owns test-phone handoffs.
- **No lead needed (migration 047).** A handed-off conversation whose customer has no
  lead keeps its chat ownership in `lead_chat_ownerships` keyed by `conversation_id`
  (`lead_id` NULL, exactly one key). The bot's silence, outbound authority, debounce,
  2-hour expiry and seller phone replies read that key too. If a lead is created later
  for that conversation, the live row moves onto the lead. No lead or opportunity is
  ever created for it.
- `handoff.acknowledged` / `handoff.resolved`, `data` exactly `{handoff_id, crm_seller_id}`:
  same transitions as the ClickUp closure (`notified → acknowledged`,
  `notified | acknowledged → resolved`; a delivered `pending` handoff counts as
  `notified`). Resolved closes an `escalation_required` conversation and every other
  open handoff of it. `200 applied`, `200 duplicate` (state already reached),
  `409 invalid_transition`, `422 unknown_handoff`.

#### Switching 1.2d on

1. Apply migrations 044 to 048 (rollbacks in `infra/postgres/rollback/`, in reverse
   order). Import `crm-events-dispatcher`, `crm-inbound-events`,
   `wa-conversation-orchestrator`, `wa-inbound-entry` and `wa-outbound-messages`.
2. With `CRM_EVENTS_PROTOCOL_REVISION=1.2`, set `CRM_EVENTS_HANDOFFS_ENABLED=true` and
   `CRM_INBOUND_HANDOFFS_ENABLED=true`, then restart n8n.
3. Rollback: both flags `false`, re-import the previous workflows, then the rollbacks
   048 → 044. Rollback 047 deletes the conversation-keyed ownership rows.

### Mapping sellers

Set each seller's CRM `usuarios.id`:

```sql
UPDATE sellers SET crm_user_id = '<crm usuarios.id uuid>' WHERE id = <seller id>;
```

Until a seller is mapped, their leads stay blocked with `seller_not_mapped`. The
next pass after the mapping enqueues them.

CRM admins must be able to take and answer chats too. Map each one as an active
seller **without a ClickUp user**:

```sql
INSERT INTO sellers (name, is_active, sort_order, crm_user_id)
VALUES ('<admin name> (CRM admin)', TRUE, <unused sort_order>, '<crm usuarios.id uuid>');
```

- The rotation only picks sellers with a `clickup_user_id`, so an admin is never
  assigned a lead.
- An admin's `chat.take` makes them the holder: the bot goes silent, the 2-hour
  window applies, and `ownership.taken` carries the admin's `crm_seller_id`.
- To act on a chat another seller holds, the admin first releases it on the holder's
  behalf (the CRM sends the holder's `crm_seller_id`), then takes it. A take while
  someone else holds the chat is `409 ownership_conflict`.
- An unmapped admin gets `422 invalid_seller`.

### Ops queries

```sql
-- Parked events (need reconciliation)
SELECT id, event_id, lead_id, revision, attempt_count, last_http_status, last_error, updated_at
FROM crm_events WHERE status = 'parked' ORDER BY updated_at DESC;

-- Leads blocked before enqueue
SELECT id, assigned_seller_id, crm_blocked_reason, created_at
FROM leads WHERE crm_blocked_reason IS NOT NULL AND deleted_at IS NULL ORDER BY created_at DESC;

-- Messages blocked before enqueue (1.2)
SELECT b.message_id, b.reason, m.conversation_id, m.sender_type, b.updated_at
FROM crm_message_blocks b JOIN messages m ON m.id = b.message_id ORDER BY b.updated_at DESC;

-- Queue health per event type
SELECT event_type, status, count(*), min(next_attempt_at) FROM crm_events GROUP BY 1, 2 ORDER BY 1, 2;

-- Queue health
SELECT status, count(*), min(next_attempt_at) FROM crm_events GROUP BY status;

-- Ownership version and recent changes of a conversation (1.2b)
SELECT * FROM crm_conversation_ownership WHERE conversation_id = <conversation id>;
SELECT ownership_version, change_kind, source, reason, raw_reason, crm_blocked_reason, changed_at
FROM crm_ownership_changes WHERE conversation_id = <conversation id> ORDER BY ownership_version;

-- Recent CRM -> bot events and the answer they got (1.2b)
SELECT event_id, event_type, http_status, response, lead_id, created_at
FROM crm_inbound_events ORDER BY created_at DESC LIMIT 50;

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

- Bot sender rollout: apply migrations 038 and 039, import `crm-events-dispatcher`,
  map `sellers.crm_user_id`, set the `CRM_EVENTS_*` variables, then activate.
  `lead.qualified` (1.1 and 1.2), `message.new`, `ownership.*` (1.2) and
  `handoff.created` (1.2d) are built.
- Confirmed dev seller UUIDs.
- Phones duplicated among the imported Dolibarr customers return 422
  `ambiguous_customer`.
- CRM → bot `opportunity.*` events (1.2c).
- `message.send` is text only; media needs a `media` contract.
- Media files in the CRM chat (1.2a sends a placeholder text).
- Customer corrections after confirmation reach the CRM through `revision`.
- Re-enable handoff delivery: since 2026-10-14 it is off in ClickUp.

## Design

Canvas: https://claude.ai/artifact/4VkZuqvA2wRTsHM7RWiivE (private; share it from its
Share menu). Source copy in [`design/`](design/):

- `Main.dc.html`: opportunity modal with the Actividad / WhatsApp switch in the panel header.
- `Inbox.dc.html`: conversation inbox (list, chat, customer and opportunity context).
- `States.dc.html`: conversation states, message types and seller notifications.
