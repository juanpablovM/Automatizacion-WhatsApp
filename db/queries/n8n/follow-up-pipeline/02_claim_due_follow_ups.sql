-- p1 batch_size, p2 window_start, p3 window_end, p4 now, p5 stale_seconds
SELECT * FROM claim_due_follow_ups(
  COALESCE(NULLIF($1::text, '')::integer, 50),
  COALESCE(NULLIF($2::text, ''), '09:00'),
  COALESCE(NULLIF($3::text, ''), '20:00'),
  COALESCE(NULLIF($4::text, '')::timestamptz, NOW()),
  COALESCE(NULLIF($5::text, '')::integer, 900)
);
