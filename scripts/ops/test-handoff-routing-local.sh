#!/bin/sh
set -eu

ROOT_DIR=$(CDPATH= cd -- "$(dirname "$0")/../.." && pwd)
cd "$ROOT_DIR"

node tests/scripts/sync-workflow-nodes.mjs --check >/dev/null
jq empty n8n/workflows/wa-inbound-downstream-dispatcher.json
jq empty n8n/workflows/ops-handoff-notification-scheduler.json

node <<'NODE'
const assert = require('assert');
const fs = require('fs');
const { prepareHandoffClickup } = require('./tests/fixtures/workflow-nodes/ops-handoff-notification-scheduler/prepare-handoff-clickup-task.js');
const { dispatchHandoffClickup } = require('./tests/fixtures/workflow-nodes/ops-handoff-notification-scheduler/dispatch-handoff-clickup-task.js');
const scheduler = JSON.parse(fs.readFileSync('n8n/workflows/ops-handoff-notification-scheduler.json'));
const dispatcher = JSON.parse(fs.readFileSync('n8n/workflows/wa-inbound-downstream-dispatcher.json'));
const escalationPolicy = require('./tests/fixtures/workflow-nodes/wa-inbound-downstream-dispatcher/ensure-escalation-handoff.js');
const schedulerId = '99999999-0000-0000-0000-000000000003';
assert.equal(scheduler.id, schedulerId);
assert.equal(scheduler.active, true);
assert(scheduler.nodes.some(n => n.type === 'n8n-nodes-base.scheduleTrigger'));
assert(scheduler.nodes.some(n => n.type === 'n8n-nodes-base.executeWorkflowTrigger'));
const link = dispatcher.nodes.find(n => n.name === 'Dispatch Handoff Notification Workflow');
assert(link && link.parameters.workflowId.value === schedulerId);
assert(!dispatcher.nodes.some(n => ['Prepare Handoff Notification','Dispatch Handoff Notification','Mark Handoff Attempt'].includes(n.name)));
const edge = (source, lane, target, index = 0) =>
  dispatcher.connections[source]?.main?.[lane]?.some(connection => connection.node === target && connection.index === index);
assert(edge('Ensure Escalation Handoff', 0, 'Handoff Write Required?'));
assert(edge('Handoff Write Required?', 0, 'Upsert Escalation Handoff'));
assert(edge('Handoff Write Required?', 1, 'Escalation Lane Complete'));
assert(edge('Upsert Escalation Handoff', 0, 'Dispatch Handoff Notification Workflow'));
assert(edge('Dispatch Handoff Notification Workflow', 0, 'Escalation Lane Complete'));
assert(edge('Escalation Lane Complete', 0, 'Merge Dispatch Completion', 0));
assert(!edge('Normalize Durable Dispatch', 0, 'Merge Dispatch Completion', 0));
const completionCode = dispatcher.nodes.find(n => n.name === 'Escalation Lane Complete').parameters.jsCode;
assert(completionCode.includes("$('Ensure Escalation Handoff').first().json"));
assert(completionCode.includes('...source') && completionCode.includes('...result'));

const normalizeNode = dispatcher.nodes.find(n => n.name === 'Normalize Durable Dispatch');
const normalize = new Function('items', normalizeNode.parameters.jsCode);
const traverseEscalation = (row) => {
  const visited = ['Ensure Escalation Handoff'];
  const routed = escalationPolicy.routeEscalation(row);
  let current = 'Handoff Write Required?';
  visited.push(current);
  const lane = routed.write ? 0 : 1;
  while (current !== 'Merge Dispatch Completion') {
    const next = dispatcher.connections[current]?.main?.[current === 'Handoff Write Required?' ? lane : 0]?.[0]?.node;
    assert(next, `escalation route stops at ${current}`);
    visited.push(next);
    current = next;
  }
  return visited;
};
const runtimeBoundary = normalize([{ json: {
  conversation_id: 126,
  inbound_event_id: 249,
  phone_number: '56900000000',
  intent: 'talk_to_human',
  escalation_area: 'sales',
  after_payload_json: JSON.stringify({ should_escalate: true, escalation_reason: 'human_requested' }),
} }])[0].json;
assert.equal(runtimeBoundary.should_escalate, true);
assert.equal(runtimeBoundary.escalation_reason, 'human_requested');
const humanRoute = traverseEscalation(runtimeBoundary);
assert(humanRoute.includes('Upsert Escalation Handoff'));
assert.equal(humanRoute.filter(name => name === 'Escalation Lane Complete').length, 1);
const noHandoffRoute = traverseEscalation({
  conversation_id: 127,
  inbound_event_id: 250,
  phone_number: '56900000001',
  intent: 'general_inquiry',
  should_escalate: false,
  escalation_area: 'none',
});
assert(!noHandoffRoute.includes('Upsert Escalation Handoff'));
assert.equal(noHandoffRoute.filter(name => name === 'Escalation Lane Complete').length, 1);
for (const name of ['Upsert Escalation Handoff']) {
  const query = dispatcher.nodes.find(n => n.name === name).parameters.query;
  assert(!/(?<!:):[A-Za-z_]\w*/.test(query), `${name} still has named placeholders`);
  assert(/\$1/.test(query));
}
const base = { handoff_id: 7, operation_id: 10, claim_token: '00000000-0000-0000-0000-000000000001', area: 'claims', area_label: 'Reclamos', responsable: 'Equipo Reclamos', prioridad: 'urgente', motivo: 'complaint', phone_number: '56912345678', conversation_id: 1, idempotency_key: '1:complaint:x' };
const env = { CLICKUP_API_TOKEN: 'token', CLICKUP_LIST_ID: 'list', HANDOFF_CLICKUP_ASSIGNEES_JSON: '{"claims":[456]}' };
const prepared = prepareHandoffClickup(base, env);
assert.equal(prepared.should_dispatch_clickup, true);
assert.deepEqual(prepared.clickup_payload.assignees, [456]);
const missingConfig = prepareHandoffClickup(base, {...env, HANDOFF_CLICKUP_ASSIGNEES_JSON: '{}'});
assert.equal(missingConfig.should_dispatch_clickup, false);
(async () => {
  const ok = await dispatchHandoffClickup(prepared, async () => ({statusCode: 200, body: {id:'cu-1', url:'https://clickup.test/cu-1'}}), 'token');
  assert.equal(ok.notification_outcome, 'succeeded');
  assert.equal(ok.notification_external_id, 'cu-1');
  const unverifiable = await dispatchHandoffClickup(prepared, async () => ({statusCode: 200, body: {}}), 'token');
  assert.equal(unverifiable.notification_outcome, 'unknown');
  const retry = await dispatchHandoffClickup(prepared, async () => ({statusCode: 429, body: {}}), 'token');
  assert.equal(retry.notification_outcome, 'failed');
  assert.equal(retry.notification_retry_safe, true);
  const ambiguous = await dispatchHandoffClickup(prepared, async () => ({statusCode: 503, body: {}}), 'token');
  assert.equal(ambiguous.notification_outcome, 'unknown');
  assert.equal(ambiguous.notification_retry_safe, false);
  const timeout = await dispatchHandoffClickup(prepared, async () => { throw new Error('timeout'); }, 'token');
  assert.equal(timeout.notification_outcome, 'unknown');
  const deferred = await dispatchHandoffClickup(missingConfig, async () => { throw new Error('must not call HTTP'); }, 'token');
  assert.equal(deferred.notification_outcome, 'deferred');
  assert.equal(deferred.notification_retry_safe, false);
  console.log('Handoff nodes/link integrity: PASS');
})().catch(e => { console.error(e); process.exit(1); });
NODE

POSTGRES_CONTAINER="${PROJECT_NAME:-crm-whatsapp-automatizado}-postgres"
TEST_DB="crm_whatsapp_handoff_${$}"
TMP_DIR=$(mktemp -d)
cleanup() {
  docker exec "$POSTGRES_CONTAINER" psql -U postgres -d postgres -c "DROP DATABASE IF EXISTS ${TEST_DB} WITH (FORCE)" >/dev/null 2>&1 || true
  rm -rf "$TMP_DIR"
}
trap cleanup EXIT

docker exec "$POSTGRES_CONTAINER" psql -U postgres -d postgres -v ON_ERROR_STOP=1 -c "CREATE DATABASE ${TEST_DB}" >/dev/null
for migration in infra/postgres/migrations/00[1-7]_*.sql infra/postgres/migrations/010_create_opportunities.sql infra/postgres/migrations/011_create_handoffs.sql infra/postgres/migrations/015_harden_handoff_delivery.sql; do
  docker exec -i "$POSTGRES_CONTAINER" psql -U postgres -d "$TEST_DB" -v ON_ERROR_STOP=1 < "$migration" >/dev/null
done
docker exec -i "$POSTGRES_CONTAINER" psql -U postgres -d "$TEST_DB" -v ON_ERROR_STOP=1 < db/seeds/001_lead_statuses.sql >/dev/null
docker exec -i "$POSTGRES_CONTAINER" psql -U postgres -d "$TEST_DB" -v ON_ERROR_STOP=1 < db/seeds/002_conversation_statuses.sql >/dev/null
docker exec -i "$POSTGRES_CONTAINER" psql -U postgres -d "$TEST_DB" -v ON_ERROR_STOP=1 >/dev/null <<'SQL'
INSERT INTO whatsapp_numbers (display_name, phone_number, phone_number_id) VALUES ('Main', '+56900000000', 'pn-main');
INSERT INTO conversations (phone_number, source_number_id, conversation_status_id)
SELECT '56912345678', 1, id FROM conversation_statuses WHERE code='active';
SQL

# Execute the exact positional SQL used by n8n; no named-placeholder renderer.
{
  printf '%s\n' 'PREPARE handoff_upsert(boolean,bigint,text,text,text,text,text,text,text,text,text,text,text,text,text) AS'
  cat db/queries/n8n/handoff-routing/01_upsert_handoff.sql
  printf '%s\n' "; EXECUTE handoff_upsert(TRUE,1,'56912345678','1','101','complaint','claims','Reclamos','urgente','Equipo Reclamos','1:complaint:a','a','producto roto','claims','complaint');"
  printf '%s\n' "EXECUTE handoff_upsert(TRUE,1,'56912345678','1','102','warranty','post_sale','Postventa','alta','Postventa','1:warranty:b','b','garantia','post_sale','warranty_inquiry');"
} > "$TMP_DIR/upsert.sql"
docker exec -i "$POSTGRES_CONTAINER" psql -U postgres -d "$TEST_DB" -v ON_ERROR_STOP=1 < "$TMP_DIR/upsert.sql" >/dev/null

make_claim_sql() {
  out=$1
  {
    printf '%s\n' 'PREPARE handoff_claim(integer,integer) AS'
    cat db/queries/n8n/handoff-routing/02_claim_notification.sql
    printf '%s\n' '; EXECUTE handoff_claim(1,900);'
  } > "$out"
}
make_claim_sql "$TMP_DIR/claim-a.sql"
make_claim_sql "$TMP_DIR/claim-b.sql"
# Two concurrent workers must receive different rows.
docker exec -i "$POSTGRES_CONTAINER" psql -U postgres -d "$TEST_DB" -At -F '|' -v ON_ERROR_STOP=1 < "$TMP_DIR/claim-a.sql" > "$TMP_DIR/claim-a.out" & p1=$!
docker exec -i "$POSTGRES_CONTAINER" psql -U postgres -d "$TEST_DB" -At -F '|' -v ON_ERROR_STOP=1 < "$TMP_DIR/claim-b.sql" > "$TMP_DIR/claim-b.out" & p2=$!
wait "$p1"; wait "$p2"
a=$(tail -n1 "$TMP_DIR/claim-a.out"); b=$(tail -n1 "$TMP_DIR/claim-b.out")
[ -n "$a" ] && [ -n "$b" ]
[ "$(printf '%s' "$a" | cut -d'|' -f1)" != "$(printf '%s' "$b" | cut -d'|' -f1)" ]

complete_one() {
  row=$1 outcome=$2 status=$3 retry_safe=$4 external_id=$5
  operation_id=$(printf '%s' "$row" | cut -d'|' -f14)
  claim_token=$(printf '%s' "$row" | cut -d'|' -f17)
  {
    printf '%s\n' 'PREPARE handoff_complete(bigint,uuid,text,integer,text,text,text,text,boolean) AS'
    cat db/queries/n8n/handoff-routing/03_complete_notification.sql
    printf "; EXECUTE handoff_complete(%s,'%s','%s',%s,'%s','%s','%s','{}',%s);\n" "$operation_id" "$claim_token" "$outcome" "$status" "$external_id" "https://clickup.test/$external_id" "${outcome}_test" "$retry_safe"
  } | docker exec -i "$POSTGRES_CONTAINER" psql -U postgres -d "$TEST_DB" -v ON_ERROR_STOP=1 >/dev/null
}
complete_one "$a" succeeded 200 false cu-a
complete_one "$b" failed 429 true ''

assert_sql() {
  actual=$(docker exec "$POSTGRES_CONTAINER" psql -U postgres -d "$TEST_DB" -Atqc "$1")
  [ "$actual" = "$2" ] || { echo "Assertion failed: $1 expected=$2 actual=$actual" >&2; exit 1; }
}
assert_sql "SELECT count(*) FROM handoffs WHERE estado='notified'" "1"
assert_sql "SELECT count(*) FROM external_operations WHERE status='failed' AND retry_safe" "1"
assert_sql "SELECT count(*) FROM handoffs WHERE estado='pending' AND next_notification_at > NOW()" "1"

# Stale processing is quarantined as unknown, never reclaimed.
docker exec "$POSTGRES_CONTAINER" psql -U postgres -d "$TEST_DB" -v ON_ERROR_STOP=1 -c "UPDATE external_operations SET status='processing', locked_at=NOW()-INTERVAL '1 hour', retry_safe=FALSE WHERE status='failed'; UPDATE handoffs SET next_notification_at=NOW() WHERE estado='pending';" >/dev/null
make_claim_sql "$TMP_DIR/stale.sql"
docker exec -i "$POSTGRES_CONTAINER" psql -U postgres -d "$TEST_DB" -At -v ON_ERROR_STOP=1 < "$TMP_DIR/stale.sql" > "$TMP_DIR/stale.out"
assert_sql "SELECT count(*) FROM external_operations WHERE status='unknown' AND reconciliation_required" "1"
! grep -q '|' "$TMP_DIR/stale.out"

# Missing ClickUp configuration defers without spending an attempt; once fixed,
# the same handoff becomes claimable again.
docker exec "$POSTGRES_CONTAINER" psql -U postgres -d "$TEST_DB" -v ON_ERROR_STOP=1 -c "
INSERT INTO handoffs (idempotency_key, conversation_id, phone_number, motivo, area, area_label, prioridad, responsable, trigger, escalation_area, intent)
VALUES ('1:finance:config-deferred', 1, '56912345678', 'payment_proof', 'finance', 'Finanzas', 'alta', 'Finanzas', 'config-deferred', 'finance', 'payment_proof');" >/dev/null
make_claim_sql "$TMP_DIR/config-claim.sql"
docker exec -i "$POSTGRES_CONTAINER" psql -U postgres -d "$TEST_DB" -At -F '|' -v ON_ERROR_STOP=1 < "$TMP_DIR/config-claim.sql" > "$TMP_DIR/config-claim.out"
config_row=$(grep '|' "$TMP_DIR/config-claim.out" | tail -n1)
[ -n "$config_row" ]
config_handoff_id=$(printf '%s' "$config_row" | cut -d'|' -f1)
complete_one "$config_row" deferred 0 false ''
assert_sql "SELECT estado || '|' || notification_attempt_count || '|' || (next_notification_at > NOW())::text FROM handoffs WHERE id=$config_handoff_id" "pending|0|true"
assert_sql "SELECT status || '|' || attempt_count FROM external_operations WHERE operation_key='handoff-clickup:$config_handoff_id'" "pending|0"
docker exec "$POSTGRES_CONTAINER" psql -U postgres -d "$TEST_DB" -c "UPDATE handoffs SET next_notification_at=NOW() WHERE id=$config_handoff_id" >/dev/null
make_claim_sql "$TMP_DIR/config-reclaim.sql"
docker exec -i "$POSTGRES_CONTAINER" psql -U postgres -d "$TEST_DB" -At -F '|' -v ON_ERROR_STOP=1 < "$TMP_DIR/config-reclaim.sql" > "$TMP_DIR/config-reclaim.out"
config_reclaimed=$(grep '|' "$TMP_DIR/config-reclaim.out" | tail -n1)
[ "$(printf '%s' "$config_reclaimed" | cut -d'|' -f1)" = "$config_handoff_id" ]
[ "$(printf '%s' "$config_reclaimed" | cut -d'|' -f16)" = "1" ]

# Database gate blocks terminal state while a handoff is pending/missing.
escalation_id=$(docker exec "$POSTGRES_CONTAINER" psql -U postgres -d "$TEST_DB" -Atqc "SELECT id FROM conversation_statuses WHERE code='escalation_required'")
closed_id=$(docker exec "$POSTGRES_CONTAINER" psql -U postgres -d "$TEST_DB" -Atqc "SELECT id FROM conversation_statuses WHERE code='closed'")
docker exec "$POSTGRES_CONTAINER" psql -U postgres -d "$TEST_DB" -c "UPDATE conversations SET conversation_status_id=$escalation_id WHERE id=1" >/dev/null
if docker exec "$POSTGRES_CONTAINER" psql -U postgres -d "$TEST_DB" -v ON_ERROR_STOP=1 -c "UPDATE conversations SET conversation_status_id=$closed_id WHERE id=1" >/dev/null 2>&1; then
  echo 'Gate did not block terminal conversation' >&2; exit 1
fi
docker exec "$POSTGRES_CONTAINER" psql -U postgres -d "$TEST_DB" -c "UPDATE handoffs SET estado='notified', notified_at=NOW() WHERE conversation_id=1; UPDATE conversations SET conversation_status_id=$closed_id WHERE id=1" >/dev/null
assert_sql "SELECT cs.code FROM conversations c JOIN conversation_statuses cs ON cs.id=c.conversation_status_id WHERE c.id=1" "closed"

echo 'Handoff routing local tests OK: positional SQL + ClickUp outcomes + concurrent claim + stale quarantine + durable closure gate'
