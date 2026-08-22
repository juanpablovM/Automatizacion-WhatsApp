#!/bin/sh

set -eu

ROOT_DIR=$(CDPATH= cd -- "$(dirname "$0")/../.." && pwd)
PHONE_NUMBER=${1:-}
MODE=${2:-}

usage() {
  cat <<'EOF'
Usage: scripts/ops/reset-controlled-test-session.sh PHONE_NUMBER --apply

Archives active conversations for one controlled test number without deleting
their messages, leads, or audit trail. It refuses to run while that number has
received or processing inbound events. The next inbound starts a fresh
conversation through the normal terminal-conversation path.
EOF
}

case "$PHONE_NUMBER" in
  *[!0-9]*|'') usage >&2; exit 1 ;;
esac

[ "$MODE" = "--apply" ] || { usage >&2; exit 1; }
[ -f "$ROOT_DIR/.env" ] || { echo "ERROR: missing .env" >&2; exit 1; }

. "$ROOT_DIR/.env"
APP_DATABASE=${APP_POSTGRES_DB:-crm_whatsapp_app}

queued_count=$(docker compose --env-file "$ROOT_DIR/.env" exec -T postgres \
  psql -At -U "${POSTGRES_USER:-postgres}" -d "$APP_DATABASE" \
  -c "SELECT COUNT(*) FROM inbound_events WHERE phone_number = '$PHONE_NUMBER' AND processing_status IN ('received', 'processing');")

[ "$queued_count" = "0" ] || {
  echo "ERROR: controlled test session has $queued_count queued/processing inbound event(s)" >&2
  exit 1
}

docker compose --env-file "$ROOT_DIR/.env" exec -T postgres \
  psql -v ON_ERROR_STOP=1 -U "${POSTGRES_USER:-postgres}" -d "$APP_DATABASE" <<SQL
BEGIN;

WITH closed_status AS (
  SELECT id FROM conversation_statuses WHERE code = 'closed'
), archived AS (
  UPDATE conversations AS conversation
  SET conversation_status_id = closed_status.id,
      closed_at = COALESCE(conversation.closed_at, NOW()),
      updated_at = NOW()
  FROM closed_status
  WHERE conversation.phone_number = '$PHONE_NUMBER'
    AND conversation.deleted_at IS NULL
    AND conversation.conversation_status_id IN (
      SELECT id FROM conversation_statuses
      WHERE code IN ('active', 'waiting_user', 'out_of_flow')
    )
  RETURNING conversation.id
)
INSERT INTO audit_logs (
  event_name, entity_type, entity_id, actor_type, actor_id, result,
  before_payload, after_payload, metadata
)
SELECT
  'controlled_test_session_archived',
  'conversation',
  archived.id,
  'system',
  'reset-controlled-test-session',
  'closed',
  '{}'::jsonb,
  jsonb_build_object('conversation_status_code', 'closed'),
  jsonb_build_object('reason', 'controlled_test_session_reset')
FROM archived;

COMMIT;
SQL
