#!/bin/sh
set -eu

# =============================================================================
# crm-backfill-1-3.sh - one-time CRM 1.3 backfill (feature U8, S9/S11)
# -----------------------------------------------------------------------------
# Starts, previews or monitors the historical backfill of every WhatsApp
# customer to the CRM under the dispatcher's current id prefix (migration 059).
# The script never sends anything: --apply only records the run
# (crm_backfill_start), and the crm-events-dispatcher workflow enqueues and
# delivers the history with its normal outbox (claim, deliver, complete, HMAC,
# 503 retries). Runbook: docs/crm-integration/README.md, "1.3 backfill".
#
# Usage:
#   scripts/ops/crm-backfill-1-3.sh [--dry-run] [--sample N] [--cutoff ISO]
#   scripts/ops/crm-backfill-1-3.sh --apply
#   scripts/ops/crm-backfill-1-3.sh --status
#
# Modes:
#   --dry-run (default)  counts per event type and a per-contact sample;
#                        writes nothing.
#   --apply              starts the backfill for the current prefix (one
#                        transaction; idempotent: a second run answers
#                        already_started and changes nothing). Refused when the
#                        prefix already has crm_events rows.
#   --status             monitoring counts (contacts, events, parked, blocks).
#
# Configuration: the dispatcher's own variables, read from the running n8n
# container (docker exec "$N8N_CONTAINER" printenv NAME), or from this shell
# with --config-from-env:
#   CRM_EVENTS_PROTOCOL_REVISION  must be 1.3 (anything else is refused)
#   CRM_EVENTS_ID_PREFIX          the delivery epoch ([a-z0-9]{1,16})
#   CRM_EVENTS_PHONE_ALLOWLIST    optional; only these phones are in scope
#   LEAD_TEST_PHONE_NUMBERS       test phones: never backfilled
#   CRM_EVENTS_HANDOFFS_ENABLED   handoffs are part of the backfill only when true
#
# Environment:
#   POSTGRES_CONTAINER  default ${PROJECT_NAME:-crm-whatsapp-automatizado}-postgres
#   N8N_CONTAINER       default ${PROJECT_NAME:-crm-whatsapp-automatizado}-n8n
#   PG_CONN             database (default crm_whatsapp_app)
#   PG_USER             database user (default postgres)
#
# Pacing: the dispatcher runs once per minute. Each pass the backfill stage
# takes up to CRM_EVENTS_BATCH_SIZE contacts (default 20) and up to
# CRM_EVENTS_MESSAGE_BATCH_SIZE historical messages (default 100); delivery
# sends up to CRM_EVENTS_DELIVER_BATCH_SIZE events (default 100 under 1.3)
# within CRM_EVENTS_DELIVER_BUDGET_SECONDS (default 450). A contact advances
# one step per pass once its previous events are delivered or parked, so
# roughly 100 events per minute: about 4,700 messages take about an hour.
# =============================================================================

ROOT_DIR=$(CDPATH='' cd -- "$(dirname "$0")/../.." && pwd)
SQL_DIR="$ROOT_DIR/db/queries/ops/crm-backfill-1-3"

MODE="dry-run"
SAMPLE=10
CUTOFF=""
CONFIG_FROM="container"

usage() {
  sed -n '7,48p' "$0" | sed 's/^# \{0,1\}//'
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --dry-run) MODE="dry-run"; shift ;;
    --apply) MODE="apply"; shift ;;
    --status) MODE="status"; shift ;;
    --sample) [ "$#" -ge 2 ] || { echo "ERROR: --sample needs a value" >&2; exit 1; }; SAMPLE="$2"; shift 2 ;;
    --cutoff) [ "$#" -ge 2 ] || { echo "ERROR: --cutoff needs a value" >&2; exit 1; }; CUTOFF="$2"; shift 2 ;;
    --config-from-env) CONFIG_FROM="env"; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "ERROR: unknown argument: $1" >&2; usage >&2; exit 1 ;;
  esac
done

case "$SAMPLE" in
  ''|*[!0-9]*) echo "ERROR: --sample must be a non-negative integer" >&2; exit 1 ;;
esac
if [ -n "$CUTOFF" ] && [ "$MODE" != "dry-run" ]; then
  echo "ERROR: --cutoff is only for --dry-run (--apply uses the current time)" >&2
  exit 1
fi
case "$CUTOFF" in
  ''|[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]*) ;;
  *) echo "ERROR: --cutoff must be an ISO timestamp (YYYY-MM-DD...)" >&2; exit 1 ;;
esac

POSTGRES_CONTAINER="${POSTGRES_CONTAINER:-${PROJECT_NAME:-crm-whatsapp-automatizado}-postgres}"
N8N_CONTAINER="${N8N_CONTAINER:-${PROJECT_NAME:-crm-whatsapp-automatizado}-n8n}"
PGDB="${PG_CONN:-crm_whatsapp_app}"
PGUSER_NAME="${PG_USER:-postgres}"

# Reads one dispatcher variable; empty when unset.
config_value() {
  if [ "$CONFIG_FROM" = "env" ]; then
    printenv "$1" || true
  else
    docker exec "$N8N_CONTAINER" printenv "$1" 2>/dev/null || true
  fi
}

if [ "$CONFIG_FROM" = "container" ] && ! docker exec "$N8N_CONTAINER" true >/dev/null 2>&1; then
  echo "ERROR: n8n container '$N8N_CONTAINER' is not running (or use --config-from-env)" >&2
  exit 1
fi

REVISION=$(config_value CRM_EVENTS_PROTOCOL_REVISION | tr -d '[:space:]')
ID_PREFIX=$(config_value CRM_EVENTS_ID_PREFIX | tr -d '[:space:]')
# Digits and commas only, the dispatcher's normalization.
ALLOWLIST=$(config_value CRM_EVENTS_PHONE_ALLOWLIST | tr -d ' +')
TEST_PHONES=$(config_value LEAD_TEST_PHONE_NUMBERS | tr -cd '0-9,')
HANDOFFS=$(config_value CRM_EVENTS_HANDOFFS_ENABLED | tr -d '[:space:]')

if [ "$REVISION" != "1.3" ]; then
  echo "ERROR: CRM_EVENTS_PROTOCOL_REVISION is '${REVISION:-unset}'; the backfill runs only under 1.3" >&2
  exit 1
fi
if ! printf '%s' "$ID_PREFIX" | grep -Eq '^[a-z0-9]{1,16}$'; then
  echo "ERROR: CRM_EVENTS_ID_PREFIX is '${ID_PREFIX:-unset}'; expected [a-z0-9]{1,16}" >&2
  exit 1
fi
if [ -n "$ALLOWLIST" ] && ! printf '%s' "$ALLOWLIST" | grep -Eq '^[0-9]{8,15}(,[0-9]{8,15})*$'; then
  echo "ERROR: CRM_EVENTS_PHONE_ALLOWLIST is invalid (comma-separated 8-15 digit phones)" >&2
  exit 1
fi
[ "$HANDOFFS" = "true" ] || HANDOFFS="false"

if ! docker exec "$POSTGRES_CONTAINER" psql -X -U "$PGUSER_NAME" -d "$PGDB" -qAt -c "SELECT 1" >/dev/null 2>&1; then
  echo "ERROR: cannot reach database '$PGDB' in container '$POSTGRES_CONTAINER'" >&2
  exit 1
fi

# Runs one SQL file of $SQL_DIR with the scope as psql variables.
run_sql() {
  docker exec -i "$POSTGRES_CONTAINER" psql -X -q -U "$PGUSER_NAME" -d "$PGDB" \
    -v ON_ERROR_STOP=1 \
    -v id_prefix="$ID_PREFIX" \
    -v allowlist="$ALLOWLIST" \
    -v test_phones="$TEST_PHONES" \
    -v cutoff="$CUTOFF" \
    -v handoffs_enabled="$HANDOFFS" \
    -v sample_size="$SAMPLE" \
    < "$SQL_DIR/$1"
}

echo "CRM 1.3 backfill: prefix=$ID_PREFIX allowlist=${ALLOWLIST:-none} test_phones=$(printf '%s' "$TEST_PHONES" | tr ',' '\n' | grep -c . || true) handoffs=$HANDOFFS mode=$MODE"

case "$MODE" in
  dry-run)
    echo "Dry run (nothing is written). Cutoff: ${CUTOFF:-now}."
    run_sql plan.sql
    if [ "$SAMPLE" -gt 0 ]; then
      echo "Per contact sample (largest history first):"
      run_sql plan-sample.sql
    fi
    echo "Run with --apply to start the backfill for prefix $ID_PREFIX."
    ;;
  apply)
    run_sql start.sql
    run_sql status.sql
    ;;
  status)
    run_sql status.sql
    ;;
esac
