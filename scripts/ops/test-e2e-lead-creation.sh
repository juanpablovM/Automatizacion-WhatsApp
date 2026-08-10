#!/bin/sh
set -eu

ROOT_DIR=$(CDPATH= cd -- "$(dirname "$0")/../.." && pwd)
cd "$ROOT_DIR"

usage() {
  cat <<'EOF'
Uso:
  E2E_ALLOW_EXTERNAL_EFFECTS=yes sh scripts/ops/test-e2e-lead-creation.sh telefono-controlado-sin-plus

Ejecuta AI, lead, asignacion, ClickUp, handoff y replay idempotente.
Genera efectos externos reales; exige telefono controlado y opt-in explicito.

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

[ -n "${1:-}" ] || { usage >&2; exit 1; }
[ "${E2E_ALLOW_EXTERNAL_EFFECTS:-}" = yes ] || { echo "ERROR: falta E2E_ALLOW_EXTERNAL_EFFECTS=yes" >&2; exit 1; }
case "$1" in *[!0-9]*|'') echo "ERROR: telefono controlado invalido" >&2; exit 1 ;; esac

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
PHONE_NUMBER="$1"
TEST_MESSAGE="Quiero cotizar hormigón armado en Santiago para una losa de 100 m2"
CONFIRM_MESSAGE="Si, correcto"

[ -z "${E2E_WEBHOOK_PATH:-}" ] || case "$E2E_WEBHOOK_PATH" in
  *[!A-Za-z0-9._-]*) echo "ERROR: E2E_WEBHOOK_PATH contiene caracteres invalidos" >&2; exit 1 ;;
esac

webhook_path=""
webhook_attempt=0
while [ "$webhook_attempt" -lt 30 ]; do
  if [ -n "${E2E_WEBHOOK_PATH:-}" ]; then
    webhook_path=$(docker compose --env-file "$ROOT_DIR/.env" exec -T postgres \
      psql -U "${POSTGRES_USER:-postgres}" -d "${POSTGRES_DB:-crm_whatsapp}" -At \
      -c "SELECT \"webhookPath\" FROM webhook_entity WHERE \"workflowId\" = (SELECT id FROM workflow_entity WHERE name = 'WA - Inbound Entry' LIMIT 1) AND method = 'POST' AND node = 'EvolutionWebhook' AND \"webhookPath\" LIKE '%/${E2E_WEBHOOK_PATH}' LIMIT 1;")
  else
    webhook_path=$(docker compose --env-file "$ROOT_DIR/.env" exec -T postgres \
      psql -U "${POSTGRES_USER:-postgres}" -d "${POSTGRES_DB:-crm_whatsapp}" -At \
      -c "SELECT \"webhookPath\" FROM webhook_entity WHERE \"workflowId\" = (SELECT id FROM workflow_entity WHERE name = 'WA - Inbound Entry' LIMIT 1) AND method = 'POST' AND node = 'EvolutionWebhook' AND \"webhookPath\" NOT LIKE '%/acceptance-%' LIMIT 1;")
  fi
  [ -z "$webhook_path" ] || break
  webhook_attempt=$((webhook_attempt + 1))
  sleep 1
done
[ -z "${E2E_WEBHOOK_PATH:-}" ] || case "$webhook_path" in *"/${E2E_WEBHOOK_PATH}") ;; *) echo "ERROR: el webhook activo no es el temporal esperado" >&2; exit 1 ;; esac

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

  http_status=000
  webhook_attempt=0
  while [ "$webhook_attempt" -lt 10 ]; do
    http_status=$(curl -sS -o "$response_file" -w '%{http_code}' \
      -X POST -H "Content-Type: application/json" "$WEBHOOK_URL" -d "$payload")
    [ "$http_status" -ne 404 ] && break
    sleep 1
    webhook_attempt=$((webhook_attempt + 1))
  done

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

query_app() {
  docker compose --env-file "$ROOT_DIR/.env" exec -T postgres \
    psql -U "${POSTGRES_USER:-postgres}" -d "${APP_POSTGRES_DB:-crm_whatsapp_app}" -At -c "$1"
}

conversation_id=$(query_app "SELECT source_conversation_id FROM leads WHERE id=${lead_id};")
attempt=0
acceptance=""
while [ $attempt -lt 30 ]; do
  acceptance=$(query_app "SELECT CONCAT_WS('|',
    COALESCE(l.assigned_seller_id::text,''), COALESCE(l.clickup_task_id,''),
    (SELECT COUNT(*) FROM advisor_decisions ad WHERE ad.conversation_id=c.id),
    (SELECT COUNT(*) FROM messages m WHERE m.conversation_id=c.id AND m.direction='outgoing' AND m.text_body LIKE '%quedó asignada%'),
    COALESCE(ie.processing_status,''), COALESCE(ie.processing_phase,'')
  ) FROM conversations c JOIN leads l ON l.id=${lead_id}
    LEFT JOIN inbound_events ie ON ie.external_message_id='e2e-test-${timestamp}-confirm'
  WHERE c.id=${conversation_id} LIMIT 1;")
  old_ifs=$IFS; IFS='|'; set -- $acceptance; IFS=$old_ifs
  if [ -n "${1:-}" ] && [ -n "${2:-}" ] && [ "${3:-0}" -gt 0 ] && [ "${4:-0}" -eq 1 ] && [ "${5:-}" = processed ] && [ "${6:-}" = completed ]; then
    break
  fi
  sleep 1
  attempt=$((attempt + 1))
done
if [ $attempt -eq 30 ]; then
  echo "ERROR: acceptance incompleta (assignment|clickup|ai|handoff|status|phase): $acceptance" >&2
  exit 1
fi

effect_counts() {
  query_app "SELECT CONCAT_WS('|',
    (SELECT COUNT(*) FROM messages WHERE conversation_id=${conversation_id} AND direction='outgoing'),
    (SELECT COUNT(*) FROM leads WHERE source_conversation_id=${conversation_id}),
    (SELECT COUNT(*) FROM lead_assignments WHERE lead_id=${lead_id}),
    (SELECT COUNT(*) FROM external_operations WHERE entity_id=${lead_id}),
    (SELECT COALESCE(SUM(attempt_count),0) FROM external_operations WHERE entity_id=${lead_id}),
    (SELECT COUNT(*) FROM inbound_events WHERE external_message_id='e2e-test-${timestamp}-confirm')
  );"
}

before_replay=$(effect_counts)
echo "Reproduciendo el mismo evento para validar idempotencia..."
send_message "e2e-test-${timestamp}-confirm" "$CONFIRM_MESSAGE" /tmp/e2e-lead-replay-response.json
attempt=0; stable=0; after_replay=""
while [ "$attempt" -lt 30 ]; do
  sleep 1
  after_replay=$(effect_counts)
  terminal=$(query_app "SELECT COUNT(*) FROM inbound_events WHERE external_message_id='e2e-test-${timestamp}-confirm' AND processing_status='processed' AND processing_phase='completed';")
  if [ "$terminal" -eq 1 ] && [ "$after_replay" = "$before_replay" ]; then stable=$((stable + 1)); else stable=0; fi
  [ "$stable" -ge 3 ] && break
  attempt=$((attempt + 1))
done
[ "$stable" -ge 3 ] || { echo "ERROR: replay no alcanzo estado terminal estable: before=$before_replay after=$after_replay" >&2; exit 1; }

evidence_file=${E2E_EVIDENCE_FILE:-/tmp/e2e-lead-${timestamp}-evidence.json}
jq -nc --arg phone "$PHONE_NUMBER" --arg conversation_id "$conversation_id" --arg lead_id "$lead_id" \
  --arg acceptance "$acceptance" --arg effects "$after_replay" \
  '{phone:$phone,conversation_id:$conversation_id,lead_id:$lead_id,acceptance:$acceptance,effects_after_replay:$effects}' > "$evidence_file"

echo "E2E test passed: Lead creado correctamente con servicio='$servicio', ciudad='$ciudad', requerimiento='$requerimiento'"
echo "Acceptance/replay evidence: $evidence_file"

# Mostrar el registro de auditoría reciente para trazabilidad
docker compose --env-file "$ROOT_DIR/.env" exec -T postgres \
  psql -U "${POSTGRES_USER:-postgres}" -d "${APP_POSTGRES_DB:-crm_whatsapp_app}" -At \
  -c "SELECT id, event_name, metadata->>'workflow_name' AS workflow, metadata->>'last_node' AS last_node, created_at FROM audit_logs WHERE event_name LIKE '%lead%' OR event_name LIKE '%clickup%' ORDER BY id DESC LIMIT 3;" || true

exit 0
