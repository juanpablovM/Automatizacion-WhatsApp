#!/bin/sh
set -eu

ROOT_DIR=$(CDPATH= cd -- "$(dirname "$0")/../.." && pwd)
cd "$ROOT_DIR"

. "$ROOT_DIR/.env"

timestamp=$(date +%s)
phone_number="${1:-56988${timestamp#????}}"
webhook_path=$(docker compose --env-file "$ROOT_DIR/.env" exec -T postgres \
  psql -U "${POSTGRES_USER:-postgres}" -d "${POSTGRES_DB:-crm_whatsapp}" -At \
  -c "SELECT \"webhookPath\" FROM webhook_entity WHERE \"workflowId\" = (SELECT id FROM workflow_entity WHERE name = 'WA - Inbound Entry' LIMIT 1) AND method = 'POST' LIMIT 1;")

if [ -z "$webhook_path" ]; then
  echo "ERROR: no existe webhook activo para WA - Inbound Entry" >&2
  exit 1
fi

webhook_url="http://127.0.0.1:${N8N_PORT:-5678}/webhook/${webhook_path}?token=${EVOLUTION_WEBHOOK_SECRET}"

send_message() {
  sequence="$1"
  message="$2"
  payload=$(jq -nc \
    --arg phone "${phone_number}@s.whatsapp.net" \
    --arg message_id "advisor-vitacura-${timestamp}-${sequence}" \
    --arg message_text "$message" \
    --arg instance_name "${EVOLUTION_DEFAULT_INSTANCE:-principal}" \
    '{
      event: "messages.upsert",
      instance: $instance_name,
      data: {
        key: { remoteJid: $phone, fromMe: false, id: $message_id },
        messageTimestamp: (now | tostring),
        message: { conversation: $message_text }
      }
    }')

  status=$(curl -sS -o "/tmp/advisor-vitacura-${sequence}.json" -w '%{http_code}' \
    -X POST -H "Content-Type: application/json" "$webhook_url" -d "$payload")
  if [ "$status" -ne 200 ]; then
    echo "ERROR: webhook respondio HTTP $status" >&2
    exit 1
  fi
  sleep 5
}

latest_conversation_id() {
  docker compose --env-file "$ROOT_DIR/.env" exec -T postgres \
    psql -U "${POSTGRES_USER:-postgres}" -d "${APP_POSTGRES_DB:-crm_whatsapp_app}" -At \
    -c "SELECT id FROM conversations WHERE phone_number='${phone_number}' ORDER BY started_at DESC LIMIT 1;"
}

latest_reply() {
  conversation_id="$1"
  docker compose --env-file "$ROOT_DIR/.env" exec -T postgres \
    psql -U "${POSTGRES_USER:-postgres}" -d "${APP_POSTGRES_DB:-crm_whatsapp_app}" -At \
    -c "SELECT text_body FROM messages WHERE conversation_id=${conversation_id} AND direction='outgoing' ORDER BY created_at DESC,id DESC LIMIT 1;"
}

send_message 1 "Quiero cotizar un cierro de placas de hormigón reforzado de 150 metros en Vitacura"
conversation_id=$(latest_conversation_id)
reply=$(latest_reply "$conversation_id")
question_count=$(printf '%s' "$reply" | tr -cd '?' | wc -c | tr -d ' ')
if [ "$question_count" -gt 1 ]; then
  echo "ERROR: el asesor hizo mas de una pregunta principal: $reply" >&2
  exit 1
fi

send_message 2 "El terreno es plano"
send_message 3 "Sí"
send_message 4 "No"

context_before_confirmation=$(docker compose --env-file "$ROOT_DIR/.env" exec -T postgres \
  psql -U "${POSTGRES_USER:-postgres}" -d "${APP_POSTGRES_DB:-crm_whatsapp_app}" -At \
  -c "SELECT CONCAT_WS('|',
    qualification_context->>'measurements',
    qualification_context->>'terrain',
    qualification_context->>'truck_access',
    qualification_context->>'debris_removal',
    COALESCE(pending_question_key,'')
  ) FROM conversations WHERE id=${conversation_id};")

if [ "$context_before_confirmation" != "150 metros|El terreno es plano|true|false|final_confirmation" ]; then
  echo "ERROR: contexto comercial incompleto antes de confirmar: $context_before_confirmation" >&2
  exit 1
fi

send_message 5 "Sí, correcto"

attempt=0
lead_data=""
while [ $attempt -lt 10 ]; do
  lead_data=$(docker compose --env-file "$ROOT_DIR/.env" exec -T postgres \
    psql -U "${POSTGRES_USER:-postgres}" -d "${APP_POSTGRES_DB:-crm_whatsapp_app}" -At -F '|' \
    -c "SELECT l.id,COALESCE(l.assigned_seller_id::text,''),COALESCE(l.clickup_task_id,''),l.qualification_context::text FROM leads l JOIN conversations c ON c.lead_id=l.id WHERE c.id=${conversation_id} ORDER BY l.id DESC LIMIT 1;")
  [ -n "$lead_data" ] && break
  sleep 1
  attempt=$((attempt + 1))
done

if [ -z "$lead_data" ]; then
  echo "ERROR: no se creo lead para el caso Vitacura" >&2
  exit 1
fi

attempt=0
final_reply=$(latest_reply "$conversation_id")
while [ $attempt -lt 10 ]; do
  case "$final_reply" in
    *"ya registré tu solicitud"*) break ;;
  esac
  sleep 1
  final_reply=$(latest_reply "$conversation_id")
  attempt=$((attempt + 1))
done
case "$final_reply" in
  *"ya registré tu solicitud"*) ;;
  *)
    echo "ERROR: no se envio confirmacion verificada de handoff: $final_reply" >&2
    exit 1
    ;;
esac

attempt=0
clickup_task_id=""
while [ $attempt -lt 15 ]; do
  clickup_task_id=$(docker compose --env-file "$ROOT_DIR/.env" exec -T postgres \
    psql -U "${POSTGRES_USER:-postgres}" -d "${APP_POSTGRES_DB:-crm_whatsapp_app}" -At \
    -c "SELECT COALESCE(l.clickup_task_id,'') FROM leads l JOIN conversations c ON c.lead_id=l.id WHERE c.id=${conversation_id} LIMIT 1;")
  [ -n "$clickup_task_id" ] && break
  sleep 1
  attempt=$((attempt + 1))
done

if [ -z "$clickup_task_id" ]; then
  echo "ERROR: el lead se creo pero no se sincronizo con ClickUp" >&2
  exit 1
fi

echo "Advisor Vitacura E2E OK: conversation_id=${conversation_id} clickup_task_id=${clickup_task_id} lead=${lead_data}"
