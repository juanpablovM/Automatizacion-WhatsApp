#!/bin/sh

set -eu

ROOT_DIR=$(CDPATH= cd -- "$(dirname "$0")/../.." && pwd)
COMPOSE_FILE="$ROOT_DIR/docker-compose.test.yml"
COMPOSE_PROJECT_NAME="${E2E_COMPOSE_PROJECT_NAME:-whatsapp-reengagement-e2e}"
EVIDENCE_DIR="${TEST_EVIDENCE_DIR:-$ROOT_DIR/tests/evidence/reengagement-n8n}"

export TEST_POSTGRES_PORT="${TEST_POSTGRES_PORT:-55433}"
export TEST_PGPORT="${TEST_PGPORT:-$TEST_POSTGRES_PORT}"
export TEST_N8N_PORT="${TEST_N8N_PORT:-5679}"
export TEST_MOCK_EVOLUTION_PORT="${TEST_MOCK_EVOLUTION_PORT:-58080}"

compose() {
  docker compose --env-file /dev/null -p "$COMPOSE_PROJECT_NAME" -f "$COMPOSE_FILE" "$@"
}

fail() {
  echo "ERROR: $*" >&2
  exit 1
}

require() {
  command -v "$1" >/dev/null 2>&1 || fail "missing dependency: $1"
}

for command in curl docker jq npm; do
  require "$command"
done

mkdir -p "$EVIDENCE_DIR"
for stale_evidence in compose.log compose-ps.txt first-response.json replay-response.json result.txt; do
  [ ! -e "$EVIDENCE_DIR/$stale_evidence" ] || unlink "$EVIDENCE_DIR/$stale_evidence"
done
tmp_dir=$(mktemp -d)

cleanup() {
  status=$?
  trap - EXIT HUP INT TERM
  if [ "$status" -ne 0 ]; then
    compose logs --no-color > "$EVIDENCE_DIR/compose.log" 2>&1 || true
    compose ps --all > "$EVIDENCE_DIR/compose-ps.txt" 2>&1 || true
    echo "Failure evidence: $EVIDENCE_DIR" >&2
  fi
  compose down -v --remove-orphans >/dev/null 2>&1 || true
  exit "$status"
}
trap cleanup EXIT HUP INT TERM

cd "$ROOT_DIR"

compose up -d --wait postgres mock-evolution
npm run db:reset:test
compose up -d --wait n8n

cat > "$tmp_dir/postgres-credential.json" <<'JSON'
[
  {
    "id": "4f0b597f-5081-48fc-9226-1cd8db06ca38",
    "name": "Postgres CRM App Local",
    "type": "postgres",
    "data": {
      "host": "postgres",
      "database": "testdb",
      "user": "test",
      "password": "test",
      "port": 5432,
      "ssl": "disable"
    }
  }
]
JSON

compose cp "$tmp_dir/postgres-credential.json" n8n:/tmp/postgres-credential.json >/dev/null
compose exec -T -u node n8n n8n import:credentials --input=/tmp/postgres-credential.json >/dev/null

# Reuse the production import transformation while keeping every Docker and
# database operation inside this isolated Compose project.
SYNC_N8N_SOURCE_ONLY=yes . "$ROOT_DIR/scripts/dev/sync-n8n-workflows.sh"
PROJECT_ROOT="$ROOT_DIR"
WORKFLOW_DIR="$ROOT_DIR/n8n/workflows"
LINK_MANIFEST="$ROOT_DIR/n8n/workflow-links.json"
compose_cmd() {
  compose "$@"
}

query_workflow_ids > "$tmp_dir/before.ids"
write_ids_json "$tmp_dir/before.ids" "$tmp_dir/before.json"
prepare_import_dir "$tmp_dir/before.json" "$tmp_dir/bootstrap" bootstrap
copy_and_import "$tmp_dir/bootstrap" "test bootstrap"
query_workflow_ids > "$tmp_dir/after.ids"
write_ids_json "$tmp_dir/after.ids" "$tmp_dir/after.json"
ensure_all_workflows_have_ids "$tmp_dir/after.json"
prepare_import_dir "$tmp_dir/after.json" "$tmp_dir/resolved" yes
copy_and_import "$tmp_dir/resolved" "test resolved links"

entry_id=$(jq -r '.["WA - Inbound Entry"] // empty' "$tmp_dir/after.json")
[ -n "$entry_id" ] || fail "WA - Inbound Entry did not receive a runtime ID"
compose exec -T -u node n8n n8n update:workflow --id="$entry_id" --active=true >/dev/null
compose restart n8n >/dev/null
compose up -d --wait n8n

seed_row=$(compose exec -T postgres psql -v ON_ERROR_STOP=1 -U test -d testdb -At -F '|' <<'SQL'
WITH source AS (
  INSERT INTO whatsapp_numbers (
    display_name, phone_number, phone_number_id, instance_name
  ) VALUES (
    'Synthetic E2E', '15550009999', 'synthetic-source-e2e', 'test-instance'
  )
  RETURNING id
), conversation AS (
  INSERT INTO conversations (
    source_number_id, phone_number, conversation_status_id, current_step,
    qualification_context, last_message_at
  )
  SELECT
    source.id,
    '15550001111',
    status.id,
    'requirement',
    '{"service":"baldosas","city":"Santiago","requirement":"patio"}'::jsonb,
    NOW() - INTERVAL '72 hours'
  FROM source
  JOIN conversation_statuses status ON status.code = 'waiting_user'
  RETURNING id, source_number_id
), old_inbound AS (
  INSERT INTO inbound_events (
    instance_name, event_fingerprint, dedupe_key, source_number_id,
    phone_number, should_process, processing_status, processing_phase,
    processed_at, created_at
  )
  SELECT
    'test-instance', 'synthetic-old-fingerprint', 'synthetic-old-dedupe',
    source_number_id, '15550001111', TRUE, 'processed', 'completed',
    NOW() - INTERVAL '72 hours', NOW() - INTERVAL '72 hours'
  FROM conversation
), old_follow_up AS (
  INSERT INTO follow_ups (
    idempotency_key, conversation_id, phone_number, source_number_id,
    motivo, step_dia, scheduled_at, estado, cycle_key
  )
  SELECT
    'synthetic-old-followup', id, '15550001111', source_number_id,
    'no_response', 1, NOW() + INTERVAL '1 day', 'pending',
    'synthetic-old-cycle'
  FROM conversation
)
SELECT source_number_id, id FROM conversation;
SQL
)
source_number_id=${seed_row%%|*}
conversation_id=${seed_row#*|}
[ -n "$source_number_id" ] && [ -n "$conversation_id" ] || fail "synthetic seed failed"

webhook_path=""
attempt=0
while [ "$attempt" -lt 30 ]; do
  webhook_path=$(compose exec -T postgres psql -U test -d testdb -At -c \
    "SELECT \"webhookPath\" FROM webhook_entity WHERE \"workflowId\"='$entry_id' AND method='POST' AND node='EvolutionWebhook' LIMIT 1;")
  [ -n "$webhook_path" ] && break
  attempt=$((attempt + 1))
  sleep 1
done
[ -n "$webhook_path" ] || fail "Entry POST webhook was not activated"

payload=$(jq -nc '{
  event: "messages.upsert",
  instance: "test-instance",
  data: {
    key: {
      remoteJid: "15550001111@s.whatsapp.net",
      fromMe: false,
      id: "synthetic-reengagement-001"
    },
    messageTimestamp: "1787349600",
    pushName: "Synthetic Contact",
    message: { conversation: "Hola" }
  }
}')

post_event() {
  output_file="$1"
  status=$(curl -sS -o "$output_file" -w '%{http_code}' \
    -X POST \
    -H 'Content-Type: application/json' \
    -H 'x-evolution-webhook-secret: test-secret' \
    "http://127.0.0.1:${TEST_N8N_PORT}/webhook/$webhook_path" \
    -d "$payload")
  [ "$status" = 200 ] || fail "Entry webhook returned HTTP $status"
}

post_event "$EVIDENCE_DIR/first-response.json"
jq -e '.status == "accepted" and .duplicate == false' \
  "$EVIDENCE_DIR/first-response.json" >/dev/null || fail "first webhook response was not a new accepted event"

processing_status=""
attempt=0
while [ "$attempt" -lt 30 ]; do
  processing_status=$(compose exec -T postgres psql -U test -d testdb -At -c \
    "SELECT processing_status FROM inbound_events WHERE external_message_id='synthetic-reengagement-001';")
  [ "$processing_status" = processed ] && break
  [ "$processing_status" = failed ] && break
  attempt=$((attempt + 1))
  sleep 1
done
[ "$processing_status" = processed ] || fail "inbound event finished as ${processing_status:-missing}"

assertions=$(compose exec -T postgres psql -v ON_ERROR_STOP=1 -U test -d testdb -At -F '|' -c "
SELECT
  (SELECT COUNT(*) FROM conversations WHERE phone_number='15550001111'),
  (SELECT current_step FROM conversations WHERE id=$conversation_id),
  (SELECT COUNT(*) FROM messages WHERE conversation_id=$conversation_id),
  (SELECT COUNT(*) FROM messages WHERE conversation_id=$conversation_id AND direction='outgoing' AND delivery_status='sent' AND text_body='¡Hola de nuevo! ¿Preferís continuar con la solicitud anterior o iniciar una nueva?'),
  (SELECT COUNT(*) FROM follow_ups WHERE conversation_id=$conversation_id AND cycle_key='synthetic-old-cycle' AND estado='cancelled'),
  (SELECT COUNT(*) FROM follow_ups WHERE conversation_id=$conversation_id AND cycle_key='inbound:event:2' AND estado='pending'),
  (SELECT COUNT(*) FROM audit_logs WHERE entity_type='conversation' AND entity_id=$conversation_id AND event_name='follow_up_inbound_policy'),
  (SELECT COUNT(*) FROM inbound_events WHERE external_message_id='synthetic-reengagement-001' AND processing_status='processed' AND processing_phase='completed');")
[ "$assertions" = "1|previous_context|2|1|1|1|1|1" ] || fail "unexpected runtime state: $assertions"

provider_count=$(curl -fsS "http://127.0.0.1:${TEST_MOCK_EVOLUTION_PORT}/requests" | jq -r '.count')
[ "$provider_count" = 1 ] || fail "mock Evolution received $provider_count requests after the first event"

before_replay=$(compose exec -T postgres psql -U test -d testdb -At -F '|' -c "
SELECT
  (SELECT COUNT(*) FROM messages WHERE conversation_id=$conversation_id),
  (SELECT COUNT(*) FROM follow_ups WHERE conversation_id=$conversation_id),
  (SELECT COUNT(*) FROM audit_logs WHERE entity_type='conversation' AND entity_id=$conversation_id AND event_name='follow_up_inbound_policy');")
before_replay="$before_replay|$provider_count"

post_event "$EVIDENCE_DIR/replay-response.json"
jq -e '.status == "accepted" and .duplicate == true' \
  "$EVIDENCE_DIR/replay-response.json" >/dev/null || fail "replay was not reported as duplicate"

after_replay=$(compose exec -T postgres psql -U test -d testdb -At -F '|' -c "
SELECT
  (SELECT COUNT(*) FROM messages WHERE conversation_id=$conversation_id),
  (SELECT COUNT(*) FROM follow_ups WHERE conversation_id=$conversation_id),
  (SELECT COUNT(*) FROM audit_logs WHERE entity_type='conversation' AND entity_id=$conversation_id AND event_name='follow_up_inbound_policy');")
provider_count=$(curl -fsS "http://127.0.0.1:${TEST_MOCK_EVOLUTION_PORT}/requests" | jq -r '.count')
after_replay="$after_replay|$provider_count"
[ "$after_replay" = "$before_replay" ] || fail "replay changed durable effects: before=$before_replay after=$after_replay"

cat > "$EVIDENCE_DIR/result.txt" <<EOF
conversation_id=$conversation_id
source_number_id=$source_number_id
first_state=$assertions
replay_counts=$after_replay
EOF

echo "n8n re-engagement E2E OK: webhook -> PostgreSQL -> dispatcher -> mock Evolution + duplicate replay"
