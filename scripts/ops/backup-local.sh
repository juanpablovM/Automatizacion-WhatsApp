#!/bin/sh
set -eu

ROOT_DIR=$(CDPATH= cd -- "$(dirname "$0")/../.." && pwd)
cd "$ROOT_DIR"

if [ ! -f "$ROOT_DIR/.env" ]; then
  echo "ERROR: no existe .env en $ROOT_DIR" >&2
  exit 1
fi

. "$ROOT_DIR/.env"

PROJECT_NAME="${PROJECT_NAME:-crm-whatsapp-automatizado}"
POSTGRES_USER="${POSTGRES_USER:-postgres}"
POSTGRES_DB="${POSTGRES_DB:-crm_whatsapp}"
APP_POSTGRES_DB="${APP_POSTGRES_DB:-crm_whatsapp_app}"
BACKUP_ROOT="${BACKUP_ROOT:-$ROOT_DIR/backups}"
STAMP=$(date +"%Y%m%d-%H%M%S")
BACKUP_DIR="$BACKUP_ROOT/$STAMP"

mkdir -p "$BACKUP_DIR"

compose() {
  docker compose --env-file "$ROOT_DIR/.env" "$@"
}

echo "Creando backup en: $BACKUP_DIR"

compose exec -T postgres pg_dump -U "$POSTGRES_USER" -d "$APP_POSTGRES_DB" \
  --format=custom --file=/tmp/crm_whatsapp_app.dump
compose cp postgres:/tmp/crm_whatsapp_app.dump "$BACKUP_DIR/crm_whatsapp_app.dump"
compose exec -T postgres rm -f /tmp/crm_whatsapp_app.dump

compose exec -T postgres pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" \
  --format=custom --file=/tmp/crm_whatsapp_n8n.dump
compose cp postgres:/tmp/crm_whatsapp_n8n.dump "$BACKUP_DIR/crm_whatsapp_n8n.dump"
compose exec -T postgres rm -f /tmp/crm_whatsapp_n8n.dump

docker run --rm \
  -v "${PROJECT_NAME}_n8n_data:/source:ro" \
  -v "$BACKUP_DIR:/backup" \
  alpine:3.20 \
  tar -czf /backup/n8n_data.tar.gz -C /source .

cat > "$BACKUP_DIR/manifest.txt" <<EOF
created_at=$STAMP
project_name=$PROJECT_NAME
postgres_business_db=$APP_POSTGRES_DB
postgres_n8n_db=$POSTGRES_DB
n8n_volume=${PROJECT_NAME}_n8n_data
EOF

echo "Backup listo:"
ls -lh "$BACKUP_DIR"
