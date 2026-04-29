#!/bin/sh

set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname "$0")" && pwd)
PROJECT_ROOT=$(CDPATH= cd -- "$SCRIPT_DIR/../.." && pwd)
WORKFLOW_DIR="$PROJECT_ROOT/n8n/workflows"
LINK_MANIFEST="$PROJECT_ROOT/n8n/workflow-links.json"
N8N_SERVICE="${N8N_SERVICE:-n8n}"
POSTGRES_SERVICE="${POSTGRES_SERVICE:-postgres}"
CONTAINER_TMP="/tmp/crm-n8n-workflows-sync"

usage() {
  cat <<'EOF'
Uso:
  scripts/dev/sync-n8n-workflows.sh [--preflight]

Sincroniza workflows versionados usando el CLI oficial de n8n.

Opciones:
  --preflight   Valida JSON, nombres y manifest local sin tocar Docker/n8n.
EOF
}

require_command() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "ERROR: falta dependencia '$1'" >&2
    exit 1
  fi
}

workflow_files() {
  find "$WORKFLOW_DIR" -maxdepth 1 -type f -name '*.json' | sort
}

workflow_name_from_file() {
  jq -r '.name // empty' "$1"
}

workflow_exists_local() {
  expected="$1"
  workflow_files | while IFS= read -r file; do
    [ "$(workflow_name_from_file "$file")" = "$expected" ] && {
      echo "yes"
      exit 0
    }
  done | grep -q yes
}

manifest_link_exists() {
  source_workflow="$1"
  node_name="$2"
  jq -e \
    --arg sourceWorkflow "$source_workflow" \
    --arg node "$node_name" \
    '.links[] | select(.sourceWorkflow == $sourceWorkflow and .node == $node)' \
    "$LINK_MANIFEST" >/dev/null
}

validate_local() {
  require_command jq

  if [ ! -d "$WORKFLOW_DIR" ]; then
    echo "ERROR: no existe $WORKFLOW_DIR" >&2
    exit 1
  fi

  if [ ! -f "$LINK_MANIFEST" ]; then
    echo "ERROR: no existe $LINK_MANIFEST" >&2
    exit 1
  fi

  jq -e '
    (.errorWorkflow.name | type == "string") and
    (.links | type == "array") and
    all(.links[]; (.sourceWorkflow | type == "string") and (.node | type == "string") and (.targetWorkflow | type == "string"))
  ' "$LINK_MANIFEST" >/dev/null

  tmp_names=$(mktemp)
  trap 'rm -f "$tmp_names"' EXIT

  workflow_count=0
  workflow_files | while IFS= read -r file; do
    jq -e . "$file" >/dev/null
    name=$(workflow_name_from_file "$file")
    if [ -z "$name" ]; then
      echo "ERROR: workflow sin nombre en $file" >&2
      exit 1
    fi
    printf '%s\n' "$name" >> "$tmp_names"
    workflow_count=$((workflow_count + 1))
  done

  if [ ! -s "$tmp_names" ]; then
    echo "ERROR: no hay workflows JSON en $WORKFLOW_DIR" >&2
    exit 1
  fi

  duplicates=$(sort "$tmp_names" | uniq -d)
  if [ -n "$duplicates" ]; then
    echo "ERROR: nombres de workflow duplicados:" >&2
    echo "$duplicates" >&2
    exit 1
  fi

  error_workflow=$(jq -r '.errorWorkflow.name' "$LINK_MANIFEST")
  if ! workflow_exists_local "$error_workflow"; then
    echo "ERROR: errorWorkflow '$error_workflow' no existe en $WORKFLOW_DIR" >&2
    exit 1
  fi

  jq -r '.links[] | [.sourceWorkflow, .node, .targetWorkflow] | @tsv' "$LINK_MANIFEST" |
    while IFS='	' read -r source_workflow node_name target_workflow; do
      if ! workflow_exists_local "$source_workflow"; then
        echo "ERROR: sourceWorkflow '$source_workflow' no existe" >&2
        exit 1
      fi
      if ! workflow_exists_local "$target_workflow"; then
        echo "ERROR: targetWorkflow '$target_workflow' no existe" >&2
        exit 1
      fi
      source_file=$(workflow_files | while IFS= read -r file; do
        [ "$(workflow_name_from_file "$file")" = "$source_workflow" ] && {
          printf '%s\n' "$file"
          exit 0
        }
      done)
      if ! jq -e --arg node "$node_name" '.nodes[] | select(.name == $node and .type == "n8n-nodes-base.executeWorkflow")' "$source_file" >/dev/null; then
        echo "ERROR: '$source_workflow' no tiene nodo Execute Workflow '$node_name'" >&2
        exit 1
      fi
    done

  workflow_files | while IFS= read -r file; do
    source_workflow=$(workflow_name_from_file "$file")
    jq -r --arg sourceWorkflow "$source_workflow" \
      '.nodes[] | select(.type == "n8n-nodes-base.executeWorkflow") | [$sourceWorkflow, .name] | @tsv' "$file"
  done | while IFS='	' read -r source_workflow node_name; do
    if ! manifest_link_exists "$source_workflow" "$node_name"; then
      echo "ERROR: falta link en $LINK_MANIFEST para '$source_workflow' -> nodo '$node_name'" >&2
      exit 1
    fi
  done

  rm -f "$tmp_names"
  trap - EXIT
  echo "Preflight local OK"
}

compose_cmd() {
  docker compose --env-file "$PROJECT_ROOT/.env" "$@"
}

query_workflow_ids() {
  compose_cmd exec -T "$POSTGRES_SERVICE" sh -lc \
    "psql -U \"\$POSTGRES_USER\" -d \"\$POSTGRES_DB\" -At -c \"SELECT name || '|' || id FROM workflow_entity ORDER BY name;\""
}

write_ids_json() {
  ids_file="$1"
  json_file="$2"
  jq -Rn '
    [inputs | select(length > 0) | split("|") | select(length == 2) | {key: .[0], value: .[1]}]
    | from_entries
  ' "$ids_file" > "$json_file"
}

prepare_import_dir() {
  ids_json="$1"
  out_dir="$2"
  resolve_links="$3"

  mkdir -p "$out_dir"

  workflow_files | while IFS= read -r file; do
    out_file="$out_dir/$(basename "$file")"
    if [ "$resolve_links" = "yes" ]; then
      jq \
        --slurpfile ids "$ids_json" \
        --slurpfile manifest "$LINK_MANIFEST" '
        def workflow_id($name): ($ids[0][$name] // "");
        . as $workflow
        | (workflow_id($workflow.name)) as $ownId
        | if $ownId != "" then .id = $ownId else del(.id) end
        | if .name != $manifest[0].errorWorkflow.name then
            .settings = (.settings // {})
            | .settings.errorWorkflow = workflow_id($manifest[0].errorWorkflow.name)
          else
            .
          end
        | .nodes = (.nodes | map(
            . as $node
            | ($manifest[0].links | map(select(.sourceWorkflow == $workflow.name and .node == $node.name)) | first) as $link
            | if $link then
                .parameters.source = "database"
                | .parameters.workflowId.value = workflow_id($link.targetWorkflow)
                | .parameters.workflowId.mode = "list"
                | .parameters.workflowId.cachedResultName = $link.targetWorkflow
              else
                .
              end
          ))
      ' "$file" > "$out_file"
    else
      jq --slurpfile ids "$ids_json" '
        (.name as $workflowName | ($ids[0][$workflowName] // "")) as $ownId
        | if $ownId != "" then .id = $ownId else del(.id) end
      ' "$file" > "$out_file"
    fi
  done
}

ensure_all_workflows_have_ids() {
  ids_json="$1"
  workflow_files | while IFS= read -r file; do
    name=$(workflow_name_from_file "$file")
    id=$(jq -r --arg name "$name" '.[$name] // empty' "$ids_json")
    if [ -z "$id" ]; then
      echo "ERROR: n8n no devolvio ID para workflow '$name' despues de importar" >&2
      exit 1
    fi
  done
}

copy_and_import() {
  import_dir="$1"
  label="$2"

  echo "Importando workflows ($label)..."
  compose_cmd exec -T "$N8N_SERVICE" sh -lc "rm -rf '$CONTAINER_TMP' && mkdir -p '$CONTAINER_TMP'"
  compose_cmd cp "$import_dir/." "$N8N_SERVICE:$CONTAINER_TMP"
  compose_cmd exec -T -u node "$N8N_SERVICE" n8n import:workflow --separate --input="$CONTAINER_TMP"
}

verify_remote() {
  ids_json="$1"
  remote_json="$2"

  duplicate_names=$(compose_cmd exec -T "$POSTGRES_SERVICE" sh -lc \
    "psql -U \"\$POSTGRES_USER\" -d \"\$POSTGRES_DB\" -At -c \"SELECT name FROM workflow_entity GROUP BY name HAVING COUNT(*) > 1;\"")
  if [ -n "$duplicate_names" ]; then
    echo "ERROR: hay workflows duplicados por nombre en n8n:" >&2
    echo "$duplicate_names" >&2
    exit 1
  fi

  compose_cmd exec -T "$POSTGRES_SERVICE" sh -lc \
    "psql -U \"\$POSTGRES_USER\" -d \"\$POSTGRES_DB\" -At -c \"SELECT COALESCE(json_agg(json_build_object('name', name, 'id', id, 'settings', settings, 'nodes', nodes) ORDER BY name), '[]'::json) FROM workflow_entity;\"" \
    > "$remote_json"

  jq -r '.links[] | [.sourceWorkflow, .node, .targetWorkflow] | @tsv' "$LINK_MANIFEST" |
    while IFS='	' read -r source_workflow node_name target_workflow; do
      expected_id=$(jq -r --arg name "$target_workflow" '.[$name] // empty' "$ids_json")
      actual_id=$(jq -r --arg source "$source_workflow" --arg node "$node_name" '
        [.[] | select(.name == $source) | .nodes[] | select(.name == $node) | .parameters.workflowId.value][0] // ""
      ' "$remote_json")
      if [ "$actual_id" != "$expected_id" ]; then
        echo "ERROR: link remoto incorrecto: '$source_workflow' / '$node_name' apunta a '$actual_id', esperado '$expected_id'" >&2
        exit 1
      fi
    done

  error_workflow=$(jq -r '.errorWorkflow.name' "$LINK_MANIFEST")
  error_id=$(jq -r --arg name "$error_workflow" '.[$name] // empty' "$ids_json")
  workflow_files | while IFS= read -r file; do
    name=$(workflow_name_from_file "$file")
    [ "$name" = "$error_workflow" ] && continue
    actual_error_id=$(jq -r --arg name "$name" '
      [.[] | select(.name == $name) | .settings.errorWorkflow][0] // ""
    ' "$remote_json")
    if [ "$actual_error_id" != "$error_id" ]; then
      echo "ERROR: '$name' no esta conectado a '$error_workflow' como errorWorkflow" >&2
      exit 1
    fi
  done

  echo "Verificacion remota OK"
}

activate_inbound_workflow() {
  inbound_id=$(compose_cmd exec -T "$POSTGRES_SERVICE" sh -lc \
    "psql -U \"\$POSTGRES_USER\" -d \"\$POSTGRES_DB\" -At -c \"SELECT id FROM workflow_entity WHERE name = 'WA - Inbound Entry' LIMIT 1;\"")
  if [ -z "$inbound_id" ]; then
    echo "ERROR: no existe workflow 'WA - Inbound Entry' en n8n" >&2
    exit 1
  fi
  compose_cmd exec -T -u node "$N8N_SERVICE" n8n update:workflow --id="$inbound_id" --active=true >/dev/null
  compose_cmd restart "$N8N_SERVICE" >/dev/null
  echo "Workflow de entrada activado: WA - Inbound Entry"
}

sync_workflows() {
  validate_local
  require_command docker

  if [ ! -f "$PROJECT_ROOT/.env" ]; then
    echo "ERROR: no existe .env en $PROJECT_ROOT" >&2
    exit 1
  fi

  tmp_dir=$(mktemp -d)
  trap 'rm -rf "$tmp_dir"' EXIT

  before_ids="$tmp_dir/before.ids"
  before_ids_json="$tmp_dir/before.ids.json"
  after_ids="$tmp_dir/after.ids"
  after_ids_json="$tmp_dir/after.ids.json"
  base_dir="$tmp_dir/base"
  resolved_dir="$tmp_dir/resolved"
  remote_json="$tmp_dir/remote.json"

  query_workflow_ids > "$before_ids"
  write_ids_json "$before_ids" "$before_ids_json"
  prepare_import_dir "$before_ids_json" "$base_dir" "no"
  copy_and_import "$base_dir" "base"

  query_workflow_ids > "$after_ids"
  write_ids_json "$after_ids" "$after_ids_json"
  ensure_all_workflows_have_ids "$after_ids_json"
  prepare_import_dir "$after_ids_json" "$resolved_dir" "yes"
  copy_and_import "$resolved_dir" "links resueltos"
  verify_remote "$after_ids_json" "$remote_json"
  activate_inbound_workflow

  compose_cmd exec -T "$N8N_SERVICE" sh -lc "rm -rf '$CONTAINER_TMP'" >/dev/null 2>&1 || true
  echo "Workflows sincronizados con CLI oficial de n8n"
}

case "${1:-}" in
  "")
    sync_workflows
    ;;
  --preflight)
    validate_local
    ;;
  -h|--help)
    usage
    ;;
  *)
    usage >&2
    exit 1
    ;;
esac
