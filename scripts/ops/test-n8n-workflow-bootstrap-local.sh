#!/bin/sh

set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname "$0")" && pwd)
PROJECT_ROOT=$(CDPATH= cd -- "$SCRIPT_DIR/../.." && pwd)
SYNC_SCRIPT="$PROJECT_ROOT/scripts/dev/sync-n8n-workflows.sh"

require() {
  command -v "$1" >/dev/null 2>&1 || { echo "ERROR: falta dependencia '$1'" >&2; exit 1; }
}

require jq
require awk

tmp_dir=$(mktemp -d)
trap 'rm -rf "$tmp_dir"' EXIT HUP INT TERM

SYNC_N8N_SOURCE_ONLY=yes . "$SYNC_SCRIPT"

WORKFLOW_DIR="$tmp_dir/workflows"
LINK_MANIFEST="$tmp_dir/workflow-links.json"
mkdir -p "$WORKFLOW_DIR" "$tmp_dir/snapshot"

cat > "$WORKFLOW_DIR/source.json" <<'JSON'
{
  "id": "stale-source-id",
  "name": "Existing Source",
  "settings": {"errorWorkflow": "stale-error-id"},
  "nodes": [{
    "name": "Call New Target",
    "type": "n8n-nodes-base.executeWorkflow",
    "parameters": {
      "source": "database",
      "workflowId": {"__rl": true, "value": "stale-target-id", "mode": "list"}
    }
  }],
  "connections": {}
}
JSON

cat > "$WORKFLOW_DIR/new-target.json" <<'JSON'
{
  "id": "stale-new-id",
  "name": "New Target",
  "settings": {"errorWorkflow": "stale-error-id"},
  "nodes": [],
  "connections": {}
}
JSON

cat > "$WORKFLOW_DIR/error.json" <<'JSON'
{"id":"stale-error-id","name":"Error Handler","settings":{},"nodes":[],"connections":{}}
JSON

cat > "$LINK_MANIFEST" <<'JSON'
{
  "errorWorkflow": {"name": "Error Handler"},
  "links": [{
    "sourceWorkflow": "Existing Source",
    "node": "Call New Target",
    "targetWorkflow": "New Target"
  }]
}
JSON

cat > "$tmp_dir/before.ids.json" <<'JSON'
{"Existing Source":"id-source","Error Handler":"id-error"}
JSON
cat > "$tmp_dir/before.ids" <<'EOF_IDS'
Error Handler|id-error
Existing Source|id-source
EOF_IDS

mkdir -p "$tmp_dir/bootstrap"
prepare_import_dir "$tmp_dir/before.ids.json" "$tmp_dir/bootstrap" bootstrap

jq -e '.id == "id-source" and .settings.errorWorkflow == "id-error" and .nodes[0].parameters.workflowId.value == ""' "$tmp_dir/bootstrap/source.json" >/dev/null
jq -e 'has("id") | not' "$tmp_dir/bootstrap/new-target.json" >/dev/null
jq -e '.settings.errorWorkflow == "id-error"' "$tmp_dir/bootstrap/new-target.json" >/dev/null

cat > "$tmp_dir/after.ids" <<'EOF_IDS'
Error Handler|id-error
Existing Source|id-source
New Target|id-new
EOF_IDS
ensure_unique_runtime_names "$tmp_dir/after.ids"
write_ids_json "$tmp_dir/after.ids" "$tmp_dir/after.ids.json"
ensure_all_workflows_have_ids "$tmp_dir/after.ids.json"
capture_bootstrap_created_workflows "$tmp_dir/before.ids" "$tmp_dir/after.ids" "$tmp_dir/created.json"
jq -e '. == [{"name":"New Target","id":"id-new"}]' "$tmp_dir/created.json" >/dev/null

mkdir -p "$tmp_dir/resolved"
prepare_import_dir "$tmp_dir/after.ids.json" "$tmp_dir/resolved" yes
jq -e '.id == "id-source" and .nodes[0].parameters.workflowId.value == "id-new" and .settings.errorWorkflow == "id-error"' "$tmp_dir/resolved/source.json" >/dev/null
jq -e '.id == "id-new" and .settings.errorWorkflow == "id-error"' "$tmp_dir/resolved/new-target.json" >/dev/null

cp "$WORKFLOW_DIR/source.json" "$tmp_dir/snapshot/source.json"
cp "$WORKFLOW_DIR/error.json" "$tmp_dir/snapshot/error.json"
cp "$tmp_dir/after.ids" "$tmp_dir/runtime.ids"

delete_bootstrap_workflows_transaction() {
  created_json="$1"
  jq -r '.[] | [.name, .id] | @tsv' "$created_json" | while IFS='	' read -r doomed_name doomed_id; do
    awk -F'|' -v name="$doomed_name" -v id="$doomed_id" '!($1 == name && $2 == id)' "$tmp_dir/runtime.ids" > "$tmp_dir/runtime.ids.next"
    mv "$tmp_dir/runtime.ids.next" "$tmp_dir/runtime.ids"
  done
}

query_workflow_ids() {
  cat "$tmp_dir/runtime.ids"
}

cleanup_bootstrap_workflows "$tmp_dir/snapshot" "$tmp_dir/created.json"
! grep -q '^New Target|id-new$' "$tmp_dir/runtime.ids"
grep -q '^Existing Source|id-source$' "$tmp_dir/runtime.ids"
grep -q '^Error Handler|id-error$' "$tmp_dir/runtime.ids"

# A bootstrap import can fail after creating only part of the batch. Rollback
# must discover snapshot-absent local workflows even before capture completes.
cp "$tmp_dir/after.ids" "$tmp_dir/runtime.ids"
printf '[]\n' > "$tmp_dir/not-yet-captured.json"
cleanup_bootstrap_workflows "$tmp_dir/snapshot" "$tmp_dir/not-yet-captured.json"
! grep -q '^New Target|id-new$' "$tmp_dir/runtime.ids"

snapshot_line=$(grep -n 'snapshot_runtime_workflows "$snapshot_dir"' "$SYNC_SCRIPT" | tail -n 1 | cut -d: -f1)
pause_line=$(grep -n 'set_callers_active false' "$SYNC_SCRIPT" | tail -n 1 | cut -d: -f1)
bootstrap_line=$(grep -n 'copy_and_import "$bootstrap_dir" "bootstrap de IDs"' "$SYNC_SCRIPT" | cut -d: -f1)
resolve_line=$(grep -n 'copy_and_import "$resolved_dir" "links resueltos"' "$SYNC_SCRIPT" | cut -d: -f1)
[ "$snapshot_line" -lt "$pause_line" ]
[ "$pause_line" -lt "$bootstrap_line" ]
[ "$bootstrap_line" -lt "$resolve_line" ]

# Runtime-imported subworkflows must accept the complete item explicitly on
# executeWorkflowTrigger v1.1. Empty workflowInputs are rejected by n8n when
# the scheduler is called from another workflow, even though its cron lane runs.
for scheduler in "$PROJECT_ROOT"/n8n/workflows/ops-*-scheduler.json; do
  jq -e '
    all(
      .nodes[] | select(.type == "n8n-nodes-base.executeWorkflowTrigger" and .typeVersion >= 1.1);
      .parameters.inputSource == "passthrough"
    )
  ' "$scheduler" >/dev/null
done

echo "n8n workflow bootstrap local tests OK: missing workflow creation + second-phase links + rollback cleanup + subworkflow passthrough"
