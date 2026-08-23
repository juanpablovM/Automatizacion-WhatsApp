#!/bin/sh
set -eu

ROOT_DIR=$(CDPATH= cd -- "$(dirname "$0")/../.." && pwd)
cd "$ROOT_DIR"

CONFIG_SCRIPT=scripts/ops/configure-handoff-clickup.sh
DEPLOY_SCRIPT=scripts/ops/deploy-handoff-scheduler.sh
LEAD_WORKFLOW=n8n/workflows/crm-clickup-sync-lead.json
HANDOFF_WORKFLOW=n8n/workflows/ops-handoff-notification-scheduler.json

[ -x "$CONFIG_SCRIPT" ] || { echo 'missing guarded ClickUp configuration script' >&2; exit 1; }
[ -x "$DEPLOY_SCRIPT" ] || { echo 'missing scheduler-only deployment script' >&2; exit 1; }
sh -n "$CONFIG_SCRIPT"
sh -n "$DEPLOY_SCRIPT"

node - "$CONFIG_SCRIPT" "$DEPLOY_SCRIPT" "$LEAD_WORKFLOW" "$HANDOFF_WORKFLOW" <<'NODE'
const assert = require('assert');
const childProcess = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const [configPath, deployPath, leadWorkflowPath, handoffWorkflowPath] = process.argv.slice(2);
const [config, deploy] = [configPath, deployPath].map((path) => fs.readFileSync(path, 'utf8'));
const [leadWorkflow, handoffWorkflow] = [leadWorkflowPath, handoffWorkflowPath].map((path) => fs.readFileSync(path, 'utf8'));
const genericListKey = 'CLICKUP_' + 'LIST_ID';
assert(leadWorkflow.includes('CLICKUP_LEADS_LIST_ID'), 'CRM lead workflow must use the dedicated leads list');
assert(!leadWorkflow.includes('CLICKUP_HANDOFF_LIST_ID'), 'CRM lead workflow must not use the handoff list');
assert(!leadWorkflow.includes(genericListKey), 'CRM lead workflow must not use the generic list key');
assert(handoffWorkflow.includes('CLICKUP_HANDOFF_LIST_ID'), 'handoff workflow must use the dedicated handoff list');
assert(!handoffWorkflow.includes('CLICKUP_LEADS_LIST_ID'), 'handoff workflow must not use the leads list');
assert(!handoffWorkflow.includes(genericListKey), 'handoff workflow must not use the generic list key');
const cliDir = fs.mkdtempSync(path.join(os.tmpdir(), 'handoff-config-cli-'));
const isolatedConfig = path.join(cliDir, 'scripts', 'ops', 'configure-handoff-clickup.sh');
const isolatedBin = path.join(cliDir, 'bin');
fs.mkdirSync(path.dirname(isolatedConfig), { recursive: true });
fs.mkdirSync(isolatedBin);
fs.copyFileSync(configPath, isolatedConfig);
fs.writeFileSync(path.join(isolatedBin, 'dirname'), '#!/bin/sh\n/usr/bin/dirname "$@"\n', { mode: 0o700 });
fs.symlinkSync('/usr/bin/cat', path.join(isolatedBin, 'cat'));
const envPath = path.join(cliDir, '.env');
const sourcedMarker = path.join(cliDir, 'env-sourced');
const envContents = ': > "$ENV_SOURCED_MARKER"\nCLICKUP_API_TOKEN=must-not-be-read\n';
fs.writeFileSync(envPath, envContents);
const runConfigCli = (args) => childProcess.spawnSync('/bin/sh', [isolatedConfig, ...args], {
  env: { PATH: isolatedBin, ENV_SOURCED_MARKER: sourcedMarker },
  encoding: 'utf8',
});
const assertNoConfigSideEffects = (result) => {
  assert.strictEqual(fs.existsSync(sourcedMarker), false, 'CLI rejection/help must not source .env');
  assert.strictEqual(fs.readFileSync(envPath, 'utf8'), envContents, 'CLI rejection/help must not write .env');
  assert.strictEqual(fs.readdirSync(cliDir).sort().join(','), '.env,bin,scripts', 'CLI rejection/help must not create runtime files');
  assert(!/missing dependency/.test(result.stderr), 'CLI parsing must happen before dependency checks');
};
for (const helpArg of ['-h', '--help']) {
  const result = runConfigCli([helpArg]);
  assert.strictEqual(result.status, 0, `${helpArg} must exit successfully without runtime dependencies`);
  assert.match(result.stdout, /^Uso:/, `${helpArg} must print usage`);
  assertNoConfigSideEffects(result);
}
for (const args of [['--unknown'], ['--help', '--recreate-n8n']]) {
  const result = runConfigCli(args);
  assert.notStrictEqual(result.status, 0, `${args.join(' ')} must fail`);
  assert.match(result.stderr, /ERROR:.*\nUso:/s, 'invalid arguments must print a clear error and usage');
  assertNoConfigSideEffects(result);
}
assert.match(runConfigCli(['--unknown']).stderr, /argumento desconocido: --unknown/, 'unknown option errors must identify the rejected argument');
for (const args of [[], ['--recreate-n8n']]) {
  const result = runConfigCli(args);
  assert.notStrictEqual(result.status, 0, 'accepted operational modes must continue to dependency checks in the isolated harness');
  assert.match(result.stderr, /missing dependency: curl/, 'accepted operational modes must preserve the guarded runtime path');
  assert.strictEqual(fs.existsSync(sourcedMarker), false, 'dependencies must still be checked before sourcing .env');
}
fs.rmSync(cliDir, { recursive: true, force: true });
const logicalDir = fs.mkdtempSync(path.join(os.tmpdir(), 'handoff-logical-parity-'));
const write = (name, value) => {
  const file = path.join(logicalDir, name);
  fs.writeFileSync(file, JSON.stringify(value));
  return file;
};
const baseline = write('baseline.json', {
  name: 'WA - Inbound Downstream Dispatcher', settings: { executionOrder: 'v1' }, pinData: {}, meta: {}, tags: [], connections: {},
  nodes: [
    { name: 'Execute Outbound Response', target: 'WA - Outbound Messages' },
    { name: 'Dispatch Handoff Notification Workflow', target: 'OPS - Handoff Notification Scheduler' },
  ].map(({ name, target }) => ({ name, type: 'n8n-nodes-base.executeWorkflow', parameters: { workflowId: { value: 'baseline-id', mode: 'list', cachedResultName: target } } })),
});
const runtime = write('runtime.json', {
  id: 'dispatcher-id', active: true, activeVersionId: 'runtime-only', createdAt: 'runtime-only', updatedAt: 'runtime-only', versionId: 'runtime-only', versionCounter: 9, isArchived: false, triggerCount: 1, description: null, staticData: {}, shared: [], meta: { runtime: true }, pinData: { runtime: true },
  name: 'WA - Inbound Downstream Dispatcher', settings: { executionOrder: 'v1', errorWorkflow: 'error-id' }, tags: [], connections: {},
  nodes: [
    { name: 'Execute Outbound Response', type: 'n8n-nodes-base.executeWorkflow', parameters: { workflowId: { value: 'outbound-id', mode: 'list', cachedResultName: 'WA - Outbound Messages' } } },
    { name: 'Dispatch Handoff Notification Workflow', type: 'n8n-nodes-base.executeWorkflow', parameters: { workflowId: { value: 'scheduler-id', mode: 'list', cachedResultName: 'OPS - Handoff Notification Scheduler' } } },
  ],
});
const ids = write('ids.json', [
  { id: 'dispatcher-id', name: 'WA - Inbound Downstream Dispatcher' }, { id: 'outbound-id', name: 'WA - Outbound Messages' },
  { id: 'scheduler-id', name: 'OPS - Handoff Notification Scheduler' }, { id: 'error-id', name: 'OPS - Error Handler' },
]);
const links = write('links.json', { errorWorkflow: { name: 'OPS - Error Handler' }, links: [
  { sourceWorkflow: 'WA - Inbound Downstream Dispatcher', node: 'Execute Outbound Response', targetWorkflow: 'WA - Outbound Messages' },
  { sourceWorkflow: 'WA - Inbound Downstream Dispatcher', node: 'Dispatch Handoff Notification Workflow', targetWorkflow: 'OPS - Handoff Notification Scheduler' },
] });
const logicalParity = (runtimeFile) => childProcess.spawnSync('sh', [deployPath, '--test-logical-dispatcher', runtimeFile, baseline, ids, links]);
const logicalResult = logicalParity(runtime);
assert.strictEqual(logicalResult.status, 0, logicalResult.stderr.toString() || 'resolved workflow links and errorWorkflow must compare logically');
const wrongRuntime = write('runtime-wrong-link.json', { ...JSON.parse(fs.readFileSync(runtime)), nodes: JSON.parse(fs.readFileSync(runtime)).nodes.map((node, index) => index ? node : { ...node, parameters: { workflowId: { ...node.parameters.workflowId, value: 'scheduler-id' } } }) });
assert.notStrictEqual(logicalParity(wrongRuntime).status, 0, 'each runtime Execute Workflow ID must resolve to its expected name');
const wrongError = write('runtime-wrong-error.json', { ...JSON.parse(fs.readFileSync(runtime)), settings: { executionOrder: 'v1', errorWorkflow: 'outbound-id' } });
assert.notStrictEqual(logicalParity(wrongError).status, 0, 'runtime errorWorkflow ID must resolve to the manifest error workflow');
const schedulerCandidate = write('scheduler-candidate.json', {
  name: 'OPS - Handoff Notification Scheduler',
  settings: { executionOrder: 'v1' },
  nodes: [{ name: 'Prepare Handoff ClickUp Task', type: 'n8n-nodes-base.code', parameters: { jsCode: 'candidate-wrapper' } }],
  connections: { 'Prepare Handoff ClickUp Task': { main: [[]] } }, tags: [{ name: 'operations' }], pinData: { sample: [{ json: { safe: true } }] },
});
const schedulerRuntime = write('scheduler-runtime.json', {
  triggerCount: 7, versionCounter: 3, activeVersionId: 'runtime-version', isArchived: false, description: 'runtime-only',
  pinData: { sample: [{ json: { safe: true } }] }, tags: [{ name: 'operations' }], connections: { 'Prepare Handoff ClickUp Task': { main: [[]] } },
  nodes: [{ parameters: { jsCode: 'candidate-wrapper' }, type: 'n8n-nodes-base.code', name: 'Prepare Handoff ClickUp Task' }],
  settings: { errorWorkflow: 'error-id', executionOrder: 'v1' }, name: 'OPS - Handoff Notification Scheduler', id: 'scheduler-id', active: false,
});
const schedulerParity = (candidate, runtimeFile) => childProcess.spawnSync('sh', [deployPath, '--test-logical-scheduler', candidate, runtimeFile, ids, links]);
assert.strictEqual(schedulerParity(schedulerCandidate, schedulerRuntime).status, 0, 'reordered equivalent scheduler exports must compare equal after runtime projection');
const wrongWrapper = write('scheduler-wrong-wrapper.json', { ...JSON.parse(fs.readFileSync(schedulerRuntime)), nodes: [{ name: 'Prepare Handoff ClickUp Task', type: 'n8n-nodes-base.code', parameters: { jsCode: 'changed-wrapper' } }] });
assert.notStrictEqual(schedulerParity(schedulerCandidate, wrongWrapper).status, 0, 'changed scheduler wrapper must fail logical parity');
const wrongConnection = write('scheduler-wrong-connection.json', { ...JSON.parse(fs.readFileSync(schedulerRuntime)), connections: {} });
assert.notStrictEqual(schedulerParity(schedulerCandidate, wrongConnection).status, 0, 'changed scheduler connection must fail logical parity');
const wrongSchedulerError = write('scheduler-wrong-error.json', { ...JSON.parse(fs.readFileSync(schedulerRuntime)), settings: { executionOrder: 'v1', errorWorkflow: 'outbound-id' } });
assert.notStrictEqual(schedulerParity(schedulerCandidate, wrongSchedulerError).status, 0, 'changed scheduler errorWorkflow must fail logical parity');
fs.rmSync(logicalDir, { recursive: true, force: true });
for (const fragment of ['/space/', 'Handoffs WhatsApp', 'HANDOFF_CLICKUP_ASSIGNEES_JSON', 'umask 077', 'sha256sum', 'rollback']) {
  assert(config.includes(fragment), `configuration guard missing ${fragment}`);
}
assert(!config.includes('/folder/$folder_id/list'), 'configuration must create/reuse the list at the Space root');
assert(config.includes('api_post "/space/$space_id/list"'), 'zero-match creation must use the folderless Space endpoint');
assert(config.includes('(.space.id | tostring) == $space'), 'created list must verify its Space parent');
assert(config.includes("--arg name 'Juan Pablo'"), 'configuration must validate the authorized exact Sales owner');
assert(!config.includes('Juan Pablo Pruebas'), 'configuration must not use the superseded Sales owner label');
assert(config.includes('JSON.parse(existingAssignees)'), 'configuration must parse the existing assignee mapping before changing Sales');
assert(config.includes('mapping.sales = [Number(ownerId)]'), 'configuration must update only the Sales assignee mapping');
assert(config.includes('runtime_hash='), 'configuration must hash the runtime configuration without disclosing IDs');
assert(config.includes('expected_hash='), 'configuration must hash the expected configuration without disclosing IDs');
assert(config.includes('recreate_n8n() {\n  unset CLICKUP_LEADS_LIST_ID CLICKUP_HANDOFF_LIST_ID HANDOFF_CLICKUP_ASSIGNEES_JSON\n  docker compose --env-file "$ENV_FILE" up -d --no-deps --force-recreate n8n'), 'every n8n recreation must clear sourced ClickUp overrides immediately before compose');
assert(config.includes('anchor=$(api_get "/list/$CLICKUP_LEADS_LIST_ID")'), 'handoff configuration must discover the parent Space from the preserved leads list');
assert(config.includes('next.push(`CLICKUP_HANDOFF_LIST_ID=${listId}`'), 'handoff configuration must write only the dedicated handoff list ID');
assert(!config.includes('CLICKUP_' + 'LIST_ID'), 'generic ClickUp list configuration must not remain');
assert.strictEqual((config.match(/--force-recreate n8n/g) || []).length, 1, 'success and rollback must share the sole override-clearing n8n recreation helper');
assert(config.includes('recreate_n8n >/dev/null 2>&1 || true'), 'rollback must recreate through the override-clearing helper');
assert(config.includes('recreate_n8n >/dev/null'), 'success must recreate through the override-clearing helper');
assert(config.includes('if [ "$mode" = recreate-n8n ]; then\n  recreate_n8n\n  exit 0\nfi'), 'the explicitly parsed n8n-only recovery path must use the same override-clearing helper');
assert(config.indexOf('members=$(api_get "/team")') < config.indexOf('api_post "/space/$space_id/list"'), 'joined active Sales owner must be preflighted before any list creation');
for (const fragment of ['OPS - Handoff Notification Scheduler', 'WA - Inbound Downstream Dispatcher', 'export:workflow --id=', 'import:workflow', 'set_active false', 'rollback']) {
  assert(deploy.includes(fragment), `deployment guard missing ${fragment}`);
}
assert(!deploy.includes('export:workflow --all'), 'scheduler deployment must not export all workflows');
assert(deploy.includes('tostring) == $id and .name == $name'), 'scheduler export must prove exact runtime identity');
assert(deploy.includes('remote_after=$(export_named "$scheduler_id" "$SCHEDULER")'), 'post-import verification must export the scheduler by exact identity');
assert(!deploy.includes('-Atqc'), 'psql named variables must be interpolated through stdin, not -c');
assert(deploy.includes('n8n update:workflow --id="$id" --active="$desired"'), 'scheduler activation must use the supported n8n CLI mechanism');
assert(!deploy.includes('UPDATE workflow_entity SET active'), 'scheduler activation must not mutate the workflow table directly');
assert(!deploy.includes('sync-n8n-workflows.sh'), 'scheduler deployment must not invoke the all-workflow synchronizer');
assert(deploy.includes('RUNNER_READY_TIMEOUT_SECONDS=90'), 'runner readiness wait must be bounded to 90 seconds');
assert(deploy.includes('n8n_started_at=$(docker inspect'), 'runner readiness must derive the current n8n StartedAt');
assert(deploy.includes('docker compose logs --since "$n8n_started_at" n8n'), 'runner readiness must reject historical logs before the current start');
assert(deploy.includes('Registered runner "JS Task Runner"'), 'runner readiness must require the JS runner registration event');
assert(deploy.includes('EXPORT_TIMEOUT_SECONDS=90'), 'workflow export must have a hard timeout');
assert(deploy.includes('timeout "$EXPORT_TIMEOUT_SECONDS" docker compose exec -T n8n n8n export:workflow'), 'workflow export must use the hard timeout');
assert(!deploy.includes('exec -T n8n jq'), 'copied exports must be validated with host jq only');
assert(deploy.includes('status=$?') && deploy.includes('exit "$status"'), 'cleanup must preserve the original exit status');
assert(deploy.includes('git show 791f9f3:n8n/workflows/wa-inbound-downstream-dispatcher.json'), 'dispatcher baseline must come from certified commit 791f9f3');
assert(deploy.includes('logical_dispatcher_parity'), 'dispatcher comparison must use the logical parity guard');
assert(deploy.includes('workflow_name_for_id') && deploy.includes('workflow_id_for_name'), 'every dispatcher workflow ID must resolve to an exact runtime name');
assert(deploy.includes('.settings.errorWorkflow'), 'dispatcher errorWorkflow must be resolved and compared semantically');
assert(deploy.includes('canonical_runtime_dispatcher'), 'only runtime metadata may be normalized before canonical comparison');
assert(deploy.includes('dispatcher logical definition differs from certified 791f9f3'), 'dispatcher logical drift from the certified baseline must stop and roll back the scheduler');
NODE

if "$DEPLOY_SCRIPT" README.sh >/dev/null 2>&1; then
  echo 'documentation-like deploy path was accepted' >&2
  exit 1
fi

echo 'Handoff delivery ops local tests OK: configuration and scheduler-only deployment guards'
