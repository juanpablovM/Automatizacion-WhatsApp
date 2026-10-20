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
         )
         -- Task 3c.19: optional synonyms (migration 026), only when present,
         -- so an entry without them keeps the exact {ref, concept, value} shape.
         || CASE
              WHEN jsonb_typeof(ci.metadata->'synonyms') = 'array' THEN
                CASE WHEN jsonb_array_length(ci.metadata->'synonyms') > 0
                  THEN jsonb_build_object('synonyms', ci.metadata->'synonyms')
                  ELSE '{}'::jsonb
                END
              ELSE '{}'::jsonb
            END
         -- Task 3c.20: optional technical sheet (private data applied via scripts/catalog/technical-sheets.mjs), only when it
         -- is an object and never with its source file names. The v3.1 policy
         -- builder keeps it only for the products relevant to the turn; v3
         -- drops it.
         || CASE
              WHEN jsonb_typeof(ci.metadata->'technical_sheet') = 'object'
                THEN jsonb_build_object('technical_sheet', (ci.metadata->'technical_sheet') - 'source_files')
              ELSE '{}'::jsonb
            END
         -- Task 3c.29: the technical-sheet PDFs of this product (migration 032),
         -- refs only and never their bytes, only when it has an active one. The
         -- v3.1 policy builder keeps them only for the products relevant to the
         -- turn; v3 drops them.
         || COALESCE((
              SELECT jsonb_build_object('technical_sheet_files', jsonb_agg(
                jsonb_build_object(
                  'ref', 'sheet:' || sheet.sheet_key,
                  'variant', sheet.variant,
                  'covers', to_jsonb(sheet.covers_variants)
                ) ORDER BY sheet.id
              ))
              FROM technical_sheet_files sheet
              WHERE sheet.sku = ci.sku
                AND sheet.active
              HAVING COUNT(*) > 0
            ), '{}'::jsonb) AS entry
  FROM catalog_items ci
  WHERE ci.is_active AND ci.deleted_at IS NULL AND NULLIF(ci.name, '') IS NOT NULL
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
    al.after_payload->>'current_step' AS state_current_step,
    al.metadata->>'pending_question_key' AS previous_commercial_pending_question_key,
    CASE WHEN al.metadata->>'commercial_question_retry' ~ '^[0-9]{1,6}$'
      THEN (al.metadata->>'commercial_question_retry')::integer ELSE 0 END AS previous_commercial_question_retry
  FROM audit_logs al
  JOIN latest_conversation lc ON TRUE
  WHERE al.entity_type = 'conversation'
    AND al.entity_id = lc.conversation_id
    AND al.event_name = 'conversation_state_evaluated'
  ORDER BY al.created_at DESC, al.id DESC
  LIMIT 1
),
latest_commercial_question_audit AS (
  SELECT al.metadata->>'pending_question_key' AS pending_question_key,
    CASE WHEN al.metadata->>'commercial_question_retry' ~ '^[0-9]{1,6}$'
      THEN (al.metadata->>'commercial_question_retry')::integer ELSE 0 END AS retry_count
  FROM audit_logs al
  JOIN latest_conversation lc ON TRUE
  LEFT JOIN conversation_turn_executions execution
    ON al.entity_type = 'conversation_turn_execution' AND execution.id = al.entity_id
  WHERE (
    (al.entity_type = 'conversation' AND al.entity_id = lc.conversation_id
      AND al.event_name = 'conversation_state_evaluated')
    OR (execution.conversation_id = lc.conversation_id
      AND al.event_name = 'v3_turn_committed')
  )
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
-- Task 3c.26: products the customer removed from this conversation's quote.
-- Evidence is the committed turn ledger only: a remove_item mutation of an
-- authorized decision whose turn committed (state_receipt), resolved to the
-- product its item held just before that commit (state_receipt.state_before).
-- Removals before the latest conversation reset no longer count. The v3.1
-- policy builder marks the matching catalog entries; v3 ignores the list.
v3_removed_products AS (
  SELECT jsonb_agg(removed.product ORDER BY removed.product) AS value
  FROM (
    SELECT DISTINCT removed_item.value->>'product' AS product
    FROM latest_conversation lc
    JOIN conversation_turn_executions execution
      ON execution.conversation_id = lc.conversation_id
     AND execution.state_receipt IS NOT NULL
    JOIN advisor_decisions decision ON decision.id = execution.advisor_decision_id
    LEFT JOIN latest_conversation_reset lcr ON TRUE
    CROSS JOIN LATERAL jsonb_array_elements(
      CASE WHEN jsonb_typeof(decision.output_payload->'state_mutations') = 'array'
        THEN decision.output_payload->'state_mutations' ELSE '[]'::jsonb END
    ) mutation(value)
    CROSS JOIN LATERAL jsonb_array_elements(
      CASE WHEN jsonb_typeof(execution.state_receipt#>'{state_before,line_items}') = 'array'
        THEN execution.state_receipt#>'{state_before,line_items}' ELSE '[]'::jsonb END
    ) removed_item(value)
    WHERE mutation.value->>'operation' = 'remove_item'
      AND removed_item.value->>'item_id' = mutation.value->>'item_id'
      AND jsonb_typeof(removed_item.value->'product') = 'string'
      AND NULLIF(btrim(removed_item.value->>'product'), '') IS NOT NULL
      AND (lcr.reset_at IS NULL OR execution.created_at > lcr.reset_at)
      -- A closed conversation never carries its removals: the first turn of a
      -- new conversation still loads the previous one.
      AND lc.conversation_status_code <> 'closed'
  ) removed
),
-- Task 3c.29: technical sheets this conversation already received (sent or
-- still in flight), so the v3.1 policy marks them sent and the validator never
-- sends one twice unless the customer asks again. A closed conversation never
-- carries them, like its removals.
v3_technical_sheets_sent AS (
  SELECT jsonb_agg(DISTINCT 'sheet:' || (m.raw_payload#>>'{technical_sheet,sheet_key}')) AS value
  FROM latest_conversation lc
  JOIN messages m ON m.conversation_id = lc.conversation_id
  WHERE m.direction = 'outgoing'
    AND m.sender_type = 'bot'
    AND m.message_type = 'document'
    AND m.deleted_at IS NULL
    AND NULLIF(m.raw_payload#>>'{technical_sheet,sheet_key}', '') IS NOT NULL
    AND m.delivery_status IN ('sending', 'sent', 'unknown')
    AND lc.conversation_status_code <> 'closed'
),
-- Task 3c.29: the sheet offered by the latest committed turn, while its
-- pending question (technical_sheet_offer) is still the open one. Only the
-- latest committed decision counts: a later turn that asked nothing else
-- leaves the pending key in place but is no longer the offer being answered.
v3_technical_sheet_offer AS (
  SELECT latest.offer_ref AS value
  FROM latest_conversation lc
  JOIN LATERAL (
    SELECT decision.output_payload#>>'{reply,primary_request,item_ref}' AS offer_ref,
           decision.output_payload#>>'{reply,primary_request,goal_id}' AS goal_id
    FROM conversation_turn_executions execution
    JOIN advisor_decisions decision ON decision.id = execution.advisor_decision_id
    WHERE execution.conversation_id = lc.conversation_id
      AND execution.state_receipt IS NOT NULL
    ORDER BY execution.id DESC
    LIMIT 1
  ) latest ON TRUE
  WHERE lc.pending_question_key = 'technical_sheet_offer'
    AND latest.goal_id = 'technical_sheet_offer'
    AND latest.offer_ref ~ '^sheet:[a-z0-9-]+$'
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
      -- handed_to_sales too: a correction right after the confirmation reopens
      -- that quote (evaluate-conversation-step), and the model needs its history
      -- not to greet the customer again. Every other turn on such a
      -- conversation is a canned reply or a reset that ignores this list.
      AND lc.conversation_status_code IN ('active', 'waiting_user', 'out_of_flow', 'handed_to_sales')
      AND (lcr.reset_at IS NULL OR m.created_at > lcr.reset_at)
    ORDER BY m.created_at DESC, m.id DESC
    LIMIT 8
  ) history
),
-- Last line this conversation actually heard from us, and how long ago.
-- recent_messages above cannot answer that question for the terminal states:
-- it is scoped to active/waiting_user/out_of_flow conversations inside a 48h
-- inbound window, so it is always empty exactly where the escalation and
-- commercial-review canned lines live. The sent message is the receipt, so no
-- counter column and no migration are needed to bound a repeated reply.
last_outgoing_message AS (
  SELECT
    m.text_body AS last_outgoing_text,
    m.created_at AS last_outgoing_at,
    EXTRACT(EPOCH FROM (NOW() - m.created_at)) / 3600 AS elapsed_hours
  FROM messages m
  JOIN latest_conversation lc ON lc.conversation_id = m.conversation_id
  WHERE m.deleted_at IS NULL
    AND m.direction = 'outgoing'
    AND m.delivery_status = 'sent'
    AND NULLIF(BTRIM(m.text_body), '') IS NOT NULL
  ORDER BY m.created_at DESC, m.id DESC
  LIMIT 1
),
-- Quote correction: the ClickUp task of the latest conversation's own lead.
-- An open task lets a correction continue the confirmed quote; a closed one
-- (status in CLICKUP_STATUS_RESOLVED) starts a new quote.
latest_conversation_task AS (
  SELECT l.clickup_task_id, l.clickup_status
  FROM leads l
  JOIN latest_conversation lc ON lc.lead_id = l.id
  WHERE l.deleted_at IS NULL
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
latest_chat_ownership AS (
  SELECT
    o.id AS ownership_id,
    o.lead_id AS ownership_lead_id,
    o.acquired_at,
    o.response_due_at,
    o.released_at,
    o.release_reason,
    o.sla_mode,
    o.quote_alert_result,
    o.quote_alerted_at,
    o.last_human_reply_at,
    COALESCE(o.released_at, o.response_due_at) AS effective_release_at
  FROM lead_chat_ownerships o
  JOIN latest_lead ll ON ll.previous_lead_id = o.lead_id
  WHERE o.deleted_at IS NULL
  ORDER BY o.id DESC
  LIMIT 1
),
chat_authority AS (
  SELECT
    o.*,
    (
      o.released_at IS NULL
      AND (o.response_due_at IS NULL OR o.response_due_at > NOW())
    ) AS bot_suppressed,
    (
      COALESCE(o.release_reason = 'sla_expired', FALSE)
      OR (
        o.released_at IS NULL
        AND o.response_due_at IS NOT NULL
        AND o.response_due_at <= NOW()
      )
    )
    AND NOT EXISTS (
      SELECT 1
      FROM messages m
      JOIN conversations history_conversation
        ON history_conversation.id = m.conversation_id
      JOIN latest_lead ll ON TRUE
      WHERE m.deleted_at IS NULL
        AND m.direction = 'outgoing'
        AND m.sender_type = 'bot'
        AND m.delivery_status = 'sent'
        AND history_conversation.deleted_at IS NULL
        AND history_conversation.phone_number = ll.phone_number
        AND history_conversation.source_number_id = ll.previous_source_number_id
        AND m.created_at >= o.effective_release_at
    ) AS human_arbitration_required,
    -- Migration 037: the quote follow-up notice asked "¿Quieres hacer una
    -- cotización nueva?". This turn answers it when the notice was delivered in
    -- the last 24 hours, the seller has not replied since, and no customer
    -- message arrived after it yet (this turn's own messages are persisted
    -- later, by 07_persist_conversation_state.sql).
    (
      o.released_at IS NULL
      AND o.sla_mode = 'quote_followup'
      AND o.quote_alert_result = 'sent'
      AND o.quote_alerted_at > NOW() - INTERVAL '24 hours'
      AND (o.last_human_reply_at IS NULL OR o.last_human_reply_at < o.quote_alerted_at)
      AND NOT EXISTS (
        SELECT 1
        FROM messages m
        JOIN conversations mc ON mc.id = m.conversation_id
        WHERE m.deleted_at IS NULL
          AND m.direction = 'incoming'
          AND m.sender_type = 'customer'
          AND (m.lead_id = o.ownership_lead_id OR mc.lead_id = o.ownership_lead_id)
          AND m.created_at > o.quote_alerted_at
      )
    ) AS quote_followup_offer_pending
  FROM latest_chat_ownership o
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
  lom.last_outgoing_text,
  lom.last_outgoing_at,
  lom.elapsed_hours::numeric AS elapsed_hours_since_last_outbound,
  lcs.state_service,
  lcs.state_city,
  lcs.state_requirement,
  lcs.state_current_step,
  lcqa.pending_question_key AS previous_commercial_pending_question_key,
  COALESCE(lcqa.retry_count, 0) AS previous_commercial_question_retry,
  COALESCE(rm.recent_messages, '[]'::jsonb) AS recent_messages,
  CASE WHEN lcr.reset_at IS NULL OR ll.previous_lead_created_at > lcr.reset_at THEN ll.previous_lead_id END AS previous_lead_id,
  CASE WHEN lcr.reset_at IS NULL OR ll.previous_lead_created_at > lcr.reset_at THEN ll.whatsapp_name END AS previous_whatsapp_name,
  CASE WHEN lcr.reset_at IS NULL OR ll.previous_lead_created_at > lcr.reset_at THEN ll.service END AS previous_service,
  CASE WHEN lcr.reset_at IS NULL OR ll.previous_lead_created_at > lcr.reset_at THEN ll.city END AS previous_city,
  CASE WHEN lcr.reset_at IS NULL OR ll.previous_lead_created_at > lcr.reset_at THEN ll.requirement END AS previous_requirement,
  CASE WHEN lcr.reset_at IS NULL OR ll.previous_lead_created_at > lcr.reset_at THEN ll.lead_status_code END AS previous_lead_status_code,
  ca.ownership_id,
  ca.ownership_lead_id,
  lct.clickup_task_id AS lead_clickup_task_id,
  lct.clickup_status AS lead_clickup_status,
  COALESCE(ca.bot_suppressed, FALSE) AS bot_suppressed,
  ca.response_due_at AS human_response_due_at,
  COALESCE(ca.human_arbitration_required, FALSE) AS human_arbitration_required,
  COALESCE(ca.quote_followup_offer_pending, FALSE) AS quote_followup_offer_pending,
  COALESCE(fs.pending_count, 0) > 0 AS has_pending_followups,
  COALESCE(lcs.state_service, ll.service) AS last_known_service,
  COALESCE(lcs.state_city, ll.city) AS last_known_city,
  COALESCE(lcs.state_requirement, ll.requirement) AS last_known_requirement,
  vg.value || CASE WHEN vrp.value IS NOT NULL
    THEN jsonb_build_object('removed_products', vrp.value) ELSE '{}'::jsonb END
    || CASE WHEN vtss.value IS NOT NULL
      THEN jsonb_build_object('technical_sheets_sent', vtss.value) ELSE '{}'::jsonb END
    || CASE WHEN vtso.value IS NOT NULL
      THEN jsonb_build_object('technical_sheet_offer_ref', vtso.value) ELSE '{}'::jsonb END AS v3_grounding
FROM input_payload ip
JOIN valid_claim vc ON TRUE
LEFT JOIN active_contract_route acr ON TRUE
LEFT JOIN latest_conversation lc ON TRUE
LEFT JOIN last_persisted_inbound lpi ON TRUE
LEFT JOIN latest_conversation_state lcs ON TRUE
LEFT JOIN latest_commercial_question_audit lcqa ON TRUE
LEFT JOIN recent_messages rm ON TRUE
LEFT JOIN last_outgoing_message lom ON TRUE
LEFT JOIN latest_conversation_reset lcr ON TRUE
LEFT JOIN latest_lead ll ON TRUE
LEFT JOIN latest_conversation_task lct ON TRUE
LEFT JOIN chat_authority ca ON TRUE
LEFT JOIN follow_up_status fs ON TRUE
LEFT JOIN v3_grounding vg ON TRUE
LEFT JOIN v3_removed_products vrp ON TRUE
LEFT JOIN v3_technical_sheets_sent vtss ON TRUE
LEFT JOIN v3_technical_sheet_offer vtso ON TRUE;
