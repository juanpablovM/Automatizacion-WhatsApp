-- Apply one verified CRM handoff.acknowledged / handoff.resolved event
-- (crm-inbound-events, 1.2d). p1 event_id, p2 sha256 hex of the raw request
-- body, p3 type, p4 the numeric handoff id of data.handoff_id ('' when it is
-- not one of ours), p5 crm_seller_id.
--
-- crm_inbound_apply_handoff_event() (migration 046) uses the transitions of
-- handoff-routing/05_close_handoff_from_clickup.sql: 200 applied | duplicate,
-- 409 invalid_transition, 422 unknown_handoff, idempotent by event_id.
SELECT http_status, response, replayed
FROM crm_inbound_apply_handoff_event(
  NULLIF($1::text, ''),
  NULLIF($2::text, ''),
  NULLIF($3::text, ''),
  NULLIF($4::text, '')::bigint,
  NULLIF($5::text, '')::uuid
);
