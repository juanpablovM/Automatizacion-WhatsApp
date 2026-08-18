#!/bin/sh
set -eu

ROOT_DIR=$(CDPATH= cd -- "$(dirname "$0")/../.." && pwd)
cd "$ROOT_DIR"
umask 077

require() { command -v "$1" >/dev/null 2>&1 || { echo "ERROR: missing dependency: $1" >&2; exit 1; }; }
for tool in curl jq sha256sum node docker; do require "$tool"; done

ENV_FILE=${HANDOFF_ENV_FILE:-.env}
[ -f "$ENV_FILE" ] || { echo 'ERROR: local environment file is required' >&2; exit 1; }
set -a
. "./$ENV_FILE"
set +a

api_get() { curl -fsS -H "Authorization: $CLICKUP_API_TOKEN" "https://api.clickup.com/api/v2$1"; }
api_post() { curl -fsS -X POST -H "Authorization: $CLICKUP_API_TOKEN" -H 'Content-Type: application/json' --data "$2" "https://api.clickup.com/api/v2$1"; }
safe_value() { case "${1:-}" in ''|__PENDIENTE__|change_me) return 1;; *) return 0;; esac; }
recreate_n8n() {
  unset CLICKUP_LIST_ID HANDOFF_CLICKUP_ASSIGNEES_JSON
  docker compose --env-file "$ENV_FILE" up -d --no-deps --force-recreate n8n
}
if [ "${1:-}" = --recreate-n8n ]; then
  recreate_n8n
  exit 0
fi

safe_value "${CLICKUP_API_TOKEN:-}" || { echo 'ERROR: ClickUp token is not configured' >&2; exit 1; }
safe_value "${CLICKUP_TEAM_ID:-}" || { echo 'ERROR: ClickUp team is not configured' >&2; exit 1; }
safe_value "${CLICKUP_LIST_ID:-}" || { echo 'ERROR: an existing validated ClickUp list is required as the parent anchor' >&2; exit 1; }

tmp_dir=$(mktemp -d)
snapshot="$tmp_dir/env.before"
rollback=0
cleanup() {
  status=$?
  if [ "$rollback" = 1 ]; then
    cp "$snapshot" "$ENV_FILE"
    recreate_n8n >/dev/null 2>&1 || true
  fi
  rm -rf "$tmp_dir"
  exit "$status"
}
trap cleanup EXIT HUP INT TERM

members=$(api_get "/team")
owner_id=$(printf '%s' "$members" | jq -er --arg name 'Juan Pablo' '
  [.teams[]?.members[]? | select((.user.username // "") == $name)
   | select((.user.date_joined // "") != "" and (.user.status // "active") == "active") | (.user.id | tostring)]
  | unique | if length == 1 then .[0] else error("owner must be exactly one active joined member") end')
anchor=$(api_get "/list/$CLICKUP_LIST_ID")
space_id=$(printf '%s' "$anchor" | jq -er '.space.id | tostring')
lists=$(api_get "/space/$space_id/list?archived=false")
matches=$(printf '%s' "$lists" | jq --arg name 'Handoffs WhatsApp' '[.lists[]? | select(.name == $name)]')
count=$(printf '%s' "$matches" | jq 'length')
case "$count" in
  0) target=$(api_post "/space/$space_id/list" '{"name":"Handoffs WhatsApp"}'); list_action=created ;;
  1) target=$(printf '%s' "$matches" | jq '.[0]'); list_action=reused ;;
  *) echo 'ERROR: duplicate dedicated handoff lists detected; configuration stopped' >&2; exit 1 ;;
esac
target_id=$(printf '%s' "$target" | jq -er '.id | tostring')
target_detail=$(api_get "/list/$target_id")
printf '%s' "$target_detail" | jq -e --arg space "$space_id" --arg name 'Handoffs WhatsApp' \
  '.id and .name == $name and (.space.id | tostring) == $space' >/dev/null
list_members=$(api_get "/list/$target_id/member")
printf '%s' "$list_members" | jq -e --arg owner "$owner_id" \
  '[.members[]? | (.user.id // .id | tostring)] | index($owner) != null' >/dev/null || {
  echo 'ERROR: Sales owner is not assignable in the dedicated list context' >&2; exit 1;
}

cp "$ENV_FILE" "$snapshot"
before_hash=$(sha256sum "$snapshot" | cut -d' ' -f1)
rollback=1
node - "$ENV_FILE" "$target_id" "$owner_id" <<'NODE'
const fs = require('fs');
const [path, listId, ownerId] = process.argv.slice(2);
const lines = fs.readFileSync(path, 'utf8').split(/\r?\n/);
const mappingPrefix = 'HANDOFF_CLICKUP_ASSIGNEES_JSON=';
const existingLine = lines.find((line) => line.startsWith(mappingPrefix));
const existingAssignees = existingLine ? existingLine.slice(mappingPrefix.length) : '{}';
let mapping;
try { mapping = JSON.parse(existingAssignees); } catch (_error) { throw new Error('existing handoff assignee mapping is invalid'); }
if (!mapping || Array.isArray(mapping) || typeof mapping !== 'object') throw new Error('existing handoff assignee mapping is invalid');
if (!Number.isSafeInteger(Number(ownerId))) throw new Error('validated Sales owner ID is not a safe integer');
mapping.sales = [Number(ownerId)];
const next = lines.filter((line) => !/^(CLICKUP_LIST_ID|HANDOFF_CLICKUP_ASSIGNEES_JSON)=/.test(line));
next.push(`CLICKUP_LIST_ID=${listId}`, `HANDOFF_CLICKUP_ASSIGNEES_JSON=${JSON.stringify(mapping)}`);
fs.writeFileSync(`${path}.next`, `${next.filter(Boolean).join('\n')}\n`, { mode: 0o600 });
fs.renameSync(`${path}.next`, path);
NODE
after_hash=$(sha256sum "$ENV_FILE" | cut -d' ' -f1)

node - "$snapshot" "$ENV_FILE" <<'NODE'
const fs = require('fs');
const allowed = /^(CLICKUP_LIST_ID|HANDOFF_CLICKUP_ASSIGNEES_JSON)=/;
const preserved = (path) => fs.readFileSync(path, 'utf8').split(/\r?\n/).filter((line) => line && !allowed.test(line));
if (JSON.stringify(preserved(process.argv[2])) !== JSON.stringify(preserved(process.argv[3]))) {
  throw new Error('configuration changed values outside the approved handoff keys');
}
NODE

recreate_n8n >/dev/null
[ "$(docker compose ps --status running --services n8n)" = n8n ] || { echo 'ERROR: n8n did not become running' >&2; exit 1; }
current=$(docker compose exec -T n8n sh -c 'printf "%s|%s" "$CLICKUP_LIST_ID" "$HANDOFF_CLICKUP_ASSIGNEES_JSON"')
expected=$(node - "$ENV_FILE" <<'NODE'
const fs = require('fs');
const values = Object.fromEntries(fs.readFileSync(process.argv[2], 'utf8').split(/\r?\n/).filter(Boolean).map((line) => {
  const index = line.indexOf('=');
  return [line.slice(0, index), line.slice(index + 1)];
}));
process.stdout.write(`${values.CLICKUP_LIST_ID || ''}|${values.HANDOFF_CLICKUP_ASSIGNEES_JSON || ''}`);
NODE
)
case "$current" in
  '|'|*'|') echo 'ERROR: n8n configuration values are missing' >&2; exit 1 ;;
esac
runtime_hash=$(printf '%s' "$current" | sha256sum | cut -d' ' -f1)
expected_hash=$(printf '%s' "$expected" | sha256sum | cut -d' ' -f1)
[ "$runtime_hash" = "$expected_hash" ] || { echo 'ERROR: n8n configuration hashes do not match' >&2; exit 1; }
[ "$current" = "$expected" ] || { echo 'ERROR: n8n configuration did not synchronize' >&2; exit 1; }

rollback=0
printf '%s\n' "ClickUp handoff configuration verified: dedicated list $list_action, active Sales owner, n8n-only runtime synchronized (env hashes present and runtime match)."
