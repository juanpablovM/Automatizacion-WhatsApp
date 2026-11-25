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
-- handoff.created (1.2d) has no lead either: delivered stores the CRM's
-- crm_case_id (read from the stored response) on the handoff when it is a
-- UUID; parked by 422 invalid_seller clears the handoff's routing seller when
-- it is still the rejected one, so Select Handoff Candidates routes it to the
-- next seller in the rotation (revision + 1, same handoff_id).
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
  RETURNING e.id, e.event_id, e.event_type, e.lead_id, e.handoff_id, e.revision, e.status, e.body
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
),
handoff_case AS (
  UPDATE handoffs h
  SET crm_case_id = (NULLIF($6::text, '')::jsonb ->> 'crm_case_id')::uuid
  FROM event_update u
  WHERE u.status = 'delivered'
    AND u.event_type = 'handoff.created'
    AND h.id = u.handoff_id
    AND (NULLIF($6::text, '')::jsonb ->> 'crm_case_id') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  RETURNING h.id
),
handoff_rejected AS (
  UPDATE handoffs h
  SET crm_routing_seller_id = NULL
  FROM event_update u, sellers s
  WHERE u.status = 'parked'
    AND u.event_type = 'handoff.created'
    AND $5::text = 'http_422:invalid_seller'
    AND h.id = u.handoff_id
    AND s.id = h.crm_routing_seller_id
    AND s.crm_user_id::text = lower(u.body::jsonb #>> '{data,crm_seller_id}')
  RETURNING h.id
)
SELECT
  u.id AS crm_event_id,
  u.event_id,
  u.status,
  EXISTS (SELECT 1 FROM lead_update) AS lead_updated
FROM event_update u;
