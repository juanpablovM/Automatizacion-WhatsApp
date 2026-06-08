#!/bin/sh
set -eu

ROOT_DIR=$(CDPATH= cd -- "$(dirname "$0")/../.." && pwd)
cd "$ROOT_DIR"

. "$ROOT_DIR/.env"

INSTANCE_NAME="${1:-${EVOLUTION_DEFAULT_INSTANCE:-principal}}"
INSTANCE_TOKEN="${2:-${EVOLUTION_DEFAULT_INSTANCE_TOKEN:-}}"
WEBHOOK_URL="${EVOLUTION_WEBHOOK_URL:?falta EVOLUTION_WEBHOOK_URL en .env}"

if [ -n "${EVOLUTION_WEBHOOK_SECRET:-}" ]; then
  case "$WEBHOOK_URL" in
    *"token="*|*"secret="*) ;;
    *"?"*) WEBHOOK_URL="${WEBHOOK_URL}&token=${EVOLUTION_WEBHOOK_SECRET}" ;;
    *) WEBHOOK_URL="${WEBHOOK_URL}?token=${EVOLUTION_WEBHOOK_SECRET}" ;;
  esac
fi

payload=$(jq -nc \
  --arg instance_name "$INSTANCE_NAME" \
  --arg instance_token "$INSTANCE_TOKEN" \
  --arg webhook_url "$WEBHOOK_URL" \
  --arg webhook_event "${EVOLUTION_WEBHOOK_EVENTS:-MESSAGES_UPSERT}" \
  '{
    instanceName: $instance_name,
    qrcode: true,
    integration: "WHATSAPP-BAILEYS",
    webhook: {
      url: $webhook_url,
      byEvents: false,
      base64: true,
      events: ($webhook_event | split(","))
    }
  } + (if $instance_token != "" then { token: $instance_token } else {} end)')

curl -sS \
  -X POST \
  -H "Content-Type: application/json" \
  -H "apikey: ${EVOLUTION_API_KEY}" \
  "${EVOLUTION_SERVER_URL}/instance/create" \
  -d "$payload"
