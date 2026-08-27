-- Claim due media downloads. $1 batch size, $2 stale seconds.
WITH stale AS (
  UPDATE media_attachments
  SET download_state = CASE
        WHEN retry_count >= max_retries THEN 'exhausted'::media_download_state
        ELSE 'failed'::media_download_state
      END,
      claim_token = NULL,
      locked_at = NULL,
      next_retry_at = CASE WHEN retry_count < max_retries THEN NOW() ELSE NULL END,
      last_error = 'stale_download_claim_recovered',
      updated_at = NOW()
  WHERE download_state = 'downloading'
    AND locked_at < NOW() - (COALESCE(NULLIF($2::text, '')::integer, 900) * INTERVAL '1 second')
  RETURNING id
),
candidates AS MATERIALIZED (
  SELECT m.id
  FROM media_attachments m
  WHERE m.deleted_at IS NULL
    AND m.download_state IN ('pending', 'failed')
    AND COALESCE(m.next_retry_at, m.created_at) <= NOW()
    AND m.retry_count < m.max_retries
  ORDER BY COALESCE(m.next_retry_at, m.created_at), m.id
  LIMIT COALESCE(NULLIF($1::text, '')::integer, 20)
  FOR UPDATE OF m SKIP LOCKED
),
claimed AS (
  UPDATE media_attachments m
  SET download_state = 'downloading',
      retry_count = m.retry_count + 1,
      claim_token = gen_random_uuid(),
      locked_at = NOW(),
      last_error = NULL,
      updated_at = NOW()
  FROM candidates c
  WHERE m.id = c.id
  RETURNING m.*
)
SELECT
  c.id AS media_id,
  c.claim_token,
  c.retry_count,
  c.max_retries,
  c.message_id,
  c.instance_name,
  c.attachment_type,
  c.mime_type,
  c.filename,
  c.file_size,
  NULLIF(c.metadata->>'expected_sha256', '') AS expected_sha256,
  c.raw_payload,
  COALESCE(
    NULLIF(c.metadata->>'max_bytes', '')::bigint,
    CASE WHEN c.attachment_type = 'video' THEN 52428800 ELSE 26214400 END
  ) AS max_bytes
FROM claimed c
ORDER BY c.id;
