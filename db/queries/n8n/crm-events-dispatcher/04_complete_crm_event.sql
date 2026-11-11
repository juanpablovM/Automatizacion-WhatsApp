-- Complete one claimed CRM event (stage B).
-- p1 crm_event_id, p2 claim_token, p3 outcome (delivered | retry | parked),
-- p4 http status, p5 error, p6 response json, p7 crm_customer_id,
-- p8 crm_opportunity_id, p9 retry delay seconds.
--
-- Only the holder of the current claim_token may complete. delivered stores
-- the CRM result and writes the CRM ids on the lead unless a newer revision
-- was already delivered (a message.new row has no lead and carries no ids, so
-- it never touches leads); retry returns the row to pending at now + delay;
-- anything else parks it for reconciliation. The body is never touched.
WITH authorized AS MATERIALIZED (
  SELECT e.id
  FROM crm_events e
  WHERE e.id = $1::bigint
    AND e.status = 'processing'
    AND e.claim_token = NULLIF($2::text, '')::uuid
  FOR UPDATE
),
event_update AS (
  UPDATE crm_events e
  SET status = CASE $3::text WHEN 'delivered' THEN 'delivered' WHEN 'retry' THEN 'pending' ELSE 'parked' END,
      claim_token = NULL,
      locked_at = NULL,
      last_http_status = NULLIF($4::text, '')::integer,
      last_error = CASE WHEN $3::text = 'delivered' THEN NULL ELSE COALESCE(NULLIF($5::text, ''), 'unspecified') END,
      response = COALESCE(NULLIF($6::text, '')::jsonb, e.response),
      next_attempt_at = CASE
        WHEN $3::text = 'retry'
          THEN NOW() + (GREATEST(COALESCE(NULLIF($9::text, '')::integer, 30), 1) * INTERVAL '1 second')
        ELSE e.next_attempt_at
      END,
      delivered_at = CASE WHEN $3::text = 'delivered' THEN NOW() ELSE e.delivered_at END,
      updated_at = NOW()
  FROM authorized a
  WHERE e.id = a.id
  RETURNING e.id, e.event_id, e.lead_id, e.revision, e.status
),
lead_update AS (
  UPDATE leads l
  SET crm_customer_id = NULLIF($7::text, '')::uuid,
      crm_opportunity_id = NULLIF($8::text, '')::uuid,
      crm_revision = u.revision
  FROM event_update u
  WHERE u.status = 'delivered'
    AND l.id = u.lead_id
    AND u.revision >= COALESCE(l.crm_revision, 0)
    AND NULLIF($7::text, '') IS NOT NULL
    AND NULLIF($8::text, '') IS NOT NULL
  RETURNING l.id
)
SELECT
  u.id AS crm_event_id,
  u.event_id,
  u.status,
  EXISTS (SELECT 1 FROM lead_update) AS lead_updated
FROM event_update u;
