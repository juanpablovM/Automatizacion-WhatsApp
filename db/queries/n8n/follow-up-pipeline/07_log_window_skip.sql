-- Record at most one out-of-window observation per hour. $1 start, $2 end, $3 now
WITH input AS (
  SELECT COALESCE(NULLIF($1::text, ''), '09:00')::time start_at,
    COALESCE(NULLIF($2::text, ''), '20:00')::time end_at,
    COALESCE(NULLIF($3::text, '')::timestamptz, NOW()) observed_at
), touched AS (
  UPDATE follow_ups f SET last_window_skip_at = i.observed_at, updated_at = i.observed_at
  FROM input i
  WHERE f.deleted_at IS NULL AND f.estado IN ('pending', 'error')
    AND COALESCE(f.next_retry_at, f.scheduled_at) <= i.observed_at
    AND (i.observed_at::time < i.start_at OR i.observed_at::time > i.end_at)
    AND (f.last_window_skip_at IS NULL OR f.last_window_skip_at < i.observed_at - INTERVAL '1 hour')
  RETURNING f.id
)
SELECT COUNT(*) skipped_count,
  CASE WHEN COUNT(*) > 0 THEN 'skipped_window' ELSE 'in_window' END result
FROM touched;
