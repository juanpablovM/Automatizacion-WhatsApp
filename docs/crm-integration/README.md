# CRM integration (ClickUp replacement)

Status: design approved on 2026-10-05. Integration contract pending.

## Scope

The new Hormiglass CRM replaces **only ClickUp** as the seller notification and
management platform. Evolution API, n8n and PostgreSQL stay as they are. There is
no move to the official WhatsApp Cloud API, so Meta's 24-hour template window does
not apply.

## Decisions

- **Integration shape:** two-way webhooks through n8n. No shared database: PostgreSQL
  stays private, and the handoff/lease rules keep living in our SQL.
- **Seller assignment:** stays in our rotation (`crm-lead-creation-and-assignment`).
  The CRM only receives `assigned_seller_id`; each seller's `crm_user_id` is stored next
  to the current `clickup_user_id`.
- **Customer creation:** `lead.qualified` upserts the customer by phone and creates a new
  opportunity. Idempotent by `event_id`; the CRM returns `crm_customer_id` and
  `crm_opportunity_id`, stored like the ClickUp task id today.
- **Transition:** ClickUp and the CRM run in parallel until the CRM is proven.

## Draft contract (to be detailed)

Events sent to the CRM:

| Event | Replaces today |
|---|---|
| `lead.qualified` | ClickUp task creation (`crm-clickup-sync-lead`) |
| `handoff.created` | Handoff task dispatch |
| `message.new` | — (new: integrated chat) |
| `ownership.released` | Lease restoration (`dispatch-lead-chat-restoration`) |

Endpoints the CRM calls (n8n webhooks):

| Endpoint | Replaces today |
|---|---|
| `take` | ClickUp status moved to "in progress" (ownership acquisition) |
| `release` / `close` | ClickUp resolved statuses (`normalize-clickup-closure`) |
| `send` | — (new: reply goes out through `wa-outbound-messages`) |
| `history` | — (new: reads conversation messages from PostgreSQL) |

Still to define: payload fields per event, authentication (HMAC), retries and
idempotency, and behavior while the CRM is down.

Also deferred to this work: route claims (reclamos) to post-sale instead of Ventas.

## Design

Canvas: https://claude.ai/artifact/4VkZuqvA2wRTsHM7RWiivE (private; share it from its
Share menu). Source copy in [`design/`](design/):

- `Main.dc.html`: opportunity modal with the Actividad / WhatsApp switch in the panel header.
- `Inbox.dc.html`: conversation inbox (list, chat, customer and opportunity context).
- `States.dc.html`: conversation states, message types and seller notifications.
