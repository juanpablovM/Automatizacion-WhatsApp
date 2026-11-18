-- Record the Evolution outcome of one claimed CRM message.send attempt
-- (crm-inbound-events). p1 outbound_id, p2 attempt, p3 outcome (sent | failed
-- | unknown), p4 Evolution message id, p5 Evolution HTTP status, p6 bounded
-- error text, p7 CRM_EVENTS_ID_PREFIX.
--
-- crm_inbound_complete_message_send() (migration 041): 'sent' stores the
-- outgoing seller message (or adopts the row its fromMe echo already stored)
-- and answers 200 {event_id, result: "sent", message_id, ownership_version};
-- 'failed' and 'unknown' answer 503. Only the attempt still 'sending' moves.
SELECT http_status, response
FROM crm_inbound_complete_message_send(
  NULLIF($1::text, '')::bigint,
  NULLIF($2::text, '')::integer,
  NULLIF($3::text, ''),
  NULLIF($4::text, ''),
  NULLIF($5::text, '')::integer,
  NULLIF($6::text, ''),
  NULLIF($7::text, '')
);
