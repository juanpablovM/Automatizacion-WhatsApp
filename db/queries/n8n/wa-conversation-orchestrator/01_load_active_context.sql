-- Load Conversation State — canonical query embedded in wa-conversation-orchestrator.json.
-- Temporal contract is based only on the latest previously persisted inbound:
--   <= 48h          continuation
--   > 48h and <=30d re-engagement
--   > 30d           new request
WITH input_payload AS (
  SELECT
    $1::text AS phone_number,
    NULLIF($2::text, '')::bigint AS source_number_id,
    NULLIF($3::text, '') AS whatsapp_name,
    NULLIF($4::text, '') AS external_contact_id,
    NULLIF($5::text, '') AS external_message_id,
    NULLIF($6::text, '') AS external_timestamp_raw,
    COALESCE(NULLIF($7::text, ''), 'unknown') AS message_type,
    NULLIF($8::text, '') AS text_body,
    COALESCE(NULLIF($9::text, ''), '{}') AS raw_payload_json,
    NULLIF($10::text, '') AS attachment_type,
    NULLIF($11::text, '') AS mime_type,
    NULLIF($12::text, '') AS filename,
    NULLIF($13::text, '') AS external_media_id,
    NULLIF($14::text, '') AS external_url,
    NULLIF($15::text, '') AS sha256,
    NULLIF($16::text, '') AS file_size_raw,
    NULLIF($17::text, '') AS instance_name,
    NULLIF($18::text, '')::bigint AS inbound_event_id,
    NULLIF($19::text, '') AS processing_token
),
v3_grounding_entries AS (
  SELECT jsonb_build_object(
           'ref', CASE WHEN ci.item_type = 'service' THEN 'service:' ELSE 'product:' END
                  || COALESCE(NULLIF(ci.sku, ''), ci.id::text),
           'concept', CASE WHEN ci.item_type = 'service' THEN 'service' ELSE 'product' END,
           'value', ci.name
         ) AS entry
  FROM catalog_items ci
  WHERE ci.is_active AND ci.deleted_at IS NULL AND NULLIF(ci.name, '') IS NOT NULL
  UNION
  SELECT jsonb_build_object(
           'ref', 'commune:' || lower(regexp_replace(city, '[^a-zA-Z0-9]+', '-', 'g')),
           'concept', 'commune',
           'value', city
         )
  FROM catalog_items ci
  CROSS JOIN LATERAL UNNEST(ci.applicable_cities) AS city
  WHERE ci.is_active AND ci.deleted_at IS NULL AND NULLIF(city, '') IS NOT NULL
),
v3_grounding AS (
  SELECT jsonb_build_object(
    'catalog', COALESCE(jsonb_agg(entry ORDER BY entry->>'ref'), '[]'::jsonb)
  ) AS value
  FROM v3_grounding_entries
),
valid_claim AS (
  SELECT ie.id, ie.processing_token
  FROM inbound_events ie
  JOIN input_payload ip ON ip.inbound_event_id = ie.id
  WHERE ie.processing_status = 'processing'
    AND ie.processing_token = ip.processing_token
    AND ie.source_number_id = ip.source_number_id
    AND ie.phone_number = ip.phone_number
),
active_contract_route AS (
  SELECT
    execution.contract_version AS active_contract_version,
    execution.route_mode AS active_route_mode,
    execution.route_rule_id AS active_route_rule_id,
    execution.state AS active_v3_execution_state
  FROM conversation_turn_executions execution
  JOIN input_payload ip ON execution.inbound_event_id = ip.inbound_event_id
  ORDER BY execution.id DESC
  LIMIT 1
),
latest_conversation AS (
  SELECT
    c.id AS conversation_id,
    c.lead_id,
    c.source_number_id,
    c.phone_number,
    c.current_step,
    c.qualification_context,
    c.pending_question_key,
    c.started_at,
    c.last_message_at,
    cs.code AS conversation_status_code,
    cs.label AS conversation_status_label
  FROM conversations c
  JOIN conversation_statuses cs ON cs.id = c.conversation_status_id
  JOIN input_payload ip ON TRUE
  WHERE c.deleted_at IS NULL
    AND c.phone_number = ip.phone_number
    AND ip.source_number_id IS NOT NULL
    AND c.source_number_id = ip.source_number_id
  ORDER BY c.started_at DESC, c.id DESC
  LIMIT 1
),
last_persisted_inbound AS (
  SELECT
    ie.id AS last_inbound_event_id,
    ie.created_at AS last_inbound_at,
    EXTRACT(EPOCH FROM (NOW() - ie.created_at)) / 3600 AS elapsed_hours
  FROM inbound_events ie
  JOIN input_payload ip ON TRUE
  WHERE ie.phone_number = ip.phone_number
    AND ip.source_number_id IS NOT NULL
    AND ie.source_number_id = ip.source_number_id
    AND ie.processing_status = 'processed'
    AND (ip.inbound_event_id IS NULL OR ie.id <> ip.inbound_event_id)
  ORDER BY ie.created_at DESC, ie.id DESC
  LIMIT 1
),
latest_conversation_state AS (
  SELECT
    al.after_payload->>'service' AS state_service,
    al.after_payload->>'city' AS state_city,
    al.after_payload->>'requirement' AS state_requirement,
    al.after_payload->>'current_step' AS state_current_step
  FROM audit_logs al
  JOIN latest_conversation lc ON TRUE
  WHERE al.entity_type = 'conversation'
    AND al.entity_id = lc.conversation_id
    AND al.event_name = 'conversation_state_evaluated'
  ORDER BY al.created_at DESC, al.id DESC
  LIMIT 1
),
latest_conversation_reset AS (
  SELECT MAX(al.created_at) AS reset_at
  FROM audit_logs al
  JOIN latest_conversation lc ON TRUE
  WHERE al.entity_type = 'conversation'
    AND al.entity_id = lc.conversation_id
    AND al.event_name = 'conversation_state_evaluated'
    AND COALESCE((al.metadata->>'reset_conversation_lead')::boolean, FALSE)
),
recent_messages AS (
  SELECT COALESCE(
    jsonb_agg(
      jsonb_build_object(
        'role', CASE WHEN history.direction = 'incoming' THEN 'user' ELSE 'assistant' END,
        'content', history.text_body
      ) ORDER BY history.created_at ASC, history.id ASC
    ),
    '[]'::jsonb
  ) AS recent_messages
  FROM (
    SELECT m.id, m.direction, m.text_body, m.created_at
    FROM messages m
    JOIN latest_conversation lc ON lc.conversation_id = m.conversation_id
    JOIN last_persisted_inbound lpi ON TRUE
    LEFT JOIN latest_conversation_reset lcr ON TRUE
    WHERE m.deleted_at IS NULL
      AND NULLIF(BTRIM(m.text_body), '') IS NOT NULL
      AND (m.direction = 'incoming' OR (m.direction = 'outgoing' AND m.delivery_status = 'sent'))
      AND lpi.last_inbound_at >= NOW() - INTERVAL '48 hours'
      AND lc.conversation_status_code IN ('active', 'waiting_user', 'out_of_flow')
      AND (lcr.reset_at IS NULL OR m.created_at > lcr.reset_at)
    ORDER BY m.created_at DESC, m.id DESC
    LIMIT 8
  ) history
),
latest_lead AS (
  SELECT
    l.id AS previous_lead_id,
    l.whatsapp_name,
    l.phone_number,
    l.service,
    l.city,
    l.requirement,
    l.created_at AS previous_lead_created_at,
    l.source_number_id AS previous_source_number_id,
    ls.code AS lead_status_code
  FROM leads l
  JOIN lead_statuses ls ON ls.id = l.lead_status_id
  JOIN input_payload ip ON TRUE
  WHERE l.deleted_at IS NULL
    AND l.phone_number = ip.phone_number
    AND ip.source_number_id IS NOT NULL
    AND l.source_number_id = ip.source_number_id
  ORDER BY l.created_at DESC, l.id DESC
  LIMIT 1
),
follow_up_status AS (
  SELECT COUNT(*) FILTER (WHERE f.estado IN ('pending', 'sending', 'error')) AS pending_count
  FROM follow_ups f
  JOIN latest_conversation lc ON TRUE
  WHERE f.deleted_at IS NULL
    AND f.conversation_id = lc.conversation_id
)
SELECT
  ip.phone_number,
  ip.source_number_id AS input_source_number_id,
  ip.instance_name,
  ip.inbound_event_id,
  ip.processing_token,
  acr.active_contract_version,
  acr.active_route_mode,
  acr.active_route_rule_id,
  acr.active_v3_execution_state,
  ip.whatsapp_name AS input_whatsapp_name,
  ip.external_contact_id AS input_external_contact_id,
  ip.external_message_id AS input_external_message_id,
  ip.external_timestamp_raw AS input_external_timestamp,
  ip.message_type,
  ip.text_body,
  ip.raw_payload_json,
  ip.attachment_type,
  ip.mime_type,
  ip.filename,
  ip.external_media_id,
  ip.external_url,
  ip.sha256,
  ip.file_size_raw,
  lc.conversation_id,
  lc.conversation_id AS target_conversation_id,
  lc.lead_id,
  lc.source_number_id,
  lc.current_step,
  COALESCE(lc.qualification_context, '{}'::jsonb) AS qualification_context,
  lc.pending_question_key,
  lc.started_at,
  lc.last_message_at,
  lc.conversation_status_code,
  lc.conversation_status_label,
  (lc.conversation_id IS NOT NULL) AS has_existing_conversation,
  (
    lc.conversation_id IS NOT NULL
    AND lpi.last_inbound_at >= NOW() - INTERVAL '48 hours'
  ) AS is_recent_conversation,
  (
    lc.conversation_id IS NOT NULL
    AND lpi.last_inbound_at < NOW() - INTERVAL '48 hours'
  ) AS is_stale_context,
  (
    lc.conversation_id IS NOT NULL
    AND lpi.last_inbound_at >= NOW() - INTERVAL '48 hours'
    AND lc.conversation_status_code IN ('active', 'waiting_user', 'out_of_flow')
  ) AS has_active_conversation,
  (
    lc.conversation_id IS NOT NULL
    AND lpi.last_inbound_at < NOW() - INTERVAL '48 hours'
    AND lpi.last_inbound_at >= NOW() - INTERVAL '30 days'
  ) AS is_reengagement,
  lpi.last_inbound_event_id,
  lpi.last_inbound_at,
  lpi.elapsed_hours::numeric AS elapsed_hours_since_last_inbound,
  lcs.state_service,
  lcs.state_city,
  lcs.state_requirement,
  lcs.state_current_step,
  COALESCE(rm.recent_messages, '[]'::jsonb) AS recent_messages,
  CASE WHEN lcr.reset_at IS NULL OR ll.previous_lead_created_at > lcr.reset_at THEN ll.previous_lead_id END AS previous_lead_id,
  CASE WHEN lcr.reset_at IS NULL OR ll.previous_lead_created_at > lcr.reset_at THEN ll.whatsapp_name END AS previous_whatsapp_name,
  CASE WHEN lcr.reset_at IS NULL OR ll.previous_lead_created_at > lcr.reset_at THEN ll.service END AS previous_service,
  CASE WHEN lcr.reset_at IS NULL OR ll.previous_lead_created_at > lcr.reset_at THEN ll.city END AS previous_city,
  CASE WHEN lcr.reset_at IS NULL OR ll.previous_lead_created_at > lcr.reset_at THEN ll.requirement END AS previous_requirement,
  CASE WHEN lcr.reset_at IS NULL OR ll.previous_lead_created_at > lcr.reset_at THEN ll.lead_status_code END AS previous_lead_status_code,
  COALESCE(fs.pending_count, 0) > 0 AS has_pending_followups,
  COALESCE(lcs.state_service, ll.service) AS last_known_service,
  COALESCE(lcs.state_city, ll.city) AS last_known_city,
  COALESCE(lcs.state_requirement, ll.requirement) AS last_known_requirement,
  vg.value AS v3_grounding
FROM input_payload ip
JOIN valid_claim vc ON TRUE
LEFT JOIN active_contract_route acr ON TRUE
LEFT JOIN latest_conversation lc ON TRUE
LEFT JOIN last_persisted_inbound lpi ON TRUE
LEFT JOIN latest_conversation_state lcs ON TRUE
LEFT JOIN recent_messages rm ON TRUE
LEFT JOIN latest_conversation_reset lcr ON TRUE
LEFT JOIN latest_lead ll ON TRUE
LEFT JOIN follow_up_status fs ON TRUE
LEFT JOIN v3_grounding vg ON TRUE;
