#!/usr/bin/env bash
set -euo pipefail
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"
POSTGRES_CONTAINER="${PROJECT_NAME:-crm-whatsapp-automatizado}-postgres"
TEST_DB="crm_whatsapp_historical_repair_${$}"
cleanup() {
  docker exec "$POSTGRES_CONTAINER" psql -U postgres -d postgres -c "DROP DATABASE IF EXISTS ${TEST_DB} WITH (FORCE)" >/dev/null 2>&1 || true
}
trap cleanup EXIT
docker exec "$POSTGRES_CONTAINER" psql -U postgres -d postgres -v ON_ERROR_STOP=1 -c "CREATE DATABASE ${TEST_DB}" >/dev/null
for migration in infra/postgres/migrations/00{1..7}_*.sql; do
  docker exec -i "$POSTGRES_CONTAINER" psql -U postgres -d "$TEST_DB" -v ON_ERROR_STOP=1 < "$migration" >/dev/null
done
docker exec -i "$POSTGRES_CONTAINER" psql -U postgres -d "$TEST_DB" -v ON_ERROR_STOP=1 < db/seeds/001_lead_statuses.sql >/dev/null
docker exec -i "$POSTGRES_CONTAINER" psql -U postgres -d "$TEST_DB" -v ON_ERROR_STOP=1 < db/seeds/002_conversation_statuses.sql >/dev/null

docker exec -i "$POSTGRES_CONTAINER" psql -U postgres -d "$TEST_DB" -v ON_ERROR_STOP=1 >/dev/null <<'SQL'
INSERT INTO whatsapp_numbers (display_name, phone_number, phone_number_id, instance_name)
VALUES ('Main', '+56900000001', 'pn-1', 'main'), ('Secondary', '+56900000002', 'pn-2', 'secondary');

-- Recent sole conversation: must remain byte-for-byte operationally active.
INSERT INTO conversations (source_number_id, phone_number, conversation_status_id, current_step, pending_question_key, last_message_at)
SELECT 1, '56910000001', id, 'city', 'commune', NOW() - INTERVAL '2 hours' FROM conversation_statuses WHERE code='waiting_user';
-- Stale waiting row.
INSERT INTO conversations (source_number_id, phone_number, conversation_status_id, current_step, pending_question_key, last_message_at)
SELECT 1, '56910000002', id, 'confirm', 'final_confirmation', NOW() - INTERVAL '25 hours' FROM conversation_statuses WHERE code='waiting_user';
-- Terminal drift.
INSERT INTO conversations (source_number_id, phone_number, conversation_status_id, current_step, pending_question_key)
SELECT 1, '56910000003', id, 'previous_context', 'final_confirmation' FROM conversation_statuses WHERE code='handed_to_sales';
INSERT INTO conversations (source_number_id, phone_number, conversation_status_id, current_step, pending_question_key)
SELECT 1, '56910000004', id, 'confirm', 'final_confirmation' FROM conversation_statuses WHERE code='escalation_required';
INSERT INTO conversations (source_number_id, phone_number, conversation_status_id, current_step, pending_question_key, closed_at)
SELECT 1, '56910000005', id, 'city', 'commune', NULL FROM conversation_statuses WHERE code='closed';
-- Two recent resumable rows on the same source+phone; newest id 7 survives.
INSERT INTO conversations (source_number_id, phone_number, conversation_status_id, current_step, last_message_at)
SELECT 1, '56910000006', id, 'service', NOW() - INTERVAL '90 minutes' FROM conversation_statuses WHERE code='active';
INSERT INTO conversations (source_number_id, phone_number, conversation_status_id, current_step, last_message_at)
SELECT 1, '56910000006', id, 'city', NOW() - INTERVAL '30 minutes' FROM conversation_statuses WHERE code='waiting_user';
-- Same phone on another source is a different partition and must remain active.
INSERT INTO conversations (source_number_id, phone_number, conversation_status_id, current_step, last_message_at)
SELECT 2, '56910000006', id, 'requirement', NOW() - INTERVAL '20 minutes' FROM conversation_statuses WHERE code='waiting_user';
-- NULL source is ambiguous legacy identity: do not deduplicate without evidence.
INSERT INTO conversations (source_number_id, phone_number, conversation_status_id, current_step, last_message_at)
SELECT NULL, '56910000007', id, 'service', NOW() - INTERVAL '80 minutes' FROM conversation_statuses WHERE code='active';
INSERT INTO conversations (source_number_id, phone_number, conversation_status_id, current_step, last_message_at)
SELECT NULL, '56910000007', id, 'city', NOW() - INTERVAL '10 minutes' FROM conversation_statuses WHERE code='waiting_user';
SQL

docker exec -i "$POSTGRES_CONTAINER" psql -U postgres -d "$TEST_DB" -v ON_ERROR_STOP=1 < infra/postgres/migrations/008_repair_legacy_conversation_state.sql >/dev/null

assert_sql() {
  local query="$1" expected="$2" actual
  actual="$(docker exec "$POSTGRES_CONTAINER" psql -U postgres -d "$TEST_DB" -Atqc "$query")"
  [[ "$actual" == "$expected" ]] || { printf 'Assertion failed\nSQL: %s\nExpected: %s\nActual: %s\n' "$query" "$expected" "$actual" >&2; exit 1; }
}
assert_sql "SELECT cs.code||'|'||c.current_step||'|'||c.pending_question_key FROM conversations c JOIN conversation_statuses cs ON cs.id=c.conversation_status_id WHERE c.id=1" "waiting_user|city|commune"
assert_sql "SELECT cs.code||'|'||COALESCE(c.current_step,'null')||'|'||COALESCE(c.pending_question_key,'null')||'|'||(c.closed_at IS NOT NULL) FROM conversations c JOIN conversation_statuses cs ON cs.id=c.conversation_status_id WHERE c.id=2" "inactive_timeout|null|null|true"
assert_sql "SELECT cs.code||'|'||c.current_step||'|'||COALESCE(c.pending_question_key,'null') FROM conversations c JOIN conversation_statuses cs ON cs.id=c.conversation_status_id WHERE c.id=3" "handed_to_sales|complete|null"
assert_sql "SELECT cs.code||'|'||c.current_step||'|'||COALESCE(c.pending_question_key,'null') FROM conversations c JOIN conversation_statuses cs ON cs.id=c.conversation_status_id WHERE c.id=4" "escalation_required|escalation|null"
assert_sql "SELECT cs.code||'|'||COALESCE(c.current_step,'null')||'|'||(c.closed_at IS NOT NULL) FROM conversations c JOIN conversation_statuses cs ON cs.id=c.conversation_status_id WHERE c.id=5" "closed|null|true"
assert_sql "SELECT cs.code FROM conversations c JOIN conversation_statuses cs ON cs.id=c.conversation_status_id WHERE c.id=6" "closed"
assert_sql "SELECT cs.code||'|'||c.current_step FROM conversations c JOIN conversation_statuses cs ON cs.id=c.conversation_status_id WHERE c.id=7" "waiting_user|city"
assert_sql "SELECT cs.code||'|'||c.current_step FROM conversations c JOIN conversation_statuses cs ON cs.id=c.conversation_status_id WHERE c.id=8" "waiting_user|requirement"
assert_sql "SELECT count(*) FROM conversations c JOIN conversation_statuses cs ON cs.id=c.conversation_status_id WHERE c.source_number_id IS NULL AND c.phone_number='56910000007' AND cs.code IN ('active','waiting_user')" "2"
assert_sql "SELECT count(*) FROM audit_logs WHERE actor_id='migration_008'" "5"

before="$(docker exec "$POSTGRES_CONTAINER" psql -U postgres -d "$TEST_DB" -Atqc "SELECT count(*) FROM audit_logs WHERE actor_id='migration_008'")"
docker exec -i "$POSTGRES_CONTAINER" psql -U postgres -d "$TEST_DB" -v ON_ERROR_STOP=1 < infra/postgres/migrations/008_repair_legacy_conversation_state.sql >/dev/null
after="$(docker exec "$POSTGRES_CONTAINER" psql -U postgres -d "$TEST_DB" -Atqc "SELECT count(*) FROM audit_logs WHERE actor_id='migration_008'")"
[[ "$before" == "$after" ]] || { echo "Migration 008 is not idempotent: $before -> $after" >&2; exit 1; }

echo "Historical repair local tests OK: timeout, terminal invariants, duplicate partitioning, audit, idempotency"
