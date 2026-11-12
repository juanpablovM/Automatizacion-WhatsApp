-- Select ownership changes to announce to the CRM as ownership.taken /
-- ownership.released (stage D, read side). Protocol revision 1.2 only: under
-- any other revision it returns no row.
-- p1 protocol revision, p2 CRM_EVENTS_SINCE (ISO timestamp), p3 id prefix,
-- p4 batch size.
--
-- One row of crm_ownership_changes (migration 040) is one version of the
-- conversation's ownership. A change is a candidate when its conversation was
-- already announced by a delivered lead.qualified event (the CRM knows the
-- conversation), it happened at or after CRM_EVENTS_SINCE, and it has no
-- crm_events row yet. Changes from before the lead qualified are included, in
-- version order, like the chat history: the CRM keeps the newest version and
-- acknowledges older ones. crm_user_id is the CRM id of the seller who took
-- the chat (NULL when unmapped, which ownership.taken allows). Changes blocked
-- on a previous pass go last so they cannot starve the batch.
WITH announced AS MATERIALIZED (
  SELECT DISTINCT substring(e.conversation_id FROM '-conversation-([0-9]+)$')::bigint AS conversation_id
  FROM crm_events e
  WHERE $1::text = '1.2'
    AND e.event_type = 'lead.qualified'
    AND e.status = 'delivered'
    AND e.conversation_id LIKE 'wa-' || $3::text || '-conversation-%'
)
SELECT
  ch.id AS change_id,
  ch.conversation_id,
  ch.ownership_version,
  ch.change_kind,
  ch.source,
  ch.reason,
  CASE WHEN ch.change_kind = 'taken' THEN s.crm_user_id::text END AS crm_user_id
FROM announced a
JOIN crm_ownership_changes ch ON ch.conversation_id = a.conversation_id
LEFT JOIN sellers s ON s.id = ch.seller_id AND s.deleted_at IS NULL
WHERE ch.changed_at >= $2::timestamptz
  AND NOT EXISTS (
    SELECT 1
    FROM crm_events e
    WHERE e.ownership_change_id = ch.id
  )
ORDER BY (ch.crm_blocked_reason IS NOT NULL), ch.changed_at, ch.conversation_id, ch.ownership_version
LIMIT COALESCE(NULLIF($4::text, '')::integer, 100);
