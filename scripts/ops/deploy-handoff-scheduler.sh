#!/bin/sh
set -eu

ROOT_DIR=$(CDPATH= cd -- "$(dirname "$0")/../.." && pwd)
cd "$ROOT_DIR"
umask 077

SCHEDULER='OPS - Handoff Notification Scheduler'
DISPATCHER='WA - Inbound Downstream Dispatcher'
BACKUP=n8n/workflows/backup/ops-handoff-notification-scheduler.runtime.json
RUNNER_READY_TIMEOUT_SECONDS=90
EXPORT_TIMEOUT_SECONDS=90

workflow_name_for_id() {
  jq -er --arg id "$1" '[.[] | select((.id | tostring) == $id)] | if length == 1 then .[0].name else error("runtime workflow ID is ambiguous") end' "$2"
}
workflow_id_for_name() {
  jq -er --arg name "$1" '[.[] | select(.name == $name)] | if length == 1 then .[0].id | tostring else error("runtime workflow name is ambiguous") end' "$2"
}
canonical_expected_dispatcher() {
  jq -cS --slurpfile ids "$3" --slurpfile manifest "$4" --arg source "$DISPATCHER" '
    def workflow_id($name): [$ids[0][] | select(.name == $name) | .id | tostring] | if length == 1 then .[0] else error("runtime workflow name is ambiguous") end;
    def target($node): [$manifest[0].links[] | select(.sourceWorkflow == $source and .node == $node) | .targetWorkflow] | if length == 1 then .[0] else error("dispatcher link is missing or ambiguous") end;
    .settings = (.settings // {}) | .settings.errorWorkflow = workflow_id($manifest[0].errorWorkflow.name)
    | .nodes |= map(if .type == "n8n-nodes-base.executeWorkflow" then .parameters.workflowId.value = workflow_id(target(.name)) else . end)
  ' "$2"
}
canonical_runtime_dispatcher() {
  jq -cS --slurpfile baseline "$2" '
    reduce ["id", "active", "activeVersionId", "createdAt", "updatedAt", "versionId", "versionCounter", "isArchived", "triggerCount", "description", "meta", "staticData", "pinData", "shared"][] as $key
      (.;
        if $baseline[0] | has($key) then .[$key] = $baseline[0][$key] else del(.[$key]) end)
  ' "$1"
}
resolve_scheduler_error_workflow() {
  jq -c --slurpfile ids "$2" --slurpfile manifest "$3" '
    def workflow_id($name): [$ids[0][] | select(.name == $name) | .id | tostring] | if length == 1 then .[0] else error("runtime workflow name is ambiguous") end;
    .settings = (.settings // {}) | .settings.errorWorkflow = workflow_id($manifest[0].errorWorkflow.name)
  ' "$1"
}
logical_scheduler_projection() {
  jq -cS 'del(.id,.active,.activeVersionId,.createdAt,.updatedAt,.versionId,.versionCounter,.isArchived,.triggerCount,.description,.meta,.staticData,.shared)' "$1"
}
logical_scheduler_parity() {
  candidate=$1 runtime=$2 runtime_ids=$3 manifest=$4
  resolved_candidate=$(resolve_scheduler_error_workflow "$candidate" "$runtime_ids" "$manifest") || return 1
  expected=$(printf '%s\n' "$resolved_candidate" | jq -cS 'del(.id,.active,.activeVersionId,.createdAt,.updatedAt,.versionId,.versionCounter,.isArchived,.triggerCount,.description,.meta,.staticData,.shared)') || return 1
  actual=$(logical_scheduler_projection "$runtime") || return 1
  [ "$actual" = "$expected" ]
}
write_scheduler_parity_diagnostic() {
  expected=$1 actual=$2 output=$3
  jq -n --arg expected_hash "$(sha256sum "$expected" | cut -d' ' -f1)" --arg actual_hash "$(sha256sum "$actual" | cut -d' ' -f1)" --slurpfile expected "$expected" --slurpfile actual "$actual" '
    def shape($workflow): {
      name: $workflow.name,
      settings_keys: (($workflow.settings // {}) | keys | sort),
      node_shape: [($workflow.nodes // [])[] | {name, type, typeVersion, parameter_keys: ((.parameters // {}) | keys | sort)}],
      connection_sources: (($workflow.connections // {}) | keys | sort),
      tag_count: (($workflow.tags // []) | length),
      pin_data_keys: (($workflow.pinData // {}) | keys | sort)
    };
    {expected_hash: $expected_hash, actual_hash: $actual_hash, expected: shape($expected[0]), actual: shape($actual[0])}
  ' > "$output"
  chmod 600 "$output"
}
logical_dispatcher_parity() {
  runtime=$1 baseline=$2 runtime_ids=$3 manifest=$4
  tab=$(printf '\tX')
  tab=${tab%X}
  jq -r --arg source "$DISPATCHER" '.links[] | select(.sourceWorkflow == $source) | [.node, .targetWorkflow] | @tsv' "$manifest" |
    while IFS="$tab" read -r node expected_name; do
      actual_id=$(jq -er --arg node "$node" '[.nodes[] | select(.name == $node and .type == "n8n-nodes-base.executeWorkflow") | .parameters.workflowId.value | tostring] | if length == 1 then .[0] else error("runtime dispatcher node is missing or ambiguous") end' "$runtime") || exit 1
      actual_name=$(workflow_name_for_id "$actual_id" "$runtime_ids") || exit 1
      expected_id=$(workflow_id_for_name "$expected_name" "$runtime_ids") || exit 1
      [ "$actual_name" = "$expected_name" ] && [ "$actual_id" = "$expected_id" ] || { echo 'ERROR: dispatcher Execute Workflow link differs from manifest' >&2; exit 1; }
    done
  expected_error=$(jq -er '.errorWorkflow.name' "$manifest")
  actual_error=$(jq -er '.settings.errorWorkflow | tostring' "$runtime") || { echo 'ERROR: dispatcher errorWorkflow is missing' >&2; return 1; }
  [ "$(workflow_name_for_id "$actual_error" "$runtime_ids")" = "$expected_error" ] || { echo 'ERROR: dispatcher errorWorkflow differs from manifest' >&2; return 1; }
  expected=$(canonical_expected_dispatcher "$runtime" "$baseline" "$runtime_ids" "$manifest")
  actual=$(canonical_runtime_dispatcher "$runtime" "$baseline")
  [ "$actual" = "$expected" ] || { echo 'ERROR: dispatcher logical definition differs from certified 791f9f3' >&2; return 1; }
}

if [ "${1:-}" = --test-logical-dispatcher ]; then
  [ "$#" -eq 5 ] || { echo "Usage: $0 --test-logical-dispatcher RUNTIME BASELINE IDS MANIFEST" >&2; exit 2; }
  logical_dispatcher_parity "$2" "$3" "$4" "$5"
  exit $?
fi
if [ "${1:-}" = --test-logical-scheduler ]; then
  [ "$#" -eq 5 ] || { echo "Usage: $0 --test-logical-scheduler CANDIDATE RUNTIME IDS MANIFEST" >&2; exit 2; }
  logical_scheduler_parity "$2" "$3" "$4" "$5"
  exit $?
fi

ACTION=${1:-deploy}
[ "$#" -eq 1 ] && { [ "$ACTION" = deploy ] || [ "$ACTION" = rollback ]; } || {
  echo "Usage: $0 {deploy|rollback}" >&2; exit 2;
}
for tool in docker jq sha256sum grep timeout git; do command -v "$tool" >/dev/null 2>&1 || { echo "ERROR: missing dependency: $tool" >&2; exit 1; }; done

set -a
. ./.env
set +a
tmp_dir=$(mktemp -d)
rollback_needed=0
cleanup() {
  status=$?
  if [ "$rollback_needed" = 1 ] && [ -f "$BACKUP" ]; then
    docker compose cp "$BACKUP" n8n:/tmp/handoff-scheduler-rollback.json >/dev/null 2>&1 || true
    docker compose exec -T n8n n8n import:workflow --input=/tmp/handoff-scheduler-rollback.json >/dev/null 2>&1 || true
    set_active "$scheduler_was_active" "$scheduler_id" || true
  fi
  rm -rf "$tmp_dir"
  exit "$status"
}
trap cleanup EXIT HUP INT TERM

workflow_id() {
  printf '%s\n' "SELECT id FROM workflow_entity WHERE name=:'name';" | \
    docker compose exec -T postgres psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v ON_ERROR_STOP=1 -v name="$1" -Atq | {
      IFS= read -r id && [ -n "$id" ] && ! IFS= read -r _ && printf '%s\n' "$id"
    }
}
runtime_workflow_ids() {
  printf '%s\n' "SELECT COALESCE(json_agg(json_build_object('id', id::text, 'name', name) ORDER BY name), '[]'::json) FROM workflow_entity;" | \
    docker compose exec -T postgres psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v ON_ERROR_STOP=1 -Atq
}
wait_for_runner() {
  n8n_container=$(docker compose ps -q n8n)
  [ -n "$n8n_container" ] || { echo 'ERROR: n8n container is not running' >&2; return 1; }
  n8n_started_at=$(docker inspect -f '{{.State.StartedAt}}' "$n8n_container")
  elapsed=0
  while [ "$elapsed" -lt "$RUNNER_READY_TIMEOUT_SECONDS" ]; do
    if docker compose logs --since "$n8n_started_at" n8n 2>&1 | grep -F 'Registered runner "JS Task Runner"' >/dev/null; then
      return 0
    fi
    sleep 1
    elapsed=$((elapsed + 1))
  done
  echo 'ERROR: JS task runner did not register after the current n8n start' >&2
  return 1
}
export_named() {
  id=$1 name=$2 output="$tmp_dir/$id.json"
  timeout "$EXPORT_TIMEOUT_SECONDS" docker compose exec -T n8n n8n export:workflow --id="$id" --output=/tmp/handoff-workflow.json >/dev/null
  docker compose cp n8n:/tmp/handoff-workflow.json "$output" >/dev/null
  jq -er --arg id "$id" --arg name "$name" \
    'if type == "array" then . else [.] end | [.[] | select((.id | tostring) == $id and .name == $name)] | if length == 1 then .[0] else error("runtime workflow identity is ambiguous") end' "$output"
}
set_active() {
  desired=$1 id=$2
  docker compose exec -T -u node n8n n8n update:workflow --id="$id" --active="$desired" >/dev/null
  expected=f
  [ "$desired" = true ] && expected=t
  actual=$(printf '%s\n' "SELECT active FROM workflow_entity WHERE id=:'id' AND name=:'name';" | \
    docker compose exec -T postgres psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v ON_ERROR_STOP=1 -v id="$id" -v name="$SCHEDULER" -Atq)
  [ "$actual" = "$expected" ]
}

 scheduler_id=$(workflow_id "$SCHEDULER") || { echo 'ERROR: scheduler runtime identity is ambiguous' >&2; exit 1; }
 dispatcher_id=$(workflow_id "$DISPATCHER") || { echo 'ERROR: dispatcher runtime identity is ambiguous' >&2; exit 1; }
wait_for_runner
runtime_scheduler=$(export_named "$scheduler_id" "$SCHEDULER")
runtime_dispatcher=$(export_named "$dispatcher_id" "$DISPATCHER")
scheduler_id=$(printf '%s' "$runtime_scheduler" | jq -er '.id | tostring')
scheduler_was_active=$(printf '%s' "$runtime_scheduler" | jq -er '.active | tostring')
printf '%s\n' "$runtime_dispatcher" > "$tmp_dir/dispatcher-before.json"
git show 791f9f3:n8n/workflows/wa-inbound-downstream-dispatcher.json > "$tmp_dir/dispatcher-791f9f3.json"
runtime_workflow_ids > "$tmp_dir/runtime-workflow-ids.json"
jq -e 'type == "array" and all(.[]; (.id | type == "string") and (.name | type == "string"))' "$tmp_dir/runtime-workflow-ids.json" >/dev/null
logical_dispatcher_parity "$tmp_dir/dispatcher-before.json" "$tmp_dir/dispatcher-791f9f3.json" "$tmp_dir/runtime-workflow-ids.json" n8n/workflow-links.json
dispatcher_before=$(canonical_runtime_dispatcher "$tmp_dir/dispatcher-before.json" "$tmp_dir/dispatcher-791f9f3.json" | sha256sum | cut -d' ' -f1)

if [ "$ACTION" = rollback ]; then
  [ -f "$BACKUP" ] || { echo 'ERROR: scheduler rollback snapshot is missing' >&2; exit 1; }
  docker compose cp "$BACKUP" n8n:/tmp/handoff-scheduler-rollback.json >/dev/null
  docker compose exec -T n8n n8n import:workflow --input=/tmp/handoff-scheduler-rollback.json >/dev/null
  set_active "$(jq -er '.active | tostring' "$BACKUP")" "$scheduler_id"
  echo 'Scheduler rollback restored the dedicated runtime snapshot.'
  exit 0
fi

mkdir -p n8n/workflows/backup
printf '%s\n' "$runtime_scheduler" > "$BACKUP"

local_candidate="$tmp_dir/scheduler.json"
jq --arg id "$scheduler_id" '.id = $id | .active = false' n8n/workflows/ops-handoff-notification-scheduler.json > "$local_candidate"
resolve_scheduler_error_workflow "$local_candidate" "$tmp_dir/runtime-workflow-ids.json" n8n/workflow-links.json > "$tmp_dir/scheduler-resolved.json"
local_candidate="$tmp_dir/scheduler-resolved.json"
rollback_needed=1
set_active false "$scheduler_id"
docker compose cp "$local_candidate" n8n:/tmp/handoff-scheduler-candidate.json >/dev/null
docker compose exec -T n8n n8n import:workflow --input=/tmp/handoff-scheduler-candidate.json >/dev/null
remote_after=$(export_named "$scheduler_id" "$SCHEDULER")
printf '%s\n' "$remote_after" > "$tmp_dir/remote.json"
logical_scheduler_parity "$local_candidate" "$tmp_dir/remote.json" "$tmp_dir/runtime-workflow-ids.json" n8n/workflow-links.json || {
  write_scheduler_parity_diagnostic "$local_candidate" "$tmp_dir/remote.json" n8n/workflows/backup/ops-handoff-notification-scheduler.parity-diagnostic.json
  echo 'ERROR: scheduler definition verification failed; sanitized diagnostic retained' >&2
  exit 1
}
export_named "$dispatcher_id" "$DISPATCHER" > "$tmp_dir/dispatcher-after.json"
logical_dispatcher_parity "$tmp_dir/dispatcher-after.json" "$tmp_dir/dispatcher-791f9f3.json" "$tmp_dir/runtime-workflow-ids.json" n8n/workflow-links.json
dispatcher_after=$(canonical_runtime_dispatcher "$tmp_dir/dispatcher-after.json" "$tmp_dir/dispatcher-791f9f3.json" | sha256sum | cut -d' ' -f1)
[ "$dispatcher_before" = "$dispatcher_after" ] || { echo 'ERROR: dispatcher definition changed; rolling back scheduler' >&2; exit 1; }
set_active true "$scheduler_id"
rollback_needed=0
echo 'Scheduler-only deployment verified: scheduler identity and wrapper parity pass; dispatcher definition/identity is unchanged.'
