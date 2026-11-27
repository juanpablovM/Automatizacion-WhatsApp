-- Enqueue the 1.3 backfill work of this pass (stage H, write side; migration
-- 059, feature U8: S9, S11). p1 JSON array built by Build Backfill Events:
-- { kind, contact_id, entity_id, id_prefix, event_id, event_type,
--   conversation_id, revision, body, blocked_reason, record_hash, source_hash,
--   requirement, routed, crm_opportunity_id, crm_seller_id, change_id,
--   contact_version }.
--
-- Rows go in array order (the select's per-contact order), so crm_events ids
-- and therefore delivery follow it. Every entity row is locked first with SKIP
-- LOCKED: the dispatcher never waits on a row, and a skipped row stays
-- unsettled and is retried on the next pass. An item is enqueued only while
-- its entity has no event of its type under the prefix yet (re-running a pass
-- enqueues nothing; the per-entity uniques of 054 back that up):
--   lead     revision is exactly the next one (all prefixes, as 02); the lead's
--            hashes are recorded as 02 records them (requirement, record hash,
--            the source hash the body was built from), so the live stage does
--            not resend an unchanged lead, and resends a changed open one;
--   handoff  revision is the next one (all prefixes, as 10); an open (routed)
--            one only while its stored routing is the one the body carries;
--   message  no message.new under the prefix yet;
--   holder   the contact counter is still the one the body was built on; the
--            counter then advances to the event's version (under the contact
--            row lock, as 056 does), so later changes stay above it;
--   complete the contact's backfill is marked completed.
-- A blocked item is recorded in crm_backfill_blocks (its step can finish).
WITH input AS MATERIALIZED (
  SELECT x.kind, x.contact_id, x.entity_id, x.id_prefix, x.event_id, x.event_type, x.conversation_id, x.revision,
         x.body, NULLIF(x.blocked_reason, '') AS blocked_reason, x.record_hash, x.source_hash, x.requirement,
         x.routed, x.crm_opportunity_id, x.crm_seller_id, x.change_id, x.contact_version, a.ord
  FROM jsonb_array_elements(COALESCE(NULLIF($1::text, ''), '[]')::jsonb) WITH ORDINALITY AS a(item, ord)
  CROSS JOIN LATERAL jsonb_to_record(a.item)
    AS x(kind TEXT, contact_id BIGINT, entity_id BIGINT, id_prefix TEXT, event_id TEXT, event_type TEXT,
         conversation_id TEXT, revision INTEGER, body TEXT, blocked_reason TEXT, record_hash TEXT,
         source_hash TEXT, requirement TEXT, routed BOOLEAN, crm_opportunity_id TEXT, crm_seller_id TEXT,
         change_id BIGINT, contact_version BIGINT)
),
buildable AS MATERIALIZED (
  SELECT i.*
  FROM input i
  WHERE i.blocked_reason IS NULL
    AND NULLIF(i.body, '') IS NOT NULL
    AND NULLIF(i.event_id, '') IS NOT NULL
    AND crm_event_id_prefix(i.event_id) = i.id_prefix
),
lead_locked AS MATERIALIZED (
  SELECT b.ord
  FROM buildable b
  JOIN leads l ON l.id = b.entity_id AND l.deleted_at IS NULL
  WHERE b.kind = 'lead'
  ORDER BY l.id
  FOR UPDATE OF l SKIP LOCKED
),
handoff_locked AS MATERIALIZED (
  SELECT b.ord, h.crm_opportunity_id::text AS stored_opportunity_id, s.crm_user_id::text AS stored_seller_id
  FROM buildable b
  JOIN handoffs h ON h.id = b.entity_id AND h.deleted_at IS NULL
  LEFT JOIN sellers s ON s.id = h.crm_routing_seller_id
  WHERE b.kind = 'handoff'
  ORDER BY h.id
  FOR UPDATE OF h SKIP LOCKED
),
holder_locked AS MATERIALIZED (
  SELECT b.ord, ct.ownership_version
  FROM buildable b
  JOIN crm_contacts ct ON ct.id = b.contact_id
  WHERE b.kind = 'holder'
  ORDER BY ct.id
  FOR UPDATE OF ct SKIP LOCKED
),
expected AS MATERIALIZED (
  SELECT b.*
  FROM buildable b
  WHERE (
    b.kind = 'lead'
    AND EXISTS (SELECT 1 FROM lead_locked ll WHERE ll.ord = b.ord)
    AND NOT EXISTS (
      SELECT 1 FROM crm_events e
      WHERE e.lead_id = b.entity_id AND e.event_type = 'lead.qualified' AND e.id_prefix = b.id_prefix
    )
    AND (
      SELECT COALESCE(MAX(e.revision), 0) FROM crm_events e
      WHERE e.lead_id = b.entity_id AND e.event_type = 'lead.qualified'
    ) = b.revision - 1
  ) OR (
    b.kind = 'handoff'
    AND EXISTS (
      SELECT 1 FROM handoff_locked hl
      WHERE hl.ord = b.ord
        AND (NOT COALESCE(b.routed, FALSE)
             OR (hl.stored_opportunity_id IS NOT DISTINCT FROM lower(NULLIF(b.crm_opportunity_id, ''))
                 AND hl.stored_seller_id IS NOT DISTINCT FROM lower(NULLIF(b.crm_seller_id, ''))))
    )
    AND NOT EXISTS (
      SELECT 1 FROM crm_events e
      WHERE e.handoff_id = b.entity_id AND e.event_type = 'handoff.created' AND e.id_prefix = b.id_prefix
    )
    AND (
      SELECT COALESCE(MAX(e.revision), 0) FROM crm_events e
      WHERE e.handoff_id = b.entity_id AND e.event_type = 'handoff.created'
    ) = b.revision - 1
  ) OR (
    b.kind = 'message'
    AND EXISTS (SELECT 1 FROM messages m WHERE m.id = b.entity_id)
    AND NOT EXISTS (
      SELECT 1 FROM crm_events e
      WHERE e.message_id = b.entity_id AND e.event_type = 'message.new' AND e.id_prefix = b.id_prefix
    )
  ) OR (
    b.kind = 'holder'
    AND b.event_type = 'ownership.taken'
    AND EXISTS (SELECT 1 FROM holder_locked ho WHERE ho.ord = b.ord AND ho.ownership_version = b.contact_version - 1)
    AND EXISTS (SELECT 1 FROM crm_ownership_changes ch WHERE ch.id = b.change_id)
    AND NOT EXISTS (
      SELECT 1 FROM crm_events e
      WHERE e.contact_id = b.contact_id AND e.id_prefix = b.id_prefix
        AND e.event_type IN ('ownership.taken', 'ownership.released')
    )
  )
),
inserted AS (
  INSERT INTO crm_events (event_id, event_type, conversation_id, lead_id, message_id, ownership_change_id, handoff_id,
                          revision, body, contact_id)
  SELECT x.event_id, x.event_type, x.conversation_id,
         CASE WHEN x.kind = 'lead' THEN x.entity_id END,
         CASE WHEN x.kind = 'message' THEN x.entity_id END,
         CASE WHEN x.kind = 'holder' THEN x.change_id END,
         CASE WHEN x.kind = 'handoff' THEN x.entity_id END,
         CASE WHEN x.kind IN ('lead', 'handoff') THEN x.revision ELSE 1 END,
         x.body, x.contact_id
  FROM expected x
  WHERE x.event_type = CASE x.kind
      WHEN 'lead' THEN 'lead.qualified'
      WHEN 'handoff' THEN 'handoff.created'
      WHEN 'message' THEN 'message.new'
      WHEN 'holder' THEN 'ownership.taken'
    END
  ORDER BY x.ord
  ON CONFLICT DO NOTHING
  RETURNING event_id, event_type, lead_id, contact_id
),
lead_marked AS (
  UPDATE leads l
  SET crm_enqueued_requirement = x.requirement,
      crm_enqueued_record_hash = NULLIF(x.record_hash, ''),
      crm_checked_source_hash = COALESCE(NULLIF(x.source_hash, ''), l.crm_checked_source_hash),
      crm_blocked_reason = NULL
  FROM expected x
  JOIN inserted i ON i.event_id = x.event_id
  WHERE x.kind = 'lead' AND l.id = x.entity_id
  RETURNING l.id
),
counter_advanced AS (
  UPDATE crm_contacts ct
  SET ownership_version = x.contact_version
  FROM expected x
  JOIN inserted i ON i.event_id = x.event_id
  WHERE x.kind = 'holder' AND ct.id = x.contact_id
  RETURNING ct.id
),
blocked AS (
  INSERT INTO crm_backfill_blocks (id_prefix, kind, entity_id, contact_id, reason)
  SELECT i.id_prefix, i.kind, i.entity_id, i.contact_id, i.blocked_reason
  FROM input i
  JOIN crm_backfill_runs r ON r.id_prefix = i.id_prefix
  WHERE i.blocked_reason IS NOT NULL
    AND i.kind IN ('lead', 'handoff', 'message', 'holder')
  ON CONFLICT (id_prefix, kind, entity_id) DO UPDATE
  SET reason = EXCLUDED.reason,
      updated_at = NOW()
  WHERE crm_backfill_blocks.reason IS DISTINCT FROM EXCLUDED.reason
  RETURNING entity_id
),
completed AS (
  UPDATE crm_contact_backfills b
  SET status = 'completed',
      completed_at = NOW()
  FROM input i
  WHERE i.kind = 'complete'
    AND b.contact_id = i.contact_id
    AND b.id_prefix = i.id_prefix
    AND b.status = 'pending'
  RETURNING b.contact_id
)
SELECT
  (SELECT COUNT(*) FROM inserted)::integer AS enqueued,
  (SELECT COUNT(*) FROM inserted WHERE event_type = 'lead.qualified')::integer AS leads,
  (SELECT COUNT(*) FROM inserted WHERE event_type = 'handoff.created')::integer AS handoffs,
  (SELECT COUNT(*) FROM inserted WHERE event_type = 'message.new')::integer AS messages,
  (SELECT COUNT(*) FROM inserted WHERE event_type = 'ownership.taken')::integer AS holders,
  (SELECT COUNT(*) FROM lead_marked)::integer AS leads_marked,
  (SELECT COUNT(*) FROM counter_advanced)::integer AS counters_advanced,
  (SELECT COUNT(*) FROM blocked)::integer AS blocked,
  (SELECT COUNT(*) FROM completed)::integer AS completed;
