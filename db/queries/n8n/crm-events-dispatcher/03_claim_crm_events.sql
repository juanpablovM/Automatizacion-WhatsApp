-- Claim due CRM events for delivery (stage B).
-- p1 batch size, p2 stale processing seconds.
--
-- Due pending rows and processing rows whose claim went stale (the worker died
-- mid-delivery) are claimed together with a fresh claim_token; the old token
-- can no longer complete. Re-sending a stale row is safe: the CRM answers a
-- duplicate event_id with its stored 200 result. The body is returned exactly
-- as stored and must be sent as-is.
WITH candidates AS MATERIALIZED (
  SELECT e.id
  FROM crm_events e
  WHERE (e.status = 'pending' AND e.next_attempt_at <= NOW())
     OR (e.status = 'processing'
         AND e.locked_at < NOW() - (COALESCE(NULLIF($2::text, '')::integer, 900) * INTERVAL '1 second'))
  ORDER BY e.next_attempt_at, e.id
  LIMIT COALESCE(NULLIF($1::text, '')::integer, 20)
  FOR UPDATE SKIP LOCKED
),
claimed AS (
  UPDATE crm_events e
  SET status = 'processing',
      claim_token = gen_random_uuid(),
      locked_at = NOW(),
      attempt_count = e.attempt_count + 1,
      last_error = CASE WHEN e.status = 'processing' THEN 'stale_processing_reclaimed' ELSE e.last_error END,
      updated_at = NOW()
  FROM candidates c
  WHERE e.id = c.id
  RETURNING e.id, e.event_id, e.claim_token, e.attempt_count, e.body, e.lead_id, e.revision
)
SELECT
  id AS crm_event_id,
  event_id,
  claim_token::text AS claim_token,
  attempt_count,
  body,
  lead_id,
  revision
FROM claimed
ORDER BY id;
