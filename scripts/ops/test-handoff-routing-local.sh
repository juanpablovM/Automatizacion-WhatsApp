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
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const prepareFixturePath = './tests/fixtures/workflow-nodes/ops-handoff-notification-scheduler/prepare-handoff-clickup-task.js';
const dispatchFixturePath = './tests/fixtures/workflow-nodes/ops-handoff-notification-scheduler/dispatch-handoff-clickup-task.js';
const { prepareHandoffClickup } = require(prepareFixturePath);
const { dispatchHandoffClickup } = require(dispatchFixturePath);
const safety = require('./tests/fixtures/workflow-nodes/ops-handoff-notification-scheduler/handoff-safety-contracts.js');
const scheduler = JSON.parse(fs.readFileSync('n8n/workflows/ops-handoff-notification-scheduler.json'));
const dispatcher = JSON.parse(fs.readFileSync('n8n/workflows/wa-inbound-downstream-dispatcher.json'));
const escalationPolicy = require('./tests/fixtures/workflow-nodes/wa-inbound-downstream-dispatcher/ensure-escalation-handoff.js');
const saga = require('./tests/fixtures/workflow-nodes/shared/v3-saga-runtime.js');
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
const base = { handoff_id: 7, operation_id: 10, claim_token: '00000000-0000-0000-0000-000000000001', area: 'claims', area_label: 'Reclamos', responsable: 'Equipo Reclamos', prioridad: 'urgente', motivo: 'complaint', phone_number: '56912345678', conversation_id: 1, idempotency_key: '1:complaint:x', operation_key: 'handoff-clickup:7' };
const env = { CLICKUP_API_TOKEN: 'token', CLICKUP_HANDOFF_LIST_ID: 'list', HANDOFF_CLICKUP_ASSIGNEES_JSON: '{"claims":[456]}' };
const prepared = prepareHandoffClickup(base, env);
assert.equal(prepared.should_dispatch_clickup, false);
assert.equal(prepared.clickup_payload, null);
assert.match(prepared.clickup_config_error, /HANDOFF_CLICKUP_AREA_unsupported:claims/);
const salesBase = {...base, area: 'sales', area_label: 'Ventas', responsable: 'Equipo Ventas'};
const salesEnv = {...env, HANDOFF_CLICKUP_ASSIGNEES_JSON: '{"sales":[456]}'};
const preparedSales = prepareHandoffClickup(salesBase, salesEnv);
assert.equal(preparedSales.should_dispatch_clickup, true);
assert.deepEqual(preparedSales.clickup_payload.assignees, [456]);
assert(preparedSales.clickup_payload.description.includes('Operation key: handoff-clickup:7'));
const missingConfig = prepareHandoffClickup(salesBase, {...salesEnv, HANDOFF_CLICKUP_ASSIGNEES_JSON: '{}'});
assert.equal(missingConfig.should_dispatch_clickup, false);
const validationDeferrals = [];
for (const [assignees, memberships, error] of [
  ['{', [], 'HANDOFF_CLICKUP_ASSIGNEES_JSON_invalid_json'],
  ['{}', [], 'HANDOFF_CLICKUP_ASSIGNEES_JSON_missing_area:sales'],
  ['{"sales":[456]}', [{ id: 456, active: false, assignable: true }], 'HANDOFF_CLICKUP_ASSIGNEE_inactive:456'],
  ['{"sales":[456]}', [{ id: 456, active: true, assignable: false }], 'HANDOFF_CLICKUP_ASSIGNEE_unassignable:456'],
]) {
  const deferred = safety.prepareValidatedSalesHandoff({...base, area: 'sales'}, {...env, HANDOFF_CLICKUP_ASSIGNEES_JSON: assignees}, memberships);
  assert.equal(deferred.should_dispatch_clickup, false);
  assert.equal(deferred.clickup_config_error, error);
  validationDeferrals.push(deferred);
}
const validSales = safety.prepareValidatedSalesHandoff({...base, area: 'sales'}, {...env, HANDOFF_CLICKUP_ASSIGNEES_JSON: '{"sales":[456]}'}, [{ id: 456, active: true, assignable: true }]);
assert.equal(validSales.should_dispatch_clickup, true);
assert.equal(safety.reconcileExactMarker([], 'handoff-clickup:7').outcome, 'reconciliation_required');
assert.equal(safety.reconcileExactMarker([{ description: 'Operation key: handoff-clickup:7' }], 'handoff-clickup:7').outcome, 'succeeded');
assert.equal(safety.reconcileExactMarker([{ description: 'Operation key: handoff-clickup:7' }, { description: 'Operation key: handoff-clickup:7' }], 'handoff-clickup:7').outcome, 'duplicate_incident');
const authorization = { operation_key: 'handoff-clickup:7', list_id: 'list', search_horizon: 'all-pages', evidence_revision: 'r1', consumed: false };
assert.equal(safety.consumeNoEffectAuthorization(authorization, {...authorization, evidence_revision: 'r0'}).allow_post, false);
assert.equal(safety.consumeNoEffectAuthorization({...authorization, consumed: true}, authorization).allow_post, false);
assert.equal(safety.consumeNoEffectAuthorization(authorization, authorization).allow_post, true);
const policy = {
  version: 'ai_prd_turn_policy/v3',
  policy_digest: 'policy-v3-recovery',
  turn: { id: 'turn-v3-recovery', conversation_id: 44, inbound_event_id: 88 },
  state_authority: { expected_snapshot_digest: 'snapshot-before-v3' },
  failure_policy: { max_complete_repairs: 1 },
};
const rejected = {
  schema: 'conversation_validation_result/v3',
  valid: false,
  errors: [{ code: 'unsupported_claim', path: '/reply_text', disposition: 'repair' }],
};
const repair = saga.buildV3RepairRequest({ policy, validation: rejected, repairAttempt: 0 });
assert.equal(repair.schema, 'ai_conversation_repair_request/v3');
assert.equal(repair.policy_digest, policy.policy_digest);
assert.equal(repair.complete_repair, true);
assert.deepEqual(repair.errors, rejected.errors);
assert.throws(
  () => saga.buildV3RepairRequest({ policy, validation: rejected, repairAttempt: 1 }),
  /repair_limit_exhausted/,
);
const assistantPolicy = { ...policy, policy_digest: 'a'.repeat(64) };
const assistantRepair = saga.buildV3RepairRequest({
  policy: assistantPolicy, validation: rejected, repairAttempt: 0,
});
const runBuildAi = new Function(
  'items', '$env',
  fs.readFileSync('./tests/fixtures/workflow-nodes/ai-lead-qualification-assistant/build-ai-request.js', 'utf8'),
);
const repairAi = runBuildAi([{ json: {
  contract_version: 'v3', turn_policy: assistantPolicy,
  ai_repair_request: assistantRepair,
} }], {
  AI_LEAD_ASSISTANT_ENABLED: 'true', AI_DIRECT_API_KEY: 'test-key',
  AI_DIRECT_API_MODEL: 'test-model', AI_DIRECT_API_PATH: '/chat/completions',
});
const repairPrompt = JSON.parse(repairAi[0].json.ai_request.messages[1].content);
assert.deepEqual(repairPrompt.repair_request.errors, rejected.errors);
assert.equal(repairPrompt.repair_request.policy_digest, assistantPolicy.policy_digest);
assert.equal(repairPrompt.repair_request.repair_attempt, 1);
const preTurnState = { city: 'Santiago', service: 'installation', budget: 'pending' };
const outage = saga.planV3Recovery({
  policy, validation: null, repairAttempt: 0, providerOutcome: 'outage',
  preTurnState, expectedSnapshotDigest: 'snapshot-before-v3',
});
assert.equal(outage.action, 'contingency');
assert.deepEqual(outage.decision.mutations, []);
assert.deepEqual(outage.preserved_state, preTurnState);
assert.equal(outage.decision.effect_commands[0].type, 'internal_handoff');
const unreleased = saga.releaseV3Contingency({ decision: outage.decision, handoffReceipt: null });
assert.equal(unreleased.release_delivery, false);
assert.equal(unreleased.reply_text, null);
const handoffReceipt = {
  operation_key: outage.decision.effect_commands[0].operation_key,
  handoff_id: 701,
  status: 'succeeded',
};
const released = saga.releaseV3Contingency({ decision: outage.decision, handoffReceipt });
assert.equal(released.release_delivery, true);
assert.equal(released.reply_text, outage.decision.reply.text);
assert.equal(released.handoff_receipt.handoff_id, 701);
const replayedOutage = saga.planV3Recovery({
  policy, validation: null, repairAttempt: 0, providerOutcome: 'outage',
  preTurnState, expectedSnapshotDigest: 'snapshot-before-v3',
});
assert.equal(replayedOutage.decision.decision_id, outage.decision.decision_id);
assert.equal(
  replayedOutage.decision.effect_commands[0].operation_key,
  outage.decision.effect_commands[0].operation_key,
);
assert.equal(replayedOutage.decision.reply.delivery_key, outage.decision.reply.delivery_key);
const afterFailedRepair = saga.planV3Recovery({
  policy, validation: rejected, repairAttempt: 1, providerOutcome: 'accepted',
  preTurnState, expectedSnapshotDigest: 'snapshot-before-v3',
});
assert.equal(afterFailedRepair.action, 'contingency');
assert.deepEqual(afterFailedRepair.preserved_state, preTurnState);
const runPreparePerItem = new Function('$json', '$env', fs.readFileSync(prepareFixturePath, 'utf8'));
  const deferredItem = runPreparePerItem(salesBase, {...salesEnv, HANDOFF_CLICKUP_ASSIGNEES_JSON: '{}'});
assert(deferredItem && !Array.isArray(deferredItem));
assert.equal(deferredItem.json.should_dispatch_clickup, false);
  assert.equal(deferredItem.json.clickup_config_error, 'HANDOFF_CLICKUP_ASSIGNEES_JSON_missing_area:sales');
(async () => {
  const runDispatchPerItem = new AsyncFunction('$json', 'helpers', '$env', fs.readFileSync(dispatchFixturePath, 'utf8'));
  let deferredHttpCalls = 0;
  const deferredRuntime = await runDispatchPerItem(missingConfig, {
    httpRequest: async () => { deferredHttpCalls += 1; throw new Error('must not call HTTP'); },
  }, env);
  assert(deferredRuntime && !Array.isArray(deferredRuntime));
  assert.equal(deferredRuntime.json.notification_outcome, 'deferred');
  assert.equal(deferredHttpCalls, 0);
  let enabledHttpCalls = 0;
  const enabledRuntime = await runDispatchPerItem(preparedSales, {
    httpRequest: async () => {
      enabledHttpCalls += 1;
      return { statusCode: 200, body: { id: 'cu-runtime', url: 'https://clickup.test/cu-runtime' } };
    },
  }, env);
  assert(enabledRuntime && !Array.isArray(enabledRuntime));
  assert.equal(enabledRuntime.json.notification_outcome, 'succeeded');
  assert.equal(enabledRuntime.json.notification_external_id, 'cu-runtime');
  assert.equal(enabledHttpCalls, 1);
  const ok = await dispatchHandoffClickup(preparedSales, async () => ({statusCode: 200, body: {id:'cu-1', url:'https://clickup.test/cu-1'}}), 'token');
  assert.equal(ok.notification_outcome, 'succeeded');
  assert.equal(ok.notification_external_id, 'cu-1');
  const unverifiable = await dispatchHandoffClickup(preparedSales, async () => ({statusCode: 200, body: {}}), 'token');
  assert.equal(unverifiable.notification_outcome, 'unknown');
  const retry = await dispatchHandoffClickup(preparedSales, async () => ({statusCode: 429, body: {}}), 'token');
  assert.equal(retry.notification_outcome, 'failed');
  assert.equal(retry.notification_retry_safe, true);
  const terminal = await dispatchHandoffClickup(preparedSales, async () => ({statusCode: 400, body: {}}), 'token');
  assert.equal(terminal.notification_outcome, 'failed');
  assert.equal(terminal.notification_retry_safe, false);
  const ambiguous = await dispatchHandoffClickup(preparedSales, async () => ({statusCode: 503, body: {}}), 'token');
  assert.equal(ambiguous.notification_outcome, 'unknown');
  assert.equal(ambiguous.notification_retry_safe, false);
  const timeout = await dispatchHandoffClickup(preparedSales, async () => { throw new Error('timeout'); }, 'token');
  assert.equal(timeout.notification_outcome, 'unknown');
  const deferred = await dispatchHandoffClickup(missingConfig, async () => { throw new Error('must not call HTTP'); }, 'token');
  assert.equal(deferred.notification_outcome, 'deferred');
  assert.equal(deferred.notification_retry_safe, false);
  for (const validationDeferral of validationDeferrals) {
    const outcome = await dispatchHandoffClickup(validationDeferral, async () => { throw new Error('must not POST'); }, 'token');
    assert.equal(outcome.notification_outcome, 'deferred');
  }
  const reconciliationRow = {...preparedSales, reconciliation_required: true};
  const deniedMethods = [];
  const denied = await dispatchHandoffClickup(reconciliationRow, async (request) => {
    deniedMethods.push(request.method);
    return {statusCode: 200, body: {tasks: [], last_page: true}};
  }, 'token');
  assert.equal(denied.notification_outcome, 'unknown');
  assert.deepEqual(deniedMethods, ['GET', 'GET']);
  const zeroMethods = [];
  const authorizedZero = await dispatchHandoffClickup({...reconciliationRow, no_effect_authorization_consumed: true}, async (request) => {
    zeroMethods.push(request.method);
    return request.method === 'POST'
      ? {statusCode: 200, body: {id: 'cu-zero', url: 'https://clickup.test/cu-zero'}}
      : {statusCode: 200, body: {tasks: [], last_page: true}};
  }, 'token');
  assert.equal(authorizedZero.notification_outcome, 'succeeded');
  assert.deepEqual(zeroMethods, ['GET', 'GET', 'POST']);
  const oneMethods = [];
  const one = await dispatchHandoffClickup(reconciliationRow, async (request) => {
    oneMethods.push(request.method);
    return {statusCode: 200, body: {tasks: request.url.includes('archived=true') ? [] : [{id: 'cu-one', url: 'https://clickup.test/cu-one', description: 'Operation key: handoff-clickup:7'}], last_page: true}};
  }, 'token');
  assert.equal(one.notification_outcome, 'succeeded');
  assert.equal(one.notification_external_id, 'cu-one');
  assert.deepEqual(oneMethods, ['GET', 'GET']);
  const duplicateMethods = [];
  const duplicate = await dispatchHandoffClickup(reconciliationRow, async (request) => {
    duplicateMethods.push(request.method);
    return {statusCode: 200, body: {tasks: request.url.includes('archived=true') ? [] : [
      {id: 'cu-duplicate-a', description: 'Operation key: handoff-clickup:7'},
      {id: 'cu-duplicate-b', description: 'Operation key: handoff-clickup:7'},
    ], last_page: true}};
  }, 'token');
  assert.equal(duplicate.notification_outcome, 'failed');
  assert.deepEqual(duplicateMethods, ['GET', 'GET']);
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
  external_url=''
  [ -n "$external_id" ] && external_url="https://clickup.test/$external_id"
  operation_id=$(printf '%s' "$row" | cut -d'|' -f14)
  claim_token=$(printf '%s' "$row" | cut -d'|' -f17)
  {
    printf '%s\n' 'PREPARE handoff_complete(bigint,uuid,text,integer,text,text,text,text,boolean) AS'
    cat db/queries/n8n/handoff-routing/03_complete_notification.sql
    printf "; EXECUTE handoff_complete(%s,'%s','%s',%s,'%s','%s','%s','{}',%s);\n" "$operation_id" "$claim_token" "$outcome" "$status" "$external_id" "$external_url" "${outcome}_test" "$retry_safe"
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
assert_sql "SELECT count(*) FROM audit_logs WHERE event_name='handoff_clickup_notification' AND result='succeeded'" "1"

# Stale processing is quarantined as unknown, never reclaimed.
docker exec "$POSTGRES_CONTAINER" psql -U postgres -d "$TEST_DB" -v ON_ERROR_STOP=1 -c "UPDATE external_operations SET status='processing', locked_at=NOW()-INTERVAL '1 hour', retry_safe=FALSE WHERE status='failed'; UPDATE handoffs SET next_notification_at=NOW() WHERE estado='pending';" >/dev/null
make_claim_sql "$TMP_DIR/stale.sql"
docker exec -i "$POSTGRES_CONTAINER" psql -U postgres -d "$TEST_DB" -At -v ON_ERROR_STOP=1 < "$TMP_DIR/stale.sql" > "$TMP_DIR/stale.out"
assert_sql "SELECT count(*) FROM external_operations WHERE status='unknown' AND reconciliation_required" "1"
! grep -q '|' "$TMP_DIR/stale.out"

# A no-effect authorization is bound to complete reconciliation evidence and is
# consumed once by CAS; stale evidence and a second use remain unauthorized.
stale_operation=$(docker exec "$POSTGRES_CONTAINER" psql -U postgres -d "$TEST_DB" -Atqc "SELECT id FROM external_operations WHERE status='unknown' AND reconciliation_required LIMIT 1")
stale_key=$(docker exec "$POSTGRES_CONTAINER" psql -U postgres -d "$TEST_DB" -Atqc "SELECT operation_key FROM external_operations WHERE id=$stale_operation")
docker exec "$POSTGRES_CONTAINER" psql -U postgres -d "$TEST_DB" -c "UPDATE external_operations SET request_payload=jsonb_build_object('operation_key','$stale_key','list_id','list','search_horizon','all-pages','evidence_revision','r1') WHERE id=$stale_operation" >/dev/null
authorize_no_effect() {
  horizon=$1 revision=$2
  {
    printf '%s\n' 'PREPARE authorize_no_effect(bigint,text,text,text,text) AS'
    cat db/queries/ops/authorize-handoff-no-effect.sql
    printf "; EXECUTE authorize_no_effect(%s,'%s','list','%s','%s');\n" "$stale_operation" "$stale_key" "$horizon" "$revision"
  } | docker exec -i "$POSTGRES_CONTAINER" psql -U postgres -d "$TEST_DB" -At -v ON_ERROR_STOP=1
}
! authorize_no_effect 'partial-pages' 'r0' | grep -qx t
authorize_no_effect 'all-pages' 'r1' | grep -qx t
! authorize_no_effect 'all-pages' 'r1' | grep -qx t
make_claim_sql "$TMP_DIR/authorized-reconciliation.sql"
docker exec -i "$POSTGRES_CONTAINER" psql -U postgres -d "$TEST_DB" -At -F '|' -v ON_ERROR_STOP=1 < "$TMP_DIR/authorized-reconciliation.sql" > "$TMP_DIR/authorized-reconciliation.out"
authorized_reconciliation=$(grep '|' "$TMP_DIR/authorized-reconciliation.out" | tail -n1)
[ -n "$authorized_reconciliation" ]
[ "$(printf '%s' "$authorized_reconciliation" | cut -d'|' -f18)" = "t" ]
[ "$(printf '%s' "$authorized_reconciliation" | cut -d'|' -f19)" = "t" ]
complete_one "$authorized_reconciliation" failed 400 false ''
assert_sql "SELECT status || '|' || retry_safe FROM external_operations WHERE id=$stale_operation" "failed|false"

# Missing ClickUp configuration defers without spending an attempt; once fixed,
# the same handoff becomes claimable again.
preserved_inbound_event=$(docker exec "$POSTGRES_CONTAINER" psql -U postgres -d "$TEST_DB" -Atqc "
  INSERT INTO inbound_events (
    instance_name, event_fingerprint, dedupe_key, source_number_id, phone_number,
    queue_key, should_process, processing_status, processing_phase, failed_at, failure_reason
  ) VALUES (
    'test-instance', 'preserved-handoff-fixture', 'preserved-handoff-fixture', 1,
    '56912345678', '1:56912345678', TRUE, 'failed', 'dispatching', NOW(), 'failed_acceptance_dispatch'
  ) RETURNING id")
docker exec "$POSTGRES_CONTAINER" psql -U postgres -d "$TEST_DB" -v ON_ERROR_STOP=1 -c "
INSERT INTO handoffs (idempotency_key, conversation_id, inbound_event_id, phone_number, motivo, area, area_label, prioridad, responsable, trigger, escalation_area, intent)
VALUES ('1:finance:config-deferred', 1, $preserved_inbound_event, '56912345678', 'payment_proof', 'finance', 'Finanzas', 'alta', 'Finanzas', 'config-deferred', 'finance', 'payment_proof');" >/dev/null
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

# Claim-token CAS rejects stale completion. The preserved failure closes the
# exact failed-dispatch inbound event, unknown operation, pending handoff, and key.
audit_before=$(docker exec "$POSTGRES_CONTAINER" psql -U postgres -d "$TEST_DB" -Atqc "SELECT count(*) FROM audit_logs")
stale_operation=$(printf '%s' "$config_reclaimed" | cut -d'|' -f14)
{
  printf '%s\n' 'PREPARE stale_complete(bigint,uuid,text,integer,text,text,text,text,boolean) AS'
  cat db/queries/n8n/handoff-routing/03_complete_notification.sql
  printf "; EXECUTE stale_complete(%s,'00000000-0000-0000-0000-000000000099','succeeded',200,'stale-should-not-write','https://clickup.test/stale','stale','{}',false);\n" "$stale_operation"
} | docker exec -i "$POSTGRES_CONTAINER" psql -U postgres -d "$TEST_DB" -v ON_ERROR_STOP=1 >/dev/null
assert_sql "SELECT count(*) FROM audit_logs" "$audit_before"
preserved_operation=$stale_operation
preserved_handoff=$(printf '%s' "$config_reclaimed" | cut -d'|' -f1)
docker exec "$POSTGRES_CONTAINER" psql -U postgres -d "$TEST_DB" -v ON_ERROR_STOP=1 -c "
  UPDATE external_operations
  SET status='unknown', reconciliation_required=TRUE,
      reconciliation_reason='stale_processing_without_provider_result', claim_token=NULL
  WHERE id=$preserved_operation;" >/dev/null
{
  printf '%s\n' 'PREPARE close_preserved(bigint,bigint,bigint,text) AS'
  cat db/queries/ops/close-preserved-handoff-test-artifact.sql
  printf "; EXECUTE close_preserved(%s,%s,%s,'handoff-clickup:%s');\n" "999999" "$preserved_operation" "$preserved_handoff" "$preserved_handoff"
  printf "; EXECUTE close_preserved(%s,%s,%s,'wrong-operation-key');\n" "$preserved_inbound_event" "$preserved_operation" "$preserved_handoff"
  printf "; EXECUTE close_preserved(%s,%s,%s,'handoff-clickup:%s');\n" "$preserved_inbound_event" "$preserved_operation" "$preserved_handoff" "$preserved_handoff"
  printf "; EXECUTE close_preserved(%s,%s,%s,'handoff-clickup:%s');\n" "$preserved_inbound_event" "$preserved_operation" "$preserved_handoff" "$preserved_handoff"
} | docker exec -i "$POSTGRES_CONTAINER" psql -U postgres -d "$TEST_DB" -At -v ON_ERROR_STOP=1 > "$TMP_DIR/close-preserved.out"
[ "$(tr '\n' '|' < "$TMP_DIR/close-preserved.out")" = "PREPARE|f|f|t|f|" ]
assert_sql "SELECT status || '|' || retry_safe || '|' || reconciliation_required || '|' || (external_id IS NULL AND external_url IS NULL)::text FROM external_operations WHERE id=$preserved_operation" "failed|false|false|true"
assert_sql "SELECT count(*) FROM external_operations WHERE id=$preserved_operation AND status IN ('pending','processing')" "0"
assert_sql "SELECT (deleted_at IS NOT NULL)::text || '|' || (estado NOT IN ('notified','resolved') AND notified_at IS NULL)::text FROM handoffs WHERE id=$preserved_handoff" "true|true"
assert_sql "SELECT processing_status || '|' || processing_phase || '|' || failure_reason || '|' || (processing_token IS NULL AND failed_at IS NOT NULL)::text FROM inbound_events WHERE id=$preserved_inbound_event" "failed|completed|preserved_test_artifact_closed_no_recovery|true"
assert_sql "SELECT count(*) FROM audit_logs WHERE event_name IN ('external_operation_preserved_test_artifact_closed','handoff_preserved_test_artifact_closed','inbound_event_preserved_test_artifact_closed') AND result='failed_test_artifact'" "3"

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
