-- Select ownership changes to announce to the CRM as ownership.taken /
-- ownership.released (stage D, read side). Protocol revisions 1.2 and 1.3
-- only: under any other revision it returns no row.
-- p1 protocol revision, p2 CRM_EVENTS_SINCE (ISO timestamp), p3 id prefix,
-- p4 batch size.
--
-- One row of crm_ownership_changes (migration 040) is one version of the
-- conversation's ownership. Under 1.2 a change is a candidate when its conversation was
-- already announced by a delivered lead.qualified or handoff.created (1.2d)
-- event (the CRM knows the
-- conversation), it happened at or after CRM_EVENTS_SINCE, and it has no
-- crm_events row yet. Changes from before the lead qualified are included, in
-- version order, like the chat history: the CRM keeps the newest version and
-- acknowledges older ones. crm_user_id is the CRM id of the seller who took
-- the chat (NULL when unmapped, which ownership.taken allows). Changes blocked
-- on a previous pass go last so they cannot starve the batch.
-- Under 1.3 (U4, U6; feature odd/tasks/crm-1-3-customer-threads.md S5, S8)
-- there is no announced gate: every conversation's changes are candidates,
-- each under its own conversation. A change is sent under the contact whose
-- counter it advanced (crm_ownership_changes.contact_id / contact_version,
-- migration 056) and carries contact_version, the per-contact counter the
-- builder sends as data.version; a change without one (from before 056, or
-- of a conversation without a contact) is never sent under 1.3. The ordering
-- rule still holds: a change whose contact has no contact.upserted under p3
-- yet is not selected, and that also applies CRM_EVENTS_PHONE_ALLOWLIST (the
-- contact stage only upserts listed contacts), as the announced gate does
-- under 1.2. CRM_EVENTS_SINCE is applied directly.
WITH announced AS MATERIALIZED (
  SELECT DISTINCT substring(e.conversation_id FROM '-conversation-([0-9]+)$')::bigint AS conversation_id
  FROM crm_events e
  WHERE $1::text = '1.2'
    AND e.event_type IN ('lead.qualified', 'handoff.created')
    AND e.status = 'delivered'
    AND e.conversation_id LIKE 'wa-' || $3::text || '-conversation-%'
), targets AS MATERIALIZED (
  SELECT ch.id AS change_id
  FROM announced a
  JOIN crm_ownership_changes ch ON ch.conversation_id = a.conversation_id
  UNION ALL
  SELECT ch.id
  FROM crm_ownership_changes ch
  WHERE $1::text = '1.3'
    AND ch.contact_id IS NOT NULL
    AND ch.contact_version IS NOT NULL
)
SELECT
  ch.id AS change_id,
  ch.conversation_id,
  ch.ownership_version,
  ch.change_kind,
  ch.source,
  ch.reason,
  CASE WHEN ch.change_kind = 'taken' THEN s.crm_user_id::text END AS crm_user_id,
  ct.contact_id,
  CASE WHEN ct.contact_id IS NOT NULL THEN $3::text END AS contact_upserted_prefixes,
  CASE WHEN $1::text = '1.3' THEN ch.contact_version END AS contact_version
FROM targets t
JOIN crm_ownership_changes ch ON ch.id = t.change_id
LEFT JOIN sellers s ON s.id = ch.seller_id AND s.deleted_at IS NULL
CROSS JOIN LATERAL (
  SELECT CASE WHEN $1::text = '1.3' THEN ch.contact_id END AS contact_id
) ct
WHERE ch.changed_at >= $2::timestamptz
  AND (
    $1::text <> '1.3'
    OR EXISTS (
      SELECT 1
      FROM crm_events ce
      WHERE ce.contact_id = ct.contact_id
        AND ce.event_type = 'contact.upserted'
        AND ce.id_prefix = $3::text
    )
  )
  AND NOT EXISTS (
    SELECT 1
    FROM crm_events e
    WHERE e.ownership_change_id = ch.id
  )
ORDER BY (ch.crm_blocked_reason IS NOT NULL), ch.changed_at, ch.conversation_id, ch.ownership_version
LIMIT COALESCE(NULLIF($4::text, '')::integer, 100);
