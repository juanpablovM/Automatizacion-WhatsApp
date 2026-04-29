-- Inputs esperados:
-- :lead_id

SELECT
  l.id AS lead_id,
  l.whatsapp_name,
  l.phone_number,
  l.service,
  l.city,
  l.requirement,
  l.channel,
  l.source_number_id,
  s.id AS seller_id,
  s.name AS seller_name,
  s.clickup_user_id,
  s.whatsapp_number AS seller_whatsapp_number,
  COALESCE(
    (
      SELECT string_agg(
        CONCAT(
          to_char(COALESCE(m.external_timestamp, m.created_at), 'YYYY-MM-DD HH24:MI'),
          ' ',
          CASE WHEN m.direction = 'incoming' THEN 'Cliente' ELSE 'Bot' END,
          ': ',
          COALESCE(m.text_body, CONCAT('[', m.message_type, ']'))
        ),
        E'\n'
        ORDER BY COALESCE(m.external_timestamp, m.created_at)
      )
      FROM messages m
      LEFT JOIN conversations c ON c.id = m.conversation_id
      WHERE (m.lead_id = l.id OR c.lead_id = l.id)
        AND m.deleted_at IS NULL
        AND m.created_at >= COALESCE(
          (
            SELECT previous.created_at
            FROM leads previous
            WHERE previous.phone_number = l.phone_number
              AND previous.id <> l.id
              AND previous.created_at < l.created_at
              AND previous.deleted_at IS NULL
            ORDER BY previous.created_at DESC
            LIMIT 1
          ),
          c.started_at,
          l.created_at - INTERVAL '1 day'
        )
        AND m.created_at <= l.created_at + INTERVAL '5 minutes'
    ),
    ''
  ) AS full_conversation,
  COALESCE(
    (
      SELECT json_agg(
        json_build_object(
          'attachment_id', ma.id,
          'attachment_type', ma.attachment_type,
          'mime_type', ma.mime_type,
          'filename', ma.filename,
          'external_media_id', ma.external_media_id,
          'external_url', ma.external_url,
          'file_size', ma.file_size
        )
      )
      FROM message_attachments ma
      JOIN messages m ON m.id = ma.message_id
      LEFT JOIN conversations c ON c.id = m.conversation_id
      WHERE (m.lead_id = l.id OR c.lead_id = l.id)
        AND ma.deleted_at IS NULL
        AND m.created_at >= COALESCE(
          (
            SELECT previous.created_at
            FROM leads previous
            WHERE previous.phone_number = l.phone_number
              AND previous.id <> l.id
              AND previous.created_at < l.created_at
              AND previous.deleted_at IS NULL
            ORDER BY previous.created_at DESC
            LIMIT 1
          ),
          c.started_at,
          l.created_at - INTERVAL '1 day'
        )
        AND m.created_at <= l.created_at + INTERVAL '5 minutes'
    ),
    '[]'::json
  ) AS attachments_json
FROM leads l
LEFT JOIN sellers s ON s.id = l.assigned_seller_id
WHERE l.id = :lead_id
  AND l.deleted_at IS NULL;
