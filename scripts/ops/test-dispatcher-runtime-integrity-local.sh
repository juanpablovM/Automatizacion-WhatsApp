#!/bin/sh
set -eu

ROOT_DIR=$(CDPATH= cd -- "$(dirname "$0")/../.." && pwd)
MODE=${1:-all}

run_semantic() {
  node - "$ROOT_DIR/n8n/workflows/wa-inbound-downstream-dispatcher.json" <<'NODE'
const fs = require('fs');
const vm = require('vm');
const workflow = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const node = (name) => workflow.nodes.find((candidate) => candidate.name === name);
const assert = (condition, message) => { if (!condition) throw new Error(message); };
const nodeIds = workflow.nodes.map((candidate) => candidate.id);
assert(nodeIds.every((id) => typeof id === 'string' && id.length > 0), 'every dispatcher node must have a stable ID');
assert(new Set(nodeIds).size === nodeIds.length, 'dispatcher node IDs must be unique');
const prepare = node('Prepare Verified Handoff');
assert(prepare, 'Prepare Verified Handoff node is missing');
const merge = node('Merge Lead Context');
assert(merge.parameters.options.clashHandling.values.resolveClash === 'preferInput2', 'persisted lead output must win Merge Lead Context field clashes');

function evaluate(row) {
  const context = { items: [{ json: row }] };
  const result = new vm.Script(`(() => { ${prepare.parameters.jsCode} })()`).runInNewContext(context);
  return JSON.parse(JSON.stringify(result));
}

const missing = evaluate({ conversation_id: 10, phone_number: '56900000000' });
assert(missing.length === 1, 'missing lead_id must emit exactly one item');
assert(missing[0].json.should_send_handoff === false, 'missing lead_id must not send handoff');
assert(missing[0].json.message === null && missing[0].json.lead_id === null, 'missing lead sentinel is invalid');

const assigned = evaluate({
  lead_id: 75, conversation_id: 95, phone_number: '56900000000',
  assignment_result: 'assigned', assigned_seller_id: 4, seller_name: 'Test Seller',
});
assert(assigned.length === 1, 'valid lead_id must emit exactly one item');
assert(assigned[0].json.should_send_handoff === true, 'valid lead_id must send handoff');
assert(assigned[0].json.message.includes('asignada'), 'assigned copy must confirm assignment');
assert(!assigned[0].json.message.includes('No pude asignarla'), 'assigned copy must not claim assignment failure');

const unassigned = evaluate({
  lead_id: 76, conversation_id: 96, phone_number: '56900000001',
  assignment_result: 'failed', assigned_seller_id: null,
});
assert(unassigned.length === 1 && unassigned[0].json.should_send_handoff === true, 'unassigned persisted lead must still send registration handoff');
assert(unassigned[0].json.message.includes('registré'), 'unassigned copy must confirm registration');
assert(!unassigned[0].json.message.includes('asignada'), 'unassigned copy must not claim assignment');

const condition = node('Handoff Items?').parameters.conditions.conditions[0].leftValue;
assert(condition.includes('should_send_handoff'), 'Handoff Items? must route on should_send_handoff');
const routes = workflow.connections['Handoff Items?'].main;
assert(routes[0][0].node === 'Execute Handoff Outbound', 'true lane must send one handoff');
assert(routes[1][0].node === 'Handoff Lane Skipped', 'false lane must preserve completion');
console.log('Dispatcher semantic integrity OK: 3 contract cases');
NODE
}

run_sync() {
  tmp_dir=$(mktemp -d)
  trap 'rm -rf "$tmp_dir"' EXIT
  mkdir "$tmp_dir/candidate"
  node - "$ROOT_DIR" "$tmp_dir/valid.json" "$tmp_dir/candidate" <<'NODE'
const fs = require('fs');
const path = require('path');
const root = process.argv[2];
const output = process.argv[3];
const candidateDir = process.argv[4];
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'n8n/workflow-links.json')));
const files = fs.readdirSync(path.join(root, 'n8n/workflows')).filter((name) => name.endsWith('.json'));
const workflows = files.map((file, index) => {
  const workflow = JSON.parse(fs.readFileSync(path.join(root, 'n8n/workflows', file)));
  workflow.id = `runtime-${index + 1}`;
  workflow.active = false;
  workflow.settings = workflow.settings || {};
  return workflow;
});
const ids = Object.fromEntries(workflows.map((workflow) => [workflow.name, workflow.id]));
for (const workflow of workflows) {
  if (workflow.name !== manifest.errorWorkflow.name) workflow.settings.errorWorkflow = ids[manifest.errorWorkflow.name];
}
for (const link of manifest.links) {
  const workflow = workflows.find((candidate) => candidate.name === link.sourceWorkflow);
  const node = workflow.nodes.find((candidate) => candidate.name === link.node);
  node.parameters.workflowId.value = ids[link.targetWorkflow];
}
fs.writeFileSync(output, JSON.stringify(workflows));
for (const workflow of workflows) fs.writeFileSync(`${candidateDir}/${workflow.id}.json`, JSON.stringify(workflow));
NODE

  cp "$tmp_dir/valid.json" "$tmp_dir/case.json"
  sh "$ROOT_DIR/scripts/dev/sync-n8n-workflows.sh" --verify-remote "$tmp_dir/case.json" "$tmp_dir/candidate" >/dev/null

  assert_rejected() {
    label=$1
    if sh "$ROOT_DIR/scripts/dev/sync-n8n-workflows.sh" --verify-remote "$tmp_dir/case.json" "$tmp_dir/candidate" >/dev/null 2>&1; then
      echo "ERROR: sync verifier accepted $label" >&2
      exit 1
    fi
  }

  jq '.[0].id = ""' "$tmp_dir/valid.json" > "$tmp_dir/case.json"; assert_rejected "empty ID"
  jq '.[0].id = "stale" | .[1].id = "stale"' "$tmp_dir/valid.json" > "$tmp_dir/case.json"; assert_rejected "duplicate ID"
  jq 'del(.[0])' "$tmp_dir/valid.json" > "$tmp_dir/case.json"; assert_rejected "missing workflow"
  jq '. += [.[0]]' "$tmp_dir/valid.json" > "$tmp_dir/case.json"; assert_rejected "duplicate workflow"
  jq '.[0].settings.errorWorkflow = "wrong"' "$tmp_dir/valid.json" > "$tmp_dir/case.json"; assert_rejected "errorWorkflow mismatch"
  jq 'map(if .name == "WA - Inbound Entry" then (.nodes |= map(if .name == "Execute Durable Downstream Dispatcher" then .parameters.workflowId.value = "stale" else . end)) else . end)' "$tmp_dir/valid.json" > "$tmp_dir/case.json"; assert_rejected "exported link mismatch"
  jq 'map(if .name == "WA - Inbound Downstream Dispatcher" then (.nodes |= map(if .name == "Prepare Verified Handoff" then .parameters.jsCode = "return [];" else . end)) else . end)' "$tmp_dir/valid.json" > "$tmp_dir/case.json"; assert_rejected "node logic drift"
  jq 'map(if .name == "WA - Inbound Downstream Dispatcher" then del(.connections["Prepare Verified Handoff"]) else . end)' "$tmp_dir/valid.json" > "$tmp_dir/case.json"; assert_rejected "connection drift"
  jq '.[0].meta = {tampered:true}' "$tmp_dir/valid.json" > "$tmp_dir/case.json"; assert_rejected "metadata drift"
  jq '.[0].staticData = {mutable:true}' "$tmp_dir/valid.json" > "$tmp_dir/case.json"
  sh "$ROOT_DIR/scripts/dev/sync-n8n-workflows.sh" --verify-remote "$tmp_dir/case.json" "$tmp_dir/candidate" >/dev/null
  node - "$ROOT_DIR/scripts/dev/sync-n8n-workflows.sh" "$ROOT_DIR/scripts/ops/test-e2e-lead-creation.sh" <<'NODE'
const source = require('fs').readFileSync(process.argv[2], 'utf8');
const e2e = require('fs').readFileSync(process.argv[3], 'utf8');
const assert = (condition, message) => { if (!condition) throw new Error(message); };
const restore = source.slice(source.indexOf('restore_runtime_workflows()'), source.indexOf('activate_runtime_workflows()'));
assert(restore.indexOf('set_callers_active false') < restore.indexOf('copy_and_import "$snapshot_dir"'), 'rollback must pause before import');
assert(source.includes('for workflow_id in $workflow_ids'), 'pause must cover every duplicate caller ID');
assert(source.includes('assert_workflows_active'), 'activation must verify persisted runtime state');
assert(source.includes('set_callers_active true entry'), 'acceptance may activate Entry only');
assert(source.includes('restore_evolution_webhook'), 'Evolution cleanup must be registered');
assert(source.includes('E2E_WEBHOOK_PATH='), 'acceptance must use a temporary webhook path');
assert(source.includes('purge_inbound_entry_acceptance_webhook_rows'), 'cleanup must be scoped to acceptance webhooks');
assert(!source.includes("AND method='POST' AND node='EvolutionWebhook';\""), 'cleanup must never delete every Entry POST webhook');
assert(source.includes("node='EvolutionWebhook'") && source.includes("node='InboundHealthCheck'"), 'runtime readiness must verify POST and GET webhooks');
assert(e2e.includes("LIKE '%/${E2E_WEBHOOK_PATH}'"), 'E2E must resolve the exact temporary webhook suffix');
assert(!e2e.includes('ORDER BY \\"webhookPath\\" DESC LIMIT 1'), 'E2E must not select an arbitrary lexicographic webhook');
assert(source.includes("<<'SQL'"), 'remote export SQL must use a quote-preserving heredoc');
assert(source.includes('"staticData"') && source.includes('"pinData"'), 'camelCase workflow columns must stay quoted');
const sync = source.slice(source.indexOf('sync_workflows()'), source.indexOf('case "${1:-}"'));
assert(sync.indexOf('ensure_unique_runtime_names') < sync.indexOf('snapshot_runtime_workflows "$snapshot_dir"'), 'runtime names must be unique before snapshot');
assert(sync.indexOf('run_controlled_acceptance') < sync.indexOf('activate_runtime_workflows'), 'acceptance must precede final activation');
const activation = source.slice(source.indexOf('activate_runtime_workflows()'), source.indexOf('purge_inbound_entry_acceptance_webhook_rows()'));
assert(activation.includes("'.active // false'") && activation.includes('set_named_workflows_active true'), 'final activation must restore declared active schedulers');
const verifyCli = source.slice(source.indexOf('  --verify-remote)'), source.indexOf('  --snapshot)'));
assert(verifyCli.includes('prepare_import_dir') && verifyCli.includes('verify_remote'), '--verify-remote must compare resolved local definitions');
NODE
  echo "Dispatcher sync integrity OK: 1 valid + 9 rejected fixtures + release ordering + webhook gates"
}


case "$MODE" in
  semantic) run_semantic ;;
  all) run_semantic; run_sync ;;
  sync) run_sync ;;
  *) echo "Usage: $0 [semantic|sync|all]" >&2; exit 2 ;;
esac
