-- Apply one verified CRM chat.take / chat.release event (crm-inbound-events).
-- p1 event_id, p2 sha256 hex of the raw request body, p3 type, p4
-- crm_opportunity_id, p5 crm_seller_id, p6 data.ownership_version.
--
-- The signature, size and envelope were already verified by Verify CRM Event.
-- Everything else happens in one transaction inside
-- crm_inbound_apply_chat_event() (migration 040): the idempotency inbox (same
-- id and bytes replay the stored response; same id, other bytes answer 409
-- event_conflict), opportunity and seller resolution (422), the stale-version
-- check, the holder conflict (409) and the take / release itself, which copies
-- the ClickUp acquire and release semantics without writing ClickUp columns.
-- It is a function so the response can carry the ownership_version that the
-- lead_chat_ownerships trigger wrote in the same transaction.
SELECT http_status, response, replayed
FROM crm_inbound_apply_chat_event(
  NULLIF($1::text, ''),
  NULLIF($2::text, ''),
  NULLIF($3::text, ''),
  NULLIF($4::text, '')::uuid,
  NULLIF($5::text, '')::uuid,
  NULLIF($6::text, '')::bigint
);
