#!/bin/sh
set -eu

ROOT_DIR=$(CDPATH= cd -- "$(dirname "$0")/../.." && pwd)
cd "$ROOT_DIR"

if [ ! -f "$ROOT_DIR/.env" ]; then
  echo "ERROR: no existe .env en $ROOT_DIR" >&2
  exit 1
fi

. "$ROOT_DIR/.env"

BACKUP_DIR="${1:-}"
if [ -z "$BACKUP_DIR" ]; then
  BACKUP_DIR=$(find "$ROOT_DIR/backups" -mindepth 1 -maxdepth 1 -type d 2>/dev/null | sort | tail -1)
fi

if [ -z "$BACKUP_DIR" ] || [ ! -d "$BACKUP_DIR" ]; then
  echo "ERROR: indica un directorio de backup o crea uno con scripts/ops/backup-local.sh" >&2
  exit 1
fi

APP_DUMP="$BACKUP_DIR/crm_whatsapp_app.dump"
N8N_DUMP="$BACKUP_DIR/crm_whatsapp_n8n.dump"
N8N_TAR="$BACKUP_DIR/n8n_data.tar.gz"

for file in "$APP_DUMP" "$N8N_DUMP" "$N8N_TAR"; do
  if [ ! -s "$file" ]; then
    echo "ERROR: falta archivo de backup o esta vacio: $file" >&2
    exit 1
  fi
done

POSTGRES_USER="${POSTGRES_USER:-postgres}"
STAMP=$(date +"%Y%m%d%H%M%S")
APP_RESTORE_DB="crm_whatsapp_app_restore_check_$STAMP"
N8N_RESTORE_DB="crm_whatsapp_n8n_restore_check_$STAMP"

compose() {
  docker compose --env-file "$ROOT_DIR/.env" "$@"
}

cleanup() {
  compose exec -T postgres psql -U "$POSTGRES_USER" -d postgres -v ON_ERROR_STOP=1 -c "DROP DATABASE IF EXISTS $APP_RESTORE_DB;" >/dev/null 2>&1 || true
  compose exec -T postgres psql -U "$POSTGRES_USER" -d postgres -v ON_ERROR_STOP=1 -c "DROP DATABASE IF EXISTS $N8N_RESTORE_DB;" >/dev/null 2>&1 || true
}
trap cleanup EXIT

echo "Verificando backup: $BACKUP_DIR"

compose cp "$APP_DUMP" "postgres:/tmp/crm_whatsapp_app_restore.dump" >/dev/null
compose cp "$N8N_DUMP" "postgres:/tmp/crm_whatsapp_n8n_restore.dump" >/dev/null

compose exec -T postgres psql -U "$POSTGRES_USER" -d postgres -v ON_ERROR_STOP=1 -c "CREATE DATABASE $APP_RESTORE_DB;" >/dev/null
compose exec -T postgres pg_restore -U "$POSTGRES_USER" -d "$APP_RESTORE_DB" --no-owner --no-privileges /tmp/crm_whatsapp_app_restore.dump >/dev/null

compose exec -T postgres psql -U "$POSTGRES_USER" -d postgres -v ON_ERROR_STOP=1 -c "CREATE DATABASE $N8N_RESTORE_DB;" >/dev/null
compose exec -T postgres pg_restore -U "$POSTGRES_USER" -d "$N8N_RESTORE_DB" --no-owner --no-privileges /tmp/crm_whatsapp_n8n_restore.dump >/dev/null

app_tables=$(compose exec -T postgres psql -U "$POSTGRES_USER" -d "$APP_RESTORE_DB" -At -c "SELECT count(*) FROM information_schema.tables WHERE table_schema = 'public';")
n8n_tables=$(compose exec -T postgres psql -U "$POSTGRES_USER" -d "$N8N_RESTORE_DB" -At -c "SELECT count(*) FROM information_schema.tables WHERE table_schema = 'public';")
lead_count=$(compose exec -T postgres psql -U "$POSTGRES_USER" -d "$APP_RESTORE_DB" -At -c "SELECT count(*) FROM leads;")
workflow_count=$(compose exec -T postgres psql -U "$POSTGRES_USER" -d "$N8N_RESTORE_DB" -At -c "SELECT count(*) FROM workflow_entity;")

tar -tzf "$N8N_TAR" >/dev/null

compose exec -T postgres rm -f /tmp/crm_whatsapp_app_restore.dump /tmp/crm_whatsapp_n8n_restore.dump >/dev/null

echo "Restore check OK"
printf "app_tables=%s\n" "$app_tables"
printf "app_leads=%s\n" "$lead_count"
printf "n8n_tables=%s\n" "$n8n_tables"
printf "n8n_workflows=%s\n" "$workflow_count"
printf "n8n_volume_tar=readable\n"
