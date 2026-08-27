-- Consume one no-effect authorization only when its complete evidence binding matches.
-- $1 operation_id, $2 operation_key, $3 list_id, $4 search_horizon, $5 evidence_revision.
WITH candidate AS MATERIALIZED (
  SELECT eo.id, eo.request_payload
  FROM external_operations eo
  WHERE eo.id = $1::bigint
    AND eo.status = 'unknown'
    AND eo.reconciliation_required = TRUE
    AND eo.request_payload->>'operation_key' = $2::text
    AND eo.request_payload->>'list_id' = $3::text
    AND eo.request_payload->>'search_horizon' = $4::text
    AND eo.request_payload->>'evidence_revision' = $5::text
    AND COALESCE(eo.request_payload->>'no_effect_authorization_consumed', 'false') = 'false'
  FOR UPDATE
), consumed AS (
  UPDATE external_operations eo
  SET request_payload = eo.request_payload || jsonb_build_object('no_effect_authorization_consumed', true),
      updated_at = NOW()
  FROM candidate c
  WHERE eo.id = c.id
  RETURNING eo.id
)
SELECT EXISTS (SELECT 1 FROM consumed) AS authorized;
