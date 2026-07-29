#!/bin/sh
set -eu

ROOT_DIR="$(CDPATH= cd -- "$(dirname "$0")/../.." && pwd)"
cd "$ROOT_DIR"

POSTGRES_CONTAINER="${PROJECT_NAME:-crm-whatsapp-automatizado}-postgres"
TEST_DB="crm_whatsapp_delivery_integrity_${$}"

cleanup() {
  docker exec "$POSTGRES_CONTAINER" psql -U postgres -d postgres \
    -c "DROP DATABASE IF EXISTS ${TEST_DB} WITH (FORCE)" >/dev/null 2>&1 || true
  rm -f /tmp/delivery-integrity-*.sql
  [ -z "${DOCKER_SHIM_DIR:-}" ] || rm -rf "$DOCKER_SHIM_DIR"
}
trap cleanup EXIT

docker exec "$POSTGRES_CONTAINER" psql -U postgres -d postgres \
  -v ON_ERROR_STOP=1 -c "CREATE DATABASE ${TEST_DB}" >/dev/null

for migration in infra/postgres/migrations/00[1-6]_*.sql; do
  docker exec -i "$POSTGRES_CONTAINER" psql -U postgres -d "$TEST_DB" \
    -v ON_ERROR_STOP=1 < "$migration" >/dev/null
done
docker exec -i "$POSTGRES_CONTAINER" psql -U postgres -d "$TEST_DB" \
  -v ON_ERROR_STOP=1 < db/seeds/001_lead_statuses.sql >/dev/null
docker exec -i "$POSTGRES_CONTAINER" psql -U postgres -d "$TEST_DB" \
  -v ON_ERROR_STOP=1 < db/seeds/002_conversation_statuses.sql >/dev/null

# Legacy rows: a single active line is the only case where attribution is safe.
docker exec -i "$POSTGRES_CONTAINER" psql -U postgres -d "$TEST_DB" -v ON_ERROR_STOP=1 >/dev/null <<'SQL'
INSERT INTO whatsapp_numbers (display_name, phone_number, phone_number_id)
VALUES ('Main', '+56900000000', 'pn-main');
INSERT INTO conversations (phone_number, conversation_status_id)
SELECT '56911111111', id FROM conversation_statuses WHERE code = 'active';
INSERT INTO leads (phone_number, lead_status_id)
SELECT '56911111111', id FROM lead_statuses WHERE code = 'draft';
INSERT INTO sellers (name, whatsapp_number, clickup_user_id, is_active, sort_order)
VALUES ('Seller One', '+56910000001', '101', TRUE, 1),
       ('Seller Two', '+56910000002', '102', TRUE, 2);
SQL

docker exec -i "$POSTGRES_CONTAINER" psql -U postgres -d "$TEST_DB" \
  -v ON_ERROR_STOP=1 < infra/postgres/migrations/007_add_delivery_integrity.sql >/dev/null
docker exec -i "$POSTGRES_CONTAINER" psql -U postgres -d "$TEST_DB" \
  -v ON_ERROR_STOP=1 -v instance_name="instance-main" \
  < db/queries/ops/ensure-default-instance-mapping.sql >/dev/null
# Reapplication must remain safe.
docker exec -i "$POSTGRES_CONTAINER" psql -U postgres -d "$TEST_DB" \
  -v ON_ERROR_STOP=1 < infra/postgres/migrations/007_add_delivery_integrity.sql >/dev/null

assert_sql() {
  local query="$1"
  local expected="$2"
  local actual
  actual="$(docker exec "$POSTGRES_CONTAINER" psql -U postgres -d "$TEST_DB" \
    -Atqc "$query")"
  if [ "$actual" != "$expected" ]; then
    printf 'Assertion failed\nSQL: %s\nExpected: %s\nActual: %s\n' \
      "$query" "$expected" "$actual" >&2
    exit 1
  fi
}

assert_sql "SELECT count(*) FROM conversations WHERE source_number_id = 1" "1"
assert_sql "SELECT count(*) FROM leads WHERE source_number_id = 1" "1"
assert_sql "SELECT count(*) FROM audit_logs WHERE event_name = 'source_number_backfilled'" "2"

python3 - <<'PY'
import json
import re
from pathlib import Path

def literal(value):
    if value is None:
        return "NULL"
    return "'" + str(value).replace("'", "''") + "'"

def render(query, values):
    return re.sub(r"\$(\d+)", lambda m: literal(values[int(m.group(1)) - 1]), query)

inbound = json.loads(Path("n8n/workflows/wa-inbound-entry.json").read_text())
inbound_query = next(n for n in inbound["nodes"] if n["name"] == "Persist Durable Inbox")["parameters"]["query"]
base = [
    "instance-main", None, "56922222222", "messages.upsert", "MESSAGES_UPSERT",
    "true", '{"event":"messages.upsert","payload":"same"}', "Test User",
    "56922222222@s.whatsapp.net", "2026-07-28T12:00:00Z", "text", "Hola",
    None, None, None, None, None, None, None,
]
Path("/tmp/delivery-integrity-inbound-first.sql").write_text(render(inbound_query, base))
Path("/tmp/delivery-integrity-inbound-replay.sql").write_text(render(inbound_query, base))
unknown = base.copy()
unknown[0], unknown[1], unknown[6] = "unregistered-instance", "unknown-1", '{"payload":"unknown"}'
Path("/tmp/delivery-integrity-inbound-unknown.sql").write_text(render(inbound_query, unknown))
fifo_a = base.copy()
fifo_a[1], fifo_a[6], fifo_a[9], fifo_a[11] = "fifo-a", '{"payload":"fifo-a"}', "2026-07-28T12:01:00Z", "Primero"
fifo_b = base.copy()
fifo_b[1], fifo_b[6], fifo_b[9], fifo_b[11] = "fifo-b", '{"payload":"fifo-b"}', "2026-07-28T12:01:01Z", "Segundo"
Path("/tmp/delivery-integrity-inbound-fifo-a.sql").write_text(render(inbound_query, fifo_a))
Path("/tmp/delivery-integrity-inbound-fifo-b.sql").write_text(render(inbound_query, fifo_b))
persist_event = base.copy()
persist_event[1], persist_event[2], persist_event[6], persist_event[8], persist_event[11] = (
    "persist-crash", "56944444444", '{"payload":"persist-crash"}',
    "56944444444@s.whatsapp.net", "Necesito pastelones",
)
Path("/tmp/delivery-integrity-inbound-persist-crash.sql").write_text(render(inbound_query, persist_event))

recovery = json.loads(Path("n8n/workflows/wa-inbound-recovery.json").read_text())
recovery_query = next(n for n in recovery["nodes"] if n["name"] == "Recover And Claim FIFO Events")["parameters"]["query"]
Path("/tmp/delivery-integrity-recovery.sql").write_text(render(recovery_query, [60, 20, 5]))

lead = json.loads(Path("n8n/workflows/crm-lead-creation-and-assignment.json").read_text())
lead_query = next(n for n in lead["nodes"] if n["name"] == "Persist Lead And Rotation")["parameters"]["query"]
lead_values = [
    None, 1, "56922222222@s.whatsapp.net", "Test User", "56922222222",
    "Pastelones", "Colina", "100 m2 con instalación", "qualified_complete",
    "true", "false", "whatsapp:1", 2, "{}",
]
Path("/tmp/delivery-integrity-lead-first.sql").write_text(render(lead_query, lead_values))
Path("/tmp/delivery-integrity-lead-replay.sql").write_text(render(lead_query, lead_values))
retry_values = lead_values.copy()
retry_values[12] = 3
Path("/tmp/delivery-integrity-lead-failed.sql").write_text(render(lead_query, retry_values))
Path("/tmp/delivery-integrity-lead-retry.sql").write_text(render(lead_query, retry_values))
finalize_query = next(n for n in lead["nodes"] if n["name"] == "Finalize Lead Assignment")["parameters"]["query"]
Path("/tmp/delivery-integrity-lead-finalize.sql").write_text(render(finalize_query, [2]))
Path("/tmp/delivery-integrity-lead-retry-finalize.sql").write_text(
    finalize_query.replace(
        "$1::bigint",
        "(SELECT id FROM leads WHERE source_conversation_id = 3)",
    )
)

outbound = json.loads(Path("n8n/workflows/wa-outbound-messages.json").read_text())
outbound_query = next(n for n in outbound["nodes"] if n["name"] == "Queue Outbound Message")["parameters"]["query"]
outbound_values = [
    2, None, "text", "Respuesta idempotente",
    '{"number":"56922222222","text":"Respuesta idempotente","delay":0,"linkPreview":false}',
    "question", "instance-main", "evolution:instance-main:2:incoming-1:question", 300,
]
Path("/tmp/delivery-integrity-outbound-first.sql").write_text(render(outbound_query, outbound_values))
Path("/tmp/delivery-integrity-outbound-concurrent.sql").write_text(render(outbound_query, outbound_values))
Path("/tmp/delivery-integrity-outbound-replay.sql").write_text(render(outbound_query, outbound_values))
claimed_crash = outbound_values.copy()
claimed_crash[3], claimed_crash[4], claimed_crash[7] = (
    "Claimed crash", '{"number":"56922222222","text":"Claimed crash"}',
    "evolution:instance-main:2:incoming-2:question",
)
Path("/tmp/delivery-integrity-outbound-claimed-first.sql").write_text(render(outbound_query, claimed_crash))
Path("/tmp/delivery-integrity-outbound-claimed-retry.sql").write_text(render(outbound_query, claimed_crash))
sending_crash = outbound_values.copy()
sending_crash[3], sending_crash[4], sending_crash[7] = (
    "Sending crash", '{"number":"56922222222","text":"Sending crash"}',
    "evolution:instance-main:2:incoming-3:question",
)
Path("/tmp/delivery-integrity-outbound-sending-first.sql").write_text(render(outbound_query, sending_crash))
Path("/tmp/delivery-integrity-outbound-sending-retry.sql").write_text(render(outbound_query, sending_crash))

orchestrator = json.loads(Path("n8n/workflows/wa-conversation-orchestrator.json").read_text())
persist_query = next(n for n in orchestrator["nodes"] if n["name"] == "Persist Conversation State")["parameters"]["query"]
persist_values = [
    None, "56944444444", 1, "city", None, "persist-crash",
    "2026-07-28T12:10:00Z", "text", "Necesito pastelones",
    '{"payload":"persist-crash"}',
    None, None, None, None, None, None, None,
    "waiting_user", "conversation_state_evaluated", "waiting_user",
    "{}", '{"service":"Pastelones","current_step":"city"}', "{}",
    "false", "false", "true", None, None, None, None, None,
    "quote", "warm", None, None, None, 0.9, "[]", "{}", "{}",
    "ask_city", None, "false", "[]", "person", "warm", "material",
    "{}", None, None, None, "[]", "{}", "city",
    "__EVENT_ID__", "__PROCESSING_TOKEN__",
    '{"phone_number":"56944444444","source_number_id":1,"instance_name":"instance-main",'
    '"external_message_id":"persist-crash","message_type":"text","text_body":"Necesito pastelones",'
    '"response_text":"¿Desde qué comuna nos escribes?","response_kind":"question",'
    '"should_create_lead":false}',
]
assert len(persist_values) == 57
persist_sql = render(persist_query, persist_values)
persist_sql = persist_sql.replace(
    "'__EVENT_ID__'",
    "(SELECT id::text FROM inbound_events WHERE external_message_id='persist-crash')",
).replace(
    "'__PROCESSING_TOKEN__'",
    "(SELECT processing_token FROM inbound_events WHERE external_message_id='persist-crash')",
)
Path("/tmp/delivery-integrity-persist-turn.sql").write_text(persist_sql)
PY

docker exec -i "$POSTGRES_CONTAINER" psql -U postgres -d "$TEST_DB" -v ON_ERROR_STOP=1 \
  < /tmp/delivery-integrity-inbound-first.sql >/tmp/delivery-integrity-inbound-first.out
docker exec -i "$POSTGRES_CONTAINER" psql -U postgres -d "$TEST_DB" -v ON_ERROR_STOP=1 \
  < /tmp/delivery-integrity-inbound-replay.sql >/tmp/delivery-integrity-inbound-replay.out

assert_sql "SELECT instance_name || '|' || id FROM whatsapp_numbers WHERE id = 1" "instance-main|1"
assert_sql "SELECT count(*) FROM inbound_events" "1"
grep -Eq '(^|[[:space:]])f([[:space:]]|$)' /tmp/delivery-integrity-inbound-replay.out

# Unknown instances are observable but never enter the processing queue.
docker exec -i "$POSTGRES_CONTAINER" psql -U postgres -d "$TEST_DB" -v ON_ERROR_STOP=1 \
  < /tmp/delivery-integrity-inbound-unknown.sql >/dev/null
assert_sql "SELECT processing_status || '|' || failure_reason FROM inbound_events WHERE instance_name = 'unregistered-instance'" "failed|unknown_instance"

# Complete the first smoke event, then race two events for the same source+phone.
# The partial unique index and advisory queue lock allow exactly one processing lease.
docker exec "$POSTGRES_CONTAINER" psql -U postgres -d "$TEST_DB" -v ON_ERROR_STOP=1 \
  -c "UPDATE inbound_events SET processing_status='processed', processed_at=NOW(), processing_token=NULL
      WHERE instance_name='instance-main'" >/dev/null
docker exec -i "$POSTGRES_CONTAINER" psql -U postgres -d "$TEST_DB" -v ON_ERROR_STOP=1 \
  < /tmp/delivery-integrity-inbound-fifo-a.sql >/tmp/delivery-integrity-fifo-a.out &
fifo_pid_a=$!
docker exec -i "$POSTGRES_CONTAINER" psql -U postgres -d "$TEST_DB" -v ON_ERROR_STOP=1 \
  < /tmp/delivery-integrity-inbound-fifo-b.sql >/tmp/delivery-integrity-fifo-b.out &
fifo_pid_b=$!
wait "$fifo_pid_a"
wait "$fifo_pid_b"
assert_sql "SELECT count(*) FROM inbound_events WHERE queue_key='1:56922222222' AND processing_status='processing'" "1"
assert_sql "SELECT count(*) FROM inbound_events WHERE queue_key='1:56922222222' AND processing_status='received'" "1"

# A stale lease without durable message evidence is reclaimed with a new token.
old_token="$(docker exec "$POSTGRES_CONTAINER" psql -U postgres -d "$TEST_DB" -Atqc \
  "SELECT processing_token FROM inbound_events WHERE queue_key='1:56922222222' AND processing_status='processing'")"
docker exec "$POSTGRES_CONTAINER" psql -U postgres -d "$TEST_DB" -v ON_ERROR_STOP=1 \
  -c "UPDATE inbound_events SET processing_started_at=NOW()-INTERVAL '10 minutes'
      WHERE queue_key='1:56922222222' AND processing_status='processing'" >/dev/null
docker exec -i "$POSTGRES_CONTAINER" psql -U postgres -d "$TEST_DB" -v ON_ERROR_STOP=1 \
  < /tmp/delivery-integrity-recovery.sql >/dev/null
new_token="$(docker exec "$POSTGRES_CONTAINER" psql -U postgres -d "$TEST_DB" -Atqc \
  "SELECT processing_token FROM inbound_events WHERE queue_key='1:56922222222' AND processing_status='processing'")"
[ -n "$new_token" ] && [ "$new_token" != "$old_token" ]
assert_sql "SELECT sum(attempt_count) FROM inbound_events WHERE external_message_id IN ('fifo-a', 'fifo-b')" "2"

# Completion releases the FIFO queue; recovery dispatches the next received event.
docker exec "$POSTGRES_CONTAINER" psql -U postgres -d "$TEST_DB" -v ON_ERROR_STOP=1 \
  -c "UPDATE inbound_events SET processing_status='processed', processed_at=NOW(), processing_token=NULL
      WHERE queue_key='1:56922222222' AND processing_status='processing'" >/dev/null
docker exec -i "$POSTGRES_CONTAINER" psql -U postgres -d "$TEST_DB" -v ON_ERROR_STOP=1 \
  < /tmp/delivery-integrity-recovery.sql >/dev/null
assert_sql "SELECT count(*) FROM inbound_events WHERE queue_key='1:56922222222' AND processing_status='processing'" "1"

# An incoming message alone is not proof that downstream effects completed.
# Without a durable result the event is reclaimed for orchestration.
docker exec "$POSTGRES_CONTAINER" psql -U postgres -d "$TEST_DB" -v ON_ERROR_STOP=1 \
  -c "INSERT INTO messages (conversation_id, direction, message_type, inbound_event_id)
      SELECT 1, 'incoming', 'text', id FROM inbound_events
      WHERE queue_key='1:56922222222' AND processing_status='processing';
      UPDATE inbound_events SET processing_started_at=NOW()-INTERVAL '10 minutes'
      WHERE queue_key='1:56922222222' AND processing_status='processing'" >/dev/null
docker exec -i "$POSTGRES_CONTAINER" psql -U postgres -d "$TEST_DB" -v ON_ERROR_STOP=1 \
  < /tmp/delivery-integrity-recovery.sql >/dev/null
assert_sql "SELECT count(*) FROM inbound_events WHERE queue_key='1:56922222222' AND processing_status='processing'" "1"

# Once the orchestration transaction stored downstream_payload, stale recovery
# preserves it so the dispatcher can resume effects without rerunning AI/state.
docker exec "$POSTGRES_CONTAINER" psql -U postgres -d "$TEST_DB" -v ON_ERROR_STOP=1 \
  -c "UPDATE inbound_events
      SET downstream_payload=jsonb_build_object('conversation_id',1,'phone_number','56922222222',
            'instance_name','instance-main','response_text','Durable reply'),
          processing_phase='state_persisted',
          processing_started_at=NOW()-INTERVAL '10 minutes'
      WHERE queue_key='1:56922222222' AND processing_status='processing'" >/dev/null
docker exec -i "$POSTGRES_CONTAINER" psql -U postgres -d "$TEST_DB" -v ON_ERROR_STOP=1 \
  < /tmp/delivery-integrity-recovery.sql >/tmp/delivery-integrity-recovery-durable.out
grep -q "Durable reply" /tmp/delivery-integrity-recovery-durable.out
assert_sql "SELECT processing_phase FROM inbound_events WHERE queue_key='1:56922222222' AND processing_status='processing'" "dispatching"

# A new request has a stable conversation identity.
docker exec "$POSTGRES_CONTAINER" psql -U postgres -d "$TEST_DB" -v ON_ERROR_STOP=1 \
  -c "INSERT INTO conversations (phone_number, source_number_id, conversation_status_id)
      SELECT '56922222222', 1, id FROM conversation_statuses WHERE code = 'active'" >/dev/null

docker exec -i "$POSTGRES_CONTAINER" psql -U postgres -d "$TEST_DB" -v ON_ERROR_STOP=1 \
  < /tmp/delivery-integrity-lead-first.sql >/dev/null
docker exec -i "$POSTGRES_CONTAINER" psql -U postgres -d "$TEST_DB" -v ON_ERROR_STOP=1 \
  < /tmp/delivery-integrity-lead-finalize.sql >/dev/null
docker exec -i "$POSTGRES_CONTAINER" psql -U postgres -d "$TEST_DB" -v ON_ERROR_STOP=1 \
  < /tmp/delivery-integrity-lead-replay.sql >/dev/null
docker exec -i "$POSTGRES_CONTAINER" psql -U postgres -d "$TEST_DB" -v ON_ERROR_STOP=1 \
  < /tmp/delivery-integrity-lead-finalize.sql >/dev/null

assert_sql "SELECT count(*) FROM leads WHERE source_conversation_id = 2" "1"
assert_sql "SELECT count(*) FROM lead_assignments WHERE idempotency_key = 'lead-assignment:2'" "1"
assert_sql "SELECT last_seller_id || '|' || next_seller_id FROM assignment_rotations WHERE rotation_key = 'whatsapp:1'" "1|2"

# A temporary lack of sellers must be recoverable with the same idempotency
# key; a failed claim cannot permanently poison the conversation.
docker exec "$POSTGRES_CONTAINER" psql -U postgres -d "$TEST_DB" -v ON_ERROR_STOP=1 \
  -c "INSERT INTO conversations (phone_number, source_number_id, conversation_status_id)
      SELECT '56933333333', 1, id FROM conversation_statuses WHERE code = 'active';
      UPDATE sellers SET is_active = FALSE;" >/dev/null
docker exec -i "$POSTGRES_CONTAINER" psql -U postgres -d "$TEST_DB" -v ON_ERROR_STOP=1 \
  < /tmp/delivery-integrity-lead-failed.sql >/dev/null
assert_sql "SELECT la.assignment_result FROM lead_assignments la JOIN leads l ON l.id = la.lead_id WHERE l.source_conversation_id = 3" "failed"
docker exec "$POSTGRES_CONTAINER" psql -U postgres -d "$TEST_DB" -v ON_ERROR_STOP=1 \
  -c "UPDATE sellers SET is_active = (id = 1);" >/dev/null
docker exec -i "$POSTGRES_CONTAINER" psql -U postgres -d "$TEST_DB" -v ON_ERROR_STOP=1 \
  < /tmp/delivery-integrity-lead-retry.sql >/dev/null
docker exec -i "$POSTGRES_CONTAINER" psql -U postgres -d "$TEST_DB" -v ON_ERROR_STOP=1 \
  < /tmp/delivery-integrity-lead-retry-finalize.sql >/dev/null
assert_sql "SELECT la.assignment_result || '|' || la.seller_id FROM lead_assignments la JOIN leads l ON l.id = la.lead_id WHERE l.source_conversation_id = 3" "assigned|1"
assert_sql "SELECT assigned_seller_id FROM leads WHERE source_conversation_id = 3" "1"

# Outbound persistence happens before the provider call, and a replay of an
# already-sent operation returns the same row without another provider effect.
docker exec -i "$POSTGRES_CONTAINER" psql -U postgres -d "$TEST_DB" -v ON_ERROR_STOP=1 \
  < /tmp/delivery-integrity-outbound-first.sql >/dev/null
docker exec -i "$POSTGRES_CONTAINER" psql -U postgres -d "$TEST_DB" -v ON_ERROR_STOP=1 \
  < /tmp/delivery-integrity-outbound-concurrent.sql >/tmp/delivery-integrity-outbound-concurrent.out
grep -Eq '(^|[[:space:]])f([[:space:]]|$)' /tmp/delivery-integrity-outbound-concurrent.out
docker exec "$POSTGRES_CONTAINER" psql -U postgres -d "$TEST_DB" -v ON_ERROR_STOP=1 \
  -c "UPDATE messages
      SET delivery_status = 'sent', external_message_id = 'provider-message-1'
      WHERE idempotency_key = 'evolution:instance-main:2:incoming-1:question'" >/dev/null
docker exec -i "$POSTGRES_CONTAINER" psql -U postgres -d "$TEST_DB" -v ON_ERROR_STOP=1 \
  < /tmp/delivery-integrity-outbound-replay.sql >/tmp/delivery-integrity-outbound-replay.out

assert_sql "SELECT count(*) FROM messages WHERE idempotency_key = 'evolution:instance-main:2:incoming-1:question'" "1"
grep -Eq '(^|[[:space:]])t([[:space:]]|$)' /tmp/delivery-integrity-outbound-replay.out

# Crash after durable queue claim but before POST is retry-safe.
docker exec -i "$POSTGRES_CONTAINER" psql -U postgres -d "$TEST_DB" -v ON_ERROR_STOP=1 \
  < /tmp/delivery-integrity-outbound-claimed-first.sql >/dev/null
docker exec "$POSTGRES_CONTAINER" psql -U postgres -d "$TEST_DB" -v ON_ERROR_STOP=1 \
  -c "UPDATE messages SET claimed_at=NOW()-INTERVAL '10 minutes'
      WHERE idempotency_key='evolution:instance-main:2:incoming-2:question'" >/dev/null
docker exec -i "$POSTGRES_CONTAINER" psql -U postgres -d "$TEST_DB" -v ON_ERROR_STOP=1 \
  < /tmp/delivery-integrity-outbound-claimed-retry.sql >/tmp/delivery-integrity-outbound-claimed-retry.out
grep -Eq '(^|[[:space:]])t([[:space:]]|$)' /tmp/delivery-integrity-outbound-claimed-retry.out

# Crash after phase=sending is ambiguous: never retry automatically.
docker exec -i "$POSTGRES_CONTAINER" psql -U postgres -d "$TEST_DB" -v ON_ERROR_STOP=1 \
  < /tmp/delivery-integrity-outbound-sending-first.sql >/dev/null
docker exec "$POSTGRES_CONTAINER" psql -U postgres -d "$TEST_DB" -v ON_ERROR_STOP=1 \
  -c "UPDATE messages SET dispatch_phase='sending', delivery_status='sending',
          attempt_started_at=NOW()-INTERVAL '10 minutes'
      WHERE idempotency_key='evolution:instance-main:2:incoming-3:question'" >/dev/null
docker exec -i "$POSTGRES_CONTAINER" psql -U postgres -d "$TEST_DB" -v ON_ERROR_STOP=1 \
  < /tmp/delivery-integrity-outbound-sending-retry.sql >/dev/null
assert_sql "SELECT dispatch_phase || '|' || reconciliation_required
  FROM messages WHERE idempotency_key='evolution:instance-main:2:incoming-3:question'" "unknown|true"

# Persist Conversation State must construct the durable dispatcher payload only
# after PostgreSQL has resolved the new conversation and incoming message IDs.
docker exec -i "$POSTGRES_CONTAINER" psql -U postgres -d "$TEST_DB" -v ON_ERROR_STOP=1 \
  < /tmp/delivery-integrity-inbound-persist-crash.sql >/dev/null
docker exec -i "$POSTGRES_CONTAINER" psql -U postgres -d "$TEST_DB" -v ON_ERROR_STOP=1 \
  < /tmp/delivery-integrity-persist-turn.sql >/tmp/delivery-integrity-persist-turn.out
assert_sql "SELECT
    (downstream_payload->>'conversation_id')::bigint = (
      SELECT conversation_id FROM messages WHERE inbound_event_id=inbound_events.id
    )
    AND (downstream_payload->>'message_id')::bigint = (
      SELECT id FROM messages WHERE inbound_event_id=inbound_events.id
    )
  FROM inbound_events WHERE external_message_id='persist-crash'" "t"
grep -q "conversation_id" /tmp/delivery-integrity-persist-turn.out
grep -q "message_id" /tmp/delivery-integrity-persist-turn.out
docker exec "$POSTGRES_CONTAINER" psql -U postgres -d "$TEST_DB" -v ON_ERROR_STOP=1 \
  -c "UPDATE inbound_events SET processing_started_at=NOW()-INTERVAL '10 minutes'
      WHERE external_message_id='persist-crash'" >/dev/null
docker exec -i "$POSTGRES_CONTAINER" psql -U postgres -d "$TEST_DB" -v ON_ERROR_STOP=1 \
  < /tmp/delivery-integrity-recovery.sql >/tmp/delivery-integrity-recovery-new-conversation.out
grep -q "¿Desde qué comuna nos escribes?" /tmp/delivery-integrity-recovery-new-conversation.out
assert_sql "SELECT processing_phase || '|' ||
    (downstream_payload ? 'conversation_id') || '|' || (downstream_payload ? 'message_id')
  FROM inbound_events WHERE external_message_id='persist-crash'" "dispatching|true|true"

# Multiple active lines must never be guessed for an unknown default instance.
docker exec "$POSTGRES_CONTAINER" psql -U postgres -d "$TEST_DB" -v ON_ERROR_STOP=1 \
  -c "INSERT INTO whatsapp_numbers (display_name,phone_number,phone_number_id,is_active)
      VALUES ('Second','+56900000001','pn-second',TRUE)" >/dev/null
if docker exec -i "$POSTGRES_CONTAINER" psql -U postgres -d "$TEST_DB" \
  -v ON_ERROR_STOP=1 -v instance_name="ambiguous-instance" \
  < db/queries/ops/ensure-default-instance-mapping.sql >/dev/null 2>&1; then
  echo "Expected ambiguous instance mapping to fail" >&2
  exit 1
fi

# Exercise the real sync mapping path with a docker shim. This catches set -u
# regressions and proves DEFAULT_INSTANCE is injected into the postgres exec,
# without connecting to or exposing the real environment.
DOCKER_SHIM_DIR="$(mktemp -d)"
cat > "$DOCKER_SHIM_DIR/docker" <<'SHIM'
#!/bin/sh
set -eu
printf '%s\n' "$*" >> /tmp/delivery-integrity-docker-shim.log
case " $* " in
  *" exec -T n8n sh -lc "*)
    printf %s "instance-main"
    ;;
  *" exec -T -e DEFAULT_INSTANCE=instance-main postgres sh -lc "*)
    cat > /tmp/delivery-integrity-mapping-stdin.sql
    ;;
  *)
    echo "Unexpected docker shim call: $*" >&2
    exit 1
    ;;
esac
SHIM
chmod +x "$DOCKER_SHIM_DIR/docker"
: > /tmp/delivery-integrity-docker-shim.log
PATH="$DOCKER_SHIM_DIR:$PATH" sh scripts/dev/sync-n8n-workflows.sh --mapping-only >/dev/null
grep -q "DEFAULT_INSTANCE=instance-main postgres" /tmp/delivery-integrity-docker-shim.log
grep -q "sole_active_unmapped_number" /tmp/delivery-integrity-mapping-stdin.sql

# Execute Normalize Delivery Result in isolation for the three provider outcome
# classes; undefined variables or wrong reconciliation flags fail immediately.
node <<'NODE'
const fs = require('fs');
const workflow = JSON.parse(fs.readFileSync('n8n/workflows/wa-outbound-messages.json', 'utf8'));
const code = workflow.nodes.find((node) => node.name === 'Normalize Delivery Result').parameters.jsCode;
const run = new Function('items', code);
const cases = [
  [{ json: { id: 1, statusCode: 200, body: { key: { id: 'wa-1' } } } }, 'sent', false, null],
  [{ json: { id: 2, statusCode: 400, body: { message: 'bad request' } } }, 'failed', false, null],
  [{ json: { id: 3, statusCode: 0, body: {}, retry_last_error: 'timeout' } }, 'unknown', true, 'timeout'],
];
for (const [input, phase, required, reason] of cases) {
  const output = run([input])[0].json;
  if (output.dispatch_phase !== phase) throw new Error(`phase ${output.dispatch_phase} != ${phase}`);
  if (output.reconciliation_required !== required) throw new Error(`reconciliation flag mismatch for ${phase}`);
  if ((output.reconciliation_reason ?? null) !== reason) throw new Error(`reason mismatch for ${phase}`);
}
NODE

# Sticker media must pass the database contract.
docker exec "$POSTGRES_CONTAINER" psql -U postgres -d "$TEST_DB" -v ON_ERROR_STOP=1 \
  -c "INSERT INTO messages (conversation_id, direction, message_type) VALUES (2, 'incoming', 'sticker')" >/dev/null

# Static workflow invariants: ACK is downstream of the durable inbox, lead
# identity is conversation-scoped, and ClickUp has an observable operation claim.
jq -e '
  .connections["Normalize Evolution Payload"].main[0][0].node == "Persist Durable Inbox"
  and .connections["Persist Durable Inbox"].main[0][0].node == "Respond Accepted"
  and .connections["Execute Conversation Orchestrator"].main[0][0].node == "Execute Durable Downstream Dispatcher"
' n8n/workflows/wa-inbound-entry.json >/dev/null
jq -e '
  ([.nodes[] | select(.name == "Recover And Claim FIFO Events") | .parameters.query]
    | join("") | contains("recover_and_claim_inbound_events"))
' n8n/workflows/wa-inbound-recovery.json >/dev/null
grep -q "FOR UPDATE OF ie SKIP LOCKED" infra/postgres/migrations/007_add_delivery_integrity.sql
grep -q "downstream_payload" infra/postgres/migrations/007_add_delivery_integrity.sql
jq -e '
  ([.nodes[] | select(.name == "Evaluate Conversation Step") | .parameters.jsCode]
    | join("") | contains("inbound_event_id: row.inbound_event_id"))
  and ([.nodes[] | select(.name == "Prepare Conversation Output") | .parameters.jsCode]
    | join("") | contains("processing_token: pick"))
  and ([.nodes[] | select(.name == "Persist Conversation State") | .parameters.query]
    | join("") | contains("ie.processing_token = NULLIF($56::text"))
  and ([.nodes[] | select(.name == "Persist Conversation State") | .parameters.query]
    | join("") | contains("downstream_payload = COALESCE(NULLIF($57::text"))
' n8n/workflows/wa-conversation-orchestrator.json >/dev/null
jq -e '
  .connections["Merge Dispatch Completion"].main[0][0].node == "Mark Inbox Processed"
  and .connections["Mark Inbox Processed"].main[0][0].node == "Dispatch Next Inbox Event"
  and ([.nodes[] | select(.name == "Mark Inbox Processed") | .parameters.query]
    | join("") | contains("downstream_payload <>"))
' n8n/workflows/wa-inbound-downstream-dispatcher.json >/dev/null
jq -e '
  .connections["Has Durable Turn Result"].main[0][0].node == "Resume Durable Downstream"
  and .connections["Has Durable Turn Result"].main[1][0].node == "Execute Inbound Processor"
' n8n/workflows/wa-inbound-recovery.json >/dev/null
jq -e '
  ([.nodes[] | select(.name == "Persist Lead And Rotation") | .parameters.query]
    | join("") | contains("pg_advisory_xact_lock"))
  and ([.nodes[] | select(.name == "Persist Lead And Rotation") | .parameters.query]
    | join("") | contains("source_conversation_id"))
' n8n/workflows/crm-lead-creation-and-assignment.json >/dev/null
jq -e '
  ([.nodes[] | select(.name == "Load ClickUp Context") | .parameters.query]
    | join("") | contains("external_operations"))
  and ([.nodes[] | select(.name == "Create ClickUp Task") | .parameters.jsCode]
    | join("") | contains("idempotency_in_progress"))
' n8n/workflows/crm-clickup-sync-lead.json >/dev/null
jq -e '
  .connections["Build Outbound Payload"].main[0][0].node == "Queue Outbound Message"
  and .connections["Queue Outbound Message"].main[0][0].node == "Should Dispatch Outbound"
  and .connections["Should Dispatch Outbound"].main[0][0].node == "Mark Outbound Sending"
  and .connections["Should Dispatch Outbound"].main[1][0].node == "Return Already Sent"
  and .connections["Mark Outbound Sending"].main[0][0].node == "Send Evolution Message"
  and .connections["Persist Delivery Result"].main[0][0].node == "Return Outbound Result"
  and .connections["Return Already Sent"].main[0][0].node == "Return Outbound Result"
  and ([.nodes[] | select(.name == "Queue Outbound Message") | .parameters.query]
    | join("") | contains("claim_outbound_message"))
  and ([.nodes[] | select(.name == "Send Evolution Message") | .parameters.jsCode]
    | join("") | contains("row.should_send === false"))
' n8n/workflows/wa-outbound-messages.json >/dev/null

echo "Delivery integrity local tests OK: durable result/outbox, FIFO recovery, source isolation, outbound claimed/sending crash windows, downstream idempotency, sticker"
