#!/bin/sh
set -eu

ROOT_DIR=$(CDPATH= cd -- "$(dirname "$0")/../.." && pwd)
cd "$ROOT_DIR"

if [ ! -f "$ROOT_DIR/.env" ]; then
  echo "ERROR: no existe .env en $ROOT_DIR" >&2
  exit 1
fi

. "$ROOT_DIR/.env"

require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "ERROR: falta dependencia '$1'" >&2
    exit 1
  fi
}

require_cmd curl
require_cmd jq

BASE_URL="${EVOLUTION_SERVER_URL:-http://localhost:8080}"
API_KEY="${EVOLUTION_API_KEY:-}"
DEFAULT_INSTANCE="${EVOLUTION_DEFAULT_INSTANCE:-principal}"
IMAGE="${EVOLUTION_API_IMAGE:-<no-definida>}"

if [ -z "$API_KEY" ]; then
  echo "ERROR: EVOLUTION_API_KEY no esta definida en .env" >&2
  exit 1
fi

api_get() {
  path="$1"
  curl -fsS -H "apikey: $API_KEY" "${BASE_URL}${path}"
}

root_json=$(curl -fsS "$BASE_URL/" 2>/dev/null || true)
if [ -z "$root_json" ]; then
  echo "ERROR: no se pudo conectar a Evolution API en $BASE_URL" >&2
  exit 1
fi

api_version=$(printf "%s" "$root_json" | jq -r '.version // "unknown"')

instances_json=$(api_get "/instance/fetchInstances" 2>/dev/null || printf "[]")
instances_total=$(printf "%s" "$instances_json" | jq 'length')
default_exists="no"
if printf "%s" "$instances_json" | jq -e --arg name "$DEFAULT_INSTANCE" '.[] | select(.name == $name)' >/dev/null 2>&1; then
  default_exists="si"
fi

printf "Evolution Doctor\n"
printf "================\n"
printf "Base URL              : %s\n" "$BASE_URL"
printf "Version API (runtime) : %s\n" "$api_version"
printf "Imagen configurada    : %s\n" "$IMAGE"
printf "Instancias totales    : %s\n" "$instances_total"
printf "Instancia default     : %s (existe: %s)\n" "$DEFAULT_INSTANCE" "$default_exists"

printf "\nInstancias:\n"
printf "%s" "$instances_json" | jq -r '.[] | "- \(.name): integration=\(.integration // "n/a"), status=\(.connectionStatus // "n/a")"'

printf "\nChequeos:\n"
if printf "%s" "$IMAGE" | grep -Eq '(^|:|/)latest$|atendai/evolution-api'; then
  printf -- "- WARN: EVOLUTION_API_IMAGE usa un tag flotante o repositorio legado; conviene fijar evoapicloud/evolution-api:v2.3.7 o superior.\n"
else
  printf -- "- OK: EVOLUTION_API_IMAGE no usa latest.\n"
fi

if printf "%s" "$api_version" | grep -Eq '^2\.[0-2]\.'; then
  printf -- "- WARN: runtime en %s (rama antigua); se recomienda v2.3.x.\n" "$api_version"
else
  printf -- "- OK: runtime en rama 2.3.x o superior.\n"
fi

if [ "$default_exists" = "no" ]; then
  printf -- "- WARN: la instancia default no existe. Crear con:\n"
  printf "  sh scripts/dev/evolution-create-instance.sh %s\n" "$DEFAULT_INSTANCE"
else
  printf -- "- OK: la instancia default existe.\n"
fi
