# CRM integration (ClickUp replacement)

Status (2026-11-11): the bot → CRM contract (v1 + revision 1.1) is agreed and live in
the CRM **development** project. Transport is verified end to end. The bot-side
sender for `lead.qualified` is built (see [Bot sender](#bot-sender)) and off by
default. Revision 1.2a (full lead record and `message.new`) is built behind
`CRM_EVENTS_PROTOCOL_REVISION=1.2` (see [Revision 1.2a](#revision-12a)); 1.1 stays the
default. Revision 1.2b (`ownership_version`, `ownership.taken` / `ownership.released`
and the CRM → bot `chat.take` / `chat.release` webhook) is built behind the same
switch and `CRM_INBOUND_ENABLED` (see [Revision 1.2b](#revision-12b)). Other CRM → bot
events (`opportunity.*`, `handoff.*`, `message.send`) are not built yet.

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
| `ownership.taken` | ClickUp status moved to "in progress" | 1.2 only. `version`, `crm_seller_id` (uuid or null), `source` (`clickup` or `crm`). See [Revision 1.2b](#revision-12b) |
| `ownership.released` | Lease restoration (`dispatch-lead-chat-restoration`) | 1.2 only. `version`, `reason`. Shares the `version` sequence with `ownership.taken` |

Handoffs to `management`, `finance`, `scheduling` and `claims` return
`pending_routing` until the CRM maps recipients per area.

### Endpoint the CRM calls (n8n webhook)

One endpoint, `POST <bot n8n>/webhook/crm-events`, takes every CRM → bot event. Only
`chat.take` and `chat.release` are built (1.2b); see
[Inbound webhook](#inbound-webhook-crm--bot). The rest come later:

| Event | Replaces today | Status |
|---|---|---|
| `chat.take` | ClickUp status moved to "in progress" (ownership acquisition) | Built (1.2b) |
| `chat.release` | ClickUp leaving "in progress" (`normalize-clickup-closure`) | Built (1.2b) |
| `opportunity.quote_sent`, `opportunity.closed`, `opportunity.reopened` | ClickUp quote statuses | 1.2c, answers `400 invalid_event` today |
| `handoff.acknowledged`, `handoff.resolved` | ClickUp handoff closure | 1.2d, answers `400 invalid_event` today |
| `message.send` | — (new: reply goes out through `wa-outbound-messages`) | Phase 3, answers `400 invalid_event` today |

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

| `CRM_INBOUND_ENABLED` | `false` | Only `true` turns the `/webhook/crm-events` receiver on. Otherwise it answers `503 receiver_unavailable` |
| `CRM_INBOUND_HMAC_SECRET` | `__PENDIENTE__` | Secret the CRM signs `X-CRM-Signature` with. Must differ from `CRM_EVENTS_HMAC_SECRET` (the receiver answers 503 if they are equal). Never logged |

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
the lead's other conversations do not.

| CRM field | Bot source |
|---|---|
| `message_id` | `wa-<prefix>-message-<messages.id>` (event id: `…-e1`) |
| `conversation_id` | `wa-<prefix>-conversation-<messages.conversation_id>` (same as the lead events) |
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

#### Switching 1.2b on

1. Apply migration 040 and import `crm-events-dispatcher` and `crm-inbound-events`.
2. Expose `/webhook/crm-events` the same way as the ClickUp webhook (stable HTTPS
   hostname) and share the URL and a new `CRM_INBOUND_HMAC_SECRET` out of band.
3. Set `CRM_INBOUND_HMAC_SECRET`, then `CRM_INBOUND_ENABLED=true`, and restart n8n.
   Ownership events go out once `CRM_EVENTS_PROTOCOL_REVISION=1.2`.

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
  `lead.qualified` (1.1 and 1.2), `message.new` and `ownership.*` (1.2) are built.
  `handoff.created` is not.
- Confirmed dev seller UUIDs.
- Phones duplicated among the imported Dolibarr customers return 422
  `ambiguous_customer`.
- CRM → bot events beyond `chat.take` / `chat.release` (`opportunity.*` in 1.2c,
  `handoff.*` in 1.2d, `message.send` in phase 3), and the dev URL + secret for
  `/webhook/crm-events`.
- Media files in the CRM chat (1.2a sends a placeholder text).
- Customer corrections after confirmation reach the CRM through `revision`.
- Re-enable handoff delivery: since 2026-10-14 it is off in ClickUp.

## Design

Canvas: https://claude.ai/artifact/4VkZuqvA2wRTsHM7RWiivE (private; share it from its
Share menu). Source copy in [`design/`](design/):

- `Main.dc.html`: opportunity modal with the Actividad / WhatsApp switch in the panel header.
- `Inbox.dc.html`: conversation inbox (list, chat, customer and opportunity context).
- `States.dc.html`: conversation states, message types and seller notifications.
