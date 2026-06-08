#!/bin/sh
set -eu

ROOT_DIR=$(CDPATH= cd -- "$(dirname "$0")/../.." && pwd)
cd "$ROOT_DIR"

. "$ROOT_DIR/.env"

INSTANCE_NAME="${1:-${EVOLUTION_DEFAULT_INSTANCE:-principal}}"

curl -sS \
  -X GET \
  -H "apikey: ${EVOLUTION_API_KEY}" \
  "${EVOLUTION_SERVER_URL}/instance/connect/${INSTANCE_NAME}"
