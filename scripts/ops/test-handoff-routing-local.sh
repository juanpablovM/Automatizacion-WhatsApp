#!/bin/sh
set -eu

# =============================================================================
# test-handoff-routing-local.sh — Harness local y determinista (sin red) para
# la Unidad 3: escalamiento humano durable y enrutado (PRD #22/#23/#9.5/#11).
# -----------------------------------------------------------------------------
# Valida en 2 capas:
#   1. Dispatcher (Ensure Escalation Handoff + Prepare/Dispatch Notification)
#      -> decision pura de routing (motivo->area->prioridad->responsable),
#         idempotency key estable y stub de notificacion. Sin BD.
#   2. Persistencia (Upsert Escalation Handoff / Mark Handoff Attempt /
#      Advance Handoff State) -> idempotencia por evento, notificacion
#      exactamente una vez, reintentos (max 3), transiciones y audit. BD
#      temporal docker.
# =============================================================================

ROOT_DIR=$(CDPATH= cd -- "$(dirname "$0")/../.." && pwd)
cd "$ROOT_DIR"

# La politica canonica vive en fixtures y se reinyecta con sync-workflow-nodes.mjs.
if ! node tests/scripts/sync-workflow-nodes.mjs --check >/dev/null 2>&1; then
  echo "ERROR: los nodos de workflow divergen de los fixtures de tests/fixtures/workflow-nodes/" >&2
  echo "Ejecuta: node tests/scripts/sync-workflow-nodes.mjs" >&2
  exit 1
fi

POSTGRES_CONTAINER="${PROJECT_NAME:-crm-whatsapp-automatizado}-postgres"
TEST_DB="crm_whatsapp_handoff_${$}"
DB_SQL_DIR="$(mktemp -d)"

cleanup() {
  docker exec "$POSTGRES_CONTAINER" psql -U postgres -d postgres \
    -c "DROP DATABASE IF EXISTS ${TEST_DB} WITH (FORCE)" >/dev/null 2>&1 || true
  rm -rf "$DB_SQL_DIR"
  rm -f /tmp/handoff-*.sql /tmp/handoff-*.out
}
trap cleanup EXIT

# ---------------------------------------------------------------------------
# Capa 1: decision pura de los nodos (vm, sin red) + contrato de routing/gate.
# ---------------------------------------------------------------------------
node <<'NODE'
(async () => {
  const fs = require('fs');
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

  const dispatcher = JSON.parse(fs.readFileSync('n8n/workflows/wa-inbound-downstream-dispatcher.json', 'utf8'));
  const nodeCode = (name) => {
    const node = dispatcher.nodes.find((entry) => entry.name === name);
    if (!node) throw new Error(`No existe nodo ${name}`);
    return node.parameters.jsCode;
  };
  const runNode = async (name, item, env = {}) => {
    const fn = new AsyncFunction('items', 'helpers', '$env', nodeCode(name));
    const result = await fn([{ json: item }], {}, env);
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
    conversation_id: 42,
    phone_number: '56912345678',
    source_number_id: 1,
    inbound_event_id: 99,
    customer_type: 'b2c',
    lead_class: 'B',
    should_escalate: false,
    escalation_area: 'none',
    escalation_reason: '',
    intent: 'quote_request',
  };

  // (a) Sin escalamiento: no se escribe handoff.
  const noEscalation = await runNode('Ensure Escalation Handoff', baseRow);
  expectEqual(noEscalation.handoff_write, false, 'sin escalamiento no escribe handoff');
  expectEqual(noEscalation.handoff_skipped, true, 'sin escalamiento queda skipped');
  expectEqual(noEscalation.handoff_scope.idempotency_key, null, 'sin escalamiento no hay idempotency key');

  // (b) Intencion operativa SIN senal de escalamiento (area 'none'): no escribe.
  const operationalNoEsc = await runNode('Ensure Escalation Handoff', {
    ...baseRow,
    intent: 'complaint',
    escalation_area: 'none',
    should_escalate: false,
  });
  expectEqual(operationalNoEsc.handoff_write, false, 'reclamo sin escalamiento no escribe');

  // (b2) Area operativa declarada por la AI (PRD #22: reclamos/handoffs) -> escala aunque should_escalate sea false.
  const aiOperational = await runNode('Ensure Escalation Handoff', {
    ...baseRow,
    intent: 'quote_request',
    escalation_area: 'claims',
    should_escalate: false,
  });
  expectEqual(aiOperational.handoff_write, true, 'area operativa declarada por la AI escala');
  expectEqual(aiOperational.handoff_scope.area, 'claims', 'area operativa rutea a claims');

  // (c) Mapping motivo->area->prioridad->responsable (PRD #22/#23/#9.5/#11).
  const cases = [
    { reason: 'el pastelon llego quebrado', esperado: { motivo: 'complaint', area: 'claims', area_label: 'Reclamos', prioridad: 'urgente', responsable: 'Responsable de Reclamos' } },
    { reason: 'envio el comprobante de la transferencia', esperado: { motivo: 'payment_proof', area: 'finance', area_label: 'Finanzas', prioridad: 'alta', responsable: 'Finanzas' } },
    { reason: 'necesito factura para la compra', esperado: { motivo: 'invoice', area: 'finance', area_label: 'Finanzas', prioridad: 'media', responsable: 'Finanzas / Administración' } },
    { reason: 'consulto por la garantia de la instalacion', esperado: { motivo: 'warranty', area: 'post_sale', area_label: 'Postventa', prioridad: 'alta', responsable: 'Administración / Postventa' } },
    { reason: 'somos una constructora con OC', esperado: { motivo: 'b2b', area: 'b2b', area_label: 'B2B', prioridad: 'alta', responsable: 'Patricia / Área B2B' } },
    { reason: 'el proyecto supera los 2.000.000 de pesos', esperado: { motivo: 'large_project', area: 'sales', area_label: 'Ventas', prioridad: 'alta', responsable: 'Ejecutiva comercial' } },
    { reason: 'pide 10% de descuento', esperado: { motivo: 'discount', area: 'management', area_label: 'Gerencia', prioridad: 'alta', responsable: 'Gerencia' } },
    { reason: 'quiere reagendar el despacho', esperado: { motivo: 'scheduling_change', area: 'scheduling', area_label: 'Programación', prioridad: 'media', responsable: 'Programación (despacho/instalación)' } },
    { reason: 'el despacho comprometido no llega', esperado: { motivo: 'committed_issue', area: 'scheduling', area_label: 'Programación', prioridad: 'alta', responsable: 'Programación (despacho/instalación)' } },
  ];
  for (const { reason, esperado } of cases) {
    const scoped = await runNode('Ensure Escalation Handoff', {
      ...baseRow, should_escalate: true, intent: 'quote_request', escalation_reason: reason,
    });
    expectEqual(scoped.handoff_write, true, `escalamiento escribe (${reason})`);
    const scope = scoped.handoff_scope;
    expectEqual(scope.motivo, esperado.motivo, `motivo (${reason})`);
    expectEqual(scope.area, esperado.area, `area (${reason})`);
    expectEqual(scope.area_label, esperado.area_label, `area_label (${reason})`);
    expectEqual(scope.prioridad, esperado.prioridad, `prioridad (${reason})`);
    expectEqual(scope.responsable, esperado.responsable, `responsable (${reason})`);
  }

  // (d) Fallback por area declarada por la AI (contrato del advisor).
  const byArea = await runNode('Ensure Escalation Handoff', {
    ...baseRow, escalation_area: 'claims', intent: 'quote_request',
  });
  expectEqual(byArea.handoff_write, true, 'escalamiento por area AI escribe');
  expectEqual(byArea.handoff_scope.area, 'claims', 'area declarada rutea a claims');
  expectEqual(byArea.handoff_scope.prioridad, 'urgente', 'fallback claims -> prioridad urgente');

  // (e) Idempotency key: mismo evento repetido -> misma clave; trigger distinto -> clave distinta.
  const first = await runNode('Ensure Escalation Handoff', {
    ...baseRow, should_escalate: true, intent: 'complaint', escalation_reason: 'falla en la entrega',
  });
  const replay = await runNode('Ensure Escalation Handoff', {
    ...baseRow, should_escalate: true, intent: 'complaint', escalation_reason: 'falla en la entrega',
  });
  expectEqual(replay.handoff_scope.idempotency_key, first.handoff_scope.idempotency_key, 'replay del mismo evento -> misma idempotency key');
  expectEqual(first.handoff_scope.idempotency_key, '42:complaint:falla en la entrega', 'formato de clave {conversation_id}:{motivo}:{trigger}');
  const differentReason = await runNode('Ensure Escalation Handoff', {
    ...baseRow, should_escalate: true, intent: 'complaint', escalation_reason: 'producto roto en destino',
  });
  assert(differentReason.handoff_scope.idempotency_key !== first.handoff_scope.idempotency_key, 'motivo distinto -> clave distinta');

  // (f) Gate de no-cierre (contrato puro via el modulo del fixture).
  const { evaluateClosureGate } = require('./tests/fixtures/workflow-nodes/wa-inbound-downstream-dispatcher/ensure-escalation-handoff.js');
  const gMissing = evaluateClosureGate({ intent: 'complaint', should_escalate: true });
  expectEqual(gMissing.requires_handoff, true, 'reclamo escalado exige handoff');
  expectEqual(gMissing.closure_allowed, false, 'reclamo escalado sin handoff NO se cierra');
  expectEqual(gMissing.required_status, 'notified', 'estado minimo exigido: notified');
  const gPending = evaluateClosureGate({ intent: 'complaint', should_escalate: true, handoff_exists: true, handoff_status: 'pending' });
  expectEqual(gPending.closure_allowed, false, 'reclamo con handoff pending NO se cierra');
  const gNotified = evaluateClosureGate({ intent: 'complaint', should_escalate: true, handoff_exists: true, handoff_status: 'notified' });
  expectEqual(gNotified.closure_allowed, true, 'reclamo con handoff notified SI puede cerrar');
  const gAcknowledged = evaluateClosureGate({ intent: 'b2b_request', should_escalate: true, customer_type: 'b2b', handoff_exists: true, handoff_status: 'acknowledged' });
  expectEqual(gAcknowledged.closure_allowed, true, 'B2B con handoff acknowledged SI puede cerrar');
  const gNoEsc = evaluateClosureGate({ intent: 'complaint', should_escalate: false });
  expectEqual(gNoEsc.closure_allowed, true, 'sin escalamiento no exige handoff (no bloquea cierre)');
  const gTalk = evaluateClosureGate({ intent: 'talk_to_human', should_escalate: true });
  expectEqual(gTalk.requires_handoff, false, 'talk_to_human no es intencion operativa de cierre');

  // (g) Nodo integrado: el gate se emite por turno dentro del dispatcher.
  const integrated = await runNode('Ensure Escalation Handoff', {
    ...baseRow, should_escalate: true, intent: 'complaint', escalation_reason: 'producto quebrado',
  });
  expectEqual(integrated.handoff_gate.requires_handoff, true, 'nodo calcula gate de no-cierre');
  expectEqual(integrated.handoff_gate.closure_allowed, false, 'gate bloquea cierre hasta notified');

  // (h) Prepare: handoff pendiente con intentos -> notifica; ya notificado -> no.
  const notifyPending = await runNode('Prepare Handoff Notification', {
    handoff_write: true, handoff_id: 7, handoff_estado: 'pending', handoff_attempts: 0,
    handoff_scope: {
      idempotency_key: '42:complaint:x', motivo: 'complaint', area: 'claims',
      area_label: 'Reclamos', prioridad: 'urgente', responsable: 'Responsable de Reclamos',
      phone_number: '56912345678', conversation_id: 42, escalation_reason: 'falla',
    },
  });
  expectEqual(notifyPending.should_notify, true, 'handoff pendiente -> notificar');
  expectEqual(notifyPending.notification_payload.responsable, 'Responsable de Reclamos', 'payload lleva responsable');
  const notifyAlready = await runNode('Prepare Handoff Notification', {
    ...notifyPending, handoff_estado: 'notified',
  });
  expectEqual(notifyAlready.should_notify, false, 'handoff ya notificado -> no re-notificar (exactamente una vez)');
  const notifyExhausted = await runNode('Prepare Handoff Notification', {
    ...notifyPending, handoff_attempts: 3,
  });
  expectEqual(notifyExhausted.should_notify, false, 'intentos agotados (3) -> no reintentar');

  // (i) Dispatch: stub determinista (exito por defecto; fallo solo si se pide).
  const stubOk = await runNode('Dispatch Handoff Notification', { should_notify: true });
  expectEqual(stubOk.notification_outcome, 'succeeded', 'stub por defecto -> exito');
  expectEqual(stubOk.notification_status_code, 200, 'exito con status 200');
  expectEqual(stubOk.notification_stub, true, 'stub queda marcado (sin mensajes reales)');
  const stubFail = await runNode('Dispatch Handoff Notification', { should_notify: true, notification_stub_mode: 'failed' });
  expectEqual(stubFail.notification_outcome, 'failed', 'stub fallo configurado -> fallido');
  expectEqual(stubFail.notification_status_code, 503, 'fallo con status 503');
  const stubSkipped = await runNode('Dispatch Handoff Notification', { should_notify: false });
  expectEqual(stubSkipped.dispatch_skipped, true, 'sin should_notify no se despacha');

  console.log(`\nEscalamiento/routing (capa nodo): ${passed} PASS / ${failed} FAIL`);
  if (failed > 0) process.exit(1);
})().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
NODE

# ---------------------------------------------------------------------------
# Capa 2: persistencia idempotente y reintentos en BD temporal (docker).
# ---------------------------------------------------------------------------
docker exec "$POSTGRES_CONTAINER" psql -U postgres -d postgres \
  -v ON_ERROR_STOP=1 -c "CREATE DATABASE ${TEST_DB}" >/dev/null

for migration in infra/postgres/migrations/00[1-7]_*.sql; do
  docker exec -i "$POSTGRES_CONTAINER" psql -U postgres -d "$TEST_DB" \
    -v ON_ERROR_STOP=1 < "$migration" >/dev/null
done
docker exec -i "$POSTGRES_CONTAINER" psql -U postgres -d "$TEST_DB" \
  -v ON_ERROR_STOP=1 < db/seeds/001_lead_statuses.sql >/dev/null
docker exec -i "$POSTGRES_CONTAINER" psql -U postgres -d "$TEST_DB" \
  -v ON_ERROR_STOP=1 < db/seeds/002_conversation_statuses.sql >/dev/null
docker exec -i "$POSTGRES_CONTAINER" psql -U postgres -d "$TEST_DB" \
  -v ON_ERROR_STOP=1 < infra/postgres/migrations/010_create_opportunities.sql >/dev/null
docker exec -i "$POSTGRES_CONTAINER" psql -U postgres -d "$TEST_DB" \
  -v ON_ERROR_STOP=1 < infra/postgres/migrations/011_create_handoffs.sql >/dev/null
# Re-aplicacion idempotente (mismo estilo que 010).
docker exec -i "$POSTGRES_CONTAINER" psql -U postgres -d "$TEST_DB" \
  -v ON_ERROR_STOP=1 < infra/postgres/migrations/011_create_handoffs.sql >/dev/null

docker exec -i "$POSTGRES_CONTAINER" psql -U postgres -d "$TEST_DB" -v ON_ERROR_STOP=1 >/dev/null <<'SQL'
INSERT INTO whatsapp_numbers (display_name, phone_number, phone_number_id)
VALUES ('Main', '+56900000000', 'pn-main');
INSERT INTO conversations (phone_number, source_number_id, conversation_status_id)
SELECT '56912345678', 1, id FROM conversation_statuses WHERE code = 'active';
SQL

python3 - <<'PY'
import json
from pathlib import Path

def literal(value):
    if value is None:
        return "NULL"
    if value is True:
        return "TRUE"
    if value is False:
        return "FALSE"
    if isinstance(value, str):
        return "'" + value.replace("'", "''") + "'"
    return str(value)

def render(query, values):
    out = query
    for key in sorted(values, key=len, reverse=True):
        out = out.replace(f":{key}", literal(values[key]))
    return out

dispatcher = json.loads(Path("n8n/workflows/wa-inbound-downstream-dispatcher.json").read_text())
upsert_query = next(n for n in dispatcher["nodes"] if n["name"] == "Upsert Escalation Handoff")["parameters"]["query"]
mark_query = next(n for n in dispatcher["nodes"] if n["name"] == "Mark Handoff Attempt")["parameters"]["query"]
advance_query = Path("db/queries/n8n/handoff-routing/03_advance_handoff_state.sql").read_text()

def upsert_values(**overrides):
    values = {
        "should_write": True,
        "conversation_id": 1,
        "phone_number": "56912345678",
        "source_number_id": "1",
        "inbound_event_id": "300",
        "motivo": "complaint",
        "area": "claims",
        "area_label": "Reclamos",
        "prioridad": "urgente",
        "responsable": "Responsable de Reclamos",
        "idempotency_key": "1:complaint:falla en la entrega",
        "trigger": "falla en la entrega",
        "escalation_reason": "falla en la entrega",
        "escalation_area": "claims",
        "intent": "complaint",
    }
    values.update(overrides)
    return values

# 1) Creacion: handoff pendiente y audit 'created'.
Path("/tmp/handoff-create.sql").write_text(render(upsert_query, upsert_values()))
# 2) Replay del mismo evento -> 'duplicate_skipped', sin duplicar.
Path("/tmp/handoff-replay.sql").write_text(render(upsert_query, upsert_values()))
# 3) Sin escalamiento (should_write=false) -> 'skipped', sin fila ni audit.
Path("/tmp/handoff-skip.sql").write_text(render(upsert_query, upsert_values(
    should_write=False)))

def mark_values(**overrides):
    values = {
        "handoff_id": 1,
        "outcome": "succeeded",
        "error": None,
    }
    values.update(overrides)
    return values

# 4) Notificacion exitosa -> 'succeeded' (estado notified, una vez).
Path("/tmp/handoff-notified.sql").write_text(render(mark_query, mark_values()))
# 5) Re-notificar (replay) -> 'already_notified', sin incrementar intentos.
Path("/tmp/handoff-already.sql").write_text(render(mark_query, mark_values()))
# 6) Fallo: intento 1 -> 'retry' (queda pending).
Path("/tmp/handoff-fail1.sql").write_text(render(mark_query, mark_values(
    handoff_id=2, outcome="failed", error="timeout stub")))
# 7) Fallo: intento 2 -> 'retry'.
Path("/tmp/handoff-fail2.sql").write_text(render(mark_query, mark_values(
    handoff_id=2, outcome="failed", error="timeout stub")))
# 8) Fallo: intento 3 -> 'notification_exhausted' (limite alcanzado).
Path("/tmp/handoff-fail3.sql").write_text(render(mark_query, mark_values(
    handoff_id=2, outcome="failed", error="timeout final")))
# 9) Llamada adicional -> 'attempt_limit_exceeded' (sin mas intentos).
Path("/tmp/handoff-fail4.sql").write_text(render(mark_query, mark_values(
    handoff_id=2, outcome="failed", error="timeout extra")))
# 10) Transiciones operativas: notified -> acknowledged -> resolved.
Path("/tmp/handoff-ack.sql").write_text(render(advance_query, {"handoff_id": 1, "estado": "acknowledged"}))
Path("/tmp/handoff-resolve.sql").write_text(render(advance_query, {"handoff_id": 1, "estado": "resolved"}))
# 11) Transicion invalida: resolved -> acknowledged (debe rechazarse + auditarse).
Path("/tmp/handoff-invalid.sql").write_text(render(advance_query, {"handoff_id": 1, "estado": "acknowledged"}))
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

# 1) Creacion durable con routing completo.
docker exec -i "$POSTGRES_CONTAINER" psql -U postgres -d "$TEST_DB" \
  -v ON_ERROR_STOP=1 < /tmp/handoff-create.sql >/tmp/handoff-create.out
grep -q "created" /tmp/handoff-create.out
assert_sql "SELECT count(*) FROM handoffs WHERE idempotency_key = '1:complaint:falla en la entrega' AND deleted_at IS NULL" "1"
assert_sql "SELECT area || '|' || prioridad || '|' || responsable FROM handoffs WHERE id = 1" "claims|urgente|Responsable de Reclamos"
assert_sql "SELECT estado FROM handoffs WHERE id = 1" "pending"
assert_sql "SELECT result FROM audit_logs WHERE event_name = 'handoff_sync' AND entity_id = 1" "created"

# 2) Replay: no duplica y queda trazado.
docker exec -i "$POSTGRES_CONTAINER" psql -U postgres -d "$TEST_DB" \
  -v ON_ERROR_STOP=1 < /tmp/handoff-replay.sql >/tmp/handoff-replay.out
grep -q "duplicate_skipped" /tmp/handoff-replay.out
assert_sql "SELECT count(*) FROM handoffs WHERE deleted_at IS NULL" "1"
assert_sql "SELECT result FROM audit_logs WHERE event_name = 'handoff_sync' AND entity_id = 1 ORDER BY id DESC LIMIT 1" "duplicate_skipped"

# 3) Sin escalamiento: no se crea handoff ni audit.
docker exec -i "$POSTGRES_CONTAINER" psql -U postgres -d "$TEST_DB" \
  -v ON_ERROR_STOP=1 < /tmp/handoff-skip.sql >/tmp/handoff-skip.out
grep -q "skipped" /tmp/handoff-skip.out
assert_sql "SELECT count(*) FROM handoffs WHERE deleted_at IS NULL" "1"
assert_sql "SELECT count(*) FROM audit_logs WHERE event_name = 'handoff_sync' AND result = 'skipped'" "0"

# 4) Notificacion exitosa: estado 'notified', una sola vez, con intento registrado.
docker exec -i "$POSTGRES_CONTAINER" psql -U postgres -d "$TEST_DB" \
  -v ON_ERROR_STOP=1 < /tmp/handoff-notified.sql >/tmp/handoff-notified.out
grep -q "succeeded" /tmp/handoff-notified.out
assert_sql "SELECT estado FROM handoffs WHERE id = 1" "notified"
assert_sql "SELECT notification_attempt_count FROM handoffs WHERE id = 1" "1"
assert_sql "SELECT notified_at IS NOT NULL FROM handoffs WHERE id = 1" "t"
assert_sql "SELECT result FROM audit_logs WHERE event_name = 'handoff_transition' AND entity_id = 1 ORDER BY id DESC LIMIT 1" "succeeded"

# 5) Replay de la notificacion: no re-envia ni suma intentos.
docker exec -i "$POSTGRES_CONTAINER" psql -U postgres -d "$TEST_DB" \
  -v ON_ERROR_STOP=1 < /tmp/handoff-already.sql >/tmp/handoff-already.out
grep -q "already_notified" /tmp/handoff-already.out
assert_sql "SELECT notification_attempt_count FROM handoffs WHERE id = 1" "1"
assert_sql "SELECT count(*) FROM handoffs WHERE estado = 'notified' AND id = 1" "1"

# 6-8) Notificacion con fallos: reintentos (max 3) y 'notification_exhausted'.
docker exec -i "$POSTGRES_CONTAINER" psql -U postgres -d "$TEST_DB" -v ON_ERROR_STOP=1 <<'SQL'
INSERT INTO handoffs (idempotency_key, conversation_id, phone_number, motivo, area, area_label, prioridad, responsable, trigger, escalation_area, intent)
VALUES ('1:payment_proof:intento-fallido', 1, '56912345678', 'payment_proof', 'finance', 'Finanzas', 'alta', 'Finanzas', 'intento-fallido', 'finance', 'payment_proof')
RETURNING id;
SQL
HANDOFF_2_ID="$(docker exec "$POSTGRES_CONTAINER" psql -U postgres -d "$TEST_DB" \
  -Atqc "SELECT id FROM handoffs WHERE idempotency_key = '1:payment_proof:intento-fallido' AND deleted_at IS NULL")"
if [ -z "$HANDOFF_2_ID" ]; then
  echo "ERROR: no se pudo recuperar el id del handoff de reintentos" >&2
  exit 1
fi
for sql_file in /tmp/handoff-fail1.sql /tmp/handoff-fail2.sql /tmp/handoff-fail3.sql /tmp/handoff-fail4.sql; do
  sed -i "s/h.id = 2::bigint/h.id = ${HANDOFF_2_ID}::bigint/" "$sql_file"
done
docker exec -i "$POSTGRES_CONTAINER" psql -U postgres -d "$TEST_DB" \
  -v ON_ERROR_STOP=1 < /tmp/handoff-fail1.sql >/tmp/handoff-fail1.out
if ! grep -q "retry" /tmp/handoff-fail1.out; then
  echo "=== fail1.out ==="; cat /tmp/handoff-fail1.out; exit 1
fi
assert_sql "SELECT estado || '|' || notification_attempt_count || '|' || (last_notification_error IS NOT NULL)::text FROM handoffs WHERE id = ${HANDOFF_2_ID}" "pending|1|true"
docker exec -i "$POSTGRES_CONTAINER" psql -U postgres -d "$TEST_DB" \
  -v ON_ERROR_STOP=1 < /tmp/handoff-fail2.sql >/tmp/handoff-fail2.out
grep -q "retry" /tmp/handoff-fail2.out
assert_sql "SELECT notification_attempt_count FROM handoffs WHERE id = ${HANDOFF_2_ID}" "2"
docker exec -i "$POSTGRES_CONTAINER" psql -U postgres -d "$TEST_DB" \
  -v ON_ERROR_STOP=1 < /tmp/handoff-fail3.sql >/tmp/handoff-fail3.out
grep -q "notification_exhausted" /tmp/handoff-fail3.out
assert_sql "SELECT estado || '|' || notification_attempt_count FROM handoffs WHERE id = ${HANDOFF_2_ID}" "pending|3"
assert_sql "SELECT last_notification_error FROM handoffs WHERE id = ${HANDOFF_2_ID}" "timeout final"
assert_sql "SELECT result FROM audit_logs WHERE event_name = 'handoff_transition' AND entity_id = ${HANDOFF_2_ID} ORDER BY id DESC LIMIT 1" "notification_exhausted"

# 9) Sin intentos disponibles: la llamada extra no incrementa nada.
docker exec -i "$POSTGRES_CONTAINER" psql -U postgres -d "$TEST_DB" \
  -v ON_ERROR_STOP=1 < /tmp/handoff-fail4.sql >/tmp/handoff-fail4.out
grep -qE "attempt_limit_exceeded" /tmp/handoff-fail4.out
assert_sql "SELECT notification_attempt_count FROM handoffs WHERE id = ${HANDOFF_2_ID}" "3"

# 10) Transiciones validas: notified -> acknowledged -> resolved.
docker exec -i "$POSTGRES_CONTAINER" psql -U postgres -d "$TEST_DB" \
  -v ON_ERROR_STOP=1 < /tmp/handoff-ack.sql >/tmp/handoff-ack.out
grep -q "advanced" /tmp/handoff-ack.out
assert_sql "SELECT estado || '|' || (acknowledged_at IS NOT NULL)::text FROM handoffs WHERE id = 1" "acknowledged|true"
docker exec -i "$POSTGRES_CONTAINER" psql -U postgres -d "$TEST_DB" \
  -v ON_ERROR_STOP=1 < /tmp/handoff-resolve.sql >/tmp/handoff-resolve.out
grep -q "advanced" /tmp/handoff-resolve.out
assert_sql "SELECT estado || '|' || (resolved_at IS NOT NULL)::text FROM handoffs WHERE id = 1" "resolved|true"

# 11) Transicion invalida (resolved -> acknowledged) rechazada y auditada.
docker exec -i "$POSTGRES_CONTAINER" psql -U postgres -d "$TEST_DB" \
  -v ON_ERROR_STOP=1 < /tmp/handoff-invalid.sql >/tmp/handoff-invalid.out
grep -q "invalid_transition" /tmp/handoff-invalid.out
assert_sql "SELECT estado FROM handoffs WHERE id = 1" "resolved"
assert_sql "SELECT result FROM audit_logs WHERE event_name = 'handoff_transition' AND entity_id = 1 ORDER BY id DESC LIMIT 1" "invalid_transition"

echo "Handoff routing local tests OK: routing PRD + idempotencia por evento + notificacion exactamente una vez + reintentos (max 3) + transiciones auditadas + gate de no-cierre"