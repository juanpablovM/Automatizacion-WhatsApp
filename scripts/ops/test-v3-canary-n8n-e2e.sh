#!/bin/sh
# shellcheck disable=SC1091,SC2016,SC2034
set -eu

ROOT_DIR=$(CDPATH='' cd -- "$(dirname "$0")/../.." && pwd)
COMPOSE_FILE="$ROOT_DIR/docker-compose.test.yml"
COMPOSE_PROJECT_NAME=whatsapp-v3-canary-e2e
PRODUCTION_COMPOSE_PROJECT=automatizacion-whatsapp
EVIDENCE_DIR="${TEST_EVIDENCE_DIR:-${TMPDIR:-/tmp}/whatsapp-v3-canary-e2e-evidence}"

export POSTGRES_IMAGE=postgres:16.13-alpine
export N8N_IMAGE=docker.n8n.io/n8nio/n8n:1.123.29
export TEST_POSTGRES_DB=testdb
export TEST_POSTGRES_USER=test
export TEST_POSTGRES_PASSWORD=test
export TEST_PGHOST=127.0.0.1
export TEST_PGDATABASE=testdb
export TEST_PGUSER=test
export TEST_PGPASSWORD=test
export TEST_POSTGRES_PORT=55434
export TEST_PGPORT=55434
export TEST_N8N_PORT=55679
export TEST_MOCK_AI_PORT=58081
export TEST_MOCK_EVOLUTION_PORT=58082
export TEST_CLICKUP_WEBHOOK_SECRET=test-clickup-webhook-secret
export TEST_AI_PRD_CONTRACT_MODE=canary
export TEST_AI_LEAD_ASSISTANT_ENABLED=true
export TEST_AI_PROVIDER=mock
export TEST_AI_DIRECT_API_BASE_URL=http://mock-ai:8081
export TEST_AI_DIRECT_API_PATH=/chat/completions
export TEST_AI_DIRECT_API_KEY=test-ai-key
export TEST_AI_DIRECT_API_MODEL=test-ai-model
export TEST_AI_DIRECT_API_MAX_ATTEMPTS=1

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

snapshot_production_containers() {
  snapshot_path=$1
  : > "$snapshot_path"
  docker ps -aq --filter "label=com.docker.compose.project=$PRODUCTION_COMPOSE_PROJECT" \
    | sort \
    | while IFS= read -r container_id; do
        [ -z "$container_id" ] || docker inspect --format \
          '{{.Id}}|{{.Name}}|{{.Config.Image}}|{{.State.StartedAt}}|{{.State.Status}}|{{.RestartCount}}' \
          "$container_id"
      done >> "$snapshot_path"
}

capture_n8n_failure_evidence() {
  {
    compose exec -T postgres psql -U test -d testdb -At -F '	' <<'SQL'
SELECT
  execution.id,
  COALESCE(workflow.name, execution."workflowId"),
  execution.status,
  execution.mode,
  execution."startedAt",
  execution."stoppedAt"
FROM execution_entity execution
LEFT JOIN workflow_entity workflow ON workflow.id=execution."workflowId"
ORDER BY execution.id::BIGINT DESC
LIMIT 50;
SQL
  } > "$EVIDENCE_DIR/n8n-execution-summary.tsv" 2>&1 || true

  {
    compose exec -T postgres psql -U test -d testdb -At -F '	' <<'SQL'
SELECT
  data."executionId",
  data.data,
  data."workflowData"
FROM execution_data data
ORDER BY data."executionId"::BIGINT DESC
LIMIT 50;
SQL
  } > "$EVIDENCE_DIR/n8n-execution-data.tsv" 2>&1 || true

  # Every v3 commit is one statement whose WHERE clause spans four tables, and
  # the stack is destroyed on the way out. Without these rows a commit that
  # matched nothing is indistinguishable from one that never ran.
  {
    compose exec -T postgres psql -U test -d testdb -At <<'SQL'
WITH v3_ledger_evidence AS (
  SELECT jsonb_build_object(
    'conversation_turn_executions', (
      SELECT COALESCE(jsonb_agg(to_jsonb(row) ORDER BY row.id), '[]'::JSONB)
      FROM conversation_turn_executions row
    ),
    'advisor_decisions', (
      SELECT COALESCE(jsonb_agg(to_jsonb(row) ORDER BY row.id), '[]'::JSONB)
      FROM advisor_decisions row
    ),
    'inbound_events', (
      SELECT COALESCE(jsonb_agg(to_jsonb(row) ORDER BY row.id), '[]'::JSONB)
      FROM inbound_events row
    ),
    'handoffs', (
      SELECT COALESCE(jsonb_agg(to_jsonb(row) ORDER BY row.id), '[]'::JSONB)
      FROM handoffs row
    ),
    'messages', (
      SELECT COALESCE(jsonb_agg(to_jsonb(row) ORDER BY row.id), '[]'::JSONB)
      FROM messages row
    )
  ) AS value
)
SELECT jsonb_pretty(value) FROM v3_ledger_evidence;
SQL
  } > "$EVIDENCE_DIR/v3-ledger-state.json" 2>&1 || true
}

for command in cmp curl docker jq npm; do
  require "$command"
done

mkdir -p "$EVIDENCE_DIR"
find "$EVIDENCE_DIR" -mindepth 1 -maxdepth 1 -type f -delete
tmp_dir=$(mktemp -d)
snapshot_production_containers "$EVIDENCE_DIR/production-containers-before.txt"

cleanup() {
  status=$?
  trap - EXIT HUP INT TERM
  if [ "$status" -ne 0 ]; then
    capture_n8n_failure_evidence
    compose logs --no-color > "$EVIDENCE_DIR/compose.log" 2>&1 || true
    compose ps --all > "$EVIDENCE_DIR/compose-ps.txt" 2>&1 || true
  fi
  compose down -v --remove-orphans >/dev/null 2>&1 || true
  snapshot_production_containers "$EVIDENCE_DIR/production-containers-after.txt" || status=1
  if ! cmp -s "$EVIDENCE_DIR/production-containers-before.txt" "$EVIDENCE_DIR/production-containers-after.txt"; then
    diff -u "$EVIDENCE_DIR/production-containers-before.txt" \
      "$EVIDENCE_DIR/production-containers-after.txt" \
      > "$EVIDENCE_DIR/production-containers.diff" 2>&1 || true
    echo "ERROR: production container identity, StartedAt, State, or restart count changed" >&2
    status=1
  fi
  rm -rf "$tmp_dir"
  [ "$status" -eq 0 ] || echo "Failure evidence: $EVIDENCE_DIR" >&2
  exit "$status"
}
trap cleanup EXIT HUP INT TERM

cd "$ROOT_DIR"
compose up -d --wait postgres mock-ai mock-evolution
npm run db:reset:test
compose up -d --wait n8n

cat > "$tmp_dir/postgres-credential.json" <<'JSON'
[{
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
}]
JSON

compose cp "$tmp_dir/postgres-credential.json" n8n:/tmp/postgres-credential.json >/dev/null
compose exec -T -u node n8n n8n import:credentials --input=/tmp/postgres-credential.json >/dev/null

SYNC_N8N_SOURCE_ONLY=yes . "$ROOT_DIR/scripts/dev/sync-n8n-workflows.sh"
PROJECT_ROOT="$ROOT_DIR"
WORKFLOW_DIR="$ROOT_DIR/n8n/workflows"
LINK_MANIFEST="$ROOT_DIR/n8n/workflow-links.json"
compose_cmd() { compose "$@"; }

query_workflow_ids > "$tmp_dir/before.ids"
write_ids_json "$tmp_dir/before.ids" "$tmp_dir/before.json"
prepare_import_dir "$tmp_dir/before.json" "$tmp_dir/bootstrap" bootstrap
copy_and_import "$tmp_dir/bootstrap" "v3 canary bootstrap"
query_workflow_ids > "$tmp_dir/after.ids"
write_ids_json "$tmp_dir/after.ids" "$tmp_dir/after.json"
ensure_all_workflows_have_ids "$tmp_dir/after.json"
prepare_import_dir "$tmp_dir/after.json" "$tmp_dir/resolved" yes
copy_and_import "$tmp_dir/resolved" "v3 canary resolved links"

entry_id=$(jq -r '.["WA - Inbound Entry"] // empty' "$tmp_dir/after.json")
[ -n "$entry_id" ] || fail "WA - Inbound Entry did not receive a runtime ID"
compose exec -T -u node n8n n8n update:workflow --id="$entry_id" --active=true >/dev/null
compose restart n8n >/dev/null
compose up -d --wait n8n

compose exec -T n8n sh -eu -c '
  test "$AI_PRD_CONTRACT_MODE" = canary
  test "$AI_LEAD_ASSISTANT_ENABLED" = true
  test "$AI_PROVIDER" = mock
  test "$AI_DIRECT_API_BASE_URL" = http://mock-ai:8081
  test "$AI_DIRECT_API_PATH" = /chat/completions
  test "$AI_DIRECT_API_KEY" = test-ai-key
  test "$AI_DIRECT_API_MODEL" = test-ai-model
  test "$AI_DIRECT_API_MAX_ATTEMPTS" = 1
  test "$EVOLUTION_API_BASE_URL" = http://mock-evolution:8080
  test "$EVOLUTION_API_KEY" = test-key
  test -z "${CLICKUP_API_TOKEN:-}"
  test -z "${CLICKUP_LEADS_LIST_ID:-}"
' || fail "n8n provider preflight rejected non-local or non-synthetic configuration"

active_workflows=$(compose exec -T postgres psql -U test -d testdb -At -c \
  "SELECT COUNT(*) FROM workflow_entity WHERE active=TRUE AND id <> '$entry_id';")
[ "$active_workflows" = 0 ] || fail "only WA - Inbound Entry may be active"

# WU4_SEED_BEGIN
source_number_id=$(compose exec -T postgres psql -v ON_ERROR_STOP=1 -U test -d testdb -At <<'SQL'
WITH inserted_source AS (
  INSERT INTO whatsapp_numbers (
    display_name, phone_number, phone_number_id, instance_name
  ) VALUES (
    'Synthetic V3 Canary', '15550009999', 'synthetic-source-v3', 'test-instance'
  )
  RETURNING id
)
SELECT id FROM inserted_source;
SQL
)
compose exec -T postgres psql -v ON_ERROR_STOP=1 -U test -d testdb -At <<'SQL' >/dev/null
INSERT INTO catalog_items (sku, name, item_type, applicable_cities, is_active)
VALUES ('H25', 'hormigon H25', 'product', ARRAY['Santiago'], TRUE);
SQL
# WU4_SEED_END
[ -n "$source_number_id" ] || fail "synthetic source-number seed failed"

preexisting=$(compose exec -T postgres psql -v ON_ERROR_STOP=1 -U test -d testdb -At -c "
SELECT jsonb_build_object(
  'conversations', (SELECT COUNT(*) FROM conversations WHERE source_number_id=$source_number_id AND phone_number='15550001111'),
  'inbound_events', (SELECT COUNT(*) FROM inbound_events WHERE source_number_id=$source_number_id AND phone_number='15550001111'),
  'messages', (SELECT COUNT(*) FROM messages WHERE conversation_id IN (SELECT id FROM conversations WHERE source_number_id=$source_number_id AND phone_number='15550001111')),
  'executions', (SELECT COUNT(*) FROM conversation_turn_executions WHERE conversation_id IN (SELECT id FROM conversations WHERE source_number_id=$source_number_id AND phone_number='15550001111')),
  'handoffs', (SELECT COUNT(*) FROM handoffs WHERE source_number_id=$source_number_id AND phone_number='15550001111')
);")
echo "$preexisting" | jq -e 'to_entries | all(.value == 0)' >/dev/null \
  || fail "new-contact precondition was not empty: $preexisting"

webhook_path=
attempt=0
while [ "$attempt" -lt 45 ]; do
  webhook_path=$(compose exec -T postgres psql -U test -d testdb -At -c \
    "SELECT \"webhookPath\" FROM webhook_entity WHERE \"workflowId\"='$entry_id' AND method='POST' AND node='EvolutionWebhook' LIMIT 1;")
  [ -n "$webhook_path" ] && break
  attempt=$((attempt + 1))
  sleep 1
done
[ -n "$webhook_path" ] || fail "Entry POST webhook was not activated"

build_payload() {
  jq -nc --arg message_id "$1" --arg text "$2" --arg timestamp "$(date +%s)" '{
    event: "messages.upsert",
    instance: "test-instance",
    data: {
      key: {
        remoteJid: "15550001111@s.whatsapp.net",
        fromMe: false,
        id: $message_id
      },
      messageTimestamp: $timestamp,
      pushName: "Synthetic V3 Contact",
      message: { conversation: $text }
    }
  }'
}

turn_one_payload=$(build_payload synthetic-v3-canary-001 \
  'Hola, necesito baldosas para un patio en Santiago.')
turn_two_payload=$(build_payload synthetic-v3-canary-002 \
  'Gracias, quiero continuar con la solicitud.')
turn_three_payload=$(build_payload synthetic-v3-canary-003 \
  'Confirmo: 20 m3 de hormigon H25 para Santiago con despacho.')

post_event() {
  event_payload=$1
  output_file=$2
  n8n_execution_floor=$(compose exec -T postgres psql -U test -d testdb -At -c \
    'SELECT COALESCE(MAX(id::BIGINT), 0) FROM execution_entity;')
  case "$n8n_execution_floor" in
    ''|*[!0-9]*) fail "n8n execution floor was not numeric: $n8n_execution_floor" ;;
  esac
  status=$(curl -sS -o "$output_file" -w '%{http_code}' \
    -X POST \
    -H 'Content-Type: application/json' \
    -H 'x-evolution-webhook-secret: test-secret' \
    "http://127.0.0.1:${TEST_N8N_PORT}/webhook/$webhook_path" \
    -d "$event_payload")
  [ "$status" = 200 ] || fail "Entry webhook returned HTTP $status"
}

wait_for_delivered_turn() {
  external_message_id=$1
  status_file=$2
  attempt=0
  while [ "$attempt" -lt 90 ]; do
    n8n_error=$(compose exec -T postgres psql -U test -d testdb -At -F '|' \
      -c \
      "SELECT execution.id, COALESCE(workflow.name, execution.\"workflowId\"), execution.status
       FROM execution_entity execution
       LEFT JOIN workflow_entity workflow ON workflow.id=execution.\"workflowId\"
       WHERE execution.id::BIGINT > $n8n_execution_floor
         AND execution.status='error'
       ORDER BY execution.id::BIGINT DESC
       LIMIT 1;")
    [ -z "$n8n_error" ] || fail "n8n execution failed after $external_message_id: $n8n_error"
    compose exec -T postgres psql -v ON_ERROR_STOP=1 -v external_message_id="$external_message_id" \
      -U test -d testdb -At > "$status_file" <<'SQL'
SELECT jsonb_build_object(
  'processing_status', inbound.processing_status,
  'processing_phase', inbound.processing_phase,
  'failure_reason', inbound.failure_reason,
  'execution_state', execution.state,
  'last_error', execution.last_error
)
FROM inbound_events inbound
LEFT JOIN conversation_turn_executions execution ON execution.inbound_event_id=inbound.id
WHERE inbound.external_message_id=:'external_message_id';
SQL
    if jq -e '.processing_status == "processed" and .processing_phase == "completed" and .execution_state == "delivered"' "$status_file" >/dev/null 2>&1; then
      return 0
    fi
    if jq -e '.processing_status == "failed" or .execution_state == "aborted" or .execution_state == "reconciliation_required"' "$status_file" >/dev/null 2>&1; then
      fail "turn $external_message_id reached a terminal failure: $(cat "$status_file")"
    fi
    attempt=$((attempt + 1))
    sleep 1
  done
  fail "turn $external_message_id did not reach delivered: $(cat "$status_file" 2>/dev/null || echo missing)"
}

capture_turn_evidence() {
  external_message_id=$1
  output_file=$2
  compose exec -T postgres psql -v ON_ERROR_STOP=1 -v external_message_id="$external_message_id" \
    -U test -d testdb -At > "$output_file" <<'SQL'
WITH target AS MATERIALIZED (
  SELECT * FROM inbound_events WHERE external_message_id=:'external_message_id'
), execution AS MATERIALIZED (
  SELECT execution.*
  FROM conversation_turn_executions execution
  JOIN target ON target.id=execution.inbound_event_id
), decision AS MATERIALIZED (
  SELECT decision.*
  FROM advisor_decisions decision
  JOIN execution ON execution.advisor_decision_id=decision.id
), outgoing AS MATERIALIZED (
  SELECT outgoing.*
  FROM messages outgoing
  JOIN execution ON execution.delivery_message_id=outgoing.id
), effect AS MATERIALIZED (
  SELECT receipt.value AS receipt
  FROM execution
  CROSS JOIN LATERAL jsonb_array_elements(execution.effect_receipt_refs) receipt(value)
  WHERE receipt.value->>'schema' = 'internal_handoff_receipt/v3'
), handoff AS MATERIALIZED (
  SELECT handoff.*
  FROM handoffs handoff
  JOIN effect ON effect.receipt->>'operation_key'=handoff.idempotency_key
  WHERE handoff.deleted_at IS NULL
)
SELECT jsonb_build_object(
  'external_message_id', target.external_message_id,
  'inbound_event_id', target.id,
  'inbound_status', target.processing_status,
  'inbound_phase', target.processing_phase,
  'conversation_id', execution.conversation_id,
  'execution_id', execution.id,
  'contract_version', execution.contract_version,
  'route_mode', execution.route_mode,
  'route_rule_id', execution.route_rule_id,
  'execution_state', execution.state,
  'decision_id', execution.decision_id,
  'decision_type', decision.decision_type,
  'decision_version', decision.output_payload->>'version',
  'decision_validation_result', decision.validation_result,
  'decision_reply_text', decision.output_payload#>>'{reply,text}',
  'decision_reply_sha256', decision.output_payload#>>'{reply,sha256}',
  'decision_delivery_key', decision.output_payload#>>'{reply,delivery_key}',
  'delivery_key', execution.delivery_key,
  'delivery_message_id', execution.delivery_message_id,
  'delivery_receipt_ref', execution.delivery_receipt_ref,
  'outgoing_id', outgoing.id,
  'outgoing_inbound_event_id', outgoing.inbound_event_id,
  'outgoing_idempotency_key', outgoing.idempotency_key,
  'outgoing_delivery_status', outgoing.delivery_status,
  'outgoing_dispatch_phase', outgoing.dispatch_phase,
  'outgoing_external_message_id', outgoing.external_message_id,
  'outgoing_text', outgoing.text_body,
  'incoming_count', (SELECT COUNT(*) FROM messages incoming WHERE incoming.inbound_event_id=target.id AND incoming.direction='incoming' AND incoming.deleted_at IS NULL),
  'outgoing_count', (SELECT COUNT(*) FROM messages message WHERE message.inbound_event_id=target.id AND message.direction='outgoing' AND message.deleted_at IS NULL),
  'effect_receipt_count', jsonb_array_length(execution.effect_receipt_refs),
  'effect_receipt', effect.receipt,
  'handoff_id', handoff.id,
  'handoff_operation_key', handoff.idempotency_key,
  'handoff_metadata_decision_id', handoff.metadata->>'decision_id',
  'handoff_count', (SELECT COUNT(*) FROM handoffs item WHERE item.inbound_event_id=target.id AND item.deleted_at IS NULL),
  'contingency_commit_audit_count', (SELECT COUNT(*) FROM audit_logs audit WHERE audit.entity_type='conversation_turn_execution' AND audit.entity_id=execution.id AND audit.event_name='v3_contingency_committed'),
  'delivery_transition_audit_count', (SELECT COUNT(*) FROM audit_logs audit WHERE audit.entity_type='conversation_turn_execution' AND audit.entity_id=execution.id AND audit.event_name='v3_delivery_recorded' AND audit.metadata->>'to_state'='delivered'),
  'legacy_outgoing_count', (SELECT COUNT(*) FROM messages legacy WHERE legacy.conversation_id=execution.conversation_id AND legacy.direction='outgoing' AND legacy.idempotency_key LIKE 'evolution:%' AND legacy.deleted_at IS NULL)
)
FROM target
JOIN execution ON TRUE
JOIN decision ON TRUE
JOIN outgoing ON TRUE
JOIN effect ON TRUE
JOIN handoff ON TRUE
WHERE execution.contract_version = 'v3'
  AND execution.route_mode = 'canary'
  AND execution.route_rule_id = 'rollout:canary'
  AND execution.state = 'delivered'
  AND decision.decision_type = 'v3_system_contingency'
  AND decision.output_payload->>'version' = 'system_contingency_decision/v3'
  AND execution.delivery_message_id = outgoing.id
  AND outgoing.idempotency_key = execution.delivery_key
  AND execution.delivery_receipt_ref->>'provider_message_id' = outgoing.external_message_id
  AND execution.delivery_receipt_ref->>'delivered_bytes_sha256' = decision.output_payload#>>'{reply,sha256}'
  AND effect.receipt->>'schema' = 'internal_handoff_receipt/v3'
  AND effect.receipt->>'status' = 'succeeded'
  AND (effect.receipt->>'handoff_id')::BIGINT = handoff.id;
SQL
}

assert_turn_evidence() {
  evidence_file=$1
  jq -e '
    .inbound_status == "processed"
    and .inbound_phase == "completed"
    and .contract_version == "v3"
    and .route_mode == "canary"
    and .route_rule_id == "rollout:canary"
    and .execution_state == "delivered"
    and (.decision_id | startswith("v3-contingency:"))
    and .decision_type == "v3_system_contingency"
    and .decision_version == "system_contingency_decision/v3"
    and .decision_validation_result == "fallback"
    and .decision_delivery_key == .delivery_key
    and .delivery_message_id == .outgoing_id
    and .outgoing_inbound_event_id == .inbound_event_id
    and .outgoing_idempotency_key == .delivery_key
    and (.outgoing_idempotency_key | startswith("v3-delivery:"))
    and .outgoing_delivery_status == "sent"
    and .outgoing_dispatch_phase == "sent"
    and (.outgoing_external_message_id | startswith("synthetic-message-id-"))
    and .outgoing_text == .decision_reply_text
    and .delivery_receipt_ref.provider_message_id == .outgoing_external_message_id
    and .delivery_receipt_ref.delivered_bytes_sha256 == .decision_reply_sha256
    and .incoming_count == 1
    and .outgoing_count == 1
    and .effect_receipt_count == 1
    and .effect_receipt.schema == "internal_handoff_receipt/v3"
    and .effect_receipt.status == "succeeded"
    and .effect_receipt.handoff_id == .handoff_id
    and .effect_receipt.operation_key == .handoff_operation_key
    and .handoff_metadata_decision_id == .decision_id
    and .handoff_count == 1
    and .contingency_commit_audit_count == 1
    and .delivery_transition_audit_count == 1
    and .legacy_outgoing_count == 0
  ' "$evidence_file" >/dev/null || fail "v3 turn evidence was incomplete: $(cat "$evidence_file")"
}

assert_mock_ai_turn() {
  turn_id=$1
  evidence_file=$2
  curl -fsS "http://127.0.0.1:${TEST_MOCK_AI_PORT}/requests" > "$evidence_file"
  jq -e --arg turn_id "$turn_id" '
    [.requests[] | select(.turn_id == $turn_id)] as $calls
    | ($calls | length) == 2
      and ($calls | map(.repair) == [false, true])
      and ($calls[0].policy_digest | test("^[a-f0-9]{64}$"))
      and $calls[1].policy_digest == $calls[0].policy_digest
      and $calls[0].repair_schema == null
      and $calls[1].repair_schema == "ai_conversation_repair_request/v3"
  ' "$evidence_file" >/dev/null || fail "AI mock did not prove initial to complete repair for turn $turn_id"
}

assert_mock_evolution_turn() {
  expected_count=$1
  provider_message_id=$2
  phone_number=$3
  text_body=$4
  evidence_file=$5
  curl -fsS "http://127.0.0.1:${TEST_MOCK_EVOLUTION_PORT}/requests" > "$evidence_file"
  jq -e --argjson expected_count "$expected_count" \
    --arg provider_message_id "$provider_message_id" \
    --arg phone_number "$phone_number" \
    --arg text_body "$text_body" '
      .count == $expected_count
      and ([.requests[] | select(
        .method == "POST"
        and .url == "/message/sendText/test-instance"
        and .response_id == $provider_message_id
        and .parsed_body.number == $phone_number
        and .parsed_body.text == $text_body
      )] | length) == 1
    ' "$evidence_file" >/dev/null || fail "Evolution mock did not match the durable outbound message"
}

capture_replay_snapshot() {
  output_file=$1
  compose exec -T postgres psql -v ON_ERROR_STOP=1 -U test -d testdb -At > "$output_file" <<'SQL'
WITH target_conversations AS MATERIALIZED (
  SELECT conversation.id
  FROM conversations conversation
  JOIN whatsapp_numbers source ON source.id=conversation.source_number_id
  WHERE source.phone_number_id='synthetic-source-v3'
    AND conversation.phone_number='15550001111'
), target_executions AS MATERIALIZED (
  SELECT execution.*
  FROM conversation_turn_executions execution
  WHERE execution.conversation_id IN (SELECT id FROM target_conversations)
)
SELECT jsonb_build_object(
  'conversations', COALESCE((SELECT jsonb_agg(jsonb_build_object('id', conversation.id, 'qualification_context', conversation.qualification_context) ORDER BY conversation.id) FROM conversations conversation JOIN target_conversations target ON target.id=conversation.id), '[]'::JSONB),
  'inbound_events', COALESCE((SELECT jsonb_agg(jsonb_build_object('id', inbound.id, 'external_message_id', inbound.external_message_id, 'processing_status', inbound.processing_status, 'processing_phase', inbound.processing_phase) ORDER BY inbound.id) FROM inbound_events inbound WHERE inbound.id IN (SELECT inbound_event_id FROM target_executions)), '[]'::JSONB),
  'executions', COALESCE((SELECT jsonb_agg(jsonb_build_object('id', execution.id, 'inbound_event_id', execution.inbound_event_id, 'advisor_decision_id', execution.advisor_decision_id, 'decision_id', execution.decision_id, 'state', execution.state, 'delivery_key', execution.delivery_key, 'delivery_message_id', execution.delivery_message_id, 'effect_receipt_refs', execution.effect_receipt_refs, 'delivery_receipt_ref', execution.delivery_receipt_ref) ORDER BY execution.id) FROM target_executions execution), '[]'::JSONB),
  'advisor_decisions', COALESCE((SELECT jsonb_agg(jsonb_build_object('id', decision.id, 'decision_type', decision.decision_type, 'output_payload', decision.output_payload, 'validation_result', decision.validation_result) ORDER BY decision.id) FROM advisor_decisions decision WHERE decision.conversation_id IN (SELECT id FROM target_conversations)), '[]'::JSONB),
  'messages', COALESCE((SELECT jsonb_agg(jsonb_build_object('id', message.id, 'inbound_event_id', message.inbound_event_id, 'direction', message.direction, 'delivery_status', message.delivery_status, 'external_message_id', message.external_message_id, 'idempotency_key', message.idempotency_key, 'text_body', message.text_body) ORDER BY message.id) FROM messages message WHERE message.conversation_id IN (SELECT id FROM target_conversations) AND message.deleted_at IS NULL), '[]'::JSONB),
  'handoffs', COALESCE((SELECT jsonb_agg(jsonb_build_object('id', handoff.id, 'inbound_event_id', handoff.inbound_event_id, 'idempotency_key', handoff.idempotency_key, 'estado', handoff.estado, 'metadata', handoff.metadata) ORDER BY handoff.id) FROM handoffs handoff WHERE handoff.conversation_id IN (SELECT id FROM target_conversations) AND handoff.deleted_at IS NULL), '[]'::JSONB)
);
SQL
}

capture_valid_turn_evidence() {
  external_message_id=$1
  output_file=$2
  compose exec -T postgres psql -v ON_ERROR_STOP=1 -v external_message_id="$external_message_id" \
    -U test -d testdb -At > "$output_file" <<'SQL'
WITH target AS MATERIALIZED (
  SELECT * FROM inbound_events WHERE external_message_id=:'external_message_id'
), execution AS MATERIALIZED (
  SELECT execution.* FROM conversation_turn_executions execution
  JOIN target ON target.id=execution.inbound_event_id
), decision AS MATERIALIZED (
  SELECT decision.* FROM advisor_decisions decision
  JOIN execution ON execution.advisor_decision_id=decision.id
), outgoing AS MATERIALIZED (
  SELECT outgoing.* FROM messages outgoing
  JOIN execution ON execution.delivery_message_id=outgoing.id
), effect_receipt AS (
  SELECT value FROM execution, jsonb_array_elements(execution.effect_receipt_refs) AS value LIMIT 1
)
SELECT jsonb_pretty(jsonb_build_object(
  'inbound_status', target.processing_status,
  'inbound_phase', target.processing_phase,
  'contract_version', execution.contract_version,
  'execution_state', execution.state,
  'decision_id', execution.decision_id,
  'decision_type', decision.decision_type,
  'decision_version', decision.output_payload->>'version',
  'decision_validation_result', decision.validation_result,
  'decision_reply_text', decision.output_payload#>>'{reply,text}',
  'state_receipt_schema', execution.state_receipt->>'schema',
  'effect_receipt_version', (SELECT value->>'version' FROM effect_receipt),
  'effect_receipt_status', (SELECT value->>'status' FROM effect_receipt),
  'effect_receipt_count', jsonb_array_length(execution.effect_receipt_refs),
  'outgoing_text', outgoing.text_body,
  'outgoing_delivery_status', outgoing.delivery_status,
  'delivery_receipt_status', execution.delivery_receipt_ref->>'delivery_status',
  'leads_for_conversation', (
    SELECT COUNT(*) FROM leads lead
    JOIN conversations conversation ON conversation.lead_id=lead.id
    WHERE conversation.id=execution.conversation_id AND lead.deleted_at IS NULL
  ),
  'authorized_effects', jsonb_array_length(COALESCE(decision.output_payload->'effect_commands', '[]'::jsonb))
))
FROM target, execution, decision, outgoing;
SQL
}

assert_valid_turn_evidence() {
  evidence_file=$1
  jq -e '
    .inbound_status == "processed"
    and .inbound_phase == "completed"
    and .contract_version == "v3"
    and .execution_state == "delivered"
    and .decision_type == "conversation_v3_authorized"
    and .decision_version == "validated_conversation_decision/v3"
    and (.decision_id | startswith("v3-contingency:") | not)
    and .state_receipt_schema == "conversation_state_receipt/v3"
    and .effect_receipt_version == "v3_effect_receipt/v1"
    and .effect_receipt_status == "succeeded"
    and .effect_receipt_count == 1
    and .authorized_effects == 1
    and .leads_for_conversation == 1
    and .outgoing_text == .decision_reply_text
    and .outgoing_delivery_status == "sent"
    and .delivery_receipt_status == "sent"
  ' "$evidence_file" >/dev/null || fail "v3 valid-lane evidence was incomplete: $(cat "$evidence_file")"
}

capture_totals() {
  output_file=$1
  compose exec -T postgres psql -v ON_ERROR_STOP=1 -U test -d testdb -At > "$output_file" <<'SQL'
WITH target_conversations AS MATERIALIZED (
  SELECT conversation.id
  FROM conversations conversation
  JOIN whatsapp_numbers source ON source.id=conversation.source_number_id
  WHERE source.phone_number_id='synthetic-source-v3'
    AND conversation.phone_number='15550001111'
), target_executions AS MATERIALIZED (
  SELECT execution.* FROM conversation_turn_executions execution
  WHERE execution.conversation_id IN (SELECT id FROM target_conversations)
), target_messages AS MATERIALIZED (
  SELECT message.* FROM messages message
  WHERE message.conversation_id IN (SELECT id FROM target_conversations)
    AND message.deleted_at IS NULL
)
SELECT jsonb_build_object(
  'conversations', (SELECT COUNT(*) FROM target_conversations),
  'leads', (SELECT COUNT(DISTINCT conversation.lead_id) FROM conversations conversation JOIN target_conversations target ON target.id=conversation.id WHERE conversation.lead_id IS NOT NULL),
  'inbound_events', (SELECT COUNT(*) FROM inbound_events inbound WHERE inbound.id IN (SELECT inbound_event_id FROM target_executions)),
  'executions', (SELECT COUNT(*) FROM target_executions),
  'delivered_executions', (SELECT COUNT(*) FROM target_executions execution WHERE execution.state='delivered'),
  'distinct_decision_ids', (SELECT COUNT(DISTINCT execution.decision_id) FROM target_executions execution),
  'distinct_delivery_keys', (SELECT COUNT(DISTINCT execution.delivery_key) FROM target_executions execution),
  'distinct_delivery_message_ids', (SELECT COUNT(DISTINCT execution.delivery_message_id) FROM target_executions execution),
  'delivery_receipts', (SELECT COUNT(*) FROM target_executions execution WHERE execution.delivery_receipt_ref IS NOT NULL),
  'advisor_decisions', (SELECT COUNT(*) FROM advisor_decisions decision WHERE decision.conversation_id IN (SELECT id FROM target_conversations)),
  'incoming_messages', (SELECT COUNT(*) FROM target_messages message WHERE message.direction='incoming'),
  'outgoing_messages', (SELECT COUNT(*) FROM target_messages message WHERE message.direction='outgoing'),
  'distinct_provider_message_ids', (SELECT COUNT(DISTINCT message.external_message_id) FROM target_messages message WHERE message.direction='outgoing'),
  'legacy_outgoing_messages', (SELECT COUNT(*) FROM target_messages message WHERE message.direction='outgoing' AND message.idempotency_key LIKE 'evolution:%'),
  'handoffs', (SELECT COUNT(*) FROM handoffs handoff WHERE handoff.conversation_id IN (SELECT id FROM target_conversations) AND handoff.deleted_at IS NULL)
);
SQL
}

post_event "$turn_one_payload" "$EVIDENCE_DIR/turn-1-response.json"
jq -e '.status == "accepted" and .duplicate == false' "$EVIDENCE_DIR/turn-1-response.json" >/dev/null \
  || fail "turn one was not accepted as a new event"
wait_for_delivered_turn synthetic-v3-canary-001 "$EVIDENCE_DIR/turn-1-terminal.json"
capture_turn_evidence synthetic-v3-canary-001 "$EVIDENCE_DIR/turn-1-evidence.json"
assert_turn_evidence "$EVIDENCE_DIR/turn-1-evidence.json"
turn_one_id=$(jq -r '.inbound_event_id | tostring' "$EVIDENCE_DIR/turn-1-evidence.json")
turn_one_provider_id=$(jq -r '.outgoing_external_message_id' "$EVIDENCE_DIR/turn-1-evidence.json")
turn_one_text=$(jq -r '.outgoing_text' "$EVIDENCE_DIR/turn-1-evidence.json")
assert_mock_ai_turn "$turn_one_id" "$EVIDENCE_DIR/mock-ai-after-turn-1.json"
assert_mock_evolution_turn 1 "$turn_one_provider_id" 15550001111 "$turn_one_text" \
  "$EVIDENCE_DIR/mock-evolution-after-turn-1.json"

post_event "$turn_two_payload" "$EVIDENCE_DIR/turn-2-response.json"
jq -e '.status == "accepted" and .duplicate == false' "$EVIDENCE_DIR/turn-2-response.json" >/dev/null \
  || fail "turn two was not accepted as a new event"
wait_for_delivered_turn synthetic-v3-canary-002 "$EVIDENCE_DIR/turn-2-terminal.json"
capture_turn_evidence synthetic-v3-canary-002 "$EVIDENCE_DIR/turn-2-evidence.json"
assert_turn_evidence "$EVIDENCE_DIR/turn-2-evidence.json"
turn_two_id=$(jq -r '.inbound_event_id | tostring' "$EVIDENCE_DIR/turn-2-evidence.json")
turn_two_provider_id=$(jq -r '.outgoing_external_message_id' "$EVIDENCE_DIR/turn-2-evidence.json")
turn_two_text=$(jq -r '.outgoing_text' "$EVIDENCE_DIR/turn-2-evidence.json")
assert_mock_ai_turn "$turn_two_id" "$EVIDENCE_DIR/mock-ai-after-turn-2.json"
assert_mock_evolution_turn 2 "$turn_two_provider_id" 15550001111 "$turn_two_text" \
  "$EVIDENCE_DIR/mock-evolution-after-turn-2.json"

capture_totals "$EVIDENCE_DIR/two-turn-totals.json"
jq -e '
  .conversations == 1
  and .leads == 0
  and .inbound_events == 2
  and .executions == 2
  and .delivered_executions == 2
  and .distinct_decision_ids == 2
  and .distinct_delivery_keys == 2
  and .distinct_delivery_message_ids == 2
  and .delivery_receipts == 2
  and .advisor_decisions == 2
  and .incoming_messages == 2
  and .outgoing_messages == 2
  and .distinct_provider_message_ids == 2
  and .legacy_outgoing_messages == 0
  and .handoffs == 2
' "$EVIDENCE_DIR/two-turn-totals.json" >/dev/null \
  || fail "two-turn durable totals were not authoritative: $(cat "$EVIDENCE_DIR/two-turn-totals.json")"

curl -fsS "http://127.0.0.1:${TEST_MOCK_AI_PORT}/requests" > "$EVIDENCE_DIR/mock-ai-before-replay.json"
jq -e '.count == 4' "$EVIDENCE_DIR/mock-ai-before-replay.json" >/dev/null \
  || fail "AI mock did not receive exactly two attempts per turn"
curl -fsS "http://127.0.0.1:${TEST_MOCK_EVOLUTION_PORT}/requests" > "$EVIDENCE_DIR/mock-evolution-before-replay.json"
jq -e '.count == 2' "$EVIDENCE_DIR/mock-evolution-before-replay.json" >/dev/null \
  || fail "Evolution mock did not receive exactly one delivery per turn"
capture_replay_snapshot "$EVIDENCE_DIR/before-replay.json"

post_event "$turn_two_payload" "$EVIDENCE_DIR/replay-response.json"
jq -e '.status == "accepted" and .duplicate == true' "$EVIDENCE_DIR/replay-response.json" >/dev/null \
  || fail "turn-two replay was not reported as a duplicate"

capture_replay_snapshot "$EVIDENCE_DIR/after-replay.json"
cmp -s "$EVIDENCE_DIR/before-replay.json" "$EVIDENCE_DIR/after-replay.json" \
  || fail "turn-two replay changed authoritative database rows"
curl -fsS "http://127.0.0.1:${TEST_MOCK_AI_PORT}/requests" > "$EVIDENCE_DIR/mock-ai-after-replay.json"
cmp -s "$EVIDENCE_DIR/mock-ai-before-replay.json" "$EVIDENCE_DIR/mock-ai-after-replay.json" \
  || fail "turn-two replay invoked AI again"
curl -fsS "http://127.0.0.1:${TEST_MOCK_EVOLUTION_PORT}/requests" > "$EVIDENCE_DIR/mock-evolution-after-replay.json"
cmp -s "$EVIDENCE_DIR/mock-evolution-before-replay.json" "$EVIDENCE_DIR/mock-evolution-after-replay.json" \
  || fail "turn-two replay sent another provider message"

curl -fsS -X POST -H 'Content-Type: application/json' \
  --data-binary @- "http://127.0.0.1:${TEST_MOCK_AI_PORT}/plan" >/dev/null <<'PLAN'
{
  "reply_text": "Confirmado: 20 m3 de hormigon H25 para Santiago con despacho. Coordinamos la entrega.",
  "observations": [
    { "id": "obs-product", "concept": "product", "quote": "hormigon H25",
      "normalized_value": "hormigon H25", "grounding_ref": "product:H25",
      "resolves_goal_ids": ["product"] },
    { "id": "obs-commune", "concept": "commune", "quote": "Santiago",
      "normalized_value": "Santiago", "grounding_ref": "commune:santiago",
      "resolves_goal_ids": ["commune"] },
    { "id": "obs-quantity", "concept": "quantity", "quote": "20 m3",
      "normalized_value": "20 m3", "grounding_ref": null,
      "resolves_goal_ids": ["quantity"] },
    { "id": "obs-modality", "concept": "modality", "quote": "despacho",
      "normalized_value": "delivery", "grounding_ref": "modality:delivery",
      "resolves_goal_ids": ["modality"] }
  ],
  "effects": ["create_lead"]
}
PLAN

post_event "$turn_three_payload" "$EVIDENCE_DIR/turn-3-response.json"
jq -e '.status == "accepted" and .duplicate == false' "$EVIDENCE_DIR/turn-3-response.json" >/dev/null \
  || fail "turn three was not accepted as a new event"
wait_for_delivered_turn synthetic-v3-canary-003 "$EVIDENCE_DIR/turn-3-terminal.json"
capture_valid_turn_evidence synthetic-v3-canary-003 "$EVIDENCE_DIR/turn-3-evidence.json"
assert_valid_turn_evidence "$EVIDENCE_DIR/turn-3-evidence.json"

cat > "$EVIDENCE_DIR/result.txt" <<EOF_RESULT
source_number_id=$source_number_id
turn_one_inbound_event_id=$turn_one_id
turn_two_inbound_event_id=$turn_two_id
turn_one_provider_message_id=$turn_one_provider_id
turn_two_provider_message_id=$turn_two_provider_id
contract_mode=canary
scenario=new_contact -> invalid_initial -> complete_repair -> invalid_repair -> contingency -> exact_delivery -> second_turn -> duplicate_replay -> valid_proposal -> lead_effect -> state_commit
EOF_RESULT

echo "n8n v3 canary E2E OK: two receipted contingency turns, duplicate replay, and one authorized turn with a real lead effect"
