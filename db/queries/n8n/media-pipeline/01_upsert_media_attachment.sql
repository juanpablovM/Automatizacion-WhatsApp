-- Register inbound media metadata without downloading untrusted external URLs.
-- $1 should_write, $2 media_key, $3 external_url (metadata only), $4 message_id,
-- $5 inbound_event_id, $6 conversation_id, $7 source_number_id,
-- $8 instance_name, $9 phone_number, $10 attachment_type, $11 mime_type,
-- $12 filename, $13 file_size, $14 download_state, $15 rejected_reason,
-- $16 dedupe_key, $17 raw_payload JSON, $18 max_bytes, $19 expected_sha256,
-- $20 dispatcher_payload JSON.
WITH input AS MATERIALIZED (
  SELECT
    COALESCE(NULLIF($1::text, '')::boolean, FALSE) AS should_write,
    NULLIF($2::text, '') AS media_key,
    NULLIF($3::text, '') AS external_url,
    NULLIF($4::text, '') AS message_id,
    NULLIF($5::text, '')::bigint AS inbound_event_id,
    NULLIF($6::text, '')::bigint AS conversation_id,
    NULLIF($7::text, '')::bigint AS source_number_id,
    NULLIF($8::text, '') AS instance_name,
    NULLIF($9::text, '') AS phone_number,
    NULLIF($10::text, '') AS attachment_type,
    NULLIF($11::text, '') AS mime_type,
    NULLIF($12::text, '') AS filename,
    NULLIF($13::text, '')::bigint AS file_size,
    COALESCE(NULLIF($14::text, ''), 'pending')::media_download_state AS download_state,
    NULLIF($15::text, '') AS rejected_reason,
    NULLIF($16::text, '') AS dedupe_key,
    COALESCE(NULLIF($17::text, '')::jsonb, '{}'::jsonb) AS raw_payload,
    NULLIF($18::text, '')::bigint AS max_bytes,
    NULLIF(btrim($19::text), '') AS expected_sha256,
    COALESCE(NULLIF($20::text, '')::jsonb, '{}'::jsonb) AS dispatcher_payload
),
existing AS MATERIALIZED (
  SELECT m.id
  FROM media_attachments m, input i
  WHERE m.deleted_at IS NULL
    AND i.should_write
    AND (
      (i.media_key IS NOT NULL AND m.media_key = i.media_key)
      OR (i.media_key IS NULL AND i.external_url IS NOT NULL AND m.media_key IS NULL AND m.external_url = i.external_url)
      OR (i.media_key IS NULL AND i.external_url IS NULL AND m.message_id = i.message_id)
    )
  ORDER BY m.id
  LIMIT 1
  FOR UPDATE OF m
),
touched AS (
  UPDATE media_attachments m
  SET duplicate_count = m.duplicate_count + 1,
      updated_at = NOW()
  WHERE m.id IN (SELECT id FROM existing)
  RETURNING m.id, 'duplicate_skipped'::text AS result
),
inserted AS (
  INSERT INTO media_attachments (
    media_key, external_url, message_id, inbound_event_id, conversation_id,
    source_number_id, instance_name, phone_number, attachment_type, mime_type,
    filename, file_size, download_state, rejected_reason, metadata, raw_payload
  )
  SELECT
    i.media_key, i.external_url, i.message_id, i.inbound_event_id, i.conversation_id,
    i.source_number_id, i.instance_name, i.phone_number, i.attachment_type, i.mime_type,
    i.filename, i.file_size, i.download_state, i.rejected_reason,
    jsonb_strip_nulls(jsonb_build_object(
      'dedupe_key', i.dedupe_key,
      'message_id', i.message_id,
      'max_bytes', i.max_bytes,
      'expected_sha256', i.expected_sha256,
      'external_url_is_metadata_only', TRUE
    )),
    i.raw_payload
  FROM input i
  WHERE i.should_write
    AND i.message_id IS NOT NULL
    AND (i.media_key IS NOT NULL OR i.external_url IS NOT NULL OR i.message_id IS NOT NULL)
    AND NOT EXISTS (SELECT 1 FROM existing)
  ON CONFLICT DO NOTHING
  RETURNING id, 'created'::text AS result
),
event AS MATERIALIZED (
  SELECT * FROM inserted
  UNION ALL
  SELECT * FROM touched
),
audit_entry AS (
  INSERT INTO audit_logs (
    event_name, entity_type, entity_id, actor_type, actor_id,
    result, before_payload, after_payload, metadata
  )
  SELECT
    'media_sync', 'media_attachment', e.id, 'system',
    'wa-inbound-downstream-dispatcher', e.result, '{}'::jsonb,
    jsonb_strip_nulls(jsonb_build_object(
      'media_key', i.media_key,
      'attachment_type', i.attachment_type,
      'download_state', i.download_state
    )),
    jsonb_build_object('dedupe_key', i.dedupe_key)
  FROM event e CROSS JOIN input i
  RETURNING id
)
SELECT
  i.dispatcher_payload,
  e.id AS media_id,
  COALESCE(e.result, CASE WHEN i.should_write THEN 'conflict_skipped' ELSE 'no_media' END) AS media_registration_result
FROM input i
LEFT JOIN event e ON TRUE
LIMIT 1;
