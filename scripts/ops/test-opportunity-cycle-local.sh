#!/bin/sh
set -eu

# =============================================================================
# test-opportunity-cycle-local.sh — Harness local y determinista (sin red) para
# la Unidad 2: ciclo de oportunidad desde el primer mensaje (PRD A-001).
# -----------------------------------------------------------------------------
# Valida en 2 capas:
#   1. Dispatcher (Ensure Early Opportunity) -> decision pura: escribe, salta o
#      promueve segun intencion, gate comercial y confirmacion. Sin BD.
#   2. Persistencia (Upsert Early Opportunity / Link Opportunity Promotion) ->
#      idempotencia por conversacion, no-duplicados, promocion a 'qualified',
#      vinculo con el lead promovido, traza en audit_logs. BD temporal docker.
# =============================================================================

ROOT_DIR=$(CDPATH= cd -- "$(dirname "$0")/../.." && pwd)
cd "$ROOT_DIR"

# Los nodos viven en los workflows; la politica canonica vive en fixtures y se
# reinyecta con sync-workflow-nodes.mjs (idempotente, con backup).
if ! node tests/scripts/sync-workflow-nodes.mjs --check >/dev/null 2>&1; then
  echo "ERROR: los nodos de workflow divergen de los fixtures de tests/fixtures/workflow-nodes/" >&2
  echo "Ejecuta: node tests/scripts/sync-workflow-nodes.mjs" >&2
  exit 1
fi

POSTGRES_CONTAINER="${PROJECT_NAME:-crm-whatsapp-automatizado}-postgres"
TEST_DB="crm_whatsapp_opportunity_${$}"
DB_SQL_DIR="$(mktemp -d)"

cleanup() {
  docker exec "$POSTGRES_CONTAINER" psql -U postgres -d postgres \
    -c "DROP DATABASE IF EXISTS ${TEST_DB} WITH (FORCE)" >/dev/null 2>&1 || true
  rm -rf "$DB_SQL_DIR"
  rm -f /tmp/opportunity-*.sql /tmp/opportunity-*.out
}
trap cleanup EXIT

# ---------------------------------------------------------------------------
# Capa 1: decision pura del nodo Ensure Early Opportunity (vm, sin red).
# ---------------------------------------------------------------------------
node <<'NODE'
(async () => {
  const fs = require('fs');
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

  const dispatcher = JSON.parse(fs.readFileSync('n8n/workflows/wa-inbound-downstream-dispatcher.json', 'utf8'));
  const ensureNode = dispatcher.nodes.find((entry) => entry.name === 'Ensure Early Opportunity');
  if (!ensureNode) throw new Error('Nodo Ensure Early Opportunity no existe');
  const runCode = async (item) => {
    const fn = new AsyncFunction('items', 'helpers', '$env', ensureNode.parameters.jsCode);
    const result = await fn([{ json: item }], {}, {});
    return result[0].json;
  };

  let passed = 0;
  let failed = 0;
  const assert = (condition, message) => {
    if (!condition) {
      failed += 1;
      console.error(`  FAIL: ${message}`);
    } else {
      passed += 1;
    }
  };
  const expectEqual = (actual, expected, message) => {
    assert(actual === expected, `${message}: esperado ${JSON.stringify(expected)}, recibido ${JSON.stringify(actual)}`);
  };

  const baseRow = {
    phone_number: '56912345678',
    source_number_id: 1,
    external_contact_id: 'cid',
    whatsapp_name: 'Juan Perez',
    service: 'Baldosas',
    city: 'Santiago',
    requirement: 'Renovar patio',
    conversation_id: 1,
    inbound_event_id: 7,
    intent: 'quote_request',
    should_create_lead: false,
    commercial_missing_fields: ['quantity'],
    confirmation_status: 'none',
    response_text: 'Hola',
  };

  // (a) Primer mensaje: crea oportunidad temprana 'new' pese al gate pendiente.
  const first = await runCode(baseRow);
  expectEqual(first.opportunity_write, true, 'primer mensaje debe escribir oportunidad');
  expectEqual(first.opportunity_status, 'new', 'gate pendiente no promueve: status new');
  expectEqual(first.opportunity_skipped, false, 'no se salta en primer mensaje');
  expectEqual(first.opportunity_scope.conversation_id, 1, 'scope conserva conversation_id');
  expectEqual(first.opportunity_scope.phone_number, '56912345678', 'scope conserva phone_number');
  expectEqual(first.opportunity_scope.intent_code, 'quote_request', 'scope conserva intencion');
  expectEqual(first.opportunity_scope.inbound_event_id, 7, 'scope conserva inbound_event_id');
  expectEqual(first.response_text, 'Hola', 'passthrough conserva el payload original');

  // (b) Gate limpio + confirmacion: promueve a 'qualified'.
  const qualified = await runCode({
    ...baseRow,
    should_create_lead: true,
    commercial_missing_fields: [],
    confirmation_status: 'confirmed',
  });
  expectEqual(qualified.opportunity_write, true, 'gate limpio debe escribir oportunidad');
  expectEqual(qualified.opportunity_status, 'qualified', 'gate limpio + confirmado promueve a qualified');

  // (c) Intencion operativa: NUNCA crea oportunidad.
  for (const intent of ['complaint', 'warranty_inquiry', 'payment_proof', 'invoice_request']) {
    const operational = await runCode({ ...baseRow, intent });
    expectEqual(operational.opportunity_write, false, `intencion operativa ${intent} no escribe`);
    expectEqual(operational.opportunity_skipped, true, `intencion operativa ${intent} queda marcada skipped`);
  }

  // (d) Sin conversation_id estable: no escribe.
  const noConversation = await runCode({ ...baseRow, conversation_id: null });
  expectEqual(noConversation.opportunity_write, false, 'sin conversation_id no escribe');
  const noPhone = await runCode({ ...baseRow, phone_number: '' });
  expectEqual(noPhone.opportunity_write, false, 'sin phone_number no escribe');

  console.log(`\nOportunidad (capa nodo): ${passed} PASS / ${failed} FAIL`);
  if (failed > 0) process.exit(1);
})().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
NODE

# ---------------------------------------------------------------------------
# Capa 2: persistencia idempotente en BD temporal (docker, sin red).
# ---------------------------------------------------------------------------
docker exec "$POSTGRES_CONTAINER" psql -U postgres -d postgres \
  -v ON_ERROR_STOP=1 -c "CREATE DATABASE ${TEST_DB}" >/dev/null

for migration in infra/postgres/migrations/00[1-6]_*.sql; do
  docker exec -i "$POSTGRES_CONTAINER" psql -U postgres -d "$TEST_DB" \
    -v ON_ERROR_STOP=1 < "$migration" >/dev/null
done
docker exec -i "$POSTGRES_CONTAINER" psql -U postgres -d "$TEST_DB" \
  -v ON_ERROR_STOP=1 < db/seeds/001_lead_statuses.sql >/dev/null
docker exec -i "$POSTGRES_CONTAINER" psql -U postgres -d "$TEST_DB" \
  -v ON_ERROR_STOP=1 < db/seeds/002_conversation_statuses.sql >/dev/null

docker exec -i "$POSTGRES_CONTAINER" psql -U postgres -d "$TEST_DB" -v ON_ERROR_STOP=1 >/dev/null <<'SQL'
INSERT INTO whatsapp_numbers (display_name, phone_number, phone_number_id)
VALUES ('Main', '+56900000000', 'pn-main');
INSERT INTO conversations (phone_number, source_number_id, conversation_status_id)
SELECT '56912345678', 1, id FROM conversation_statuses WHERE code = 'active';
SQL

# source_conversation_id en leads llega con la migracion 007 (entrega durable).
docker exec -i "$POSTGRES_CONTAINER" psql -U postgres -d "$TEST_DB" \
  -v ON_ERROR_STOP=1 < infra/postgres/migrations/007_add_delivery_integrity.sql >/dev/null
docker exec -i "$POSTGRES_CONTAINER" psql -U postgres -d "$TEST_DB" \
  -v ON_ERROR_STOP=1 < infra/postgres/migrations/010_create_opportunities.sql >/dev/null
# Re-aplicacion debe seguir siendo segura (idempotencia de migraciones).
docker exec -i "$POSTGRES_CONTAINER" psql -U postgres -d "$TEST_DB" \
  -v ON_ERROR_STOP=1 < infra/postgres/migrations/010_create_opportunities.sql >/dev/null

python3 - <<'PY'
import json
import re
from pathlib import Path

def literal(value):
    if value is None:
        return "NULL"
    return "'" + str(value).replace("'", "''") + "'"

def render(query, values):
    return re.sub(r"\$(\d+)", lambda m: literal(values[int(m.group(1)) - 1]), query)

dispatcher = json.loads(Path("n8n/workflows/wa-inbound-downstream-dispatcher.json").read_text())
upsert_query = next(n for n in dispatcher["nodes"] if n["name"] == "Upsert Early Opportunity")["parameters"]["query"]

def upsert_values(**overrides):
    values = {
        "phone_number": "56912345678",
        "source_number_id": "1",
        "conversation_id": "1",
        "external_contact_id": "cid",
        "whatsapp_name": "Juan Perez",
        "service": "Baldosas",
        "city": "Santiago",
        "requirement": "Renovar patio",
        "intent_code": "quote_request",
        "inbound_event_id": "7",
        "should_write": "true",
        "requested_status": "new",
    }
    values.update(overrides)
    return [values[k] for k in [
        "phone_number", "source_number_id", "conversation_id", "external_contact_id",
        "whatsapp_name", "service", "city", "requirement", "intent_code",
        "inbound_event_id", "should_write", "requested_status",
    ]]

# Escenario 1: primer mensaje crea oportunidad 'new'.
Path("/tmp/opportunity-first.sql").write_text(render(upsert_query, upsert_values()))
# Escenario 2: mismo mensaje repetido -> duplicate_skipped, sin duplicar.
Path("/tmp/opportunity-replay.sql").write_text(render(upsert_query, upsert_values()))
# Escenario 3: gate limpio + confirmado -> promueve a qualified.
Path("/tmp/opportunity-qualified.sql").write_text(render(upsert_query, upsert_values(
    should_write="true", requested_status="qualified")))
# Escenario 4: intencion operativa -> no escribe.
Path("/tmp/opportunity-operational.sql").write_text(render(upsert_query, upsert_values(
    intent_code="complaint", should_write="false")))

crm = json.loads(Path("n8n/workflows/crm-lead-creation-and-assignment.json").read_text())
link_query = next(n for n in crm["nodes"] if n["name"] == "Link Opportunity Promotion")["parameters"]["query"]
Path("/tmp/opportunity-link.sql").write_text(render(link_query, [1]))
Path("/tmp/opportunity-link-replay.sql").write_text(render(link_query, [1]))
PY

assert_sql() {
  local query="$1"
  local expected="$2"
  local actual
  actual="$(docker exec "$POSTGRES_CONTAINER" psql -U postgres -d "$TEST_DB" \
    -Atqc "$query")"
  if [ "$actual" != "$expected" ]; then
    printf 'Assertion failed\nSQL: %s\nExpected: %s\nActual: %s\n' \
      "$query" "$expected" "$actual" >&2
    exit 1
  fi
}

# Primer mensaje: se crea la oportunidad 'new' con traza.
docker exec -i "$POSTGRES_CONTAINER" psql -U postgres -d "$TEST_DB" \
  -v ON_ERROR_STOP=1 < /tmp/opportunity-first.sql >/tmp/opportunity-first.out
grep -q "created" /tmp/opportunity-first.out
assert_sql "SELECT count(*) FROM opportunities WHERE conversation_id = 1 AND deleted_at IS NULL" "1"
assert_sql "SELECT status_code FROM opportunities WHERE conversation_id = 1" "new"
assert_sql "SELECT result FROM audit_logs WHERE entity_type = 'opportunity' AND entity_id = 1" "created"

# Mensaje repetido (replay de dispatch): no duplica y queda trazado.
docker exec -i "$POSTGRES_CONTAINER" psql -U postgres -d "$TEST_DB" \
  -v ON_ERROR_STOP=1 < /tmp/opportunity-replay.sql >/tmp/opportunity-replay.out
grep -q "duplicate_skipped" /tmp/opportunity-replay.out
assert_sql "SELECT count(*) FROM opportunities WHERE conversation_id = 1 AND deleted_at IS NULL" "1"
assert_sql "SELECT result FROM audit_logs WHERE entity_type = 'opportunity' AND entity_id = 1 ORDER BY id DESC LIMIT 1" "duplicate_skipped"

# Gate limpio + confirmado: promueve la misma oportunidad a qualified.
docker exec -i "$POSTGRES_CONTAINER" psql -U postgres -d "$TEST_DB" \
  -v ON_ERROR_STOP=1 < /tmp/opportunity-qualified.sql >/tmp/opportunity-qualified.out
grep -q "promoted_qualified" /tmp/opportunity-qualified.out
assert_sql "SELECT status_code FROM opportunities WHERE conversation_id = 1" "qualified"
assert_sql "SELECT count(*) FROM opportunities WHERE conversation_id = 1 AND deleted_at IS NULL" "1"

# Intencion operativa: no crea oportunidad ni deja traza de escritura.
docker exec -i "$POSTGRES_CONTAINER" psql -U postgres -d "$TEST_DB" \
  -v ON_ERROR_STOP=1 < /tmp/opportunity-operational.sql >/tmp/opportunity-operational.out
grep -q "skipped" /tmp/opportunity-operational.out
assert_sql "SELECT count(*) FROM opportunities WHERE conversation_id = 1 AND deleted_at IS NULL" "1"
assert_sql "SELECT count(*) FROM audit_logs WHERE event_name = 'opportunity_sync' AND result = 'skipped'" "0"

# Lead promovido: la oportunidad queda vinculada al lead y en estado promoted.
docker exec -i "$POSTGRES_CONTAINER" psql -U postgres -d "$TEST_DB" -v ON_ERROR_STOP=1 >/dev/null <<'SQL'
INSERT INTO leads (phone_number, source_number_id, source_conversation_id, channel, lead_status_id, is_qualified)
SELECT '56912345678', 1, 1, 'whatsapp', id, TRUE FROM lead_statuses WHERE code = 'qualified_complete';
SQL
docker exec -i "$POSTGRES_CONTAINER" psql -U postgres -d "$TEST_DB" \
  -v ON_ERROR_STOP=1 < /tmp/opportunity-link.sql >/tmp/opportunity-link.out
grep -q "promoted" /tmp/opportunity-link.out
assert_sql "SELECT status_code || '|' || promoted_lead_id FROM opportunities WHERE conversation_id = 1" "promoted|1"

# Replay del link: no re-vincula ni cambia estado.
docker exec -i "$POSTGRES_CONTAINER" psql -U postgres -d "$TEST_DB" \
  -v ON_ERROR_STOP=1 < /tmp/opportunity-link-replay.sql >/tmp/opportunity-link-replay.out
assert_sql "SELECT status_code || '|' || promoted_lead_id FROM opportunities WHERE conversation_id = 1" "promoted|1"

echo "Opportunity cycle local tests OK: decision pura + idempotencia por conversacion + promocion a qualified + vinculo con lead promovido + intenciones operativas excluidas"
