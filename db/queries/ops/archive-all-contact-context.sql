-- Explicitly authorized global fresh start. Supply reset_scope='all' and the
-- verified counts with psql -v; this is not the controlled-number reset tool.
-- A validated backup and an application in-flight execution check are required
-- before execution: database locks cannot recall an already authorized HTTP send.
BEGIN;
SET LOCAL lock_timeout = '3s';
LOCK TABLE inbound_events, conversations, leads, opportunities, handoffs,
  lead_chat_ownerships, follow_ups, follow_up_preferences, messages,
  external_operations IN EXCLUSIVE MODE;

CREATE TEMP TABLE contact_context_archive_input ON COMMIT DROP AS
SELECT :'reset_scope'::text AS reset_scope,
       :'expected_non_deleted_conversations'::bigint AS expected_conversations,
       :'expected_non_deleted_leads'::bigint AS expected_leads,
       gen_random_uuid()::text AS reset_id;

DO $archive$
DECLARE
  input record;
  target record;
  changed bigint;
  total_changed bigint := 0;
  counts jsonb := '{}'::jsonb;
  reason constant text := 'fresh_start_user_confirmed_all';
BEGIN
  SELECT * INTO STRICT input FROM contact_context_archive_input;
  IF input.reset_scope IS DISTINCT FROM 'all' THEN
    RAISE EXCEPTION 'reset_scope must explicitly equal all';
  END IF;
  IF input.expected_conversations < 0 OR input.expected_leads < 0
     OR input.expected_conversations IS NULL OR input.expected_leads IS NULL
     OR (SELECT COUNT(*) FROM conversations WHERE deleted_at IS NULL) <> input.expected_conversations
     OR (SELECT COUNT(*) FROM leads WHERE deleted_at IS NULL) <> input.expected_leads THEN
    RAISE EXCEPTION 'expected non-deleted conversation/lead counts do not match';
  END IF;
  -- Preferences are conversation-scoped. Refuse, rather than lose consent when
  -- the normal pipeline subsequently creates a new conversation for this phone.
  IF EXISTS (SELECT 1 FROM follow_up_preferences WHERE opted_out)
     OR EXISTS (SELECT 1 FROM follow_ups WHERE opted_out OR estado = 'opted_out') THEN
    RAISE EXCEPTION 'stored opt-out requires explicit consent-preserving migration before reset';
  END IF;
  IF EXISTS (SELECT 1 FROM inbound_events WHERE processing_status IN ('received', 'processing')) THEN
    RAISE EXCEPTION 'queued/processing inbound events require drain before reset';
  END IF;
  IF EXISTS (SELECT 1 FROM messages WHERE direction = 'outgoing'
             AND COALESCE(delivery_status, '') <> 'sent'
             AND COALESCE(dispatch_phase, '') <> 'sent'
             AND (dispatch_phase IN ('claimed', 'sending') OR delivery_status = 'sending' OR dispatch_token IS NOT NULL))
     OR EXISTS (SELECT 1 FROM follow_ups WHERE estado = 'sending' OR claim_token IS NOT NULL)
     OR EXISTS (SELECT 1 FROM external_operations WHERE status = 'processing' OR claim_token IS NOT NULL)
     OR EXISTS (SELECT 1 FROM lead_chat_ownerships WHERE restoration_state = 'processing'
                 OR restoration_claim_token IS NOT NULL) THEN
    RAISE EXCEPTION 'in-flight automation claims require drain before reset';
  END IF;

  -- Retain original business statuses, qualification data, external task IDs,
  -- and timestamps as historical evidence. Setting closed would invoke the
  -- handoff delivery gate and falsely imply that commercial work was resolved.
  FOR target IN SELECT * FROM (VALUES
    ('conversations', 'conversation'), ('leads', 'lead'),
    ('opportunities', 'opportunity'), ('handoffs', 'handoff'),
    ('lead_chat_ownerships', 'lead_chat_ownership')
  ) AS targets(table_name, entity_type) LOOP
    EXECUTE format($change$
      WITH before_rows AS MATERIALIZED (
        SELECT id, to_jsonb(t) payload FROM %I t WHERE deleted_at IS NULL
      ), changed AS (
        UPDATE %I t SET deleted_at = NOW(), updated_at = NOW()%s
        FROM before_rows b WHERE t.id = b.id RETURNING t.id, to_jsonb(t) payload
      )
      INSERT INTO audit_logs (event_name, entity_type, entity_id, actor_type,
        actor_id, result, before_payload, after_payload, metadata)
      SELECT 'contact_context_archived', $1, c.id, 'system',
        'archive-all-contact-context', 'archived', b.payload, c.payload,
        jsonb_build_object('reset_id', $2, 'reason', $3, 'backup_required', TRUE)
      FROM changed c JOIN before_rows b ON b.id = c.id
    $change$, target.table_name, target.table_name,
      CASE WHEN target.table_name = 'lead_chat_ownerships' THEN
        ', released_at = COALESCE(t.released_at, NOW()), release_reason = COALESCE(t.release_reason, ''manual''), restoration_state = CASE WHEN t.restoration_state IN (''pending'', ''processing'') THEN ''skipped_status_changed'' ELSE t.restoration_state END, restoration_claim_token = NULL'
      ELSE '' END)
    USING target.entity_type, input.reset_id, reason;
    GET DIAGNOSTICS changed = ROW_COUNT;
    counts := counts || jsonb_build_object(target.table_name, changed);
    total_changed := total_changed + changed;
  END LOOP;

  WITH before_rows AS MATERIALIZED (
    SELECT id, to_jsonb(f) payload FROM follow_ups f
    WHERE deleted_at IS NULL AND estado IN ('pending', 'error')
  ), changed AS (
    UPDATE follow_ups f SET estado = 'cancelled', claim_token = NULL,
      claimed_at = NULL, next_retry_at = NULL, updated_at = NOW(),
      metadata = metadata || jsonb_build_object('reset_id', input.reset_id, 'cancel_reason', reason)
    FROM before_rows b WHERE f.id = b.id RETURNING f.id, to_jsonb(f) payload
  )
  INSERT INTO audit_logs (event_name, entity_type, entity_id, actor_type, actor_id,
    result, before_payload, after_payload, metadata)
  SELECT 'contact_context_archived', 'follow_up', c.id, 'system',
    'archive-all-contact-context', 'cancelled', b.payload, c.payload,
    jsonb_build_object('reset_id', input.reset_id, 'reason', reason)
  FROM changed c JOIN before_rows b ON b.id = c.id;
  GET DIAGNOSTICS changed = ROW_COUNT;
  counts := counts || jsonb_build_object('follow_ups_cancelled', changed);
  total_changed := total_changed + changed;

  -- Preserve confirmed and ambiguous provider outcomes. A cancelled dispatch
  -- cannot be reclaimed and does not keep the old fromMe echo arbiter waiting.
  WITH before_rows AS MATERIALIZED (
    SELECT id, to_jsonb(m) payload FROM messages m
    WHERE deleted_at IS NULL AND direction = 'outgoing'
      AND COALESCE(delivery_status, '') <> 'sent'
      AND COALESCE(dispatch_phase, '') <> 'sent'
      AND (dispatch_phase IN ('failed', 'unknown', 'pending', 'queued')
           OR delivery_status IN ('failed', 'unknown', 'pending', 'queued'))
  ), changed AS (
    UPDATE messages m SET dispatch_phase = 'cancelled', dispatch_token = NULL,
      delivery_status = CASE WHEN m.delivery_status IN ('failed', 'unknown')
                             THEN m.delivery_status ELSE 'cancelled' END,
      reconciliation_reason = reason, updated_at = NOW()
    FROM before_rows b WHERE m.id = b.id RETURNING m.id, to_jsonb(m) payload
  )
  INSERT INTO audit_logs (event_name, entity_type, entity_id, actor_type, actor_id,
    result, before_payload, after_payload, metadata)
  SELECT 'contact_context_archived', 'message', c.id, 'system',
    'archive-all-contact-context', 'dispatch_cancelled', b.payload, c.payload,
    jsonb_build_object('reset_id', input.reset_id, 'reason', reason)
  FROM changed c JOIN before_rows b ON b.id = c.id;
  GET DIAGNOSTICS changed = ROW_COUNT;
  counts := counts || jsonb_build_object('outbound_dispatches_cancelled', changed);
  total_changed := total_changed + changed;

  -- No cancelled enum exists in this ledger. A terminal failed, retry-unsafe
  -- operation cannot publish an old handoff or restore/reacquire an old task.
  WITH before_rows AS MATERIALIZED (
    SELECT id, to_jsonb(eo) payload FROM external_operations eo
    WHERE status IN ('pending', 'failed', 'unknown') AND (
      (entity_type = 'lead' AND EXISTS (SELECT 1 FROM leads WHERE id = eo.entity_id))
      OR (entity_type = 'conversation' AND EXISTS (SELECT 1 FROM conversations WHERE id = eo.entity_id))
      OR (entity_type = 'opportunity' AND EXISTS (SELECT 1 FROM opportunities WHERE id = eo.entity_id))
      OR (entity_type = 'handoff' AND EXISTS (SELECT 1 FROM handoffs WHERE id = eo.entity_id))
      OR (entity_type = 'lead_chat_ownership' AND EXISTS (SELECT 1 FROM lead_chat_ownerships WHERE id = eo.entity_id))
    )
  ), changed AS (
    UPDATE external_operations eo SET status = 'failed', retry_safe = FALSE,
      claim_token = NULL, completed_at = NOW(), last_error = reason,
      reconciliation_reason = reason, updated_at = NOW()
    FROM before_rows b WHERE eo.id = b.id RETURNING eo.id, to_jsonb(eo) payload
  )
  INSERT INTO audit_logs (event_name, entity_type, entity_id, actor_type, actor_id,
    result, before_payload, after_payload, metadata)
  SELECT 'contact_context_archived', 'external_operation', c.id, 'system',
    'archive-all-contact-context', 'retry_cancelled', b.payload, c.payload,
    jsonb_build_object('reset_id', input.reset_id, 'reason', reason)
  FROM changed c JOIN before_rows b ON b.id = c.id;
  GET DIAGNOSTICS changed = ROW_COUNT;
  counts := counts || jsonb_build_object('external_operations_cancelled', changed);
  total_changed := total_changed + changed;

  IF EXISTS (SELECT 1 FROM conversations WHERE deleted_at IS NULL)
     OR EXISTS (SELECT 1 FROM leads WHERE deleted_at IS NULL)
     OR EXISTS (SELECT 1 FROM opportunities WHERE deleted_at IS NULL)
     OR EXISTS (SELECT 1 FROM lead_chat_ownerships WHERE deleted_at IS NULL)
     OR EXISTS (SELECT 1 FROM handoffs WHERE deleted_at IS NULL)
     OR EXISTS (SELECT 1 FROM follow_ups WHERE deleted_at IS NULL AND estado IN ('pending', 'sending', 'error')) OR EXISTS (SELECT 1 FROM messages WHERE deleted_at IS NULL AND direction = 'outgoing'
          AND COALESCE(delivery_status, '') <> 'sent' AND COALESCE(dispatch_phase, '') <> 'sent'
          AND dispatch_phase IN ('claimed', 'sending', 'failed', 'unknown', 'pending', 'queued')) THEN
    RAISE EXCEPTION 'global context archive postcondition failed';
  END IF;
  INSERT INTO audit_logs (event_name, entity_type, actor_type, actor_id, result,
    before_payload, after_payload, metadata)
  VALUES ('all_contact_context_archived', 'operation', 'system',
    'archive-all-contact-context', 'archived',
    jsonb_build_object('expected_conversations', input.expected_conversations, 'expected_leads', input.expected_leads),
    counts || jsonb_build_object('total_rows_changed', total_changed),
    jsonb_build_object('reset_id', input.reset_id, 'reason', reason,
      'scope', input.reset_scope, 'backup_required', TRUE,
      'rollback_requires_no_new_activity', TRUE));
END
$archive$;
COMMIT;
