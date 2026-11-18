-- Rollback of migration 042 (no inbound debounce for seller-owned chats).
-- Restores the exact 034 claim_inbound_event and 6-argument
-- recover_and_claim_inbound_events, then drops the ownership helper. No data
-- changes: events claimed inline while 042 was live are ordinary turns, and
-- seller-owned queues simply wait for the window again.
-- Apply atomically: psql -v ON_ERROR_STOP=1 -f <this file>.

BEGIN;
SET LOCAL lock_timeout = '5s';

-- Verbatim from migration 034.
CREATE OR REPLACE FUNCTION claim_inbound_event(p_payload JSONB)
RETURNS TABLE (
  inbound_event_id BIGINT,
  processing_token TEXT,
  duplicate_event BOOLEAN,
  should_process BOOLEAN,
  event_type TEXT,
  normalized_event TEXT,
  instance_name TEXT,
  phone_number TEXT,
  source_number_id BIGINT,
  whatsapp_name TEXT,
  external_contact_id TEXT,
  external_message_id TEXT,
  external_timestamp TEXT,
  message_type TEXT,
  text_body TEXT,
  raw_payload_json TEXT,
  attachment_type TEXT,
  mime_type TEXT,
  filename TEXT,
  external_media_id TEXT,
  external_url TEXT,
  sha256 TEXT,
  file_size TEXT,
  debounce_pending BOOLEAN
)
LANGUAGE plpgsql
AS $$
DECLARE
  v_instance_name TEXT := COALESCE(NULLIF(p_payload->>'instance_name', ''), 'unknown');
  v_external_message_id TEXT := NULLIF(p_payload->>'external_message_id', '');
  v_phone_number TEXT := NULLIF(p_payload->>'phone_number', '');
  v_source_number_id BIGINT;
  v_event_fingerprint TEXT;
  v_dedupe_key TEXT;
  v_queue_key TEXT;
  v_requested_processing BOOLEAN := COALESCE((p_payload->>'requested_processing')::boolean, FALSE);
  v_debounce_seconds INTEGER := CASE
    WHEN COALESCE(p_payload->>'debounce_seconds', '') ~ '^[0-9]{1,4}$'
      THEN LEAST(60, (p_payload->>'debounce_seconds')::integer)
    ELSE 0
  END;
  v_own_message BOOLEAN := COALESCE(p_payload->>'is_from_me', 'false') = 'true'
    OR COALESCE(p_payload->>'sender_type_candidate', '') = 'own_message';
  v_status TEXT;
  v_failure_reason TEXT;
  v_token TEXT;
  v_event inbound_events%ROWTYPE;
BEGIN
  SELECT wn.id INTO v_source_number_id
  FROM whatsapp_numbers wn
  WHERE wn.deleted_at IS NULL
    AND wn.is_active = TRUE
    AND wn.instance_name = v_instance_name
  ORDER BY wn.id
  LIMIT 1;

  v_event_fingerprint := md5(concat_ws('|',
    v_instance_name,
    COALESCE(v_phone_number, ''),
    COALESCE(p_payload->>'external_timestamp', ''),
    COALESCE(NULLIF(p_payload->>'message_type', ''), 'unknown'),
    COALESCE(p_payload->>'text_body', ''),
    COALESCE(p_payload->>'raw_payload_json', '{}')
  ));
  v_dedupe_key := COALESCE('id:' || v_external_message_id, 'fp:' || v_event_fingerprint);
  v_queue_key := CASE
    WHEN v_source_number_id IS NOT NULL AND v_phone_number IS NOT NULL
      THEN v_source_number_id::text || ':' || v_phone_number
  END;

  -- The lock is acquired before any queue read. Calls waiting on the same
  -- source+phone resume with a fresh READ COMMITTED snapshot inside PL/pgSQL.
  PERFORM pg_advisory_xact_lock(hashtextextended(
    COALESCE(v_queue_key, 'unmapped:' || v_instance_name || ':' || COALESCE(v_phone_number, '')),
    0
  ));

  SELECT ie.* INTO v_event
  FROM inbound_events ie
  WHERE ie.instance_name = v_instance_name
    AND ie.dedupe_key = v_dedupe_key;

  IF FOUND THEN
    RETURN QUERY SELECT
      v_event.id, v_event.processing_token, TRUE, FALSE,
      p_payload->>'event_type', p_payload->>'normalized_event', v_instance_name,
      v_phone_number, v_event.source_number_id, p_payload->>'whatsapp_name',
      p_payload->>'external_contact_id', v_external_message_id,
      p_payload->>'external_timestamp',
      COALESCE(NULLIF(p_payload->>'message_type', ''), 'unknown'),
      p_payload->>'text_body', COALESCE(p_payload->>'raw_payload_json', '{}'),
      p_payload->>'attachment_type', p_payload->>'mime_type', p_payload->>'filename',
      p_payload->>'external_media_id', p_payload->>'external_url',
      p_payload->>'sha256', p_payload->>'file_size', FALSE;
    RETURN;
  END IF;

  IF v_requested_processing AND v_source_number_id IS NULL THEN
    v_status := 'failed';
    v_failure_reason := 'unknown_instance';
  ELSIF v_requested_processing AND v_phone_number IS NULL THEN
    v_status := 'failed';
    v_failure_reason := 'missing_phone_number';
  ELSIF NOT v_requested_processing THEN
    v_status := 'ignored';
  ELSIF v_debounce_seconds > 0 AND NOT v_own_message THEN
    -- Debounced: the turn starts only once the contact has been quiet for the
    -- window, from recover_and_claim_inbound_events.
    v_status := 'received';
  ELSIF EXISTS (
    SELECT 1 FROM inbound_events queued
    WHERE queued.queue_key = v_queue_key
      AND queued.processing_status IN ('received', 'processing')
  ) THEN
    v_status := 'received';
  ELSE
    v_status := 'processing';
    v_token := md5(random()::text || clock_timestamp()::text || v_dedupe_key);
  END IF;

  INSERT INTO inbound_events (
    instance_name, external_message_id, event_fingerprint, dedupe_key,
    source_number_id, phone_number, queue_key, event_type, normalized_event,
    should_process, processing_status, processing_started_at, processing_token,
    processing_phase, attempt_count, failure_reason, raw_payload, normalized_payload
  )
  VALUES (
    v_instance_name, v_external_message_id, v_event_fingerprint, v_dedupe_key,
    v_source_number_id, v_phone_number, v_queue_key, p_payload->>'event_type',
    p_payload->>'normalized_event',
    (v_requested_processing AND v_source_number_id IS NOT NULL AND v_phone_number IS NOT NULL),
    v_status, CASE WHEN v_status = 'processing' THEN NOW() END, v_token,
    CASE WHEN v_status = 'processing' THEN 'orchestrating' ELSE 'queued' END,
    CASE WHEN v_status = 'processing' THEN 1 ELSE 0 END, v_failure_reason,
    COALESCE(NULLIF(p_payload->>'raw_payload_json', '')::jsonb, '{}'::jsonb),
    p_payload
  )
  RETURNING * INTO v_event;

  RETURN QUERY SELECT
    v_event.id, v_event.processing_token, FALSE, (v_status = 'processing'),
    p_payload->>'event_type', p_payload->>'normalized_event', v_instance_name,
    v_phone_number, v_source_number_id, p_payload->>'whatsapp_name',
    p_payload->>'external_contact_id', v_external_message_id,
    p_payload->>'external_timestamp',
    COALESCE(NULLIF(p_payload->>'message_type', ''), 'unknown'),
    p_payload->>'text_body', COALESCE(p_payload->>'raw_payload_json', '{}'),
    p_payload->>'attachment_type', p_payload->>'mime_type', p_payload->>'filename',
    p_payload->>'external_media_id', p_payload->>'external_url',
    p_payload->>'sha256', p_payload->>'file_size',
    -- Every queued event wakes its queue after the window: also one queued
    -- behind a busy turn, whose completion may come before its window closes.
    (v_status = 'received' AND v_debounce_seconds > 0);
END;
$$;

-- Verbatim from migration 034.
CREATE OR REPLACE FUNCTION recover_and_claim_inbound_events(
  p_stale_seconds INTEGER,
  p_batch_size INTEGER,
  p_max_attempts INTEGER,
  p_debounce_seconds INTEGER,
  p_debounce_max_wait_seconds INTEGER,
  p_scope_inbound_event_id BIGINT
)
RETURNS TABLE (
  inbound_event_id BIGINT,
  processing_token TEXT,
  source_number_id BIGINT,
  normalized_payload JSONB,
  downstream_payload JSONB,
  inbound_batch_event_ids BIGINT[]
)
LANGUAGE plpgsql
AS $$
DECLARE
  -- Leader plus followers. A burst longer than this becomes several turns.
  c_max_batch_events CONSTANT INTEGER := 20;
  v_stale_seconds INTEGER := GREATEST(60, p_stale_seconds);
  v_batch_size INTEGER := GREATEST(1, LEAST(100, p_batch_size));
  v_max_attempts INTEGER := GREATEST(1, p_max_attempts);
  v_debounce_seconds INTEGER := GREATEST(0, LEAST(60, COALESCE(p_debounce_seconds, 0)));
  v_max_wait_seconds INTEGER;
  v_scope_queue_key TEXT;
  v_claimed_ids BIGINT[];
  v_leader inbound_events%ROWTYPE;
BEGIN
  v_max_wait_seconds := CASE
    WHEN v_debounce_seconds = 0 THEN 0
    ELSE GREATEST(v_debounce_seconds, LEAST(300, COALESCE(p_debounce_max_wait_seconds, 30)))
  END;

  IF p_scope_inbound_event_id IS NOT NULL THEN
    SELECT scoped.queue_key INTO v_scope_queue_key
    FROM inbound_events scoped
    WHERE scoped.id = p_scope_inbound_event_id;
    IF v_scope_queue_key IS NULL THEN
      RETURN;
    END IF;
  END IF;

  UPDATE inbound_events ie
  SET processing_status = 'failed',
      failed_at = NOW(),
      processing_token = NULL,
      failure_reason = 'stale_processing_max_attempts',
      updated_at = NOW()
  WHERE ie.processing_status = 'processing'
    AND ie.processing_started_at < NOW() - make_interval(secs => v_stale_seconds)
    AND ie.attempt_count >= v_max_attempts;

  UPDATE inbound_events ie
  SET processing_status = 'received',
      processing_started_at = NULL,
      processing_token = NULL,
      failure_reason = 'stale_processing_requeued',
      updated_at = NOW()
  WHERE ie.processing_status = 'processing'
    AND ie.processing_started_at < NOW() - make_interval(secs => v_stale_seconds)
    AND ie.attempt_count < v_max_attempts;

  WITH pending AS (
    SELECT ie.queue_key,
      MAX(ie.received_at) AS newest_at,
      MIN(ie.received_at) AS oldest_at
    FROM inbound_events ie
    WHERE ie.should_process = TRUE
      AND ie.processing_status = 'received'
      AND ie.queue_key IS NOT NULL
      AND (v_scope_queue_key IS NULL OR ie.queue_key = v_scope_queue_key)
    GROUP BY ie.queue_key
  ),
  settled AS (
    SELECT p.queue_key
    FROM pending p
    WHERE v_debounce_seconds = 0
       OR p.newest_at <= NOW() - make_interval(secs => v_debounce_seconds)
       OR p.oldest_at <= NOW() - make_interval(secs => v_max_wait_seconds)
  ),
  ranked AS (
    SELECT ie.id,
      row_number() OVER (
        PARTITION BY ie.queue_key ORDER BY ie.received_at, ie.id
      ) AS queue_position
    FROM inbound_events ie
    JOIN settled s ON s.queue_key = ie.queue_key
    WHERE ie.should_process = TRUE
      AND ie.processing_status = 'received'
      -- A follower is answered by its leader's turn, never by its own.
      AND (ie.batch_leader_event_id IS NULL OR ie.batch_leader_event_id = ie.id)
      AND NOT EXISTS (
        SELECT 1 FROM inbound_events active
        WHERE active.queue_key = ie.queue_key
          AND active.processing_status = 'processing'
      )
  ),
  selected AS (
    SELECT ie.id
    FROM inbound_events ie
    JOIN ranked r ON r.id = ie.id AND r.queue_position = 1
    ORDER BY ie.received_at, ie.id
    FOR UPDATE OF ie SKIP LOCKED
    LIMIT v_batch_size
  ),
  claimed AS (
    UPDATE inbound_events ie
    SET processing_status = 'processing',
        processing_started_at = NOW(),
        processing_token = md5(random()::text || clock_timestamp()::text || ie.id::text),
        processing_phase = CASE
          WHEN ie.downstream_payload <> '{}'::jsonb THEN 'dispatching'
          ELSE 'orchestrating'
        END,
        attempt_count = ie.attempt_count + 1,
        failure_reason = NULL,
        updated_at = NOW()
    FROM selected s
    WHERE ie.id = s.id
      AND ie.processing_status = 'received'
    RETURNING ie.id
  )
  SELECT COALESCE(array_agg(c.id ORDER BY c.id), ARRAY[]::BIGINT[])
  INTO v_claimed_ids
  FROM claimed c;

  -- Form a batch only on a leader's first attempt: a retried turn may already
  -- have persisted state for its text, so its membership never changes.
  IF v_debounce_seconds > 0 THEN
    FOR v_leader IN
      SELECT ie.* FROM inbound_events ie WHERE ie.id = ANY(v_claimed_ids) ORDER BY ie.id
    LOOP
      CONTINUE WHEN v_leader.batch_leader_event_id IS NOT NULL
        OR v_leader.attempt_count <> 1
        OR v_leader.downstream_payload <> '{}'::jsonb
        OR NOT inbound_payload_is_batchable(v_leader.normalized_payload);

      WITH candidates AS (
        SELECT ie.id,
          ie.batch_leader_event_id IS NULL
            AND ie.attempt_count = 0
            AND ie.downstream_payload = '{}'::jsonb
            AND inbound_payload_is_batchable(ie.normalized_payload) AS joinable,
          row_number() OVER (ORDER BY ie.received_at, ie.id) AS position
        FROM inbound_events ie
        WHERE ie.queue_key = v_leader.queue_key
          AND ie.should_process = TRUE
          AND ie.processing_status = 'received'
          AND (ie.received_at, ie.id) > (v_leader.received_at, v_leader.id)
      ),
      unbroken AS (
        -- The first event that cannot join ends the batch: it keeps its FIFO
        -- turn, and so does everything behind it.
        SELECT c.id, c.position,
          bool_and(c.joinable) OVER (ORDER BY c.position) AS joins
        FROM candidates c
      ),
      attached AS (
        UPDATE inbound_events ie
        SET batch_leader_event_id = v_leader.id,
            updated_at = NOW()
        FROM unbroken u
        WHERE ie.id = u.id
          AND u.joins
          AND u.position < c_max_batch_events
        RETURNING ie.id
      )
      UPDATE inbound_events ie
      SET batch_leader_event_id = v_leader.id
      WHERE ie.id = v_leader.id
        AND EXISTS (SELECT 1 FROM attached);
    END LOOP;
  END IF;

  RETURN QUERY
  SELECT ie.id,
    ie.processing_token,
    ie.source_number_id,
    CASE
      WHEN batch.member_count > 1 THEN ie.normalized_payload || jsonb_build_object(
        'text_body', batch.joined_text,
        'inbound_batch_event_ids', to_jsonb(batch.member_ids)
      )
      ELSE ie.normalized_payload
    END,
    ie.downstream_payload,
    batch.member_ids
  FROM inbound_events ie
  CROSS JOIN LATERAL (
    SELECT
      array_agg(member.id ORDER BY member.received_at, member.id) AS member_ids,
      COUNT(*) AS member_count,
      string_agg(
        NULLIF(member.normalized_payload->>'text_body', ''), E'\n'
        ORDER BY member.received_at, member.id
      ) AS joined_text
    FROM inbound_events member
    WHERE member.id = ie.id
       OR member.batch_leader_event_id = ie.id
  ) batch
  WHERE ie.id = ANY(v_claimed_ids)
  ORDER BY ie.id;
END;
$$;

DROP FUNCTION IF EXISTS inbound_contact_seller_owned(BIGINT, TEXT);

COMMIT;
