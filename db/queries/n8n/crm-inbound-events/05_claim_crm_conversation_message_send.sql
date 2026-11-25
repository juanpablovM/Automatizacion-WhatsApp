-- Claim one verified CRM message.send event identified by conversation_id
-- before Evolution is called (crm-inbound-events, 1.2d). p1 event_id, p2
-- sha256 hex of the raw request body, p3 data.conversation_id as sent, p4 its
-- numeric conversation id ('' when the id carries another prefix), p5
-- crm_seller_id, p6 client_message_id, p7 data.ownership_version, p8 the
-- trimmed text.
--
-- crm_inbound_claim_conversation_message_send() (migration 046) decides like
-- crm_inbound_claim_message_send() (041) and returns the same columns, so
-- Should Send CRM Message, Send CRM Message and Complete CRM Message Send run
-- unchanged after it.
SELECT http_status, response, replayed, send, outbound_id, attempt, phone_number, instance_name, text_body
FROM crm_inbound_claim_conversation_message_send(
  NULLIF($1::text, ''),
  NULLIF($2::text, ''),
  NULLIF($3::text, ''),
  NULLIF($4::text, '')::bigint,
  NULLIF($5::text, '')::uuid,
  NULLIF($6::text, '')::uuid,
  NULLIF($7::text, '')::bigint,
  NULLIF($8::text, '')
);
