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
# The advisor only quotes what the official catalogue carries. This scenario
# also protects the factory-pickup rule: a private material pickup needs a
# quantity, but never a client commune or project address.
TEST_MESSAGE="Quiero cotizar 100 unidades de pastelones, solo material, para retirar en fábrica"
CONFIRM_MESSAGE="Si, correcto"
E2E_WAIT_SECONDS=${E2E_WAIT_SECONDS:-240}
case "$E2E_WAIT_SECONDS" in *[!0-9]*|'') echo "ERROR: E2E_WAIT_SECONDS debe ser un entero positivo" >&2; exit 1 ;; esac
[ "$E2E_WAIT_SECONDS" -gt 0 ] || { echo "ERROR: E2E_WAIT_SECONDS debe ser mayor que cero" >&2; exit 1; }

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
        messageTimestamp: (now | floor),
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
confirm_state=""
while [ "$attempt" -lt "$E2E_WAIT_SECONDS" ]; do
  sleep 1
  confirm_state=$(docker compose --env-file "$ROOT_DIR/.env" exec -T postgres \
    psql -U "${POSTGRES_USER:-postgres}" -d "${APP_POSTGRES_DB:-crm_whatsapp_app}" -At \
    -c "SELECT CONCAT_WS('|', ie.processing_status, ie.processing_phase, COALESCE(c.current_step, ''), COALESCE(ad.validation_result, ''))
        FROM inbound_events ie
        LEFT JOIN messages m ON m.inbound_event_id = ie.id AND m.direction = 'incoming'
        LEFT JOIN conversations c ON c.id = m.conversation_id
        LEFT JOIN conversation_turn_executions turn ON turn.inbound_event_id = ie.id
        LEFT JOIN advisor_decisions ad ON ad.id = turn.advisor_decision_id
        WHERE ie.external_message_id = 'e2e-test-${timestamp}-complete'
        ORDER BY ie.id DESC LIMIT 1;" 2>/dev/null || echo "")

  old_ifs=$IFS; IFS='|'; set -- $confirm_state; IFS=$old_ifs
  if [ "${1:-}" = processed ] && [ "${2:-}" = completed ]; then
    if [ "${4:-}" = accepted ]; then
      case "${3:-}" in confirm*) confirm_ready=1 ;; esac
    fi
    break
  fi
  [ "${1:-}" != failed ] || break
  attempt=$((attempt + 1))
done

if [ $confirm_ready -eq 0 ]; then
  echo "ERROR: La conversacion no llego a una confirmacion v3 aceptada dentro de ${E2E_WAIT_SECONDS} segundos (status|phase|step|validation: $confirm_state)" >&2
  docker compose --env-file "$ROOT_DIR/.env" logs --tail=20 n8n >&2
  exit 1
fi

pickup_reply_valid=$(docker compose --env-file "$ROOT_DIR/.env" exec -T postgres \
  psql -U "${POSTGRES_USER:-postgres}" -d "${APP_POSTGRES_DB:-crm_whatsapp_app}" -At \
  -c "SELECT COUNT(*)
      FROM messages m
      JOIN inbound_events ie ON ie.id = m.inbound_event_id
      WHERE ie.external_message_id = 'e2e-test-${timestamp}-complete'
        AND m.direction = 'outgoing'
        AND m.text_body ILIKE '%Portezuelo 1502%'
        AND m.text_body ILIKE '%San Bernardo%'
        AND m.text_body NOT ILIKE '%qué comuna%'
        AND m.text_body NOT ILIKE '%indicarme%comuna%';" 2>/dev/null || echo "0")
[ "$pickup_reply_valid" -eq 1 ] || {
  echo "ERROR: La confirmacion de retiro no informó Portezuelo 1502, San Bernardo o volvió a pedir comuna" >&2
  exit 1
}

echo "Enviando confirmacion final..."
send_message "e2e-test-${timestamp}-confirm" "$CONFIRM_MESSAGE" /tmp/e2e-lead-confirm-response.json

echo "Esperando a que se cree el lead..."
attempt=0
lead_found=0
confirm_event_state=""
while [ "$attempt" -lt "$E2E_WAIT_SECONDS" ]; do
  sleep 1
  lead_count=$(docker compose --env-file "$ROOT_DIR/.env" exec -T postgres \
    psql -U "${POSTGRES_USER:-postgres}" -d "${APP_POSTGRES_DB:-crm_whatsapp_app}" -At \
    -c "SELECT COUNT(*) FROM leads WHERE phone_number = '${PHONE_NUMBER}';" 2>/dev/null || echo "0")

  if [ "$lead_count" -gt "$before_leads" ]; then
    lead_found=1
    break
  fi
  confirm_event_state=$(docker compose --env-file "$ROOT_DIR/.env" exec -T postgres \
    psql -U "${POSTGRES_USER:-postgres}" -d "${APP_POSTGRES_DB:-crm_whatsapp_app}" -At \
    -c "SELECT CONCAT_WS('|', processing_status, processing_phase) FROM inbound_events WHERE external_message_id = 'e2e-test-${timestamp}-confirm' ORDER BY id DESC LIMIT 1;" 2>/dev/null || echo "")
  case "$confirm_event_state" in processed\|completed|failed\|*) break ;; esac
  attempt=$((attempt + 1))
done

if [ $lead_found -eq 0 ]; then
  echo "ERROR: No se encontró el lead dentro de ${E2E_WAIT_SECONDS} segundos (confirm status|phase: $confirm_event_state)" >&2
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
lead_id=$(printf '%s\n' "$lead_fields" | cut -d '|' -f 1)
servicio=$(printf '%s\n' "$lead_fields" | cut -d '|' -f 2)
ciudad=$(printf '%s\n' "$lead_fields" | cut -d '|' -f 3)
requerimiento=$(printf '%s\n' "$lead_fields" | cut -d '|' -f 4)
estado=$(printf '%s\n' "$lead_fields" | cut -d '|' -f 5)
created_at=$(printf '%s\n' "$lead_fields" | cut -d '|' -f 6)

if [ "$servicio" != retiro ] || [ -n "$ciudad" ] || [ -z "$requerimiento" ]; then
  echo "ERROR: El lead de retiro no conservó la semántica esperada" >&2
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
pickup_context_valid=$(query_app "SELECT COUNT(*) FROM conversations
  WHERE id=${conversation_id}
    AND qualification_context->>'service_scope'='material'
    AND qualification_context->>'fulfillment'='pickup'
    AND NULLIF(qualification_context->>'commune','') IS NULL
    AND NULLIF(qualification_context->>'address','') IS NULL
    AND NULLIF(qualification_context->>'debris_removal','') IS NULL;")
[ "$pickup_context_valid" -eq 1 ] || {
  echo "ERROR: El contexto pickup contiene comuna, dirección de proyecto, retiro de escombros o modalidad incorrecta" >&2
  exit 1
}
attempt=0
acceptance=""
while [ "$attempt" -lt "$E2E_WAIT_SECONDS" ]; do
  acceptance=$(query_app "SELECT CONCAT_WS('|',
    COALESCE(l.assigned_seller_id::text,''), COALESCE(l.clickup_task_id,''),
    (SELECT COUNT(*) FROM advisor_decisions ad WHERE ad.conversation_id=c.id),
    (SELECT COUNT(*) FROM messages m
      WHERE m.conversation_id=c.id
        AND m.inbound_event_id=ie.id
        AND m.direction='outgoing'
        AND m.delivery_status='sent'
        AND m.idempotency_key IS NOT NULL),
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
if [ "$attempt" -eq "$E2E_WAIT_SECONDS" ]; then
  echo "ERROR: acceptance incompleta (assignment|clickup|ai|reply|status|phase): $acceptance" >&2
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
while [ "$attempt" -lt "$E2E_WAIT_SECONDS" ]; do
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
