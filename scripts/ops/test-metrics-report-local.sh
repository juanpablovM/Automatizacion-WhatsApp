#!/bin/sh
set -eu

# =============================================================================
# test-metrics-report-local.sh — Harness local y determinista (sin red) para
# la Unidad 7: métricas y dashboard PRD 32 (brecha B09).
# -----------------------------------------------------------------------------
# Crea una BD docker temporal, aplica migraciones 001-014 + seeds, inserta un
# fixture REALISTO (conversaciones/mensajes/leads/oportunidades/handoffs/
# media/follow_ups/audit en estados y edades variados) y valida:
#   * 31 KPIs con valores conocidos (ventana 30 días),
#   * 2 métricas con 0 cuando no hay datos,
#   * freshness marcado STALE según umbral configurable,
#   * agrupación temporal correcta (serie diaria excluye la fila vieja),
#   * el reporte markdown (scripts/ops/metrics-report.sh) genera bien.
# =============================================================================

ROOT_DIR=$(CDPATH= cd -- "$(dirname "$0")/../.." && pwd)
cd "$ROOT_DIR"

if ! command -v docker >/dev/null 2>&1; then
  echo "ERROR: se requiere docker" >&2
  exit 1
fi

POSTGRES_CONTAINER="${PROJECT_NAME:-crm-whatsapp-automatizado}-postgres"
TEST_DB="crm_whatsapp_metrics_$$"

cleanup() {
  docker exec "$POSTGRES_CONTAINER" psql -U postgres -d postgres \
    -c "DROP DATABASE IF EXISTS ${TEST_DB} WITH (FORCE)" >/dev/null 2>&1 || true
  rm -f /tmp/metrics-*.sql /tmp/metrics-*.out
}
trap cleanup EXIT

docker exec "$POSTGRES_CONTAINER" psql -U postgres -d postgres -qc "SELECT 1" >/dev/null 2>&1 || {
  echo "ERROR: container postgres '$POSTGRES_CONTAINER' no está activo" >&2
  exit 1
}

docker exec "$POSTGRES_CONTAINER" psql -U postgres -d postgres \
  -v ON_ERROR_STOP=1 -c "CREATE DATABASE ${TEST_DB}" >/dev/null

apply_sql() {
  docker exec -i "$POSTGRES_CONTAINER" psql -U postgres -d "$TEST_DB" \
    -v ON_ERROR_STOP=1 >/dev/null
}

PASS=0
FAIL=0

assert_sql() {
  local label="$1" query="$2" expected="$3"
  local actual
  actual="$(docker exec "$POSTGRES_CONTAINER" psql -U postgres -d "$TEST_DB" -Atqc "$query")"
  if [ "$actual" = "$expected" ]; then
    PASS=$((PASS + 1))
  else
    FAIL=$((FAIL + 1))
    echo "Assertion failed: $label"
    echo "  esperado: $expected"
    echo "  actual:   $actual"
  fi
}

expect_grep() {
  local label="$1" file="$2" pattern="$3"
  if grep -q "$pattern" "$file"; then
    PASS=$((PASS + 1))
  else
    FAIL=$((FAIL + 1))
    echo "OUT MISSING '$pattern' in $file:"
    sed -n '1,12p' "$file"
  fi
}

# ----------------------------------------------------------------------------
# 1) Migraciones + semillas
# ----------------------------------------------------------------------------
for migration in infra/postgres/migrations/001_create_status_catalogs.sql \
                 infra/postgres/migrations/002_create_operational_tables.sql \
                 infra/postgres/migrations/003_create_indexes.sql \
                 infra/postgres/migrations/004_create_commercial_advisor_tables.sql \
                 infra/postgres/migrations/005_create_conversation_memory_indexes.sql \
                 infra/postgres/migrations/006_add_conversation_qualification_context.sql \
                 infra/postgres/migrations/007_add_delivery_integrity.sql \
                 infra/postgres/migrations/008_repair_legacy_conversation_state.sql \
                 infra/postgres/migrations/009_create_monitor_snapshots.sql \
                 infra/postgres/migrations/010_create_opportunities.sql \
                 infra/postgres/migrations/011_create_handoffs.sql \
                 infra/postgres/migrations/012_create_media_attachments.sql \
                 infra/postgres/migrations/013_create_follow_ups.sql \
                 infra/postgres/migrations/014_create_metrics_views.sql; do
  apply_sql <"$migration"
done
apply_sql <db/seeds/001_lead_statuses.sql
apply_sql <db/seeds/002_conversation_statuses.sql

# ----------------------------------------------------------------------------
# 2) Fixture determinista (datos conocidos, edades relativas para ventanas).
#    KPIs esperados (ventana 30 días):
#      K01 7.50 | K02 8 | K03 1 | K04 3 | K05 1 | K06 0.2000
#      K07 1 | K08 3 | K09 2 | K10 2 | K11 1 | K12 1 | K13 1 | K14 33.33
#      K15 1 | K16 1 | K17 0 | K18 0 | K19 3 | K20 2 | K21 4 | K22 1
#      K23 1 | K24 1 | K25 1 | K26 1 | K27 62.50 | K28 50.00 | K29 33.33 | K30 50.00 | K31 1
# ----------------------------------------------------------------------------
apply_sql <<'SQL'
INSERT INTO conversations (id, phone_number, conversation_status_id, current_step, started_at, last_message_at, qualification_context, closed_at)
SELECT 1, '+56910000001', s.id, 'ask_data',
       NOW() - INTERVAL '5 days',  NOW() - INTERVAL '5 days' + INTERVAL '8 minutes',
       '{"intent":"quote_request","lead_class":"B","objection_detected":"price","customer_type":"b2c","service":"pasto natural","city":"Vitacura","requirement":"120 m2","diagnostic_datos":{"pain":"precio","scope":"120 m2","timing":"1 mes","obstacle":"presupuesto","next_step":"cotizar"}}'::jsonb,
       NOW() - INTERVAL '4 days'
FROM conversation_statuses s WHERE s.code = 'closed'
UNION ALL
SELECT 2, '+56910000002', s.id, 'ask_data',
       NOW() - INTERVAL '2 days',  NOW() - INTERVAL '2 days' + INTERVAL '10 minutes',
       '{"intent":"installation_inquiry","lead_class":"A","customer_type":"b2c","service":"pastelones","city":"La Florida","requirement":"60 m2","diagnostic_datos":{"pain":"instalacion","scope":"60 m2","timing":"2 semanas","obstacle":"fecha","next_step":"agendar"}}'::jsonb,
       NULL
FROM conversation_statuses s WHERE s.code = 'active'
UNION ALL
SELECT 3, '+56910000003', s.id, 'ask_data',
       NOW() - INTERVAL '5 days' + INTERVAL '3 hours', NOW() - INTERVAL '5 days' + INTERVAL '4 hours',
       '{"intent":"quote_request","lead_class":"C","customer_type":"b2c","service":"adoquin","city":"La Reina","requirement":"40 m2","diagnostic_datos":{"pain":"precio","scope":"40 m2","timing":"1 semana","obstacle":"precio","next_step":"cotizar"}}'::jsonb,
       NOW() - INTERVAL '5 days' + INTERVAL '3 hours'
FROM conversation_statuses s WHERE s.code = 'closed'
UNION ALL
SELECT 4, '+56900000004', s.id, 'ask_data',
       NOW() - INTERVAL '12 hours', NOW() - INTERVAL '12 hours',
       '{"intent":"payment_proof","objection":"comprobante","customer_type":"b2c","service":"pasto","city":"Vitacura","requirement":"30 m2","diagnostic_datos":{"pain":"pago","scope":"30 m2","timing":"1 dia","obstacle":"mostrador","next_step":"verificar"}}'::jsonb,
       NULL
FROM conversation_statuses s WHERE s.code = 'active'
UNION ALL
SELECT 5, '+56900000005', s.id, 'ask_data',
       NOW() - INTERVAL '6 days', NOW() - INTERVAL '6 days',
       '{"intent":"delivery_inquiry","customer_type":"b2c","source":"pasto","diagnostic_datos":{"pain":"despacho","scope":"1","timing":"2 dias","obstacle":"retraso","next_step":"confirmar"}}'::jsonb,
       NULL
FROM conversation_statuses s WHERE s.code = 'waiting_user'
UNION ALL
SELECT 6, '+56900000006', s.id, 'ask_data',
       NOW() - INTERVAL '8 days', NOW() - INTERVAL '8 days' + INTERVAL '5 minutes',
       '{"intent":"installation_inquiry","customer_type":"b2c","service":"pasto","city":"Maipu","requirement":"50 m2","diagnostic_datos":{"pain":"instalacion","scope":"50 m2","timing":null,"obstacle":null,"next_step":"agendar"}}'::jsonb,
       NOW() - INTERVAL '7 days'
FROM conversation_statuses s WHERE s.code = 'closed'
UNION ALL
SELECT 7, '+56900000007', s.id, 'ask_data',
       NOW() - INTERVAL '10 days', NOW() - INTERVAL '10 days' + INTERVAL '2 hours',
       '{"intent":"invoice_request","customer_type":"b2c","service":"pasto","city":"Renca","requirement":"80 m2"}'::jsonb,
       NULL
FROM conversation_statuses s WHERE s.code = 'active'
UNION ALL
SELECT 8, '+56900000008', s.id, 'agenda',
       NOW() - INTERVAL '3 days', NOW() - INTERVAL '3 days' + INTERVAL '4 hours',
       '{"intent":"b2b_request","customer_type":"contractor","service":"hormigon"}'::jsonb,
       NULL
FROM conversation_statuses s WHERE s.code = 'handed_to_sales'
UNION ALL
SELECT 99, '+56919999999', s.id, 'disabled',
       NOW() - INTERVAL '40 days', NOW() - INTERVAL '40 days',
       '{"intent":"installation_inquiry","customer_type":"b2c","service":"membrana","city":"Lampa","requirement":"100 m2"}'::jsonb,
       NULL
FROM conversation_statuses s WHERE s.code = 'active';

INSERT INTO messages (conversation_id, direction, message_type, text_body, created_at)
VALUES
  (1, 'incoming', 'text', 'Hola, cuanto sale el pasto?', NOW() - INTERVAL '5 days'),
  (1, 'outgoing', 'text', 'Te pregunto la comuna', NOW() - INTERVAL '5 days' + INTERVAL '5 minutes'),
  (2, 'incoming', 'text', 'Buenas, quiero instalar', NOW() - INTERVAL '2 days'),
  (2, 'outgoing', 'text', 'Perfecto, necesito datos', NOW() - INTERVAL '2 days' + INTERVAL '10 minutes'),
  (3, 'incoming', 'text', 'Cotizame 40 m2', NOW() - INTERVAL '5 days' + INTERVAL '3 hours'),
  (3, 'outgoing', 'text', 'Te cotizo', NOW() - INTERVAL '5 days' + INTERVAL '3 hours' + INTERVAL '3 minutes'),
  (4, 'incoming', 'text', 'Ahí va el comprobante', NOW() - INTERVAL '11 hours'),
  (4, 'outgoing', 'text', 'Gracias, lo reviso', NOW() - INTERVAL '10 hours'),
  (5, 'outgoing', 'text', '¿Sigue interesado?', NOW() - INTERVAL '6 days');

INSERT INTO leads (id, phone_number, lead_status_id, service, city, requirement, is_qualified, created_at)
VALUES
  (1, '+56920000001', (SELECT id FROM lead_statuses WHERE code = 'qualified_complete'), 'pasto', 'Vitacura', '120 m2', TRUE, NOW() - INTERVAL '4 days'),
  (2, '+56920000002', (SELECT id FROM lead_statuses WHERE code = 'draft'), 'pastelones', 'La Florida', '60 m2', FALSE, NOW() - INTERVAL '2 days'),
  (3, '+56920000003', (SELECT id FROM lead_statuses WHERE code = 'draft'), 'adoquin', NULL, NULL, FALSE, NOW() - INTERVAL '5 days');

INSERT INTO opportunities (id, phone_number, conversation_id, service, city, requirement, intent_code, status_code, created_at, promoted_at)
VALUES
  (1, '+56930000001', 1, 'pasto', 'Vitacura', '120 m2', 'quote_request', 'promoted', NOW() - INTERVAL '4 days', NOW() - INTERVAL '3 days'),
  (2, '+56930000002', 2, 'pastelones', 'La Florida', '60 m2', 'installation_inquiry', 'qualified', NOW() - INTERVAL '2 days', NULL),
  (3, '+56930000003', 6, 'pasto', 'Maipu', '50 m2', 'installation_inquiry', 'new', NOW() - INTERVAL '8 days', NULL);

INSERT INTO handoffs (id, idempotency_key, conversation_id, phone_number, motivo, area, area_label, prioridad, responsable, estado, created_at, notified_at, acknowledged_at)
VALUES
  (1, 'h1', 4, '+56930000004', 'payment_proof', 'finance', 'Finanzas', 'alta', 'Finanzas', 'acknowledged', NOW() - INTERVAL '1 day', NOW() - INTERVAL '1 day', NOW() - INTERVAL '1 day'),
  (2, 'h2', 8, '+56930000008', 'b2b', 'b2b', 'B2B', 'alta', 'Patricia', 'pending', NOW() - INTERVAL '5 days', NULL, NULL),
  (3, 'h3', 1, '+56930000001', 'complaint', 'claims', 'Reclamos', 'urgente', 'Sofia', 'acknowledged', NOW() - INTERVAL '4 days', NOW() - INTERVAL '4 days', NOW() - INTERVAL '4 days'),
  (4, 'h4', 8, '+56930000008', 'complaint', 'claims', 'Reclamos', 'urgente', 'Sofia', 'pending', NOW() - INTERVAL '1 hour', NULL, NULL);

INSERT INTO media_attachments (id, message_id, conversation_id, attachment_type, mime_type, filename, download_state, sha256, attach_pending, created_at, updated_at)
VALUES
  (1, 'm1', 4, 'image', 'image/jpeg', 'comprobante.jpg', 'downloaded', '0123456789abcdef', FALSE, NOW() - INTERVAL '11 hours', NOW() - INTERVAL '1 hours'),
  (2, 'm2', 6, 'image', 'image/jpeg', 'instalacion.jpg', 'rejected', NULL, TRUE, NOW() - INTERVAL '7 days', NOW() - INTERVAL '7 days'),
  (3, 'm3', 3, 'image', 'image/jpeg', 'foto-instalacion.jpg', 'pending', NULL, TRUE, NOW() - INTERVAL '5 days', NOW() - INTERVAL '5 days');

INSERT INTO follow_ups (id, idempotency_key, conversation_id, phone_number, motivo, step_dia, scheduled_at, estado, created_at, updated_at, sent_at, opted_out)
VALUES
  (1, 'fu1', 1, '+56910000001', 'cotizacion_lead', 3, NOW() + INTERVAL '3 days', 'sent', NOW() - INTERVAL '3 days', NOW() - INTERVAL '2 days', NOW() - INTERVAL '2 days', FALSE),
  (2, 'fu2', 2, '+56910000002', 'cotizacion_lead', 7, NOW() + INTERVAL '7 days', 'cancelled', NOW() - INTERVAL '2 days', NOW() - INTERVAL '2 days', NULL, FALSE),
  (3, 'fu3', 8, '+56910000008', 'b2b', 0, NOW() + INTERVAL '1 day', 'opted_out', NOW() - INTERVAL '3 days', NOW() - INTERVAL '3 days', NULL, TRUE);

INSERT INTO audit_logs (event_name, entity_type, entity_id, actor_type, actor_id, result, metadata, created_at)
VALUES
  ('conversation_state_evaluated', 'conversation', 1, 'system', 'n8n', 'ok', '{"intent":"quote_request"}', NOW() - INTERVAL '5 days'),
  ('conversation_state_evaluated', 'conversation', 2, 'system', 'n8n', 'ok', '{}', NOW() - INTERVAL '2 days'),
  ('conversation_state_evaluated', 'conversation', 3, 'system', 'n8n', 'ok', '{}', NOW() - INTERVAL '5 days'),
  ('conversation_state_evaluated', 'conversation', 4, 'system', 'n8n', 'ok', '{}', NOW() - INTERVAL '11 hours'),
  ('conversation_state_evaluated', 'conversation', 5, 'system', 'n8n', 'ok', '{}', NOW() - INTERVAL '6 days'),
  ('ai_fallback', 'conversation', 6, 'system', 'n8n', 'fallback', '{"fallback_reason":"invalid_json"}', NOW() - INTERVAL '8 days');
SQL

# ----------------------------------------------------------------------------
# 3) Aserciones de KPIs (valores conocidos, exactos)
# ----------------------------------------------------------------------------
V=v_metrics_prd32_kpi
assert_sql "KPI-01 mediana TTR = 7.50 (3,5,10,60)" \
  "SELECT ROUND(valor,2)::text FROM $V WHERE kpi_id='KPI-01'" "7.50"
assert_sql "KPI-02 atendidas=8 (excluye conv 99 a 40d)" \
  "SELECT valor::text FROM $V WHERE kpi_id='KPI-02'" "8"
assert_sql "KPI-03 derivadas=1" \
  "SELECT valor::text FROM $V WHERE kpi_id='KPI-03'" "1"
assert_sql "KPI-04 cerradas=3" \
  "SELECT valor::text FROM $V WHERE kpi_id='KPI-04'" "3"
assert_sql "KPI-05 sin respuesta=1 (solo c5)" \
  "SELECT valor::text FROM $V WHERE kpi_id='KPI-05'" "1"
assert_sql "KPI-06 fallback=0.2000 (1/5)" \
  "SELECT ROUND(valor::numeric,4)::text FROM $V WHERE kpi_id='KPI-06'" "0.2000"
assert_sql "KPI-07 leads calificados=1" \
  "SELECT valor::text FROM $V WHERE kpi_id='KPI-07'" "1"
assert_sql "KPI-08 clasificados A/B/C/D=3" \
  "SELECT valor::text FROM $V WHERE kpi_id='KPI-08'" "3"
assert_sql "KPI-09 cotizaciones=2" \
  "SELECT valor::text FROM $V WHERE kpi_id='KPI-09'" "2"
assert_sql "KPI-10 instalaciones=2" \
  "SELECT valor::text FROM $V WHERE kpi_id='KPI-10'" "2"
assert_sql "KPI-11 B2B=1" \
  "SELECT valor::text FROM $V WHERE kpi_id='KPI-11'" "1"
assert_sql "KPI-12 despacho=1" \
  "SELECT valor::text FROM $V WHERE kpi_id='KPI-12'" "1"
assert_sql "KPI-13 objeciones de precio=1" \
  "SELECT valor::text FROM $V WHERE kpi_id='KPI-13'" "1"
assert_sql "KPI-14 conversion=33.33 (1/3)" \
  "SELECT valor::text FROM $V WHERE kpi_id='KPI-14'" "33.33"
assert_sql "KPI-15 comprobantes=1" \
  "SELECT valor::text FROM $V WHERE kpi_id='KPI-15'" "1"
assert_sql "KPI-16 facturas=1" \
  "SELECT valor::text FROM $V WHERE kpi_id='KPI-16'" "1"
assert_sql "KPI-17 reclamos=0 (sin datos)" \
  "SELECT valor::text FROM $V WHERE kpi_id='KPI-17'" "0"
assert_sql "KPI-18 garantias=0 (sin datos)" \
  "SELECT valor::text FROM $V WHERE kpi_id='KPI-18'" "0"
assert_sql "KPI-19 con fotos=3 (c3,c4,c6)" \
  "SELECT valor::text FROM $V WHERE kpi_id='KPI-19'" "3"
assert_sql "KPI-20 datos incompletos=2 (c5,c8)" \
  "SELECT valor::text FROM $V WHERE kpi_id='KPI-20'" "2"
assert_sql "KPI-21 handoffs=4" \
  "SELECT valor::text FROM $V WHERE kpi_id='KPI-21'" "4"
assert_sql "KPI-22 pendientes vencidos=1 (h2)" \
  "SELECT valor::text FROM $V WHERE kpi_id='KPI-22'" "1"
assert_sql "KPI-23 media con sha256=1" \
  "SELECT valor::text FROM $V WHERE kpi_id='KPI-23'" "1"
assert_sql "KPI-24 media rechazada=1" \
  "SELECT valor::text FROM $V WHERE kpi_id='KPI-24'" "1"
assert_sql "KPI-25 follow-ups enviados=1" \
  "SELECT valor::text FROM $V WHERE kpi_id='KPI-25'" "1"
assert_sql "KPI-26 follow-ups cancelados=1" \
  "SELECT valor::text FROM $V WHERE kpi_id='KPI-26'" "1"
assert_sql "KPI-27 diagnostico completo=62.50 (5/8)" \
  "SELECT valor::text FROM $V WHERE kpi_id='KPI-27'" "62.50"
assert_sql "KPI-28 derivaciones correctas=50.00 (2/4)" \
  "SELECT valor::text FROM $V WHERE kpi_id='KPI-28'" "50.00"
assert_sql "KPI-29 leads incompletos=33.33 (1/3)" \
  "SELECT valor::text FROM $V WHERE kpi_id='KPI-29'" "33.33"
assert_sql "KPI-30 reclamos escalados=50.00 (1/2)" \
  "SELECT valor::text FROM $V WHERE kpi_id='KPI-30'" "50.00"
assert_sql "KPI-31 optouts=1" \
  "SELECT valor::text FROM $V WHERE kpi_id='KPI-31'" "1"

# ----------------------------------------------------------------------------
# 4) Serie diaria (agrupación temporal correcta)
# ----------------------------------------------------------------------------
assert_sql "serie: suma conversaciones=8 (la de 40d no cuenta)" \
  "SELECT SUM(conversaciones_iniciadas)::text FROM v_metrics_prd32_serie_diaria" "8"
assert_sql "serie: entre 6 y 9 fechas distintas (dependiente de medianoche)" \
  "SELECT CASE WHEN COUNT(DISTINCT fecha) BETWEEN 6 AND 9 THEN 'ok' ELSE 'bad' END FROM v_metrics_prd32_serie_diaria" "ok"
assert_sql "serie: la conversacion vieja (40d) no aparece" \
  "SELECT COUNT(*)::text FROM v_metrics_prd32_serie_diaria d WHERE d.fecha = (NOW() - INTERVAL '40 days')::date" "0"

# ----------------------------------------------------------------------------
# 5) Reporte markdown + freshness (umbral de stale configurable)
# ----------------------------------------------------------------------------
PG_CONN="$TEST_DB" scripts/ops/metrics-report.sh --stale-hours 24 --format md \
  --out /tmp/metrics-report.md
expect_grep "reporte markdown: generated_at presente" /tmp/metrics-report.md "generated_at"
expect_grep "reporte markdown: tabla de KPIs" /tmp/metrics-report.md "KPI-01"
expect_grep "reporte markdown: KPI-06 con valor 0.200" /tmp/metrics-report.md "0.200"

# Freshness: con umbral 24h y datos a más de 24h -> STALE; con 300h -> OK
#   KPI-04 (closed -4d), KPI-07/29 (leads -2d), KPI-14 (opps -2d),
#   KPI-25/26/31 (follow_ups -2d) -> 7 STALE; el resto < 24h
assert_sql "freshness: hay al menos 7 KPI STALE con umbral 24h" \
  "SELECT COUNT(*)::text FROM (
     SELECT CASE WHEN EXTRACT(EPOCH FROM (CURRENT_TIMESTAMP - metric_as_of))/3600 > 24 THEN 1 END AS stale
     FROM $V WHERE metric_as_of IS NOT NULL
   ) s WHERE stale=1" "7"
assert_sql "freshness: sin metric_as_of nulos (todos los KPIs con fuente)" \
  "SELECT COUNT(*)::text FROM $V WHERE metric_as_of IS NULL" "0"

echo
echo "Unidad 7 — métricas PRD 32 local: $PASS assertions OK, $FAIL failed"
[ "$FAIL" -eq 0 ] || exit 1
echo "Metrics PRD 32: KPIs cubiertos + freschezz OK"