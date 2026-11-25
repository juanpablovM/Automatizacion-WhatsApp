-- Apply one verified CRM chat.take / chat.release event identified by
-- conversation_id (crm-inbound-events, 1.2d). p1 event_id, p2 sha256 hex of
-- the raw request body, p3 type, p4 data.conversation_id as sent, p5 its
-- numeric conversation id ('' when the id carries another prefix), p6
-- crm_seller_id, p7 data.ownership_version.
--
-- crm_inbound_apply_conversation_chat_event() (migration 046) has the effects
-- of crm_inbound_apply_chat_event() (040) for a conversation the bot handed
-- off to the CRM without an opportunity; any other conversation answers 422
-- unknown_conversation.
SELECT http_status, response, replayed
FROM crm_inbound_apply_conversation_chat_event(
  NULLIF($1::text, ''),
  NULLIF($2::text, ''),
  NULLIF($3::text, ''),
  NULLIF($4::text, ''),
  NULLIF($5::text, '')::bigint,
  NULLIF($6::text, '')::uuid,
  NULLIF($7::text, '')::bigint
);
