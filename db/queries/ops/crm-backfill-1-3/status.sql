-- CRM 1.3 backfill monitoring (scripts/ops/crm-backfill-1-3.sh --status).
-- Read-only. psql variable: id_prefix. Rows: (section, item, count).
SELECT 'contacts' AS section, b.status AS item, COUNT(*) AS count
FROM crm_contact_backfills b
WHERE b.id_prefix = :'id_prefix'
GROUP BY b.status
UNION ALL
SELECT 'events', e.event_type || ':' || e.status, COUNT(*)
FROM crm_events e
WHERE e.id_prefix = :'id_prefix'
GROUP BY e.event_type, e.status
UNION ALL
SELECT 'parked', e.event_type || ':' || COALESCE(e.last_error, 'unknown'), COUNT(*)
FROM crm_events e
WHERE e.id_prefix = :'id_prefix' AND e.status = 'parked'
GROUP BY e.event_type, e.last_error
UNION ALL
SELECT 'blocks', bb.kind || ':' || bb.reason, COUNT(*)
FROM crm_backfill_blocks bb
WHERE bb.id_prefix = :'id_prefix'
GROUP BY bb.kind, bb.reason
ORDER BY 1, 2;
