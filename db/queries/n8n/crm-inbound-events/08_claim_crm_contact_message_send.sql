-- Claim one verified 1.3 message.send (keyed by crm_opportunity_id,
-- conversation_id or contact_id) before Evolution is called
-- (crm-inbound-events). p1 event_id, p2 sha256 hex of the raw request body,
-- p3 crm_opportunity_id, p4 data.conversation_id as sent, p5 its numeric id,
-- p6 data.contact_id as sent, p7 its numeric id (p5/p7 '' when the id carries
-- another prefix), p8 CRM_EVENTS_ID_PREFIX, p9 crm_seller_id, p10
-- client_message_id, p11 data.ownership_version, p12 the trimmed text. Absent
-- identities are ''.
--
-- crm_inbound_claim_contact_message_send() (migration 058) runs the 051
-- conversation claim on the customer's latest conversation and returns the
-- same columns, so Should Send CRM Message, Send CRM Message and Complete CRM
-- Message Send run unchanged after it; answers carry the contact counter.
SELECT http_status, response, replayed, send, outbound_id, attempt, phone_number, instance_name, text_body
FROM crm_inbound_claim_contact_message_send(
  NULLIF($1::text, ''),
  NULLIF($2::text, ''),
  NULLIF($3::text, '')::uuid,
  NULLIF($4::text, ''),
  NULLIF($5::text, '')::bigint,
  NULLIF($6::text, ''),
  NULLIF($7::text, '')::bigint,
  NULLIF($8::text, ''),
  NULLIF($9::text, '')::uuid,
  NULLIF($10::text, '')::uuid,
  NULLIF($11::text, '')::bigint,
  NULLIF($12::text, '')
);
