#!/bin/sh
set -eu

# =============================================================================
# test-media-pipeline-local.sh — Harness local y determinista (sin red) para la
# Unidad 5 (alcance ajustado): pipeline de fotos/archivos reales (A-009).
# -----------------------------------------------------------------------------
# Cubre en 2 capas:
#   1. Nodos (Ensure Media Attachment / Prepare / Dispatch): politica de tipo y
#      tamano, allowlist de host, descarga stub con hash SHA-256 real,
#      expiracion/fallo deterministas. Sin BD.
#   2. Persistencia (01_upsert_media_attachment / 02_apply_download_result):
#      pending -> downloaded/failed/expired/rejected/exhausted, idempotencia
#      (duplicate_count), backoff, mensaje preservado, audit. BD temporal.
# Gate de extension ClickUp (CR-014 PENDIENTE): el harness verifica que
# `mark_media_attached` NO es invocado por ningun workflow y que la media
# descargada queda attach_pending=true con attached_to=NULL.
# =============================================================================

ROOT_DIR=$(CDPATH= cd -- "$(dirname "$0")/../.." && pwd)
cd "$ROOT_DIR"

if ! node tests/scripts/sync-workflow-nodes.mjs --check >/dev/null 2>&1; then
  echo "ERROR: los nodos de workflow divergen de los fixtures de tests/fixtures/workflow-nodes/" >&2
  echo "Ejecuta: node tests/scripts/sync-workflow-nodes.mjs" >&2
  exit 1
fi

POSTGRES_CONTAINER="${PROJECT_NAME:-crm-whatsapp-automatizado}-postgres"
TEST_DB="crm_whatsapp_media_${$}"
DB_SQL_DIR="$(mktemp -d)"

cleanup() {
  docker exec "$POSTGRES_CONTAINER" psql -U postgres -d postgres \
    -c "DROP DATABASE IF EXISTS ${TEST_DB} WITH (FORCE)" >/dev/null 2>&1 || true
  rm -rf "$DB_SQL_DIR"
  rm -f /tmp/media-*.sql /tmp/media-*.out
}
trap cleanup EXIT

# ---------------------------------------------------------------------------
# Capa 1: decisiones puras de los nodos (vm, sin red).
# ---------------------------------------------------------------------------
node <<'NODE'
(async () => {
  const fs = require('fs');
  const crypto = require('crypto');
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
    instance_name: 'wahormiglass',
    external_message_id: 'MSG-MEDIA-001',
    media_key: '3EB0BA9876',
    external_url: 'https://evo.internal.crm/media/file/3EB0BA9876',
    attachment_type: 'image',
    mime_type: 'image/jpeg',
    filename: 'pastelon.jpg',
    file_size: 512000,
  };

  const noMedia = await runNode('Ensure Media Attachment', { ...baseRow, attachment_type: null, media_key: null, external_url: null });
  expectEqual(noMedia.media_skipped, true, 'sin media -> skipped');
  expectEqual(noMedia.media_write, false, 'sin media -> no escribe');

  const imageOk = await runNode('Ensure Media Attachment', baseRow);
  expectEqual(imageOk.media_write, true, 'imagen recibida -> escribe registro');
  expectEqual(imageOk.media_scope.download_state, 'pending', 'imagen OK -> pending (se descargara)');
  expectEqual(imageOk.media_scope.policy.allowed_download, true, 'imagen dentro de limites -> download permitido');
  expectEqual(imageOk.media_scope.dedupe_key, 'media:3EB0BA9876', 'dedupe key por media_key');
  expectEqual(imageOk.media_scope.attached_to, null, 'attached_to NULL (ClickUp pendiente)');

  const sticker = await runNode('Ensure Media Attachment', { ...baseRow, attachment_type: 'sticker', mime_type: 'image/webp' });
  expectEqual(sticker.media_scope.download_state, 'rejected', 'sticker -> rejected');
  expectEqual(sticker.media_scope.rejected_reason, 'unsupported_type', 'sticker -> motivo unsupported_type');

  const oversized = await runNode('Ensure Media Attachment', baseRow, { MEDIA_MAX_BYTES_IMAGE: '100' });
  expectEqual(oversized.media_scope.download_state, 'rejected', 'imagen > limite -> rejected');
  expectEqual(oversized.media_scope.rejected_reason, 'oversized_declared', 'imagen > limite -> motivo oversized_declared');

  const foreignHost = await runNode('Ensure Media Attachment', {
    ...baseRow,
    external_url: 'https://evil.example.com/media/3EB0BA9876',
  }, { MEDIA_ALLOWED_HOSTS: 'evo.internal.crm' });
  expectEqual(foreignHost.media_scope.download_state, 'rejected', 'host externo -> rejected');
  expectEqual(foreignHost.media_scope.rejected_reason, 'host_not_allowed', 'host externo -> motivo host_not_allowed');
  expectEqual(foreignHost.media_scope.url_host_allowed, false, 'allowlist de host evaluada');

  const fixtureBytes = Buffer.from('CRMWA-MEDIA-FIXTURE-BYTES-001', 'utf8');
  const expectedHash = crypto.createHash('sha256').update(fixtureBytes).digest('hex');
  const stubBackend = {
    fetch: (manifest) => ({ status: 200, bytes: fixtureBytes }),
  };

  const prepared = await runNode('Prepare Media Download', { media_scope: imageOk.media_scope, ...imageOk.media_scope });
  expectEqual(prepared.should_download, true, 'pending con intentos -> descargar');
  const dispatched = await runNode('Dispatch Media Download', {
    ...prepared,
    media_backend: stubBackend,
    media_scope: imageOk.media_scope,
  });
  expectEqual(dispatched.media_download.outcome, 'downloaded', 'descarga exitosa');
  expectEqual(dispatched.media_download.sha256, expectedHash, 'hash SHA-256 real determinista del binario fixture');
  expectEqual(dispatched.media_download.bytes_length, fixtureBytes.length, 'bytes descargados correctos');
  assert(/^m-[0-9a-f]{8}$/.test(dispatched.media_download.storage_token), 'storage_token interno (id generico, sin rutas)');
  assert(dispatched.media_download.storage_path.startsWith('media/image/'), 'storage_path relativo interno');

  const downloadedScope = { ...imageOk.media_scope, download_state: 'downloaded', sha256: expectedHash };
  const noRedownload = await runNode('Prepare Media Download', { media_scope: downloadedScope, ...downloadedScope });
  expectEqual(noRedownload.should_download, false, 'ya descargado -> no re-descargar');

  const exhaustedScope = { ...imageOk.media_scope, download_state: 'pending', retry_count: 3, max_retries: 3 };
  const noExhausted = await runNode('Prepare Media Download', { media_scope: exhaustedScope, ...exhaustedScope });
  expectEqual(noExhausted.should_download, false, 'intentos agotados -> no reintentar');

  const expiredBackend = { fetch: () => ({ status: 410, error: 'expired' }) };
  const expired = await runNode('Dispatch Media Download', {
    ...prepared,
    media_backend: expiredBackend,
    media_scope: imageOk.media_scope,
  });
  expectEqual(expired.media_download.outcome, 'expired', 'media vencida (410) -> expired');

  const failedBackend = { fetch: () => { throw new Error('network_timeout'); } };
  const downloadFailed = await runNode('Dispatch Media Download', {
    ...prepared,
    media_backend: failedBackend,
    media_scope: imageOk.media_scope,
  });
  expectEqual(downloadFailed.media_download.outcome, 'failed', 'fallo de red -> failed (reintentable)');
  expectEqual(downloadFailed.media_download.error, 'network_timeout', 'error de fallo conservado');
  expectEqual(downloadFailed.media_download.attempt_spent, true, 'el intento se gasta');

  const oversizedBackend = { fetch: () => ({ status: 200, bytes: Buffer.alloc(200) }) };
  const tinyLimit = await runNode('Prepare Media Download', { media_scope: imageOk.media_scope, ...imageOk.media_scope }, { MEDIA_MAX_BYTES_IMAGE: '100' });
  const oversizedAfter = await runNode('Dispatch Media Download', {
    ...tinyLimit,
    media_backend: oversizedBackend,
    media_scope: imageOk.media_scope,
  });
  expectEqual(oversizedAfter.media_download.outcome, 'rejected', 'binario mayor al limite tras descarga -> rejected');
  expectEqual(oversizedAfter.media_download.rejected_reason, 'oversized_actual', 'motivo oversized_actual');

  const hostBlocked = await runNode('Dispatch Media Download', {
    ...prepared,
    media_backend: { fetch: () => ({ status: 200, bytes: fixtureBytes }) },
    media_scope: { ...imageOk.media_scope, policy: { allowed_download: false, reason: 'host_not_allowed' } },
  });
  expectEqual(hostBlocked.media_download.outcome, 'failed', 'host no permitido -> no se toca backend');

  console.log(`\nPipeline media (capa nodo): ${passed} PASS / ${failed} FAIL`);
  if (failed > 0) process.exit(1);
})().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
NODE

# ---------------------------------------------------------------------------
# Gate de extension ClickUp (CR-014): ningun workflow invoca mark_media_attached.
# ---------------------------------------------------------------------------
if grep -rlE "mark_media_attached\\(" n8n/workflows/*.json >/dev/null 2>&1; then
  echo "ERROR: un workflow referencia mark_media_attached (extension pendiente no debe invocarse)" >&2
  exit 1
fi
echo "Gate extension OK: ningun workflow referencia mark_media_attached"

# ---------------------------------------------------------------------------
# Capa 2: persistencia idempotente y reintentos en BD temporal (docker).
# ---------------------------------------------------------------------------
docker exec "$POSTGRES_CONTAINER" psql -U postgres -d postgres \
  -v ON_ERROR_STOP=1 -c "CREATE DATABASE ${TEST_DB}" >/dev/null

for migration in infra/postgres/migrations/00[1-9]_*.sql; do
  docker exec -i "$POSTGRES_CONTAINER" psql -U postgres -d "$TEST_DB" \
    -v ON_ERROR_STOP=1 < "$migration" >/dev/null
done
docker exec -i "$POSTGRES_CONTAINER" psql -U postgres -d "$TEST_DB" \
  -v ON_ERROR_STOP=1 < infra/postgres/migrations/010_create_opportunities.sql >/dev/null
docker exec -i "$POSTGRES_CONTAINER" psql -U postgres -d "$TEST_DB" \
  -v ON_ERROR_STOP=1 < infra/postgres/migrations/011_create_handoffs.sql >/dev/null
docker exec -i "$POSTGRES_CONTAINER" psql -U postgres -d "$TEST_DB" \
  -v ON_ERROR_STOP=1 < infra/postgres/migrations/012_create_media_attachments.sql >/dev/null
# Re-aplicacion idempotente (mismo estilo 010/011).
docker exec -i "$POSTGRES_CONTAINER" psql -U postgres -d "$TEST_DB" \
  -v ON_ERROR_STOP=1 < infra/postgres/migrations/012_create_media_attachments.sql >/dev/null

docker exec -i "$POSTGRES_CONTAINER" psql -U postgres -d "$TEST_DB" -v ON_ERROR_STOP=1 <<'SQL' 2>&1
INSERT INTO conversation_statuses (code, label, description, sort_order, is_active)
VALUES ('active', 'Activa', 'Conversacion en curso dentro del flujo del bot.', 10, TRUE)
ON CONFLICT (code) DO UPDATE SET label = EXCLUDED.label;
INSERT INTO whatsapp_numbers (display_name, phone_number, phone_number_id)
VALUES ('Main', '+56900000000', 'pn-main');
INSERT INTO conversations (phone_number, source_number_id, conversation_status_id)
SELECT '56912345678', 1, id FROM conversation_statuses WHERE code = 'active';
INSERT INTO inbound_events (instance_name, external_message_id, phone_number, source_number_id, event_type, normalized_event, dedupe_key, queue_key, processing_status, event_fingerprint)
VALUES ('wahormiglass', 'MSG-MEDIA-001', '56912345678', 1, 'MESSAGES_UPSERT', 'MESSAGES_UPSERT', 'id:MSG-MEDIA-001', '1:56912345678', 'processed', md5('wahormiglass|id:MSG-MEDIA-001'));
SQL

expect_out() {
  if ! grep -q "$1" "$2"; then
    echo "OUT MISSING '$1' in $2:" >&2
    cat "$2" >&2
    exit 1
  fi
}

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

assert_sql "SELECT count(*) FROM conversations" "1"
assert_sql "SELECT count(*) FROM inbound_events" "1"
assert_sql "SELECT count(*) FROM whatsapp_numbers" "1"

python3 - <<'PY'
import json
import os
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
upsert_query = next(n for n in dispatcher["nodes"] if n["name"] == "Upsert Media Attachment")["parameters"]["query"]
mark_query = next(n for n in dispatcher["nodes"] if n["name"] == "Mark Media Download")["parameters"]["query"]
upsert_file = Path("db/queries/n8n/media-pipeline/01_upsert_media_attachment.sql").read_text()
mark_file = Path("db/queries/n8n/media-pipeline/02_apply_download_result.sql").read_text()
if upsert_query != upsert_file or mark_query != mark_file:
    raise SystemExit("ERROR: queries embebidos en el dispatcher divergen de db/queries/n8n/media-pipeline/")

def upsert_values(**overrides):
    values = {
        "should_write": True,
        "media_key": "3EB0BA9876",
        "external_url": "https://evo.internal.crm/media/file/3EB0BA9876",
        "message_id": "MSG-MEDIA-001",
        "inbound_event_id": 1,
        "conversation_id": 1,
        "source_number_id": "1",
        "instance_name": "wahormiglass",
        "phone_number": "56912345678",
        "attachment_type": "image",
        "mime_type": "image/jpeg",
        "filename": "pastelon.jpg",
        "file_size": 512000,
        "download_state": "pending",
        "rejected_reason": None,
        "dedupe_key": "media:3EB0BA9876",
    }
    values.update(overrides)
    return values

# 1) Registro entrante -> created (pending).
Path("/tmp/media-1-create.sql").write_text(render(upsert_query, upsert_values()))
# 2) Replay del mismo media -> duplicate_skipped + duplicate_count++.
Path("/tmp/media-2-replay.sql").write_text(render(upsert_query, upsert_values()))
# 3) Sin media (should_write=false) -> no escribe nada.
Path("/tmp/media-3-skip.sql").write_text(render(upsert_query, upsert_values(
    should_write=False, media_key="SKIP-001", external_url="https://evo.internal.crm/media/file/SKIP-001",
    message_id="MSG-MEDIA-000")))
# 4) Sticker rechazado -> rejected pre-descarga con motivo.
Path("/tmp/media-4-reject.sql").write_text(render(upsert_query, upsert_values(
    media_key="STICKER-01", external_url="https://evo.internal.crm/media/file/STICKER-01",
    message_id="MSG-MEDIA-002", attachment_type="sticker", mime_type="image/webp",
    download_state="rejected", rejected_reason="unsupported_type", dedupe_key="media:STICKER-01")))

def mark_values(**overrides):
    values = {
        "media_id": 1,
        "outcome": "downloaded",
        "sha256": "f49f5b4f6f7e1b2a3c4d5e6f708192a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f",
        "storage_path": "media/image/m-3eb0ba9876",
        "storage_token": "m-3eb0ba98",
        "error": None,
    }
    values.update(overrides)
    return values

# 5) Descarga exitosa -> downloaded + hash + attach_pending, attached_to NULL.
Path("/tmp/media-5-downloaded.sql").write_text(render(mark_query, mark_values()))
# 12-14) Registros propios para reintentos, expiracion y rechazo post-descarga.
Path("/tmp/media-12-fail-row.sql").write_text(render(upsert_query, upsert_values(
    media_key="FAIL-01", external_url="https://evo.internal.crm/media/file/FAIL-01",
    message_id="MSG-MEDIA-003", attachment_type="document", mime_type="application/pdf",
    dedupe_key="media:FAIL-01")))
Path("/tmp/media-13-expire-row.sql").write_text(render(upsert_query, upsert_values(
    media_key="EXPIRE-01", external_url="https://evo.internal.crm/media/file/EXPIRE-01",
    message_id="MSG-MEDIA-004", attachment_type="document", mime_type="application/pdf",
    dedupe_key="media:EXPIRE-01")))
Path("/tmp/media-14-oversize-row.sql").write_text(render(upsert_query, upsert_values(
    media_key="OVERSIZE-01", external_url="https://evo.internal.crm/media/file/OVERSIZE-01",
    message_id="MSG-MEDIA-005", attachment_type="document", mime_type="application/pdf",
    file_size=300, dedupe_key="media:OVERSIZE-01")))
# 6) Fallo 1 -> retry_count=1 + next_retry_at futuro.
Path("/tmp/media-6-fail1.sql").write_text(render(mark_query, mark_values(media_id="__FAIL__", outcome="failed", error="network_timeout")))
# 7) Fallo 2 -> retry_count=2.
Path("/tmp/media-7-fail2.sql").write_text(render(mark_query, mark_values(media_id="__FAIL__", outcome="failed", error="network_timeout")))
# 8) Fallo 3 -> exhausted (max_retries 3 consumido).
Path("/tmp/media-8-fail3.sql").write_text(render(mark_query, mark_values(media_id="__FAIL__", outcome="failed", error="network_timeout")))
# 9) Llamada extra -> estado final no cambia (retry_count queda 3).
Path("/tmp/media-9-extra.sql").write_text(render(mark_query, mark_values(media_id="__FAIL__", outcome="failed", error="network_timeout")))
# 10) Expiraccion -> expired (mensaje preservado).
Path("/tmp/media-10-expired.sql").write_text(render(mark_query, mark_values(media_id="__EXPIRE__", outcome="expired", error="media_expired")))
# 11) Rejected post-descarga (oversized_actual).
Path("/tmp/media-11-rejected.sql").write_text(render(mark_query, mark_values(media_id="__OVERSIZE__", outcome="rejected", error="oversized_actual")))
PY

# 1) Registro entrante: pending, metadata y audit 'created'.
docker exec -i "$POSTGRES_CONTAINER" psql -U postgres -d "$TEST_DB" \
  -v ON_ERROR_STOP=1 < /tmp/media-1-create.sql >/tmp/media-1-create.out
expect_out "created" /tmp/media-1-create.out
assert_sql "SELECT count(*) FROM media_attachments WHERE media_key = '3EB0BA9876' AND deleted_at IS NULL" "1"
assert_sql "SELECT download_state::text || '|' || message_id FROM media_attachments WHERE media_key = '3EB0BA9876'" "pending|MSG-MEDIA-001"
assert_sql "SELECT attachment_type || '|' || mime_type || '|' || file_size FROM media_attachments WHERE media_key = '3EB0BA9876'" "image|image/jpeg|512000"
assert_sql "SELECT result FROM audit_logs WHERE event_name = 'media_sync' AND entity_id = 1" "created"

# 2) Replay: no duplica, duplicate_count++ y audit.
docker exec -i "$POSTGRES_CONTAINER" psql -U postgres -d "$TEST_DB" \
  -v ON_ERROR_STOP=1 < /tmp/media-2-replay.sql >/tmp/media-2-replay.out
expect_out "duplicate_skipped" /tmp/media-2-replay.out
assert_sql "SELECT count(*) FROM media_attachments WHERE media_key = '3EB0BA9876' AND deleted_at IS NULL" "1"
assert_sql "SELECT duplicate_count FROM media_attachments WHERE media_key = '3EB0BA9876'" "1"
assert_sql "SELECT result FROM audit_logs WHERE event_name = 'media_sync' AND entity_id = 1 ORDER BY id DESC LIMIT 1" "duplicate_skipped"

# 3) Sin media: no escribe ni audita.
docker exec -i "$POSTGRES_CONTAINER" psql -U postgres -d "$TEST_DB" \
  -v ON_ERROR_STOP=1 < /tmp/media-3-skip.sql >/tmp/media-3-skip.out
assert_sql "SELECT count(*) FROM media_attachments WHERE media_key = 'SKIP-001'" "0"
assert_sql "SELECT count(*) FROM audit_logs WHERE event_name = 'media_sync' AND metadata->>'dedupe_key' = 'url:https://evo.internal.crm/media/file/SKIP-001'" "0"

# 4) Tipo no permitido: rejected pre-descarga con motivo en audit.
docker exec -i "$POSTGRES_CONTAINER" psql -U postgres -d "$TEST_DB" \
  -v ON_ERROR_STOP=1 < /tmp/media-4-reject.sql >/tmp/media-4-reject.out
expect_out "created" /tmp/media-4-reject.out
assert_sql "SELECT download_state::text || '|' || rejected_reason FROM media_attachments WHERE media_key = 'STICKER-01'" "rejected|unsupported_type"
assert_sql "SELECT result FROM audit_logs WHERE event_name = 'media_sync' AND entity_id = 2" "created"

# 5) Descarga exitosa: downloaded + sha256 + storage interno + attach_pending.
docker exec -i "$POSTGRES_CONTAINER" psql -U postgres -d "$TEST_DB" \
  -v ON_ERROR_STOP=1 < /tmp/media-5-downloaded.sql >/tmp/media-5-downloaded.out
expect_out "downloaded" /tmp/media-5-downloaded.out
assert_sql "SELECT download_state::text FROM media_attachments WHERE id = 1" "downloaded"
assert_sql "SELECT sha256 FROM media_attachments WHERE id = 1" "f49f5b4f6f7e1b2a3c4d5e6f708192a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f"
assert_sql "SELECT storage_token || '|' || storage_path FROM media_attachments WHERE id = 1" "m-3eb0ba98|media/image/m-3eb0ba9876"
assert_sql "SELECT attach_pending::text || '|' || COALESCE(attached_to, '') FROM media_attachments WHERE id = 1" "true|"
assert_sql "SELECT result FROM audit_logs WHERE event_name = 'media_download' AND entity_id = 1 ORDER BY id DESC LIMIT 1" "downloaded"

# 6-9) Fallos: retry_count + backoff, max 3 -> exhausted, extra no cambia.
# Primero se crean los registros propios (FAIL/EXPIRE/OVERSIZE) y se resuelven
# sus ids reales (la secuencia puede saltarse -> nunca asumir ids hardcoded).
for row_sql in /tmp/media-12-fail-row.sql /tmp/media-13-expire-row.sql /tmp/media-14-oversize-row.sql; do
  docker exec -i "$POSTGRES_CONTAINER" psql -U postgres -d "$TEST_DB" \
    -v ON_ERROR_STOP=1 < "$row_sql" >/dev/null
done
docker exec "$POSTGRES_CONTAINER" psql -U postgres -d "$TEST_DB" -Atqc "SELECT id || '|' || COALESCE(media_key,'') FROM media_attachments ORDER BY id"
FAIL_ID="$(docker exec "$POSTGRES_CONTAINER" psql -U postgres -d "$TEST_DB" -Atqc \
  "SELECT id FROM media_attachments WHERE media_key = 'FAIL-01' AND deleted_at IS NULL")"
EXPIRE_ID="$(docker exec "$POSTGRES_CONTAINER" psql -U postgres -d "$TEST_DB" -Atqc \
  "SELECT id FROM media_attachments WHERE media_key = 'EXPIRE-01' AND deleted_at IS NULL")"
OVERSIZE_ID="$(docker exec "$POSTGRES_CONTAINER" psql -U postgres -d "$TEST_DB" -Atqc \
  "SELECT id FROM media_attachments WHERE media_key = 'OVERSIZE-01' AND deleted_at IS NULL")"
for sql_file in /tmp/media-6-fail1.sql /tmp/media-7-fail2.sql /tmp/media-8-fail3.sql /tmp/media-9-extra.sql; do
  sed -i "s/'"__FAIL__"'::bigint/${FAIL_ID}::bigint/" "$sql_file"
done
sed -i "s/'"__EXPIRE__"'::bigint/${EXPIRE_ID}::bigint/" /tmp/media-10-expired.sql
sed -i "s/'__OVERSIZE__'::bigint/${OVERSIZE_ID}::bigint/" /tmp/media-11-rejected.sql

docker exec -i "$POSTGRES_CONTAINER" psql -U postgres -d "$TEST_DB" \
  -v ON_ERROR_STOP=1 < /tmp/media-6-fail1.sql >/tmp/media-6-fail1.out
expect_out "failed" /tmp/media-6-fail1.out
assert_sql "SELECT retry_count || '|' || (next_retry_at IS NOT NULL)::text FROM media_attachments WHERE id = ${FAIL_ID}" "1|true"
assert_sql "SELECT last_error FROM media_attachments WHERE id = ${FAIL_ID}" "network_timeout"
docker exec -i "$POSTGRES_CONTAINER" psql -U postgres -d "$TEST_DB" \
  -v ON_ERROR_STOP=1 < /tmp/media-7-fail2.sql >/tmp/media-7-fail2.out
assert_sql "SELECT retry_count FROM media_attachments WHERE id = ${FAIL_ID}" "2"
docker exec -i "$POSTGRES_CONTAINER" psql -U postgres -d "$TEST_DB" \
  -v ON_ERROR_STOP=1 < /tmp/media-8-fail3.sql >/tmp/media-8-fail3.out
expect_out "exhausted" /tmp/media-8-fail3.out
assert_sql "SELECT download_state::text || '|' || retry_count FROM media_attachments WHERE id = ${FAIL_ID}" "exhausted|3"
docker exec -i "$POSTGRES_CONTAINER" psql -U postgres -d "$TEST_DB" \
  -v ON_ERROR_STOP=1 < /tmp/media-9-extra.sql >/tmp/media-9-extra.out
assert_sql "SELECT download_state::text || '|' || retry_count FROM media_attachments WHERE id = ${FAIL_ID}" "exhausted|3"
assert_sql "SELECT message_id FROM media_attachments WHERE id = ${FAIL_ID}" "MSG-MEDIA-003"

# 10) Expiracion: expired terminal, mensaje preservado, audit.
docker exec -i "$POSTGRES_CONTAINER" psql -U postgres -d "$TEST_DB" \
  -v ON_ERROR_STOP=1 < /tmp/media-10-expired.sql >/tmp/media-10-expired.out
expect_out "expired" /tmp/media-10-expired.out
assert_sql "SELECT download_state::text FROM media_attachments WHERE id = ${EXPIRE_ID}" "expired"
assert_sql "SELECT message_id FROM media_attachments WHERE id = ${EXPIRE_ID}" "MSG-MEDIA-004"
assert_sql "SELECT result FROM audit_logs WHERE event_name = 'media_download' AND entity_id = ${EXPIRE_ID} ORDER BY id DESC LIMIT 1" "expired"

# 11) Rejected post-descarga (oversized_actual).
docker exec -i "$POSTGRES_CONTAINER" psql -U postgres -d "$TEST_DB" \
  -v ON_ERROR_STOP=1 < /tmp/media-11-rejected.sql >/tmp/media-11-rejected.out
expect_out "rejected" /tmp/media-11-rejected.out
assert_sql "SELECT download_state::text || '|' || rejected_reason FROM media_attachments WHERE id = ${OVERSIZE_ID}" "rejected|oversized_actual"

# Gate de extension: nunca se adjunta (audit media_attached vacio).
assert_sql "SELECT count(*) FROM audit_logs WHERE event_name = 'media_attached'" "0"
assert_sql "SELECT count(*) FROM media_attachments WHERE attach_pending = TRUE AND attached_to IS NULL" "1"

echo "Media pipeline local tests OK: registro pending + descarga con hash + idempotencia + reintentos (max 3) + expiracion con mensaje preservado + rechazos pre/post descarga + gate ClickUp sin adjuntar"