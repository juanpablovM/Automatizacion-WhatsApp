#!/bin/sh
set -eu

ROOT_DIR=$(CDPATH= cd -- "$(dirname "$0")/../.." && pwd)
cd "$ROOT_DIR"

usage() {
  cat <<'EOF'
Uso:
  sh scripts/ops/test-error-handler.sh [telefono-sin-plus]

Envia un evento sintetico autorizado al webhook local de WA - Inbound Entry
con un timestamp invalido para forzar un fallo controlado y verificar que
OPS - Error Handler registre audit_logs.event_name='workflow_execution_error'.

No usar durante pruebas comerciales reales: genera auditoria operativa.
EOF
}

require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "ERROR: falta dependencia '$1'" >&2
    exit 1
  fi
}

case "${1:-}" in
  -h|--help)
    usage
    exit 0
    ;;
esac

if [ ! -f "$ROOT_DIR/.env" ]; then
  echo "ERROR: no existe .env en $ROOT_DIR" >&2
  exit 1
fi

require_cmd curl
require_cmd docker
require_cmd jq

. "$ROOT_DIR/.env"

if [ -z "${EVOLUTION_WEBHOOK_SECRET:-}" ]; then
  echo "ERROR: EVOLUTION_WEBHOOK_SECRET no esta configurado en .env" >&2
  exit 1
fi

PHONE_NUMBER="${1:-56999999099}"
WEBHOOK_URL="http://127.0.0.1:${N8N_PORT:-5678}/webhook/mXz1XhLO0cd9PME6/evolutionwebhook/wa-inbound-entry?token=${EVOLUTION_WEBHOOK_SECRET}"

before=$(docker compose --env-file "$ROOT_DIR/.env" exec -T postgres \
  psql -U "${POSTGRES_USER:-postgres}" -d "${APP_POSTGRES_DB:-crm_whatsapp_app}" -At \
  -c "SELECT count(*) FROM audit_logs WHERE event_name='workflow_execution_error';")

payload=$(jq -nc \
  --arg phone "${PHONE_NUMBER}@s.whatsapp.net" \
  --arg message_id "ops-error-handler-smoke-$(date +%s)" \
  '{
    event: "messages.upsert",
    instance: "principal",
    data: {
      key: {
        remoteJid: $phone,
        fromMe: false,
        id: $message_id
      },
      messageTimestamp: "not-a-valid-timestamp",
      message: {
        conversation: "Prueba controlada de OPS Error Handler"
      }
    }
  }')

http_status=$(curl -sS -o /tmp/ops-error-handler-response.json -w '%{http_code}' \
  -X POST \
  -H "Content-Type: application/json" \
  "$WEBHOOK_URL" \
  -d "$payload")

after="$before"
attempt=0
while [ "$attempt" -lt 30 ]; do
  sleep 1
  after=$(docker compose --env-file "$ROOT_DIR/.env" exec -T postgres \
    psql -U "${POSTGRES_USER:-postgres}" -d "${APP_POSTGRES_DB:-crm_whatsapp_app}" -At \
    -c "SELECT count(*) FROM audit_logs WHERE event_name='workflow_execution_error';")

  if [ "$after" -gt "$before" ]; then
    break
  fi

  attempt=$((attempt + 1))
done

if [ "$after" -le "$before" ]; then
  echo "ERROR: no se registro auditoria nueva de error" >&2
  echo "http_status=$http_status" >&2
  cat /tmp/ops-error-handler-response.json >&2
  exit 1
fi

echo "OPS Error Handler smoke OK"
printf "http_status=%s\n" "$http_status"
printf "audit_before=%s\n" "$before"
printf "audit_after=%s\n" "$after"

docker compose --env-file "$ROOT_DIR/.env" exec -T postgres \
  psql -U "${POSTGRES_USER:-postgres}" -d "${APP_POSTGRES_DB:-crm_whatsapp_app}" \
  -c "SELECT id, after_payload->>'message' AS message, metadata->>'workflow_name' AS workflow, metadata->>'last_node' AS last_node, created_at FROM audit_logs WHERE event_name='workflow_execution_error' ORDER BY id DESC LIMIT 2;"
