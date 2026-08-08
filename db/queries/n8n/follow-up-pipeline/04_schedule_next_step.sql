-- Compatibility probe: next-step scheduling is atomic in 03_apply_send_result.sql.
-- $1 previous_follow_up_id
SELECT id AS previous_follow_up_id,
  CASE WHEN estado = 'sent' THEN 'handled_atomically' ELSE 'not_sent' END AS result
FROM follow_ups WHERE id = $1::bigint AND deleted_at IS NULL;
