-- Complete a claimed media download.
-- $1 media_id, $2 claim_token, $3 outcome, $4 sha256, $5 bytes_length,
-- $6 storage_path, $7 storage_token, $8 error, $9 http_status.
WITH authorized AS MATERIALIZED (
  SELECT *
  FROM media_attachments
  WHERE id = $1::bigint
    AND download_state = 'downloading'
    AND claim_token = $2::uuid
    AND deleted_at IS NULL
  FOR UPDATE
),
resolved AS (
  SELECT a.*,
    CASE
      WHEN $3::text = 'downloaded' THEN 'downloaded'::media_download_state
      WHEN $3::text = 'deferred' THEN 'pending'::media_download_state
      WHEN $3::text = 'expired' THEN 'expired'::media_download_state
      WHEN $3::text = 'rejected' THEN 'rejected'::media_download_state
      WHEN a.retry_count >= a.max_retries THEN 'exhausted'::media_download_state
      ELSE 'failed'::media_download_state
    END AS final_state,
    ($3::text = 'deferred') AS is_deferred
  FROM authorized a
),
applied AS (
  UPDATE media_attachments m
  SET download_state = r.final_state,
      retry_count = CASE WHEN r.is_deferred THEN GREATEST(m.retry_count - 1, 0) ELSE m.retry_count END,
      next_retry_at = CASE
        WHEN r.is_deferred THEN NOW() + INTERVAL '60 seconds'
        WHEN r.final_state = 'failed' THEN NOW() + (LEAST(3600, 10 * POWER(2, GREATEST(m.retry_count - 1, 0))) * INTERVAL '1 second')
        ELSE NULL
      END,
      sha256 = CASE WHEN r.final_state = 'downloaded' THEN NULLIF($4::text, '') ELSE m.sha256 END,
      file_size = CASE WHEN r.final_state = 'downloaded' THEN NULLIF($5::text, '')::bigint ELSE m.file_size END,
      storage_path = CASE WHEN r.final_state = 'downloaded' THEN NULLIF($6::text, '') ELSE m.storage_path END,
      storage_token = CASE WHEN r.final_state = 'downloaded' THEN NULLIF($7::text, '') ELSE m.storage_token END,
      attach_pending = CASE WHEN r.final_state = 'downloaded' THEN TRUE ELSE m.attach_pending END,
      last_error = CASE WHEN r.final_state = 'downloaded' THEN NULL ELSE NULLIF($8::text, '') END,
      rejected_reason = CASE WHEN r.final_state = 'rejected' THEN NULLIF($8::text, '') ELSE m.rejected_reason END,
      metadata = m.metadata || jsonb_strip_nulls(jsonb_build_object('last_http_status', NULLIF($9::text, '')::integer)),
      claim_token = NULL,
      locked_at = NULL,
      updated_at = NOW()
  FROM resolved r
  WHERE m.id = r.id
  RETURNING m.*
),
audit_entry AS (
  INSERT INTO audit_logs (
    event_name, entity_type, entity_id, actor_type, actor_id,
    result, before_payload, after_payload, metadata
  )
  SELECT
    'media_download', 'media_attachment', r.id, 'system',
    'ops-media-download-scheduler', r.final_state::text,
    jsonb_build_object('download_state', r.download_state, 'retry_count', r.retry_count - 1),
    jsonb_build_object('download_state', a.download_state, 'retry_count', a.retry_count),
    jsonb_strip_nulls(jsonb_build_object('outcome', $3::text, 'http_status', NULLIF($9::text, '')::integer))
  FROM resolved r JOIN applied a ON a.id = r.id
  RETURNING id
)
SELECT
  a.id AS media_id,
  a.download_state::text AS download_state,
  a.retry_count,
  a.next_retry_at,
  a.sha256,
  a.storage_path,
  a.attach_pending
FROM applied a;
