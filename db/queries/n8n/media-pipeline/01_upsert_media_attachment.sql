-- =============================================================================
-- 01_upsert_media_attachment.sql — Registro idempotente de media (A-009).
-- Nodo n8n: "Upsert Media Attachment" (WA - Inbound Downstream Dispatcher).
-- -----------------------------------------------------------------------------
-- Idempotencia por `media_key` (uq_media_attachments_media_key) o, cuando no
-- hay media_key, por `external_url` (sin hash aun: el hash se une tras la
-- descarga y uq_media_attachments_url_hash evita duplicados de contenido).
-- Replay del mismo evento -> 'duplicate_skipped' con duplicate_count++ y
-- auditoria en audit_logs (el evento del mensaje no se pierde nunca).
--
-- Params:
--   :should_write        false -> sin media, no escribe (ni audita)
--   :media_key, :external_url, :message_id   identidad de la media
--   :inbound_event_id, :conversation_id, :source_number_id (opcional/nullable)
--   :instance_name, :phone_number, :attachment_type, :mime_type
--   :filename, :file_size (nullable), :download_state, :rejected_reason
--   :dedupe_key (traza del evento)
-- =============================================================================

WITH resolved AS (
  SELECT
    NULLIF(:media_key, '')::text AS media_key,
    NULLIF(:external_url, '')::text AS external_url,
    NULLIF(:message_id, '')::text AS message_id,
    NULLIF(:instance_name, '')::text AS instance_name,
    NULLIF(:phone_number, '')::text AS phone_number,
    NULLIF(:attachment_type, '')::text AS attachment_type,
    NULLIF(:mime_type, '')::text AS mime_type,
    NULLIF(:filename, '')::text AS filename,
    NULLIF(:file_size::text, '')::bigint AS file_size_value,
    NULLIF(:rejected_reason, '')::text AS rejected_reason,
    NULLIF(:dedupe_key, '')::text AS dedupe_key,
    NULLIF(:inbound_event_id::text, '')::bigint AS inbound_event_id_value,
    NULLIF(:conversation_id::text, '')::bigint AS conversation_id_value,
    NULLIF(:source_number_id::text, '')::bigint AS source_number_id_value
),
existing AS (
  SELECT id
  FROM media_attachments
  WHERE deleted_at IS NULL
    AND (
      (media_key IS NOT NULL AND media_key = (SELECT media_key FROM resolved))
      OR (media_key IS NULL AND external_url IS NOT NULL
          AND external_url = (SELECT external_url FROM resolved))
    )
  LIMIT 1
),
touched AS (
  UPDATE media_attachments
  SET duplicate_count = duplicate_count + 1
  WHERE id IN (SELECT id FROM existing)
  RETURNING id, 'duplicate_skipped'::text AS touch_result
),
inserted AS (
  INSERT INTO media_attachments (
    media_key, external_url, message_id, inbound_event_id, conversation_id,
    source_number_id, instance_name, phone_number, attachment_type, mime_type,
    filename, file_size, download_state, rejected_reason, metadata
  )
  SELECT
    media_key, external_url, message_id, inbound_event_id_value, conversation_id_value,
    source_number_id_value, instance_name, phone_number, attachment_type, mime_type,
    filename, file_size_value,
    COALESCE(NULLIF(:download_state, '')::text, 'pending')::media_download_state,
    rejected_reason,
    jsonb_strip_nulls(jsonb_build_object('dedupe_key', dedupe_key, 'message_id', message_id))
  FROM resolved
  WHERE (:media_key IS NOT NULL OR :external_url IS NOT NULL)
    AND NOT EXISTS (SELECT 1 FROM existing)
    AND :should_write
  ON CONFLICT DO NOTHING
  RETURNING id, 'created'::text AS insert_result
),
audit_entry AS (
  INSERT INTO audit_logs (
    event_name, entity_type, entity_id, actor_type, actor_id,
    result, before_payload, after_payload, metadata
  )
  SELECT
    'media_sync',
    'media_attachment',
    events.id,
    'system',
    'wa-inbound-downstream-dispatcher',
    events.result,
    '{}'::jsonb,
    jsonb_strip_nulls(jsonb_build_object(
      'media_key', (SELECT media_key FROM resolved),
      'external_url_log', left((SELECT external_url FROM resolved), 64),
      'attachment_type', (SELECT attachment_type FROM resolved),
      'download_state', COALESCE(NULLIF(:download_state, '')::text, 'pending')
    )),
    jsonb_build_object('dedupe_key', (SELECT dedupe_key FROM resolved))
  FROM (
    SELECT id, 'created'::text AS result FROM inserted
    UNION ALL
    SELECT id, 'duplicate_skipped'::text AS result FROM touched
  ) events
  RETURNING result
)
SELECT id, result FROM (
  SELECT id, 'created'::text AS result FROM inserted
  UNION ALL
  SELECT id, 'duplicate_skipped'::text AS result FROM touched
) final
ORDER BY result DESC
LIMIT 1;