-- CRM 1.2d: route a contingency handoff to exactly one owner (handoff.created).
--
-- Feature document: odd/tasks/crm-1-2d-contingency-handoffs.md (S2, S3, S4).
--
-- 1. handoffs.crm_blocked_reason: why the dispatcher could not enqueue the
--    handoff's next handoff.created (no eligible seller, or a body the CRM
--    would reject). Blocked handoffs are retried last on every pass, so they
--    never starve fresh ones; NULL once an event is enqueued.
-- 2. crm_route_handoff(handoff, test seller): decides the routing once and
--    stores it on the handoff (crm_opportunity_id XOR crm_routing_seller_id).
--    Order, all under the conversation's routing lock:
--      a. re-escalation: another open handoff of the same conversation that is
--         already routed gives its exact key (same opportunity, same seller);
--      b. the customer's opportunity: the newest live lead with that phone and
--         a crm_opportunity_id;
--      c. a test phone (the caller passes the test seller): that seller, even
--         one out of the rotation; never a real seller, and the rotation is
--         not advanced (same rule as the lead rotation);
--      d. the lead rotation itself: same advisory lock
--         ('seller-rotation:' || rotation_key), same assignment_rotations row
--         and pointer, same key ('whatsapp:' || source number, else
--         'whatsapp:default'), same (sort_order, id) order and wrap-around as
--         "Persist Lead And Rotation", so leads and handoffs share one turn.
--         A handoff seller must be active with a crm_user_id (the CRM needs
--         it), where a lead seller needs a clickup_user_id.
--    Sellers the CRM already rejected for this handoff (422 invalid_seller on
--    one of its parked events) are skipped in a, c and d. A handoff already
--    routed returns its routing unchanged; no owner leaves it unrouted and
--    blocked as no_eligible_seller.
--
-- Additive: no existing row changes. Apply atomically:
-- psql -v ON_ERROR_STOP=1 -f <this file>.

BEGIN;
SET LOCAL lock_timeout = '5s';

ALTER TABLE handoffs
  ADD COLUMN IF NOT EXISTS crm_blocked_reason TEXT;

CREATE OR REPLACE FUNCTION crm_route_handoff(p_handoff_id BIGINT, p_test_seller_id BIGINT DEFAULT NULL)
RETURNS TABLE (crm_opportunity_id UUID, crm_routing_seller_id BIGINT)
LANGUAGE plpgsql
AS $$
#variable_conflict use_column
DECLARE
  v_conversation_id BIGINT;
  v_handoff handoffs%ROWTYPE;
  v_rejected UUID[];
  v_opportunity UUID;
  v_seller BIGINT;
  v_rotation_key TEXT;
  v_rotation assignment_rotations%ROWTYPE;
  v_next BIGINT;
  v_picked_sort INTEGER;
BEGIN
  SELECT h.conversation_id INTO v_conversation_id FROM handoffs h WHERE h.id = p_handoff_id;
  IF NOT FOUND THEN
    RETURN;
  END IF;
  -- Handoffs of one conversation are routed one at a time, so a re-escalation
  -- always sees the routing of the handoff it re-escalates.
  PERFORM pg_advisory_xact_lock(hashtextextended('crm-handoff-routing:' || v_conversation_id::text, 0));

  SELECT h.* INTO v_handoff
  FROM handoffs h
  WHERE h.id = p_handoff_id
    AND h.deleted_at IS NULL
  FOR UPDATE;
  IF NOT FOUND THEN
    RETURN;
  END IF;
  IF v_handoff.crm_opportunity_id IS NOT NULL OR v_handoff.crm_routing_seller_id IS NOT NULL THEN
    RETURN QUERY SELECT v_handoff.crm_opportunity_id, v_handoff.crm_routing_seller_id;
    RETURN;
  END IF;
  IF v_handoff.estado NOT IN ('pending', 'notified', 'acknowledged') THEN
    RETURN;
  END IF;

  SELECT COALESCE(array_agg(DISTINCT (e.body::jsonb #>> '{data,crm_seller_id}')::uuid), '{}'::uuid[])
  INTO v_rejected
  FROM crm_events e
  WHERE e.handoff_id = v_handoff.id
    AND e.event_type = 'handoff.created'
    AND e.status = 'parked'
    AND e.last_error = 'http_422:invalid_seller'
    AND (e.body::jsonb #>> '{data,crm_seller_id}') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';

  -- a. Re-escalation: the oldest open routed handoff of the conversation.
  SELECT o.crm_opportunity_id, o.crm_routing_seller_id
  INTO v_opportunity, v_seller
  FROM handoffs o
  LEFT JOIN sellers s ON s.id = o.crm_routing_seller_id
  WHERE o.conversation_id = v_handoff.conversation_id
    AND o.id <> v_handoff.id
    AND o.deleted_at IS NULL
    AND o.estado IN ('pending', 'notified', 'acknowledged')
    AND (
      o.crm_opportunity_id IS NOT NULL
      OR (s.deleted_at IS NULL AND s.crm_user_id IS NOT NULL AND NOT (s.crm_user_id = ANY (v_rejected)))
    )
  ORDER BY o.created_at, o.id
  LIMIT 1;

  -- b. The customer's opportunity.
  IF v_opportunity IS NULL AND v_seller IS NULL THEN
    SELECT l.crm_opportunity_id INTO v_opportunity
    FROM leads l
    WHERE l.deleted_at IS NULL
      AND l.phone_number = v_handoff.phone_number
      AND l.crm_opportunity_id IS NOT NULL
    ORDER BY l.created_at DESC, l.id DESC
    LIMIT 1;
  END IF;

  IF v_opportunity IS NULL AND v_seller IS NULL AND p_test_seller_id IS NOT NULL THEN
    -- c. A test phone: the test seller or nobody.
    SELECT s.id INTO v_seller
    FROM sellers s
    WHERE s.id = p_test_seller_id
      AND s.deleted_at IS NULL
      AND s.crm_user_id IS NOT NULL
      AND NOT (s.crm_user_id = ANY (v_rejected));
  ELSIF v_opportunity IS NULL AND v_seller IS NULL THEN
    -- d. The lead rotation.
    v_rotation_key := COALESCE(
      'whatsapp:' || COALESCE(v_handoff.source_number_id, (SELECT c.source_number_id FROM conversations c WHERE c.id = v_handoff.conversation_id))::text,
      'whatsapp:default'
    );
    PERFORM pg_advisory_xact_lock(hashtextextended('seller-rotation:' || v_rotation_key, 0));

    SELECT ar.* INTO v_rotation FROM assignment_rotations ar WHERE ar.rotation_key = v_rotation_key FOR UPDATE;
    IF NOT FOUND THEN
      INSERT INTO assignment_rotations (rotation_key, next_seller_id, created_at, updated_at)
      SELECT v_rotation_key, s.id, NOW(), NOW()
      FROM sellers s
      WHERE s.deleted_at IS NULL AND s.is_active = TRUE AND s.crm_user_id IS NOT NULL
      ORDER BY s.sort_order ASC, s.id ASC
      LIMIT 1
      ON CONFLICT (rotation_key) DO NOTHING;
      SELECT ar.* INTO v_rotation FROM assignment_rotations ar WHERE ar.rotation_key = v_rotation_key FOR UPDATE;
    END IF;

    IF FOUND THEN
      SELECT sx.id, sx.sort_order INTO v_seller, v_picked_sort
      FROM sellers sx
      WHERE sx.deleted_at IS NULL
        AND sx.is_active = TRUE
        AND sx.crm_user_id IS NOT NULL
        AND NOT (sx.crm_user_id = ANY (v_rejected))
      ORDER BY
        CASE WHEN sx.id = v_rotation.next_seller_id THEN 0 ELSE 1 END,
        CASE WHEN sx.sort_order >= COALESCE((SELECT sn.sort_order FROM sellers sn WHERE sn.id = v_rotation.next_seller_id), sx.sort_order)
             THEN 0 ELSE 1 END,
        sx.sort_order ASC,
        sx.id ASC
      LIMIT 1;

      IF v_seller IS NOT NULL THEN
        SELECT COALESCE(
          (SELECT s2.id FROM sellers s2
           WHERE s2.deleted_at IS NULL AND s2.is_active = TRUE AND s2.crm_user_id IS NOT NULL
             AND (s2.sort_order, s2.id) > (v_picked_sort, v_seller)
           ORDER BY s2.sort_order, s2.id LIMIT 1),
          (SELECT s3.id FROM sellers s3
           WHERE s3.deleted_at IS NULL AND s3.is_active = TRUE AND s3.crm_user_id IS NOT NULL
           ORDER BY s3.sort_order, s3.id LIMIT 1)
        ) INTO v_next;

        UPDATE assignment_rotations ar
        SET last_seller_id = v_seller,
            next_seller_id = v_next,
            last_assigned_at = NOW(),
            updated_at = NOW()
        WHERE ar.id = v_rotation.id;
      END IF;
    END IF;
  END IF;

  IF v_opportunity IS NULL AND v_seller IS NULL THEN
    UPDATE handoffs h
    SET crm_blocked_reason = 'no_eligible_seller'
    WHERE h.id = v_handoff.id
      AND h.crm_blocked_reason IS DISTINCT FROM 'no_eligible_seller';
    RETURN;
  END IF;

  UPDATE handoffs h
  SET crm_opportunity_id = v_opportunity,
      crm_routing_seller_id = CASE WHEN v_opportunity IS NULL THEN v_seller END
  WHERE h.id = v_handoff.id;
  RETURN QUERY SELECT v_opportunity, CASE WHEN v_opportunity IS NULL THEN v_seller END;
END;
$$;

COMMIT;
