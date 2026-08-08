-- $1 batch_size, $2 window_start, $3 window_end, $4 now, $5 stale_seconds
SELECT * FROM claim_due_follow_ups(
  COALESCE(NULLIF($1::text, '')::integer, 50),
  COALESCE(NULLIF($2::text, ''), '09:00'),
  COALESCE(NULLIF($3::text, ''), '20:00'),
  COALESCE(NULLIF($4::text, '')::timestamptz, NOW()),
  COALESCE(NULLIF($5::text, '')::integer, 900)
);
