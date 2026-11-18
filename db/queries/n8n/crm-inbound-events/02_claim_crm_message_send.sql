-- Claim one verified CRM message.send event before Evolution is called
-- (crm-inbound-events). p1 event_id, p2 sha256 hex of the raw request body,
-- p3 crm_opportunity_id, p4 crm_seller_id, p5 client_message_id, p6
-- data.ownership_version, p7 the trimmed text.
--
-- The signature, size, envelope and data were already verified by Verify CRM
-- Event. crm_inbound_claim_message_send() (migration 041) decides in one
-- transaction: idempotency (stored answers, 409 event_conflict, 503 while an
-- earlier attempt is in flight or ambiguous), opportunity and seller (422),
-- ownership (implicit chat.take when the bot holds the chat, 409
-- ownership_conflict when another seller does) and the claim of the send
-- intent. send = TRUE carries what Send CRM Message needs; otherwise
-- http_status and response are the final answer.
SELECT http_status, response, replayed, send, outbound_id, attempt, phone_number, instance_name, text_body
FROM crm_inbound_claim_message_send(
  NULLIF($1::text, ''),
  NULLIF($2::text, ''),
  NULLIF($3::text, '')::uuid,
  NULLIF($4::text, '')::uuid,
  NULLIF($5::text, '')::uuid,
  NULLIF($6::text, '')::bigint,
  NULLIF($7::text, '')
);
