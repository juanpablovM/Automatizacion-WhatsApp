WITH claimed AS (
  SELECT * FROM claim_outbound_message(
    NULLIF($1::text, '')::bigint,
    NULLIF($2::text, '')::bigint,
    COALESCE(NULLIF($3::text, ''), 'text'),
    NULLIF($4::text, ''),
    COALESCE(NULLIF($5::text, '')::jsonb, '{}'::jsonb),
    NULLIF($6::text, ''),
    NULLIF($7::text, ''),
    NULLIF($8::text, ''),
    COALESCE(NULLIF($9::text, '')::integer, 300)
  )
)
SELECT
  claimed.*,
  COALESCE(NULLIF($10::text, '')::boolean, FALSE) AS human_arbitration_required
FROM claimed;
