#!/bin/sh
set -eu

# =============================================================================
# test-followup-cadence-local.sh — Harness local y determinista (sin red) para
# la Unidad 6: seguimiento automatico A-010 (cadencia 0/1/3/7/14).
# -----------------------------------------------------------------------------
# Valida en 3 capas:
#   1. Decision pura (fixtures): cadence builder, textos por step/motivo,
#      ventana horaria, opt-out y deteccion de perdida de interes.
#   2. Persistencia/scheduler (SQL): scheduling idempotente por
#      (conversation, step), claim con lock+token y ventana, envio exactamente
#      una vez por step, avance de cadencia, cancelacion (client_replied/lost),
#      opt-out definitivo y skip de ventana. Reloj inyectado (sin sleeps).
#   3. Cancelacion integrada en el dispatcher (Ensure Follow-Up Cancellation).
# =============================================================================

ROOT_DIR=$(CDPATH= cd -- "$(dirname "$0")/../.." && pwd)
cd "$ROOT_DIR"

if ! node tests/scripts/sync-workflow-nodes.mjs --check >/dev/null 2>&1; then
  echo "ERROR: los nodos de workflow divergen de los fixtures de tests/fixtures/workflow-nodes/" >&2
  echo "Ejecuta: node tests/scripts/sync-workflow-nodes.mjs" >&2
  exit 1
fi

POSTGRES_CONTAINER="${PROJECT_NAME:-crm-whatsapp-automatizado}-postgres"
TEST_DB="crm_whatsapp_followup_${$}"

cleanup() {
  docker exec "$POSTGRES_CONTAINER" psql -U postgres -d postgres \
    -c "DROP DATABASE IF EXISTS ${TEST_DB} WITH (FORCE)" >/dev/null 2>&1 || true
  rm -f /tmp/followup-*.sql /tmp/followup-*.out
}
trap cleanup EXIT

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

expect_out() {
  local label="$1" file="$2" needle="$3"
  if grep -q "$needle" "$file"; then
    PASS=$((PASS + 1))
  else
    FAIL=$((FAIL + 1))
    echo "OUT MISSING '$needle' in $file:"
    sed -n '1,8p' "$file"
  fi
}

run_sql_file() {
  local file="$1"
  docker exec -i "$POSTGRES_CONTAINER" psql -U postgres -d "$TEST_DB" \
    -v ON_ERROR_STOP=1 < "$file" > /tmp/followup-run.out 2>&1
}

sql_value() {
  docker exec "$POSTGRES_CONTAINER" psql -U postgres -d "$TEST_DB" -Atqc "$1"
}

# ---------------------------------------------------------------------------
# Capa 1: decisiones puras de los fixtures.
# ---------------------------------------------------------------------------
node <<'NODE'
(async () => {
  const policy = require('./tests/fixtures/workflow-nodes/ops-followup-scheduler/follow-up-policy.js');
  const prepare = require('./tests/fixtures/workflow-nodes/ops-followup-scheduler/prepare-follow-up-message.js');
  const cancel = require('./tests/fixtures/workflow-nodes/wa-inbound-downstream-dispatcher/ensure-follow-up-cancellation.js');

  let passed = 0;
  let failed = 0;
  const expectEqual = (actual, expected, message) => {
    if (actual !== expected) { failed += 1; console.error(`  FAIL: ${message}: esperado ${JSON.stringify(expected)}, recibido ${JSON.stringify(actual)}`); }
    else { passed += 1; }
  };

  const c0 = policy.buildCadence({ withDayZero: true, now: '2026-08-07T10:00:00Z' });
  expectEqual(c0.map((c) => c.step_dia).join(','), '0,1,3,7,14', 'cadence con dia 0');
  expectEqual(c0[1].scheduled_at, '2026-08-08T10:00:00.000Z', 'dia 1 = base+1d');
  expectEqual(c0[3].scheduled_at, '2026-08-14T10:00:00.000Z', 'dia 7 = base+7d');
  const cNo0 = policy.buildCadence({ withDayZero: false, now: '2026-08-07T10:00:00Z' });
  expectEqual(cNo0.map((x) => x.step_dia).join(','), '1,3,7,14', 'cadence sin dia 0 (confirmacion ya cubierta por el bot)');

  const msg1 = prepare.prepareFollowUp({ motivo: 'cotizacion_lead', step_dia: 1, scheduled_at: '2026-08-08T15:00:00' }, { contactName: 'Jorge' });
  expectEqual(msg1.follow_up_text, 'Hola Jorge, te escribimos para saber si queres seguir avanzando con tu consulta sobre la cotizacion.', 'texto cotizacion dia 1');
  expectEqual(msg1.follow_up_will_send, true, 'dentro de ventana 15:00 si envia');
  const msg14 = prepare.prepareFollowUp({ motivo: 'cotizacion_lead', step_dia: 14 }, { contactName: '' });
  expectEqual(msg14.follow_up_text.includes('ultimo recordatorio'), true, 'texto dia 14 sin nombre');
  const msgOut = prepare.prepareFollowUp({ motivo: 'cotizacion_lead', step_dia: 1, scheduled_at: '2026-08-08T07:30:00' });
  expectEqual(msgOut.follow_up_will_send, false, 'fuera de ventana no envia');

  expectEqual(policy.detectOptOut('no me escribas mas por favor'), true, 'opt-out: no me escribas mas');
  expectEqual(policy.detectOptOut('dame de baja de la lista'), true, 'opt-out: baja de la lista');
  expectEqual(policy.detectOptOut('quiero saber precios'), false, 'no es opt-out');
  expectEqual(policy.detectLostIntent('ya no me interesa, gracias'), true, 'perdida: ya no me interesa');

  const baseRow = { conversation_id: 42, phone_number: '56912345678', from_user: true, is_customer_message: true, follow_up_pending: true };
  const replied = cancel.resolveCancellationAction({ ...baseRow, customer_message: 'hola, sigo interesado, cuanto vale el pastelon?' });
  expectEqual(replied.follow_up_cancel_reason, 'client_replied', 'cliente responde -> cancela pendientes');
  const optOut = cancel.resolveCancellationAction({ ...baseRow, customer_message: 'no me escribas mas' });
  expectEqual(optOut.follow_up_cancel_action, 'opt_out', 'texto de baja -> opt_out');
  const lost = cancel.resolveCancellationAction({ ...baseRow, customer_message: 'ya no me interesa' });
  expectEqual(lost.follow_up_cancel_reason, 'lost', 'pierde interes -> lost');
  const escalated = cancel.resolveCancellationAction({ ...baseRow, should_escalate: true, handoff_write: true });
  expectEqual(escalated.follow_up_cancel_reason, 'escalated', 'derivacion a humano cancela');
  const noPending = cancel.resolveCancellationAction({ conversation_id: 42, from_user: true, customer_message: 'hola' });
  expectEqual(noPending.should_apply, false, 'sin pendientes no escribe nada');

  console.log(`Follow-up capa nodo: ${passed} PASS / ${failed} FAIL`);
  if (failed > 0) process.exit(1);
})().catch((error) => {
  console.error(`  FAIL global: ${error.message}`);
  process.exit(1);
});
NODE

# ---------------------------------------------------------------------------
# Capa 2-3: persistencia y scheduler en BD temporal (docker).
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
for extra in 010_create_opportunities 011_create_handoffs 012_create_media_attachments 013_create_follow_ups; do
  docker exec -i "$POSTGRES_CONTAINER" psql -U postgres -d "$TEST_DB" \
    -v ON_ERROR_STOP=1 < "infra/postgres/migrations/${extra}.sql" >/dev/null
done
docker exec -i "$POSTGRES_CONTAINER" psql -U postgres -d "$TEST_DB" \
  -v ON_ERROR_STOP=1 < infra/postgres/migrations/013_create_follow_ups.sql >/dev/null

docker exec -i "$POSTGRES_CONTAINER" psql -U postgres -d "$TEST_DB" -v ON_ERROR_STOP=1 >/dev/null <<'SQL'
INSERT INTO whatsapp_numbers (display_name, phone_number, phone_number_id)
VALUES ('Main', '+56900000000', 'pn-main');
INSERT INTO conversations (phone_number, source_number_id, conversation_status_id)
SELECT '56912345678', 1, id FROM conversation_statuses WHERE code = 'active';
INSERT INTO conversations (phone_number, source_number_id, conversation_status_id)
SELECT '56922222222', 1, id FROM conversation_statuses WHERE code = 'active';
INSERT INTO conversations (phone_number, source_number_id, conversation_status_id)
SELECT '56933333333', 1, id FROM conversation_statuses WHERE code = 'active';
INSERT INTO conversations (phone_number, source_number_id, conversation_status_id)
SELECT '56944444444', 1, id FROM conversation_statuses WHERE code = 'active';
INSERT INTO conversations (phone_number, source_number_id, conversation_status_id)
SELECT '56955555555', 1, id FROM conversation_statuses WHERE code = 'active';
INSERT INTO opportunities (phone_number, source_number_id, conversation_id, service, city, requirement, status_code)
VALUES ('56912345678', 1, 1, 'Pastelon', 'Maipu', 'Pastelon para patio trasero', 'qualified');
SQL

python3 - <<'PY'
from pathlib import Path

Q = Path('db/queries/n8n/follow-up-pipeline')
q = {n: (Q / f'{n}.sql').read_text() for n in
     ['01_schedule_follow_up', '02_claim_due_follow_ups', '03_apply_send_result',
      '04_schedule_next_step', '05_cancel_pending_follow_ups', '06_apply_opt_out',
      '07_log_window_skip']}

def lit(v):
    if v is None: return 'NULL'
    if v is True: return 'TRUE'
    if v is False: return 'FALSE'
    if isinstance(v, str): return "'" + v.replace("'", "''") + "'"
    if isinstance(v, (int, float)): return str(v)
    raise TypeError(v)

def render(template, values):
    text = template
    for key in sorted(values, key=len, reverse=True):
        text = text.replace(':' + key, lit(values[key]))
    return text

def save(name, text):
    Path(f'/tmp/followup-{name}.sql').write_text(text)

PHONE = '56912345678'

def sched(conv, step, when, motivo='cotizacion_lead', opp=None, phone=None):
    save(f'sched-{conv}-{step}', render(q['01_schedule_follow_up'], {
        'conversation_id': conv, 'opportunity_id': opp or '', 'phone_number': phone or PHONE,
        'source_number_id': 1, 'motivo': motivo, 'step_dia': step, 'scheduled_at': when,
    }))

def claim(name, when, wstart='09:00', wend='20:00'):
    save(f'claim-{name}', render(q['02_claim_due_follow_ups'], {
        'batch_size': 50, 'window_start': wstart, 'window_end': wend,
        'now': when, 'claim_stale_seconds': 300,
    }))

def apply_res(name, fid, token, outcome, error=''):
    save(f'apply-{name}', render(q['03_apply_send_result'], {
        'follow_up_id': fid, 'origin_token': token, 'outcome': outcome, 'error': error,
    }))

# -- Conversacion 1: ciclo completo 1 -> 3 -> 7 -> 14 --
sched(1, 1, '2026-08-08T11:00:00', opp=1)
# Replay del schedule (idempotente)
sched(1, 1, '2026-08-08T11:00:00', opp=1)
# -- Conversacion 2: cancelacion por respuesta del cliente --
sched(2, 1, '2026-08-08T11:00:00', phone='56922222222')
sched(2, 3, '2026-08-10T11:00:00', phone='56922222222')
# -- Conversacion 3: perdida de interes --
sched(3, 1, '2026-08-08T11:00:00', phone='56933333333')
# -- Conversacion 4: opt-out --
sched(4, 1, '2026-08-08T11:00:00', phone='56944444444')
claim('tick1', '2026-08-08T11:05:00')
claim('tick1b', '2026-08-08T11:06:00')
apply_res('sent1', '__FID1__', '__TOKEN1__', 'sent')
PY

# ---------------------------------------------------------------------------
# Ejecucion determinista (reloj inyectado).
# ---------------------------------------------------------------------------
run_sql_file /tmp/followup-sched-1-1.sql
expect_out "schedule step1 conv1" /tmp/followup-run.out "scheduled"
run_sql_file /tmp/followup-sched-1-1.sql
expect_out "schedule replay step1 conv1 idempotente" /tmp/followup-run.out "duplicate_skipped"
assert_sql "un solo follow_up activo conv1 step1" \
  "SELECT count(*) FROM follow_ups WHERE conversation_id = 1 AND step_dia = 1 AND estado IN ('pending','sending')" "1"
assert_sql "fechas de la cadencia (dia1 = 2026-08-08 11:00)" \
  "SELECT to_char(scheduled_at, 'YYYY-MM-DD HH24:MI') FROM follow_ups WHERE conversation_id = 1 AND step_dia = 1" "2026-08-08 11:00"
assert_sql "audit follow_up_step scheduled (conv1)" \
  "SELECT count(*) FROM audit_logs WHERE event_name = 'follow_up_step' AND result = 'scheduled' AND after_payload->>'conversation_id' = '1'" "1"

run_sql_file /tmp/followup-sched-2-1.sql
run_sql_file /tmp/followup-sched-2-3.sql
run_sql_file /tmp/followup-sched-3-1.sql
run_sql_file /tmp/followup-sched-4-1.sql

# -- Tick 1 (11:05): reclama los steps due de conv1/2/3/4 (conv5 se crea luego).
run_sql_file /tmp/followup-claim-tick1.sql
FOLLOWUP_ID="$(sql_value "SELECT id FROM follow_ups WHERE conversation_id = 1 AND step_dia = 1")"
TOKEN="$(sql_value "SELECT claim_token::text FROM follow_ups WHERE id = ${FOLLOWUP_ID}")"
assert_sql "claim marca sending + token" \
  "SELECT estado || '|' || (claim_token IS NOT NULL)::text FROM follow_ups WHERE id = ${FOLLOWUP_ID}" "sending|true"
assert_sql "conv5 no existe aun en el tick principal" \
  "SELECT count(*) FROM follow_ups WHERE conversation_id = 5" "0"

# -- Tick 1b (11:06): el item ya reclamado NO se vuelve a claim (idempotencia).
run_sql_file /tmp/followup-claim-tick1b.sql
assert_sql "segundo tick no re-claima (token estable)" \
  "SELECT count(*) FROM follow_ups WHERE id = ${FOLLOWUP_ID} AND claim_token::text = '${TOKEN}'" "1"
assert_sql "cuatro claims en vuelo (conv1/2/3/4) y ninguno duplicado" \
  "SELECT count(*) FROM follow_ups WHERE estado = 'sending'" "4"

# -- Apply sent -> estado sent, attempt 1, audit.
sed -i "s/__FID1__/${FOLLOWUP_ID}/; s/__TOKEN1__/${TOKEN}/" /tmp/followup-apply-sent1.sql
run_sql_file /tmp/followup-apply-sent1.sql
expect_out "apply sent step1" /tmp/followup-run.out "sent"
assert_sql "step1 sent exactamente una vez" \
  "SELECT estado || '|' || send_attempt_count || '|' || (sent_at IS NOT NULL)::text FROM follow_ups WHERE id = ${FOLLOWUP_ID}" "sent|1|true"
assert_sql "delivery_log registra el envio" \
  "SELECT jsonb_array_length(delivery_log) FROM follow_ups WHERE id = ${FOLLOWUP_ID}" "1"
assert_sql "audit follow_up_send sent" \
  "SELECT count(*) FROM audit_logs WHERE event_name = 'follow_up_send' AND entity_id = ${FOLLOWUP_ID}" "1"

# -- Replay del apply (mismo claim): already_sent, no re-envia.
run_sql_file /tmp/followup-apply-sent1.sql
expect_out "replay apply no re-envia" /tmp/followup-run.out "already_sent"
assert_sql "no duplica el envio en replay" \
  "SELECT send_attempt_count FROM follow_ups WHERE id = ${FOLLOWUP_ID}" "1"

# -- Avance de cadencia: siguiente step 3 (idempotente: conv1 ya no tiene 3,
#    pero el fixture scheduler lo agenda con el 04).
python3 - <<'PY'
from pathlib import Path
q = Path('db/queries/n8n/follow-up-pipeline/04_schedule_next_step.sql').read_text()
def lit(v):
    if v is None: return 'NULL'
    if v is True: return 'TRUE'
    if v is False: return 'FALSE'
    if isinstance(v, str): return "'" + v.replace("'", "''") + "'"
    if isinstance(v, (int, float)): return str(v)
    raise TypeError(v)
def render(template, values):
    text = template
    for key in sorted(values, key=len, reverse=True):
        text = text.replace(':' + key, lit(values[key]))
    return text
Path('/tmp/followup-next-3.sql').write_text(render(q, {
    'conversation_id': 1, 'opportunity_id': 1, 'phone_number': '56912345678',
    'source_number_id': 1, 'motivo': 'cotizacion_lead', 'step_dia': 3,
    'scheduled_at': '2026-08-10T11:00:00', 'previous_id': 1,
}))
PY
run_sql_file /tmp/followup-next-3.sql
expect_out "next step 3 agendado" /tmp/followup-run.out "next_scheduled"
run_sql_file /tmp/followup-next-3.sql
expect_out "next step 3 idempotente" /tmp/followup-run.out "duplicate_skipped"

# -- Cancelacion por respuesta del cliente (conv2).
python3 - <<'PY'
from pathlib import Path
q = Path('db/queries/n8n/follow-up-pipeline/05_cancel_pending_follow_ups.sql').read_text()
def lit(v):
    if v is None: return 'NULL'
    if v is True: return 'TRUE'
    if v is False: return 'FALSE'
    if isinstance(v, str): return "'" + v.replace("'", "''") + "'"
    if isinstance(v, (int, float)): return str(v)
    raise TypeError(v)
def render(template, values):
    text = template
    for key in sorted(values, key=len, reverse=True):
        text = text.replace(':' + key, lit(values[key]))
    return text
Path('/tmp/followup-cancel-2.sql').write_text(render(q, {
    'conversation_id': 2, 'cancel_reason': 'client_replied', 'lost_reason': '', 'lost_step_dia': '',
}))
Path('/tmp/followup-cancel-3.sql').write_text(render(q, {
    'conversation_id': 3, 'cancel_reason': 'lost', 'lost_reason': 'ya no me interesa', 'lost_step_dia': 1,
}))
Path('/tmp/followup-cancel-2b.sql').write_text(render(q, {
    'conversation_id': 2, 'cancel_reason': 'client_replied', 'lost_reason': '', 'lost_step_dia': '',
}))
PY
run_sql_file /tmp/followup-cancel-2.sql
expect_out "cancela pendientes conv2" /tmp/followup-run.out "cancelled"
assert_sql "conv2 ambos steps cancelados" \
  "SELECT count(*) FROM follow_ups WHERE conversation_id = 2 AND estado = 'cancelled'" "2"
assert_sql "conv2 steps futuros (3) tambien cancelados" \
  "SELECT count(*) FROM follow_ups WHERE conversation_id = 2 AND step_dia = 3 AND estado = 'cancelled'" "1"
run_sql_file /tmp/followup-cancel-2b.sql
expect_out "cancelar de nuevo es idempotente" /tmp/followup-run.out "already_cancelled"

run_sql_file /tmp/followup-cancel-3.sql
assert_sql "conv3 cancelada con lost_reason" \
  "SELECT estado || '|' || COALESCE(lost_reason, '') || '|' || COALESCE(lost_step_dia::text, '') FROM follow_ups WHERE conversation_id = 3 AND step_dia = 1" "cancelled|ya no me interesa|1"

# -- Opt-out definitivo (conv4).
python3 - <<'PY'
from pathlib import Path
q = Path('db/queries/n8n/follow-up-pipeline/06_apply_opt_out.sql').read_text()
def lit(v):
    if v is None: return 'NULL'
    if v is True: return 'TRUE'
    if v is False: return 'FALSE'
    if isinstance(v, str): return "'" + v.replace("'", "''") + "'"
    if isinstance(v, (int, float)): return str(v)
    raise TypeError(v)
def render(template, values):
    text = template
    for key in sorted(values, key=len, reverse=True):
        text = text.replace(':' + key, lit(values[key]))
    return text
Path('/tmp/followup-opt-4.sql').write_text(render(q, {
    'conversation_id': 4, 'source_text': 'no me escribas mas',
}))
PY
run_sql_file /tmp/followup-opt-4.sql
expect_out "opt-out aplica" /tmp/followup-run.out "opted_out"
assert_sql "conv4 opted_out + flag" \
  "SELECT estado || '|' || opted_out::text FROM follow_ups WHERE conversation_id = 4 AND step_dia = 1" "opted_out|true"

# -- Ventana: conv5 fuera de la franja actual -> skip log + reintento en franja.
python3 - <<'PY'
from pathlib import Path
q1 = Path('db/queries/n8n/follow-up-pipeline/01_schedule_follow_up.sql').read_text()
q2 = Path('db/queries/n8n/follow-up-pipeline/02_claim_due_follow_ups.sql').read_text()
q = Path('db/queries/n8n/follow-up-pipeline/07_log_window_skip.sql').read_text()
def lit(v):
    if v is None: return 'NULL'
    if isinstance(v, str): return "'" + v.replace("'", "''") + "'"
    if isinstance(v, (int, float)): return str(v)
    raise TypeError(v)
def render(template, values):
    text = template
    for key in sorted(values, key=len, reverse=True):
        text = text.replace(':' + key, lit(values[key]))
    return text
Path('/tmp/followup-sched-5.sql').write_text(render(q1, {
    'conversation_id': 5, 'opportunity_id': '', 'phone_number': '56955555555',
    'source_number_id': 1, 'motivo': 'cotizacion_lead', 'step_dia': 1,
    'scheduled_at': '2026-08-08T07:30:00',
}))
## Tick FUERA de la franja (07:31): no reclama nada (0 filas, sin error).
Path('/tmp/followup-claim-off.sql').write_text(render(q2, {
    'batch_size': 50, 'window_start': '09:00', 'window_end': '20:00',
    'now': '2026-08-08T07:31:00', 'claim_stale_seconds': 300,
}))
Path('/tmp/followup-window-5.sql').write_text(render(q, {
    'window_start': '09:00', 'window_end': '20:00', 'now': '2026-08-08T07:31:00',
}))
Path('/tmp/followup-window-5b.sql').write_text(render(q, {
    'window_start': '09:00', 'window_end': '20:00', 'now': '2026-08-08T07:32:00',
}))
PY
run_sql_file /tmp/followup-sched-5.sql
expect_out "conv5 agendada 07:30" /tmp/followup-run.out "scheduled"
run_sql_file /tmp/followup-claim-off.sql
assert_sql "tick fuera de franja no reclama nada" \
  "SELECT count(*) FROM follow_ups WHERE conversation_id = 5 AND estado = 'sending'" "0"
run_sql_file /tmp/followup-window-5.sql
expect_out "skip de ventana registrado" /tmp/followup-run.out "skipped_window"
assert_sql "audit skipped_window" \
  "SELECT count(*) FROM audit_logs WHERE event_name = 'follow_up_skipped_window'" "1"
run_sql_file /tmp/followup-window-5b.sql
expect_out "segundo skip no spamea (en 1h no repite)" /tmp/followup-run.out "in_window"

# -- Dentro de la franja (10:00) conv5 si se reclama y se envia.
python3 - <<'PY'
from pathlib import Path
q = Path('db/queries/n8n/follow-up-pipeline/02_claim_due_follow_ups.sql').read_text()
def lit(v):
    if v is None: return 'NULL'
    if isinstance(v, str): return "'" + v.replace("'", "''") + "'"
    if isinstance(v, (int, float)): return str(v)
    raise TypeError(v)
def render(template, values):
    text = template
    for key in sorted(values, key=len, reverse=True):
        text = text.replace(':' + key, lit(values[key]))
    return text
Path('/tmp/followup-claim-5.sql').write_text(render(q, {
    'batch_size': 50, 'window_start': '09:00', 'window_end': '20:00',
    'now': '2026-08-08T10:00:00', 'claim_stale_seconds': 300,
}))
PY
run_sql_file /tmp/followup-claim-5.sql
assert_sql "conv5 reclamada en la franja" \
  "SELECT estado FROM follow_ups WHERE conversation_id = 5 AND step_dia = 1" "sending"
assert_sql "conv4 opted_out nunca se reclama" \
  "SELECT count(*) FROM follow_ups WHERE conversation_id = 4 AND estado = 'sending'" "0"
assert_sql "tras la franja solo conv5 queda reclamada (las demas sent/cancelled/opted_out)" \
  "SELECT count(*) FROM follow_ups WHERE estado = 'sending'" "1"

# ---------------------------------------------------------------------------
echo
echo "Follow-up cadence local tests OK: scheduling idempotente + claim unico por step + envio una sola vez + avance 1->3 + cancelaciones (client_replied/lost) + opt-out definitivo + skip de ventana con reintento en franja"
echo "Resumen SQL: ${PASS} PASS / ${FAIL} FAIL"
[ "$FAIL" -eq 0 ] || exit 1
