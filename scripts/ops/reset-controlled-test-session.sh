#!/bin/sh

set -eu

ROOT_DIR=$(CDPATH= cd -- "$(dirname "$0")/../.." && pwd)
COMPOSE_FILE="$ROOT_DIR/docker-compose.yml"
COMPOSE_PROJECT=automatizacion-whatsapp
ENV_FILE="$ROOT_DIR/.env"
SQL_FILE="$ROOT_DIR/db/queries/ops/reset-controlled-test-session.sql"
PHONE_NUMBER=${1:-}
MODE=${2:-}

usage() {
  cat <<'EOF'
Usage: scripts/ops/reset-controlled-test-session.sh PHONE_NUMBER --apply

Archives active conversations for one controlled test number without deleting
their messages, leads, or audit trail. It refuses to run while that number has
received or processing inbound events. The next inbound starts a fresh
conversation through the normal terminal-conversation path. The PHONE_NUMBER
must exactly match CONTROLLED_TEST_PHONE_NUMBER from the repository .env file.
EOF
}

case "$PHONE_NUMBER" in
  *[!0-9]*|'') usage >&2; exit 1 ;;
esac

[ "$MODE" = "--apply" ] || { usage >&2; exit 1; }
[ -f "$ENV_FILE" ] || { echo "ERROR: missing .env" >&2; exit 1; }
[ -f "$COMPOSE_FILE" ] || { echo "ERROR: missing docker-compose.yml" >&2; exit 1; }
[ -f "$SQL_FILE" ] || { echo "ERROR: missing reset SQL" >&2; exit 1; }

. "$ENV_FILE"
APP_DATABASE=${APP_POSTGRES_DB:-crm_whatsapp_app}
CONTROLLED_PHONE_NUMBER=${CONTROLLED_TEST_PHONE_NUMBER:-}

case "$CONTROLLED_PHONE_NUMBER" in
  *[!0-9]*|'')
    echo "ERROR: CONTROLLED_TEST_PHONE_NUMBER must contain the authorized test phone number" >&2
    exit 1
    ;;
esac

[ "$PHONE_NUMBER" = "$CONTROLLED_PHONE_NUMBER" ] || {
  echo "ERROR: phone number is not authorized for controlled test resets" >&2
  exit 1
}

docker compose \
  --env-file "$ENV_FILE" \
  -f "$COMPOSE_FILE" \
  --project-directory "$ROOT_DIR" \
  -p "$COMPOSE_PROJECT" \
  exec -T postgres \
  psql -v ON_ERROR_STOP=1 -v "phone_number=$PHONE_NUMBER" \
    -U "${POSTGRES_USER:-postgres}" -d "$APP_DATABASE" < "$SQL_FILE"
