#!/bin/sh
set -eu

ROOT_DIR=$(CDPATH= cd -- "$(dirname "$0")/../.." && pwd)
cd "$ROOT_DIR"

if [ ! -f "$ROOT_DIR/.env" ]; then
  echo "ERROR: no existe .env en $ROOT_DIR" >&2
  exit 1
fi

. "$ROOT_DIR/.env"

INSTANCE_NAME="${1:-${EVOLUTION_DEFAULT_INSTANCE:-principal}}"
WEBHOOK_EVENTS="${EVOLUTION_WEBHOOK_EVENTS:-MESSAGES_UPSERT}"
WEBHOOK_URL="${EVOLUTION_WEBHOOK_URL:?falta EVOLUTION_WEBHOOK_URL en .env}"

if [ -n "${EVOLUTION_WEBHOOK_SECRET:-}" ]; then
  case "$WEBHOOK_URL" in
    *"token="*|*"secret="*) ;;
    *"?"*) WEBHOOK_URL="${WEBHOOK_URL}&token=${EVOLUTION_WEBHOOK_SECRET}" ;;
    *) WEBHOOK_URL="${WEBHOOK_URL}?token=${EVOLUTION_WEBHOOK_SECRET}" ;;
  esac
fi

payload=$(jq -nc \
  --arg webhook_url "$WEBHOOK_URL" \
  --arg webhook_event "$WEBHOOK_EVENTS" \
  '{
    webhook: {
      enabled: true,
      url: $webhook_url,
      byEvents: true,
      base64: true,
      events: ($webhook_event | split(",") | map(gsub("^\\s+|\\s+$"; "")) | map(select(length > 0)))
    }
  }')

response=$(curl -sS \
  -X POST \
  -H "Content-Type: application/json" \
  -H "apikey: ${EVOLUTION_API_KEY}" \
  "${EVOLUTION_SERVER_URL}/webhook/set/${INSTANCE_NAME}" \
  -d "$payload")

printf "%s" "$response" | jq '{
  id,
  enabled,
  events,
  webhookByEvents,
  webhookBase64,
  url: (.url | sub("(?<prefix>[?&]token=)[^&]+"; "\(.prefix)<redacted>") | sub("(?<prefix>[?&]secret=)[^&]+"; "\(.prefix)<redacted>")),
  updatedAt
}'
