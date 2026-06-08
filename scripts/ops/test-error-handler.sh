#!/bin/sh
set -eu

ROOT_DIR=$(CDPATH= cd -- "$(dirname "$0")/../.." && pwd)
cd "$ROOT_DIR"

usage() {
  cat <<'EOF'
Uso:
  sh scripts/ops/test-error-handler.sh [telefono-sin-plus]

Envia un evento sintetico autorizado al webhook local de WA - Inbound Entry
con una bandera interna de prueba para forzar un fallo controlado y verificar
que OPS - Error Handler registre audit_logs.event_name='workflow_execution_error'.

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
webhook_path=$(docker compose --env-file "$ROOT_DIR/.env" exec -T postgres \
  psql -U "${POSTGRES_USER:-postgres}" -d "${POSTGRES_DB:-crm_whatsapp}" -At \
  -c "SELECT \"webhookPath\" FROM webhook_entity WHERE \"workflowId\" = (SELECT id FROM workflow_entity WHERE name = 'WA - Inbound Entry' LIMIT 1) AND method = 'POST' AND node = 'EvolutionWebhook' LIMIT 1;")

if [ -z "$webhook_path" ]; then
  echo "ERROR: no se encontro webhook POST activo para 'WA - Inbound Entry'. Ejecuta scripts/dev/sync-n8n-workflows.sh" >&2
  exit 1
fi

WEBHOOK_URL="http://127.0.0.1:${N8N_PORT:-5678}/webhook/${webhook_path}"
case "$WEBHOOK_URL" in
  *"token="*|*"secret="*) ;;
  *"?"*) WEBHOOK_URL="${WEBHOOK_URL}&token=${EVOLUTION_WEBHOOK_SECRET}" ;;
  *) WEBHOOK_URL="${WEBHOOK_URL}?token=${EVOLUTION_WEBHOOK_SECRET}" ;;
esac

before=$(docker compose --env-file "$ROOT_DIR/.env" exec -T postgres \
  psql -U "${POSTGRES_USER:-postgres}" -d "${APP_POSTGRES_DB:-crm_whatsapp_app}" -At \
  -c "SELECT count(*) FROM audit_logs WHERE event_name='workflow_execution_error';")

payload=$(jq -nc \
  --arg phone "${PHONE_NUMBER}@s.whatsapp.net" \
  --arg message_id "ops-error-handler-smoke-$(date +%s)" \
  --arg instance_name "${EVOLUTION_DEFAULT_INSTANCE:-principal}" \
  --arg now "$(date +%s)" \
  '{
    event: "messages.upsert",
    instance: $instance_name,
    data: {
      key: {
        remoteJid: $phone,
        fromMe: false,
        id: $message_id
      },
      messageTimestamp: ($now | tonumber),
      message: {
        conversation: "Prueba controlada de OPS Error Handler"
      }
    },
    __force_error_handler_test: true
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
