#!/bin/sh
set -eu

ROOT_DIR=$(CDPATH= cd -- "$(dirname "$0")/../.." && pwd)
cd "$ROOT_DIR"

usage() {
  cat <<'EOF'
Uso:
  sh scripts/ops/test-e2e-lead-creation.sh [telefono-sin-plus]

Envía dos mensajes sintéticos al webhook local de WA - Inbound Entry:
uno con servicio, ciudad y requerimiento, y otro con confirmacion final.
Verifica que el lead se cree en la base de datos de CRM.

No usar durante pruebas comerciales reales: genera datos de prueba en la base de datos.
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
  echo "ERROR: EVOLUTION_WEBHOOK_SECRET no está configurado en .env" >&2
  exit 1
fi

timestamp=$(date +%s)
suffix=${timestamp#??}
# Numero de telefono de prueba (sin +). Por defecto usa uno nuevo para no
# heredar conversaciones o leads anteriores.
PHONE_NUMBER="${1:-569${suffix}}"
TEST_MESSAGE="Quiero cotizar hormigón armado en Santiago para una losa de 100 m2"
CONFIRM_MESSAGE="Si, correcto"

webhook_path=$(docker compose --env-file "$ROOT_DIR/.env" exec -T postgres \
  psql -U "${POSTGRES_USER:-postgres}" -d "${POSTGRES_DB:-crm_whatsapp}" -At \
  -c "SELECT \"webhookPath\" FROM webhook_entity WHERE \"workflowId\" = (SELECT id FROM workflow_entity WHERE name = 'WA - Inbound Entry' LIMIT 1) AND method = 'POST' AND node = 'EvolutionWebhook' LIMIT 1;")

if [ -z "$webhook_path" ]; then
  echo "ERROR: no se encontró webhook POST activo para 'WA - Inbound Entry'. Ejecuta scripts/dev/sync-n8n-workflows.sh" >&2
  exit 1
fi

WEBHOOK_URL="http://127.0.0.1:${N8N_PORT:-5678}/webhook/${webhook_path}"
case "$WEBHOOK_URL" in
  *"token="*|*"secret="*) ;;
  *"?"*) WEBHOOK_URL="${WEBHOOK_URL}&token=${EVOLUTION_WEBHOOK_SECRET}" ;;
  *) WEBHOOK_URL="${WEBHOOK_URL}?token=${EVOLUTION_WEBHOOK_SECRET}" ;;
esac

send_message() {
  message_id="$1"
  message_text="$2"
  response_file="$3"

  payload=$(jq -nc \
    --arg phone "${PHONE_NUMBER}@s.whatsapp.net" \
    --arg message_id "$message_id" \
    --arg message_text "$message_text" \
    --arg instance_name "${EVOLUTION_DEFAULT_INSTANCE:-principal}" \
    '{
      event: "messages.upsert",
      instance: $instance_name,
      data: {
        key: {
          remoteJid: $phone,
          fromMe: false,
          id: $message_id
        },
        messageTimestamp: (now | tostring),
        message: {
          conversation: $message_text
        }
      }
    }')

  http_status=$(curl -sS -o "$response_file" -w '%{http_code}' \
    -X POST \
    -H "Content-Type: application/json" \
    "$WEBHOOK_URL" \
    -d "$payload")

  if [ "$http_status" -ne 200 ]; then
    echo "ERROR: El webhook no respondio con 200 para '$message_text'" >&2
    printf "http_status=%s\n" "$http_status" >&2
    cat "$response_file" >&2
    exit 1
  fi
}

before_leads=$(docker compose --env-file "$ROOT_DIR/.env" exec -T postgres \
  psql -U "${POSTGRES_USER:-postgres}" -d "${APP_POSTGRES_DB:-crm_whatsapp_app}" -At \
  -c "SELECT COUNT(*) FROM leads WHERE phone_number = '${PHONE_NUMBER}';" 2>/dev/null || echo "0")

echo "Enviando mensaje completo al webhook..."
send_message "e2e-test-${timestamp}-complete" "$TEST_MESSAGE" /tmp/e2e-lead-complete-response.json

echo "Esperando estado de confirmacion..."
attempt=0
confirm_ready=0
while [ $attempt -lt 30 ]; do
  sleep 1
  confirm_count=$(docker compose --env-file "$ROOT_DIR/.env" exec -T postgres \
    psql -U "${POSTGRES_USER:-postgres}" -d "${APP_POSTGRES_DB:-crm_whatsapp_app}" -At \
    -c "SELECT COUNT(*) FROM conversations WHERE phone_number = '${PHONE_NUMBER}' AND current_step LIKE 'confirm%';" 2>/dev/null || echo "0")

  if [ "$confirm_count" -gt 0 ]; then
    confirm_ready=1
    break
  fi
  attempt=$((attempt + 1))
done

if [ $confirm_ready -eq 0 ]; then
  echo "ERROR: La conversacion no llego a confirmacion despues de 30 segundos" >&2
  docker compose --env-file "$ROOT_DIR/.env" logs --tail=20 n8n >&2
  exit 1
fi

echo "Enviando confirmacion final..."
send_message "e2e-test-${timestamp}-confirm" "$CONFIRM_MESSAGE" /tmp/e2e-lead-confirm-response.json

echo "Esperando a que se cree el lead..."
attempt=0
lead_found=0
while [ $attempt -lt 30 ]; do
  sleep 1
  lead_count=$(docker compose --env-file "$ROOT_DIR/.env" exec -T postgres \
    psql -U "${POSTGRES_USER:-postgres}" -d "${APP_POSTGRES_DB:-crm_whatsapp_app}" -At \
    -c "SELECT COUNT(*) FROM leads WHERE phone_number = '${PHONE_NUMBER}';" 2>/dev/null || echo "0")

  if [ "$lead_count" -gt "$before_leads" ]; then
    lead_found=1
    break
  fi
  attempt=$((attempt + 1))
done

if [ $lead_found -eq 0 ]; then
  echo "ERROR: No se encontró el lead en la base de datos después de 30 segundos" >&2
  echo "Últimos logs de n8n para depuración:" >&2
  docker compose --env-file "$ROOT_DIR/.env" logs --tail=20 n8n >&2
  exit 1
fi

echo "Lead encontrado en la base de datos. Verificando detalles..."

# Obtener el lead insertado para verificar los campos
lead_data=$(docker compose --env-file "$ROOT_DIR/.env" exec -T postgres \
  psql -U "${POSTGRES_USER:-postgres}" -d "${APP_POSTGRES_DB:-crm_whatsapp_app}" -At \
  -c "SELECT l.id, l.service, l.city, l.requirement, ls.code, l.created_at FROM leads l JOIN lead_statuses ls ON ls.id = l.lead_status_id WHERE l.phone_number = '${PHONE_NUMBER}' ORDER BY l.created_at DESC LIMIT 1;" 2>/dev/null)

if [ -z "$lead_data" ]; then
  echo "ERROR: No se pudo recuperar los datos del lead" >&2
  exit 1
fi

echo "Datos del lead:"
echo "$lead_data"

# Verificar que los campos esperados estén presentes (con valores no vacíos)
# Dividimos la línea por el separador '|' (por defecto de psql -At)
lead_fields=$(printf '%s\n' "$lead_data" | sed -n '1p')
old_ifs=$IFS
IFS='|'
set -- $lead_fields
IFS=$old_ifs
lead_id=${1:-}
servicio=${2:-}
ciudad=${3:-}
requerimiento=${4:-}
estado=${5:-}
created_at=${6:-}

if [ -z "$servicio" ] || [ -z "$ciudad" ] || [ -z "$requerimiento" ]; then
  echo "ERROR: Algunos campos esenciales del lead están vacíos" >&2
  echo "servicio: '$servicio'"
  echo "ciudad: '$ciudad'"
  echo "requerimiento: '$requerimiento'"
  exit 1
fi

# Opcional: verificar que el estado sea algo como 'Calificado Completo' o 'Creado en ClickUp'
# Esto depende del flujo y de si ClickUp está configurado.
# Por ahora, solo verificamos que el lead exista y tenga los datos básicos.

echo "E2E test passed: Lead creado correctamente con servicio='$servicio', ciudad='$ciudad', requerimiento='$requerimiento'"

# Mostrar el registro de auditoría reciente para trazabilidad
docker compose --env-file "$ROOT_DIR/.env" exec -T postgres \
  psql -U "${POSTGRES_USER:-postgres}" -d "${APP_POSTGRES_DB:-crm_whatsapp_app}" -At \
  -c "SELECT id, event_name, metadata->>'workflow_name' AS workflow, metadata->>'last_node' AS last_node, created_at FROM audit_logs WHERE event_name LIKE '%lead%' OR event_name LIKE '%clickup%' ORDER BY id DESC LIMIT 3;" || true

exit 0
