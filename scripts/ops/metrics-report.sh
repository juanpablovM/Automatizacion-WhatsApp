#!/bin/sh
set -eu

# =============================================================================
# metrics-report.sh — Reporte operativo de métricas PRD 32 (Unidad 7)
# -----------------------------------------------------------------------------
# Ejecuta las vistas v_metrics_prd32_* contra la base de datos y genera un
# reporte Markdown (o CSV) con los valores y estado de freshness
# (OK / STALE / sin_datos) según umbral configurable.
#
# Uso:
#   scripts/ops/metrics-report.sh [--stale-hours N] [--format md|csv]
#                                 [--out FILE] [-h]
#
# Variables de entorno:
#   METRICS_STALE_HOURS   umbral por defecto (default 24)
#   PG_CONN               nombre de la base (default: crm_whatsapp_app)
#   POSTGRES_CONTAINER    contenedor postgres (default: ${PROJECT_NAME:-crm-whatsapp-automatizado}-postgres)
# =============================================================================

ROOT_DIR=$(CDPATH= cd -- "$(dirname "$0")/../.." && pwd)
cd "$ROOT_DIR"

STALE_HOURS="${METRICS_STALE_HOURS:-24}"
FORMAT="md"
OUT=""

usage() {
  cat <<'EOF'
Uso:
  scripts/ops/metrics-report.sh [opciones]

Opciones:
  --stale-hours N   umbral de staleness en horas (default 24)
  --format md|csv   formato de salida (default md)
  --out FILE        escribir el reporte en FILE (default stdout)
  -h, --help        esta ayuda

Conexión: docker exec "$POSTGRES_CONTAINER" psql -U postgres -d "$PG_CONN" (defecto crm_whatsapp_app).
EOF
}

case "${1:-}" in
  -h|--help) usage; exit 0 ;;
esac

while [ "$#" -gt 0 ]; do
  case "$1" in
    --stale-hours) STALE_HOURS="$2"; shift 2 ;;
    --format) FORMAT="$2"; shift 2 ;;
    --out) OUT="$2"; shift 2 ;;
    *) echo "ERROR: argumento desconocido: $1" >&2; usage; exit 1 ;;
  esac
done

case "$FORMAT" in
  md|csv) ;;
  *) echo "ERROR: formato no soportado: $FORMAT" >&2; exit 1 ;;
esac

case "$STALE_HOURS" in
  ''|*[!0-9]*) echo "ERROR: --stale-hours debe ser un entero positivo" >&2; exit 1 ;;
esac

POSTGRES_CONTAINER="${POSTGRES_CONTAINER:-${PROJECT_NAME:-crm-whatsapp-automatizado}-postgres}"

if ! docker exec "$POSTGRES_CONTAINER" psql -U postgres -d postgres -qc "SELECT 1" >/dev/null 2>&1; then
  echo "ERROR: contenedor postgres '$POSTGRES_CONTAINER' no está activo" >&2
  exit 1
fi

PGDB="${PG_CONN:-crm_whatsapp_app}"
GENERATED_AT=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

psql_metric() {
  docker exec -i "$POSTGRES_CONTAINER" psql -X -qAt -U postgres \
    -v ON_ERROR_STOP=1 \
    -v STALE_HOURS="$STALE_HOURS" \
    -d "$PGDB"
}

kpi_lines() {
  psql_metric <<'SQL'
SELECT
  kpi_id || '|' ||
  nombre || '|' ||
  dominio || '|' ||
  unidad || '|' ||
  COALESCE(LTRIM(TO_CHAR(valor, '99999999990.000')), 'n/d') || '|' ||
  COALESCE(TO_CHAR(metric_as_of AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'), 'sin datos') || '|' ||
  CASE
    WHEN metric_as_of IS NULL THEN 'sin_datos'
    WHEN EXTRACT(EPOCH FROM (CURRENT_TIMESTAMP - metric_as_of)) / 3600 > :STALE_HOURS THEN 'STALE'
    ELSE 'OK'
  END
FROM v_metrics_prd32_kpi
ORDER BY CAST(SUBSTRING(kpi_id FROM 5) AS INTEGER);
SQL
}

series_lines() {
  psql_metric <<'SQL'
SELECT fecha::text || '|' || conversaciones_iniciadas::text
FROM v_metrics_prd32_serie_diaria
ORDER BY fecha DESC
LIMIT 30;
SQL
}

render_md() {
  echo "# Reporte métricas PRD 32 — CRM WhatsApp"
  echo
  echo "- generated_at: ${GENERATED_AT} (UTC)"
  echo "- ventana: 30 días | zona horaria: America/Santiago"
  echo "- umbral stale: ${STALE_HOURS}h"
  echo
  echo "## KPIs"
  echo
  echo "| KPI | Nombre | Dominio | Unidad | Valor | Última data | Estado |"
  echo "|-----|--------|---------|--------|-------|-------------|--------|"
  kpi_lines
  echo
  echo "## Serie diaria (conversaciones iniciadas)"
  echo
  echo "| Fecha | Conversaciones iniciadas |"
  echo "|-------|--------------------------|"
  series_lines
}

render_csv() {
  echo "kpi_id,nombre,dominio,unidad,valor,ultima_data,estado"
  psql_metric <<'SQL'
SELECT
  kpi_id || ',' ||
  regexp_replace(nombre, '[,|]', ';', 'g') || ',' ||
  dominio || ',' || unidad || ',' ||
  COALESCE(TO_CHAR(valor, 'FM99999999990.999'), 'n/d') || ',' ||
  COALESCE(TO_CHAR(metric_as_of AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'), 'sin datos') || ',' ||
  CASE
    WHEN metric_as_of IS NULL THEN 'sin_datos'
    WHEN EXTRACT(EPOCH FROM (CURRENT_TIMESTAMP - metric_as_of)) / 3600 > :STALE_HOURS THEN 'STALE'
    ELSE 'OK'
  END
FROM v_metrics_prd32_kpi
ORDER BY CAST(SUBSTRING(kpi_id FROM 5) AS INTEGER);
SQL
}

if [ "$FORMAT" = "md" ]; then
  if [ -n "$OUT" ]; then
    render_md >"$OUT"
    echo "Reporte generado: $OUT" >&2
  else
    render_md
  fi
else
  if [ -n "$OUT" ]; then
    render_csv >"$OUT"
    echo "Reporte generado: $OUT" >&2
  else
    render_csv
  fi
fi