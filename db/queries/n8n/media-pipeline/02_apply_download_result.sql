-- =============================================================================
-- 02_apply_download_result.sql — Aplica el resultado de la descarga (A-009).
-- Nodo n8n: "Mark Media Download" (WA - Inbound Downstream Dispatcher).
-- -----------------------------------------------------------------------------
-- Outcomes del stub/backend de descarga:
--   - downloaded  -> download_state='downloaded', sha256 + storage_path/
--                    storage_token, attach_pending=true (extension ClickUp
--                    CR-014 queda PENDIENTE: attached_to=NULL y nadie llama
--                    a mark_media_attached en el dispatcher).
--   - failed      -> retry_count++ con next_retry_at = now + 10s * 2^retry
--                    (backoff); al agotar max_retries -> 'exhausted'
--                    (el mensaje NUNCA se borra: message_id permanece).
--   - expired     -> 'expired' (url vencida; terminal y preserva mensaje).
--   - rejected    -> 'rejected' con motivo (tipo/tamano/host).
-- Idempotente: un replay 'downloaded' no reaplica (revisa estado previo).
-- -----------------------------------------------------------------------------

WITH target AS (
  SELECT id, download_state, retry_count, max_retries
  FROM media_attachments
  WHERE id = :media_id::bigint AND deleted_at IS NULL
),
outcome_resolution AS (
  SELECT
    t.id,
    t.download_state,
    t.retry_count,
    t.max_retries,
    CASE
      WHEN t.id IS NULL THEN 'media_missing'
      WHEN t.download_state = 'downloaded' THEN 'already_downloaded'
      WHEN t.download_state IN ('rejected', 'expired', 'exhausted') THEN 'state_final'
      WHEN :outcome::text = 'downloaded' THEN 'downloaded'
      WHEN :outcome::text = 'expired' THEN 'expired'
      WHEN :outcome::text = 'rejected' THEN 'rejected'
      WHEN (t.retry_count + 1) >= t.max_retries THEN 'exhausted'
      ELSE 'failed'
    END AS result
  FROM target t
),
apply AS (
  UPDATE media_attachments m
  SET
    download_state = CASE o.result
      WHEN 'downloaded' THEN 'downloaded'::media_download_state
      WHEN 'expired' THEN 'expired'::media_download_state
      WHEN 'rejected' THEN 'rejected'::media_download_state
      WHEN 'exhausted' THEN 'exhausted'::media_download_state
      ELSE 'failed'::media_download_state
    END,
    retry_count = CASE
      WHEN o.result IN ('failed', 'exhausted')
        THEN m.retry_count + 1
      ELSE m.retry_count
    END,
    next_retry_at = CASE
      WHEN o.result = 'failed'
        THEN NOW() + ((10 * POWER(2, m.retry_count))) * INTERVAL '1 second'
      ELSE m.next_retry_at
    END,
    sha256 = CASE
      WHEN o.result = 'downloaded' THEN NULLIF(:sha256, '')::text
      ELSE m.sha256
    END,
    storage_path = CASE
      WHEN o.result = 'downloaded' THEN NULLIF(:storage_path, '')::text
      ELSE m.storage_path
    END,
    storage_token = CASE
      WHEN o.result = 'downloaded' THEN NULLIF(:storage_token, '')::text
      ELSE m.storage_token
    END,
    attach_pending = CASE
      WHEN o.result = 'downloaded' THEN TRUE
      ELSE m.attach_pending
    END,
    last_error = CASE
      WHEN o.result IN ('failed', 'exhausted')
        THEN NULLIF(:error, '')::text
      ELSE NULL
    END,
    rejected_reason = CASE
      WHEN o.result = 'rejected' THEN NULLIF(:error, '')::text
      ELSE m.rejected_reason
    END,
    updated_at = NOW()
  FROM outcome_resolution o
  WHERE m.id = o.id
    AND o.result IN ('downloaded', 'failed', 'expired', 'rejected', 'exhausted')
  RETURNING m.id, m.download_state, m.retry_count, m.next_retry_at
),
audit_entry AS (
  INSERT INTO audit_logs (
    event_name, entity_type, entity_id, actor_type, actor_id,
    result, before_payload, after_payload, metadata
  )
  SELECT
    'media_download',
    'media_attachment',
    o.id,
    'system',
    'wa-inbound-downstream-dispatcher',
    o.result,
    jsonb_build_object('download_state', o.download_state, 'retry_count', o.retry_count),
    jsonb_build_object(
      'download_state', COALESCE(a.download_state, o.download_state),
      'retry_count', COALESCE(a.retry_count, o.retry_count),
      'error', NULLIF(:error, '')
    ),
    jsonb_build_object('outcome', :outcome::text)
  FROM outcome_resolution o
  LEFT JOIN apply a ON a.id = o.id
  WHERE o.id IS NOT NULL
  RETURNING result
)
SELECT
  COALESCE(a.id, o.id) AS media_id,
  COALESCE(a.download_state::text, o.download_state::text) AS download_state,
  COALESCE(a.retry_count, o.retry_count) AS retry_count,
  a.next_retry_at,
  o.result
FROM outcome_resolution o
LEFT JOIN apply a ON a.id = o.id;