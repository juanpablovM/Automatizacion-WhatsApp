-- Apply one verified 1.3 chat.take / chat.release (keyed by
-- crm_opportunity_id, conversation_id or contact_id) or
-- contact.opportunity_linked (crm-inbound-events). p1 event_id, p2 sha256 hex
-- of the raw request body, p3 type, p4 crm_opportunity_id, p5
-- data.conversation_id as sent, p6 its numeric conversation id, p7
-- data.contact_id as sent, p8 its numeric contact id (p6/p8 '' when the id
-- carries another prefix), p9 CRM_EVENTS_ID_PREFIX, p10 crm_seller_id, p11
-- data.ownership_version ('' for contact.opportunity_linked). Absent
-- identities are ''.
--
-- crm_inbound_apply_contact_event() (migration 058): idempotency inbox,
-- the customer named by the identity (422 invalid_opportunity |
-- unknown_conversation | unknown_contact), the 051 take / release on the
-- customer's latest conversation with the stale check and every
-- ownership_version on the contact counter (056); or the link of a CRM
-- opportunity to the customer (200 applied | duplicate, 409
-- identity_conflict, 422 unknown_contact | invalid_seller).
SELECT http_status, response, replayed
FROM crm_inbound_apply_contact_event(
  NULLIF($1::text, ''),
  NULLIF($2::text, ''),
  NULLIF($3::text, ''),
  NULLIF($4::text, '')::uuid,
  NULLIF($5::text, ''),
  NULLIF($6::text, '')::bigint,
  NULLIF($7::text, ''),
  NULLIF($8::text, '')::bigint,
  NULLIF($9::text, ''),
  NULLIF($10::text, '')::uuid,
  NULLIF($11::text, '')::bigint
);
