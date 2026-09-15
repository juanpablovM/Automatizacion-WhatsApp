WITH claimed AS (
  SELECT *
  FROM claim_inbound_event(jsonb_strip_nulls(jsonb_build_object(
    'instance_name', NULLIF($1::text, ''),
    'external_message_id', NULLIF($2::text, ''),
    'phone_number', NULLIF($3::text, ''),
    'event_type', NULLIF($4::text, ''),
    'normalized_event', NULLIF($5::text, ''),
    'requested_processing', COALESCE(NULLIF($6::text, '')::boolean, FALSE),
    'raw_payload_json', COALESCE(NULLIF($7::text, ''), '{}'),
    'whatsapp_name', NULLIF($8::text, ''),
    'external_contact_id', NULLIF($9::text, ''),
    'external_timestamp', NULLIF($10::text, ''),
    'message_type', COALESCE(NULLIF($11::text, ''), 'unknown'),
    'text_body', NULLIF($12::text, ''),
    'attachment_type', NULLIF($13::text, ''),
    'mime_type', NULLIF($14::text, ''),
    'filename', NULLIF($15::text, ''),
    'external_media_id', NULLIF($16::text, ''),
    'external_url', NULLIF($17::text, ''),
    'sha256', NULLIF($18::text, ''),
    'file_size', NULLIF($19::text, ''),
    'is_from_me', COALESCE(NULLIF($20::text, '')::boolean, FALSE),
    'sender_type_candidate', NULLIF($21::text, '')
  )))
)
SELECT
  claimed.*,
  COALESCE(NULLIF($20::text, '')::boolean, FALSE) AS is_from_me,
  NULLIF($21::text, '') AS sender_type_candidate
FROM claimed;
