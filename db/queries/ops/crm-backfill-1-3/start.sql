-- CRM 1.3 backfill start (scripts/ops/crm-backfill-1-3.sh --apply): one
-- transaction, idempotent per prefix (migration 059, crm_backfill_start).
-- psql variables: id_prefix, allowlist, test_phones (comma-separated digits).
SELECT result, to_char(cutoff_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS cutoff_at,
       pending_contacts, skipped_contacts
FROM crm_backfill_start(:'id_prefix', :'allowlist', :'test_phones');
