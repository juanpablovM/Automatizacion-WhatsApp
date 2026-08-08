#!/bin/sh

set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname "$0")" && pwd)
PROJECT_ROOT=$(CDPATH= cd -- "$SCRIPT_DIR/../.." && pwd)
WORKFLOW_DIR="$PROJECT_ROOT/n8n/workflows"
LINK_MANIFEST="$PROJECT_ROOT/n8n/workflow-links.json"
N8N_SERVICE="${N8N_SERVICE:-n8n}"
POSTGRES_SERVICE="${POSTGRES_SERVICE:-postgres}"
CONTAINER_TMP="/tmp/crm-n8n-workflows-sync"
WORKFLOW_LOGIC_JQ='{name,id,description:(.description // null),settings:(.settings // {}),pinData:(.pinData // {}),meta:(.meta // {}),nodes:(.nodes // []),connections:(.connections // {})}'
EVOLUTION_WEBHOOK_STATE=""

usage() {
  cat <<'EOF'
Uso:
  E2E_ALLOW_EXTERNAL_EFFECTS=yes scripts/dev/sync-n8n-workflows.sh --deploy TELEFONO_CONTROLADO
  scripts/dev/sync-n8n-workflows.sh --preflight
  scripts/dev/sync-n8n-workflows.sh --verify-remote [export.json]
  scripts/dev/sync-n8n-workflows.sh --snapshot DIR | --rollback DIR

Sincroniza workflows versionados usando el CLI oficial de n8n.

Opciones:
  --preflight   Valida JSON, nombres y manifest local sin tocar Docker/n8n.
  --deploy      Despliega pausado, ejecuta acceptance controlada y activa al final.
  --verify-remote  Exporta y verifica el runtime, o verifica un export sin mutarlo.
  --snapshot DIR   Exporta un snapshot completo para rollback.
  --rollback DIR   Restaura y verifica un snapshot; deja Entry/Recovery pausados.
  --mapping-only  Valida/aplica solamente el mapping seguro de la instancia.
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

ensure_unique_runtime_names() {
  duplicate_names=$(cut -d'|' -f1 "$1" | sort | uniq -d)
  [ -z "$duplicate_names" ] || { echo "ERROR: nombres runtime duplicados antes del deploy: $duplicate_names" >&2; exit 1; }
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
    elif [ "$resolve_links" = "bootstrap" ]; then
      jq \
        --slurpfile ids "$ids_json" \
        --slurpfile manifest "$LINK_MANIFEST" '
        def workflow_id($name): ($ids[0][$name] // "");
        . as $workflow
        | (workflow_id($workflow.name)) as $ownId
        | if $ownId != "" then .id = $ownId else del(.id) end
        | if .name != $manifest[0].errorWorkflow.name then
            .settings = (.settings // {})
            | (workflow_id($manifest[0].errorWorkflow.name)) as $errorId
            | if $errorId != "" then .settings.errorWorkflow = $errorId else del(.settings.errorWorkflow) end
          else
            .
          end
        | .nodes = (.nodes | map(
            . as $node
            | ($manifest[0].links | map(select(.sourceWorkflow == $workflow.name and .node == $node.name)) | first) as $link
            | if $link then
                (workflow_id($link.targetWorkflow)) as $targetId
                | .parameters.source = "database"
                | .parameters.workflowId = {
                    "__rl": true,
                    "value": $targetId,
                    "mode": "list",
                    "cachedResultName": $link.targetWorkflow
                  }
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

capture_bootstrap_created_workflows() {
  before_ids="$1"
  after_ids="$2"
  created_json="$3"

  jq -Rn \
    --rawfile before "$before_ids" \
    --argjson names "$(workflow_files | while IFS= read -r file; do workflow_name_from_file "$file"; done | jq -Rsc 'split("\n") | map(select(length > 0))')" '
      ($before | split("\n") | map(select(length > 0) | split("|") | .[0])) as $beforeNames
      | [inputs
          | select(length > 0)
          | split("|")
          | select(length == 2)
          | {name: .[0], id: .[1]}
          | . as $row
          | select(($names | index($row.name)) != null)
          | select(($beforeNames | index($row.name)) == null)
        ]
      | unique_by([.name, .id])
    ' "$after_ids" > "$created_json"
}

snapshot_has_workflow_name() {
  snapshot_dir="$1"
  expected_name="$2"
  find "$snapshot_dir" -maxdepth 1 -type f -name '*.json' | sort | while IFS= read -r snapshot_file; do
    [ "$(workflow_name_from_file "$snapshot_file")" = "$expected_name" ] && {
      echo yes
      exit 0
    }
  done | grep -q '^yes$'
}

discover_bootstrap_workflows_for_rollback() {
  snapshot_dir="$1"
  runtime_ids="$2"
  discovered_json="$3"
  snapshot_names=$(find "$snapshot_dir" -maxdepth 1 -type f -name '*.json' | sort | while IFS= read -r snapshot_file; do workflow_name_from_file "$snapshot_file"; done | jq -Rsc 'split("\n") | map(select(length > 0))')
  local_names=$(workflow_files | while IFS= read -r file; do workflow_name_from_file "$file"; done | jq -Rsc 'split("\n") | map(select(length > 0))')

  jq -Rn --argjson snapshotNames "$snapshot_names" --argjson localNames "$local_names" '
    [inputs
      | select(length > 0)
      | split("|")
      | select(length == 2)
      | {name: .[0], id: .[1]}
      | . as $row
      | select(($localNames | index($row.name)) != null)
      | select(($snapshotNames | index($row.name)) == null)
    ]
    | unique_by([.name, .id])
  ' "$runtime_ids" > "$discovered_json"
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

delete_bootstrap_workflows_transaction() {
  created_json="$1"
  container_created="$CONTAINER_TMP-bootstrap-created-$$.json"

  compose_cmd cp "$created_json" "$POSTGRES_SERVICE:$container_created"
  compose_cmd exec -T "$POSTGRES_SERVICE" sh -lc \
    "psql -U \"\$POSTGRES_USER\" -d \"\$POSTGRES_DB\" -v ON_ERROR_STOP=1" <<SQL
BEGIN;
WITH requested AS (
  SELECT name, id
  FROM jsonb_to_recordset(pg_read_file('$container_created')::jsonb) AS x(name text, id text)
)
DELETE FROM workflow_entity AS workflow
USING requested
WHERE workflow.name = requested.name
  AND workflow.id = requested.id;
COMMIT;
SQL
  compose_cmd exec -T "$POSTGRES_SERVICE" rm -f "$container_created" >/dev/null 2>&1 || true
}

cleanup_bootstrap_workflows() {
  snapshot_dir="$1"
  created_json="${2:-}"
  rollback_ids=$(mktemp)
  cleanup_json=$(mktemp)
  query_workflow_ids > "$rollback_ids"
  discover_bootstrap_workflows_for_rollback "$snapshot_dir" "$rollback_ids" "$cleanup_json"

  if [ -n "$created_json" ] && [ -s "$created_json" ]; then
    jq -e 'type == "array" and all(.[]; (.name | type == "string") and (.id | type == "string") and (.name | length > 0) and (.id | length > 0))' "$created_json" >/dev/null
  fi
  [ "$(jq 'length' "$cleanup_json")" -gt 0 ] || { rm -f "$rollback_ids" "$cleanup_json"; return 0; }

  jq -r '.[].name' "$cleanup_json" | while IFS= read -r created_name; do
    if snapshot_has_workflow_name "$snapshot_dir" "$created_name"; then
      echo "ERROR: rollback rechazo borrar '$created_name': el nombre existe en el snapshot" >&2
      return 1
    fi
  done

  delete_bootstrap_workflows_transaction "$cleanup_json"

  query_workflow_ids > "$rollback_ids"
  jq -r '.[] | [.name, .id] | @tsv' "$cleanup_json" | while IFS='	' read -r created_name created_id; do
    if awk -F'|' -v name="$created_name" -v id="$created_id" '$1 == name && $2 == id { found=1 } END { exit !found }' "$rollback_ids"; then
      echo "ERROR: rollback no elimino workflow bootstrap '$created_name' ($created_id)" >&2
      rm -f "$rollback_ids"
      return 1
    fi
  done
  rm -f "$rollback_ids" "$cleanup_json"
  echo "Workflows creados durante bootstrap eliminados en rollback" >&2
}

export_remote_definitions() {
  remote_json="$1"
  compose_cmd exec -T "$POSTGRES_SERVICE" sh -lc 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -At' > "$remote_json" <<'SQL'
SELECT COALESCE(json_agg(json_build_object(
  'name',name,'id',id,'active',active,'description',description,
  'settings',settings,'staticData',"staticData",'pinData',"pinData",
  'meta',meta,'nodes',nodes,'connections',connections
) ORDER BY name), '[]'::json) FROM workflow_entity;
SQL
}

verify_remote_export() {
  remote_json="$1"
  require_paused="${2:-no}"
  candidate_dir="${3:-}"
  jq -e 'type == "array"' "$remote_json" >/dev/null

  ids_json=$(mktemp)
  trap 'rm -f "$ids_json"' EXIT
  workflow_files | while IFS= read -r file; do
    name=$(workflow_name_from_file "$file")
    count=$(jq -r --arg name "$name" '[.[] | select(.name == $name)] | length' "$remote_json")
    [ "$count" -eq 1 ] || { echo "ERROR: '$name' debe resolver a un workflow remoto; encontrados: $count" >&2; exit 1; }
    id=$(jq -r --arg name "$name" '[.[] | select(.name == $name) | .id][0] // ""' "$remote_json")
    [ -n "$id" ] || { echo "ERROR: workflow remoto '$name' tiene ID vacio" >&2; exit 1; }
    printf '%s|%s\n' "$name" "$id"
  done > "$ids_json"

  duplicate_ids=$(cut -d'|' -f2- "$ids_json" | sort | uniq -d)
  [ -z "$duplicate_ids" ] || { echo "ERROR: IDs remotos ambiguos: $duplicate_ids" >&2; exit 1; }

  jq -r '.links[] | [.sourceWorkflow, .node, .targetWorkflow] | @tsv' "$LINK_MANIFEST" |
    while IFS='	' read -r source_workflow node_name target_workflow; do
      expected_id=$(awk -F'|' -v name="$target_workflow" '$1 == name { print $2; exit }' "$ids_json")
      actual_id=$(jq -r --arg source "$source_workflow" --arg node "$node_name" '
        [.[] | select(.name == $source) | .nodes[] | select(.name == $node) | .parameters.workflowId.value][0] // ""
      ' "$remote_json")
      if [ "$actual_id" != "$expected_id" ]; then
        echo "ERROR: link remoto incorrecto: '$source_workflow' / '$node_name' apunta a '$actual_id', esperado '$expected_id'" >&2
        exit 1
      fi
    done

  error_workflow=$(jq -r '.errorWorkflow.name' "$LINK_MANIFEST")
  error_id=$(awk -F'|' -v name="$error_workflow" '$1 == name { print $2; exit }' "$ids_json")
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

  if [ "$require_paused" = yes ]; then
    for caller in 'WA - Inbound Entry' 'WA - Inbound Recovery'; do
      active=$(jq -r --arg name "$caller" '[.[] | select(.name == $name) | .active][0] // false' "$remote_json")
      [ "$active" = "false" ] || { echo "ERROR: '$caller' sigue activo antes de completar la verificacion" >&2; exit 1; }
    done
  fi

  if [ -n "$candidate_dir" ]; then
    workflow_files | while IFS= read -r file; do
      name=$(workflow_name_from_file "$file")
      candidate=$(find "$candidate_dir" -type f -name '*.json' -exec jq -r --arg name "$name" 'select(.name == $name) | input_filename' {} + | head -n 1)
      [ -n "$candidate" ] || { echo "ERROR: candidato sin '$name'" >&2; exit 1; }
      expected=$(jq -cS "$WORKFLOW_LOGIC_JQ" "$candidate")
      actual=$(jq -cS --arg name "$name" "[.[] | select(.name == \$name)][0] | $WORKFLOW_LOGIC_JQ" "$remote_json")
      [ "$actual" = "$expected" ] || { echo "ERROR: definicion remota difiere del candidato para '$name'" >&2; exit 1; }
    done
  fi

  rm -f "$ids_json"
  trap - EXIT
  echo "Verificacion remota OK"
}

set_callers_active() {
  state="$1"
  [ "${2:-both}" = entry ] && callers='WA - Inbound Entry' || callers='WA - Inbound Entry|WA - Inbound Recovery'
  printf '%s\n' "$callers" | tr '|' '\n' | while IFS= read -r workflow_name; do
    workflow_ids=$(query_workflow_ids | awk -F'|' -v name="$workflow_name" '$1 == name { print $2 }')
    count=$(printf '%s\n' "$workflow_ids" | sed '/^$/d' | wc -l | tr -d ' ')
    [ "$count" -ge 1 ] || { echo "ERROR: no existe workflow '$workflow_name' en n8n" >&2; exit 1; }
    [ "$state" = false ] || [ "$count" -eq 1 ] || { echo "ERROR: activacion ambigua para '$workflow_name': $count IDs" >&2; exit 1; }
    for workflow_id in $workflow_ids; do compose_cmd exec -T -u node "$N8N_SERVICE" n8n update:workflow --id="$workflow_id" --active="$state" >/dev/null; done
  done
  compose_cmd restart "$N8N_SERVICE" >/dev/null
}

snapshot_runtime_workflows() {
  snapshot_dir="$1"
  container_snapshot="$CONTAINER_TMP-snapshot"
  [ ! -e "$snapshot_dir" ] || { echo "ERROR: el destino del snapshot ya existe: $snapshot_dir" >&2; exit 1; }
  mkdir -p "$snapshot_dir"
  compose_cmd exec -T "$N8N_SERVICE" sh -lc "rm -rf '$container_snapshot' && mkdir -p '$container_snapshot'"
  compose_cmd exec -T -u node "$N8N_SERVICE" n8n export:workflow --backup --output="$container_snapshot" >/dev/null
  compose_cmd cp "$N8N_SERVICE:$container_snapshot/." "$snapshot_dir"
}

restore_runtime_workflows() {
  snapshot_dir="$1"
  created_json="${2:-}"
  echo "Restaurando snapshot runtime; los callers permaneceran pausados..." >&2
  set_callers_active false
  copy_and_import "$snapshot_dir" "rollback"
  cleanup_bootstrap_workflows "$snapshot_dir" "$created_json"
  compose_cmd restart "$N8N_SERVICE" >/dev/null
  restored_json=$(mktemp)
  export_remote_definitions "$restored_json"
  find "$snapshot_dir" -type f -name '*.json' | sort | while IFS= read -r snapshot_file; do
    name=$(workflow_name_from_file "$snapshot_file")
    [ "$(jq -r --arg name "$name" '[.[] | select(.name == $name)] | length' "$restored_json")" -eq 1 ] || { echo "ERROR: rollback ambiguo para '$name'" >&2; exit 1; }
    expected=$(jq -cS "$WORKFLOW_LOGIC_JQ" "$snapshot_file")
    actual=$(jq -cS --arg name "$name" "[.[] | select(.name == \$name)][0] | $WORKFLOW_LOGIC_JQ" "$restored_json")
    [ "$actual" = "$expected" ] || { echo "ERROR: rollback remoto no coincide para '$name'" >&2; exit 1; }
  done
  rm -f "$restored_json"
  echo "Rollback remoto verificado; trafico pausado" >&2
}

verify_remote() {
  remote_json="$1"
  require_paused="${2:-no}"
  candidate_dir="${3:-}"
  export_remote_definitions "$remote_json"
  verify_remote_export "$remote_json" "$require_paused" "$candidate_dir"
}

activate_runtime_workflows() {
  set_callers_active true
  echo "Workflows runtime activados: Entry y Recovery"
}

run_controlled_acceptance() {
  phone="$1"
  evidence_file="$2"
  acceptance_path="$3"
  [ "${E2E_ALLOW_EXTERNAL_EFFECTS:-}" = yes ] || { echo "ERROR: exporta E2E_ALLOW_EXTERNAL_EFFECTS=yes para aceptar efectos externos controlados" >&2; return 1; }
  . "$PROJECT_ROOT/.env"
  EVOLUTION_WEBHOOK_STATE=$(mktemp)
  curl -fsS -H "apikey: $EVOLUTION_API_KEY" "$EVOLUTION_SERVER_URL/webhook/find/${EVOLUTION_DEFAULT_INSTANCE}" > "$EVOLUTION_WEBHOOK_STATE"
  webhook_payload=$(jq -c '{webhook:{enabled:false,url:.url,byEvents:.webhookByEvents,base64:.webhookBase64,events:.events,headers:.headers}}' "$EVOLUTION_WEBHOOK_STATE")
  curl -fsS -X POST -H 'Content-Type: application/json' -H "apikey: $EVOLUTION_API_KEY" "$EVOLUTION_SERVER_URL/webhook/set/${EVOLUTION_DEFAULT_INSTANCE}" -d "$webhook_payload" >/dev/null
  set +e
  set_callers_active true entry
  E2E_ALLOW_EXTERNAL_EFFECTS=yes E2E_EVIDENCE_FILE="$evidence_file" E2E_WEBHOOK_PATH="$acceptance_path" sh "$PROJECT_ROOT/scripts/ops/test-e2e-lead-creation.sh" "$phone"
  status=$?
  set_callers_active false || status=1
  restore_evolution_webhook || status=1
  set -e
  return "$status"
}

restore_evolution_webhook() {
  [ -n "$EVOLUTION_WEBHOOK_STATE" ] && [ -f "$EVOLUTION_WEBHOOK_STATE" ] || return 0
  payload=$(jq -c '{webhook:{enabled:.enabled,url:.url,byEvents:.webhookByEvents,base64:.webhookBase64,events:.events,headers:.headers}}' "$EVOLUTION_WEBHOOK_STATE")
  attempt=0
  while [ "$attempt" -lt 3 ]; do
    if curl -fsS -X POST -H 'Content-Type: application/json' -H "apikey: $EVOLUTION_API_KEY" "$EVOLUTION_SERVER_URL/webhook/set/${EVOLUTION_DEFAULT_INSTANCE}" -d "$payload" >/dev/null; then rm -f "$EVOLUTION_WEBHOOK_STATE"; EVOLUTION_WEBHOOK_STATE=""; return 0; fi
    attempt=$((attempt + 1)); sleep 1
  done
  return 1
}

verify_webhook_ready() {
  attempt=0
  while [ "$attempt" -lt 20 ]; do
    webhook_path=$(compose_cmd exec -T "$POSTGRES_SERVICE" sh -lc "psql -U \"\$POSTGRES_USER\" -d \"\$POSTGRES_DB\" -At -c \"SELECT \\\"webhookPath\\\" FROM webhook_entity WHERE \\\"workflowId\\\"=(SELECT id FROM workflow_entity WHERE name='WA - Inbound Entry') AND node='InboundHealthCheck' LIMIT 1;\"")
    [ -n "$webhook_path" ] && curl -fsS "http://127.0.0.1:${N8N_PORT:-5678}/webhook/$webhook_path" >/dev/null && return 0
    sleep 1; attempt=$((attempt + 1))
  done
  echo "ERROR: webhook de Entry no quedo disponible despues de activar" >&2
  return 1
}

ensure_default_instance_mapping() {
  mapping_sql="$PROJECT_ROOT/db/queries/ops/ensure-default-instance-mapping.sql"
  if [ ! -f "$mapping_sql" ]; then
    echo "ERROR: no existe $mapping_sql" >&2
    exit 1
  fi

  default_instance=$(compose_cmd exec -T "$N8N_SERVICE" sh -lc 'printf %s "$EVOLUTION_DEFAULT_INSTANCE"')
  if [ -z "$default_instance" ]; then
    echo "ERROR: EVOLUTION_DEFAULT_INSTANCE esta vacio en n8n" >&2
    exit 1
  fi

  app_db=$(awk -F= '$1 == "APP_POSTGRES_DB" { print substr($0, index($0, "=") + 1); exit }' "$PROJECT_ROOT/.env")
  app_db=${app_db:-crm_whatsapp_app}

  compose_cmd exec -T -e DEFAULT_INSTANCE="$default_instance" "$POSTGRES_SERVICE" sh -lc \
    "psql -U \"\$POSTGRES_USER\" -d '$app_db' -v ON_ERROR_STOP=1 -v instance_name=\"\$DEFAULT_INSTANCE\"" \
    < "$mapping_sql"
  echo "Mapeo de instancia validado para la linea activa"
}

sync_workflows() {
  controlled_phone="$1"
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
  after_bootstrap_ids="$tmp_dir/after-bootstrap.ids"
  after_bootstrap_ids_json="$tmp_dir/after-bootstrap.ids.json"
  bootstrap_created_json="$tmp_dir/bootstrap-created.json"
  bootstrap_dir="$tmp_dir/bootstrap"
  resolved_dir="$tmp_dir/resolved"
  remote_json="$tmp_dir/remote.json"
  snapshot_dir="$tmp_dir/runtime-snapshot"

  query_workflow_ids > "$before_ids"
  ensure_unique_runtime_names "$before_ids"
  write_ids_json "$before_ids" "$before_ids_json"
  snapshot_runtime_workflows "$snapshot_dir"
  printf '[]\n' > "$bootstrap_created_json"
  rollback_required=yes
  trap 'status=$?; trap - EXIT HUP INT TERM; restore_evolution_webhook || true; if [ "$status" -ne 0 ] && [ "${rollback_required:-no}" = yes ]; then restore_runtime_workflows "$snapshot_dir" "$bootstrap_created_json" || true; fi; rm -rf "$tmp_dir"; exit "$status"' EXIT
  trap 'exit 130' HUP INT TERM
  set_callers_active false
  prepare_import_dir "$before_ids_json" "$bootstrap_dir" "bootstrap"
  copy_and_import "$bootstrap_dir" "bootstrap de IDs"
  query_workflow_ids > "$after_bootstrap_ids"
  capture_bootstrap_created_workflows "$before_ids" "$after_bootstrap_ids" "$bootstrap_created_json"
  ensure_unique_runtime_names "$after_bootstrap_ids"
  write_ids_json "$after_bootstrap_ids" "$after_bootstrap_ids_json"
  ensure_all_workflows_have_ids "$after_bootstrap_ids_json"
  prepare_import_dir "$after_bootstrap_ids_json" "$resolved_dir" "yes"
  copy_and_import "$resolved_dir" "links resueltos"
  verify_remote "$remote_json" yes "$resolved_dir"
  ensure_default_instance_mapping
  acceptance_dir="$tmp_dir/acceptance"; cp -R "$resolved_dir" "$acceptance_dir"
  acceptance_path="acceptance-$(date +%s)-$$"
  entry_file=$(find "$acceptance_dir" -type f -name '*.json' -exec jq -r 'select(.name == "WA - Inbound Entry") | input_filename' {} + | head -n 1)
  jq --arg path "$acceptance_path" '(.nodes[] | select(.name == "EvolutionWebhook") | .parameters.path) = $path' "$entry_file" > "$entry_file.tmp" && mv "$entry_file.tmp" "$entry_file"
  copy_and_import "$acceptance_dir" "acceptance aislada"
  verify_remote "$tmp_dir/acceptance.json" yes "$acceptance_dir"
  run_controlled_acceptance "$controlled_phone" "$tmp_dir/e2e-evidence.json" "$acceptance_path"
  copy_and_import "$resolved_dir" "candidato post-acceptance"
  verify_remote "$remote_json" yes "$resolved_dir"
  activate_runtime_workflows
  verify_remote "$tmp_dir/post-activation.json" no "$resolved_dir"
  verify_webhook_ready
  rollback_required=no

  compose_cmd exec -T "$N8N_SERVICE" sh -lc "rm -rf '$CONTAINER_TMP'" >/dev/null 2>&1 || true
  echo "Workflows sincronizados con CLI oficial de n8n"
}

if [ "${SYNC_N8N_SOURCE_ONLY:-no}" = yes ]; then
  return 0 2>/dev/null || exit 0
fi

case "${1:-}" in
  "")
    echo "ERROR: usa --deploy TELEFONO_CONTROLADO con E2E_ALLOW_EXTERNAL_EFFECTS=yes" >&2
    exit 1
    ;;
  --deploy)
    [ -n "${2:-}" ] || { usage >&2; exit 1; }
    sync_workflows "$2"
    ;;
  --preflight)
    validate_local
    ;;
  --verify-remote)
    validate_local
    if [ -n "${2:-}" ]; then
      verify_remote_export "$2" no "${3:-}"
    else
      require_command docker
      tmp_remote=$(mktemp)
      trap 'rm -f "$tmp_remote"' EXIT
      verify_remote "$tmp_remote"
    fi
    ;;
  --snapshot)
    [ -n "${2:-}" ] || { usage >&2; exit 1; }
    require_command docker
    snapshot_runtime_workflows "$2"
    ;;
  --rollback)
    [ -d "${2:-}" ] || { echo "ERROR: snapshot de rollback invalido" >&2; exit 1; }
    require_command docker
    restore_runtime_workflows "$2"
    ;;
  --mapping-only)
    require_command docker
    if [ ! -f "$PROJECT_ROOT/.env" ]; then
      echo "ERROR: no existe .env en $PROJECT_ROOT" >&2
      exit 1
    fi
    ensure_default_instance_mapping
    ;;
  -h|--help)
    usage
    ;;
  *)
    usage >&2
    exit 1
    ;;
esac
