WITH valid_claim AS (
  SELECT ie.id
  FROM inbound_events ie
  WHERE ie.id = NULLIF($55::text, '')::bigint
    AND ie.processing_status = 'processing'
    AND ie.processing_token = NULLIF($56::text, '')
),
updated_existing_conversation AS (
  UPDATE conversations c
  SET
    current_step = COALESCE(NULLIF($4::text, ''), c.current_step),
    conversation_status_id = cs.id,
    lead_id = CASE
      WHEN $24::boolean THEN NULL
      ELSE COALESCE(
        NULLIF($5::text, '')::bigint,
        NULLIF($58::text, '')::bigint,
        c.lead_id
      )
    END,
    source_number_id = COALESCE(NULLIF($3::text, '')::bigint, c.source_number_id),
    qualification_context = COALESCE(NULLIF($53::text, '')::jsonb, c.qualification_context),
    pending_question_key = NULLIF($54::text, ''),
    last_message_at = NOW(),
    handed_to_sales_at = CASE
      WHEN cs.code = 'handed_to_sales' THEN NOW()
      WHEN $24::boolean THEN NULL
      ELSE c.handed_to_sales_at
    END,
    closed_at = CASE
      WHEN cs.code IN ('closed', 'inactive_timeout') THEN COALESCE(c.closed_at, NOW())
      ELSE c.closed_at
    END,
    updated_at = NOW()
  FROM conversation_statuses cs
  CROSS JOIN valid_claim
  WHERE NULLIF($1::text, '') IS NOT NULL
    AND c.id = NULLIF($1::text, '')::bigint
    AND cs.code = $18::text
  RETURNING
    c.id,
    c.lead_id,
    c.current_step,
    c.last_message_at,
    FALSE AS created_now
),
created_conversation AS (
  INSERT INTO conversations (
    lead_id,
    source_number_id,
    phone_number,
    conversation_status_id,
    current_step,
    qualification_context,
    pending_question_key,
    started_at,
    last_message_at,
    handed_to_sales_at,
    closed_at
  )
  SELECT
    CASE
      WHEN $24::boolean THEN NULL
      ELSE COALESCE(
        NULLIF($5::text, '')::bigint,
        NULLIF($58::text, '')::bigint
      )
    END,
    NULLIF($3::text, '')::bigint,
    $2::text,
    cs.id,
    COALESCE(NULLIF($4::text, ''), 'service'),
    COALESCE(NULLIF($53::text, '')::jsonb, '{}'::jsonb),
    NULLIF($54::text, ''),
    NOW(),
    NOW(),
    CASE WHEN cs.code = 'handed_to_sales' THEN NOW() ELSE NULL END,
    CASE WHEN cs.code IN ('closed', 'inactive_timeout') THEN NOW() ELSE NULL END
  FROM conversation_statuses cs
  CROSS JOIN valid_claim
  WHERE cs.code = $18::text
    AND NOT EXISTS (
      SELECT 1
      FROM updated_existing_conversation
    )
  RETURNING
    id,
    lead_id,
    current_step,
    last_message_at,
    TRUE AS created_now
),
resolved_conversation_candidates AS (
  SELECT id, lead_id, current_step, last_message_at, created_now
  FROM updated_existing_conversation

  UNION ALL

  SELECT id, lead_id, current_step, last_message_at, created_now
  FROM created_conversation
),
resolved_conversation AS (
  -- This aggregate always evaluates once. A missing/duplicate resolution raises
  -- division_by_zero instead of allowing n8n to finish successfully with zero rows.
  SELECT
    CASE WHEN COUNT(*) = 1 THEN MAX(id) ELSE 1 / (COUNT(*) - COUNT(*)) END AS id,
    MAX(lead_id) AS lead_id,
    MAX(current_step) AS current_step,
    MAX(last_message_at) AS last_message_at,
    BOOL_OR(created_now) AS created_now
  FROM resolved_conversation_candidates
),
incoming_message AS (
  INSERT INTO messages (
    conversation_id,
    lead_id,
    direction,
    sender_type,
    message_type,
    external_message_id,
    external_timestamp,
    delivery_status,
    text_body,
    raw_payload,
    inbound_event_id
  )
  SELECT
    rc.id,
    rc.lead_id,
    'incoming',
    'customer',
    COALESCE(NULLIF($8::text, ''), 'unknown'),
    NULLIF($6::text, ''),
    CASE
      WHEN NULLIF($7::text, '') IS NULL THEN NULL
      WHEN $7::text ~ '^[0-9]+(?:\.\d+)?$' THEN to_timestamp(($7::text)::double precision)
      WHEN $7::text ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}(?:[T ][0-9]{2}:[0-9]{2}:[0-9]{2}(?:\.[0-9]+)?(?:Z|[+-][0-9]{2}(?::?[0-9]{2})?)?)?$' THEN ($7::text)::timestamptz
      ELSE NULL
    END,
    NULL,
    NULLIF($9::text, ''),
    COALESCE(NULLIF($10::text, '')::jsonb, '{}'::jsonb),
    NULLIF($55::text, '')::bigint
  FROM resolved_conversation rc
  RETURNING id, conversation_id, created_at
),
ownership_deadline AS (
  UPDATE lead_chat_ownerships o
  SET
    pending_message_id = im.id,
    pending_message_at = im.created_at,
    response_due_at = im.created_at + INTERVAL '2 hours',
    updated_at = NOW()
  FROM incoming_message im
  WHERE o.lead_id = NULLIF($58::text, '')::bigint
    AND o.released_at IS NULL
    AND o.deleted_at IS NULL
    -- Once the SLA expired, a new customer message must not revive the old
    -- human lease and silence the bot again before ClickUp is restored.
    AND (o.response_due_at IS NULL OR o.response_due_at > NOW())
  RETURNING o.id, o.response_due_at
),
attachment_insert AS (
  INSERT INTO message_attachments (
    message_id,
    attachment_type,
    mime_type,
    filename,
    external_media_id,
    external_url,
    sha256,
    file_size
  )
  SELECT
    im.id,
    NULLIF($11::text, ''),
    NULLIF($12::text, ''),
    NULLIF($13::text, ''),
    NULLIF($14::text, ''),
    NULLIF($15::text, ''),
    NULLIF($16::text, ''),
    NULLIF($17::text, '')::bigint
  FROM incoming_message im
  WHERE NULLIF($11::text, '') IS NOT NULL
  RETURNING id
),
audit_insert AS (
  INSERT INTO audit_logs (
    event_name,
    entity_type,
    entity_id,
    actor_type,
    actor_id,
    result,
    before_payload,
    after_payload,
    metadata
  )
  SELECT
    $19::text,
    'conversation',
    rc.id,
    'system',
    'n8n',
    $20::text,
    COALESCE(NULLIF($21::text, '')::jsonb, '{}'::jsonb),
    COALESCE(NULLIF($22::text, '')::jsonb, '{}'::jsonb),
    COALESCE(NULLIF($23::text, '')::jsonb, '{}'::jsonb)
  FROM resolved_conversation rc
  RETURNING id
),
advisor_decision_insert AS (
  INSERT INTO advisor_decisions (
    conversation_id,
    lead_id,
    message_id,
    decision_type,
    sales_stage,
    buying_intent,
    urgency,
    next_best_action,
    confidence,
    ai_provider,
    ai_model,
    input_payload,
    output_payload,
    validation_result,
    validation_errors
  )
  SELECT
    rc.id,
    rc.lead_id,
    im.id,
    CASE
      WHEN COALESCE(NULLIF($26::text, '')::boolean, false) THEN 'ai_skipped'
      WHEN NULLIF($30::text, '') IS NOT NULL THEN 'ai_error'
      WHEN NULLIF($31::text, '') IS NOT NULL THEN 'ai_fallback'
      ELSE COALESCE(NULLIF($41::text, ''), 'lead_qualification')
    END,
    NULLIF($34::text, ''),
    NULLIF($35::text, ''),
    NULLIF($36::text, ''),
    NULLIF($41::text, ''),
    LEAST(1, GREATEST(0, NULLIF($37::text, '')::numeric)),
    NULLIF($27::text, ''),
    NULLIF($28::text, ''),
    jsonb_build_object(
      'message_type', COALESCE(NULLIF($8::text, ''), 'unknown'),
      'text_body', NULLIF($9::text, ''),
      'before_payload', COALESCE(NULLIF($21::text, '')::jsonb, '{}'::jsonb),
      'commercial_context_counts', COALESCE(NULLIF($40::text, '')::jsonb, '{}'::jsonb)
    ),
    jsonb_build_object(
      'intent', NULLIF($32::text, ''),
      'lead_quality', NULLIF($33::text, ''),
      'customer_type', NULLIF($45::text, ''),
      'lead_class', NULLIF($46::text, ''),
      'modality', NULLIF($47::text, ''),
      'diagnostic_datos', COALESCE(NULLIF($48::text, '')::jsonb, '{}'::jsonb),
      'commercial_missing_fields', COALESCE(NULLIF($52::text, '')::jsonb, '[]'::jsonb),
      'objection_detected', NULLIF($49::text, ''),
      'escalation_area', NULLIF($50::text, ''),
      'executive_summary', NULLIF($51::text, ''),
      'after_payload', COALESCE(NULLIF($22::text, '')::jsonb, '{}'::jsonb),
      'metadata', COALESCE(NULLIF($23::text, '')::jsonb, '{}'::jsonb),
      'catalog_matches', COALESCE(NULLIF($38::text, '')::jsonb, '[]'::jsonb),
      'price_context', COALESCE(NULLIF($39::text, '')::jsonb, '{}'::jsonb),
      'handoff_reason', NULLIF($42::text, ''),
      'ai_status_code', NULLIF($29::text, '')::integer,
      'ai_applied', COALESCE(NULLIF($43::text, '')::boolean, false),
      'ai_accepted_fields', COALESCE(NULLIF($44::text, '')::jsonb, '[]'::jsonb)
    ),
    CASE
      WHEN NULLIF($30::text, '') IS NOT NULL THEN 'error'
      WHEN COALESCE(NULLIF($26::text, '')::boolean, false) OR NULLIF($31::text, '') IS NOT NULL THEN 'fallback'
      ELSE 'accepted'
    END,
    to_jsonb(array_remove(ARRAY[
      CASE WHEN COALESCE(NULLIF($26::text, '')::boolean, false) THEN 'skipped' ELSE NULL END,
      CASE WHEN NULLIF($30::text, '') IS NOT NULL THEN 'parse_error:' || $30::text ELSE NULL END,
      CASE WHEN NULLIF($31::text, '') IS NOT NULL THEN 'fallback:' || $31::text ELSE NULL END
    ]::text[], NULL))
  FROM resolved_conversation rc
  JOIN incoming_message im ON im.conversation_id = rc.id
  WHERE COALESCE(NULLIF($25::text, '')::boolean, false)
  RETURNING id
),
durable_result_update AS (
  UPDATE inbound_events ie
  SET downstream_payload = COALESCE(NULLIF($57::text, '')::jsonb, '{}'::jsonb)
        || jsonb_build_object(
          'conversation_id', rc.id,
          'lead_id', rc.lead_id,
          'message_id', im.id,
          'ownership_id', (SELECT id FROM ownership_deadline LIMIT 1),
          'human_response_due_at', (SELECT response_due_at FROM ownership_deadline LIMIT 1),
          'inbound_event_id', ie.id,
          'processing_token', ie.processing_token
        ),
      processing_phase = 'state_persisted',
      updated_at = NOW()
  FROM incoming_message im
  JOIN resolved_conversation rc ON rc.id = im.conversation_id
  WHERE ie.id = NULLIF($55::text, '')::bigint
    AND ie.processing_status = 'processing'
    AND ie.processing_token = NULLIF($56::text, '')
  RETURNING ie.id, ie.downstream_payload
)
SELECT
  rc.id AS conversation_id,
  rc.lead_id,
  rc.current_step,
  rc.last_message_at,
  rc.created_now,
  im.id AS message_id,
  (SELECT id FROM ownership_deadline LIMIT 1) AS ownership_id,
  (SELECT response_due_at FROM ownership_deadline LIMIT 1) AS human_response_due_at,
  EXISTS(SELECT 1 FROM attachment_insert) AS has_attachment,
  (SELECT id FROM advisor_decision_insert LIMIT 1) AS advisor_decision_id,
  dru.downstream_payload
FROM resolved_conversation rc
JOIN incoming_message im ON im.conversation_id = rc.id
JOIN durable_result_update dru ON dru.id = NULLIF($55::text, '')::bigint;
