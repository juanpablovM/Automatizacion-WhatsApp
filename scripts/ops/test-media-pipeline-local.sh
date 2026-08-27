#!/bin/sh
set -eu

ROOT_DIR=$(CDPATH= cd -- "$(dirname "$0")/../.." && pwd)
cd "$ROOT_DIR"

node tests/scripts/sync-workflow-nodes.mjs --check >/dev/null
jq empty n8n/workflows/wa-inbound-downstream-dispatcher.json
jq empty n8n/workflows/ops-media-download-scheduler.json

TMP_DIR=$(mktemp -d)
export U5_TEST_DIR="$TMP_DIR/storage"
POSTGRES_CONTAINER="${PROJECT_NAME:-crm-whatsapp-automatizado}-postgres"
TEST_DB="crm_whatsapp_media_${$}"

cleanup() {
  docker exec "$POSTGRES_CONTAINER" psql -U postgres -d postgres \
    -c "DROP DATABASE IF EXISTS ${TEST_DB} WITH (FORCE)" >/dev/null 2>&1 || true
  rm -rf "$TMP_DIR"
}
trap cleanup EXIT

node <<'NODE'
const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const {
  mediaScopeFor,
} = require('./tests/fixtures/workflow-nodes/wa-inbound-downstream-dispatcher/ensure-media-attachment.js');
const {
  downloadAndPersistMedia,
  persistAtomic,
} = require('./tests/fixtures/workflow-nodes/ops-media-download-scheduler/download-and-persist-media.js');

const dispatcher = JSON.parse(fs.readFileSync('n8n/workflows/wa-inbound-downstream-dispatcher.json'));
const scheduler = JSON.parse(fs.readFileSync('n8n/workflows/ops-media-download-scheduler.json'));
const links = JSON.parse(fs.readFileSync('n8n/workflow-links.json'));
const schedulerId = '99999999-0000-0000-0000-000000000004';
assert.equal(scheduler.id, schedulerId);
assert.equal(scheduler.active, true);
assert(scheduler.nodes.some((node) => node.type === 'n8n-nodes-base.scheduleTrigger'));
assert(scheduler.nodes.some((node) => node.type === 'n8n-nodes-base.executeWorkflowTrigger'));
const dispatchNode = dispatcher.nodes.find((node) => node.name === 'Dispatch Media Download Workflow');
assert(dispatchNode && dispatchNode.parameters.workflowId.value === schedulerId);
assert(links.links.some((link) => link.node === 'Dispatch Media Download Workflow' && link.targetWorkflow === scheduler.name));
assert(!dispatcher.nodes.some((node) => ['Prepare Media Download', 'Dispatch Media Download', 'Mark Media Download'].includes(node.name)));

for (const node of [
  dispatcher.nodes.find((entry) => entry.name === 'Upsert Media Attachment'),
  scheduler.nodes.find((entry) => entry.name === 'Claim Due Media Downloads'),
  scheduler.nodes.find((entry) => entry.name === 'Complete Media Download'),
]) {
  assert(node.parameters.options.queryReplacement, `${node.name} lacks queryReplacement`);
  assert(/\$1/.test(node.parameters.query), `${node.name} lacks positional SQL`);
  assert(!/(?<!:):[A-Za-z_]\w*/.test(node.parameters.query), `${node.name} still has named placeholders`);
}

const workerSource = scheduler.nodes.find((node) => node.name === 'Download and Persist Media').parameters.jsCode;
assert(!workerSource.includes('media_backend'));
assert(!workerSource.includes('row.external_url'));
assert(workerSource.includes('/chat/getBase64FromMediaMessage/'));

const rawPayload = { data: { key: { id: 'MSG-1' }, message: { imageMessage: { mediaKey: 'secret' } } } };
const inbound = mediaScopeFor({
  conversation_id: 1,
  inbound_event_id: 1,
  source_number_id: 1,
  instance_name: 'wahormiglass',
  external_message_id: 'MSG-1',
  external_media_id: 'MEDIA-1',
  external_url: 'https://attacker.invalid/never-fetched',
  attachment_type: 'image',
  mime_type: 'image/png',
  filename: 'photo.png',
  file_size: 5,
  raw_payload_json: JSON.stringify(rawPayload),
});
assert.equal(inbound.media_scope.download_state, 'pending');
assert.deepEqual(inbound.media_scope.raw_payload, rawPayload);
assert.equal(inbound.media_scope.media_key, 'MEDIA-1');
assert.equal(mediaScopeFor({ attachment_type: 'image', raw_payload_json: '{broken' }).media_scope.rejected_reason, 'raw_payload_invalid');
assert.equal(mediaScopeFor({ attachment_type: 'sticker' }).media_scope.download_state, 'rejected');
assert.equal(mediaScopeFor({ attachment_type: 'image', file_size: 101 }, { MEDIA_MAX_BYTES_IMAGE: '100' }).media_scope.rejected_reason, 'oversized_declared');

const bytes = Buffer.from('real-media-bytes');
const expectedHash = crypto.createHash('sha256').update(bytes).digest('hex');
const row = {
  media_id: 1,
  claim_token: '00000000-0000-0000-0000-000000000001',
  instance_name: 'wahormiglass',
  attachment_type: 'image',
  mime_type: 'image/png',
  max_bytes: 1024,
  raw_payload: rawPayload,
  expected_sha256: Buffer.from(expectedHash, 'hex').toString('base64'),
};
const env = {
  EVOLUTION_API_BASE_URL: 'http://evolution-api:8080',
  EVOLUTION_API_KEY: 'secret-key',
  MEDIA_STORAGE_ROOT: '/data/media',
};

(async () => {
  let request;
  const testRoot = process.env.U5_TEST_DIR;
  const persistForTest = (payload, hash, _configuredRoot, claimToken) => persistAtomic(payload, hash, testRoot, claimToken);
  const downloaded = await downloadAndPersistMedia(row, env, async (options) => {
    request = options;
    return { statusCode: 200, body: { base64: bytes.toString('base64'), mimetype: 'image/png' } };
  }, persistForTest);
  assert.equal(request.url, 'http://evolution-api:8080/chat/getBase64FromMediaMessage/wahormiglass');
  assert.equal(request.headers.apikey, 'secret-key');
  assert.deepEqual(request.body, { message: rawPayload.data });
  assert(!JSON.stringify(request).includes('attacker.invalid'));
  assert.equal(downloaded.media_outcome, 'downloaded');
  assert.equal(downloaded.media_sha256, expectedHash);
  const physical = path.join(testRoot, downloaded.media_storage_path);
  assert.deepEqual(fs.readFileSync(physical), bytes);
  assert.equal(fs.statSync(physical).mode & 0o777, 0o600);
  const replay = await downloadAndPersistMedia({ ...row, expected_sha256: expectedHash.toUpperCase() }, env, async () => ({ statusCode: 200, body: { base64: bytes.toString('base64'), mimetype: 'image/png' } }), persistForTest);
  assert.equal(replay.media_storage_path, downloaded.media_storage_path);

  assert.equal((await downloadAndPersistMedia(row, { ...env, EVOLUTION_API_KEY: '__PENDIENTE__' }, async () => { throw new Error('must not call'); })).media_outcome, 'deferred');
  assert.equal((await downloadAndPersistMedia(row, env, async () => ({ statusCode: 401, body: {} }))).media_outcome, 'deferred');
  assert.equal((await downloadAndPersistMedia(row, env, async () => ({ statusCode: 404, body: {} }))).media_outcome, 'expired');
  assert.equal((await downloadAndPersistMedia(row, env, async () => ({ statusCode: 429, body: {} }))).media_outcome, 'failed');
  assert.equal((await downloadAndPersistMedia(row, env, async () => { throw new Error('timeout'); })).media_outcome, 'failed');
  assert.equal((await downloadAndPersistMedia({ ...row, max_bytes: 2 }, env, async () => ({ statusCode: 200, body: { base64: bytes.toString('base64'), mimetype: 'image/png' } }))).media_error, 'oversized_encoded');
  assert.equal((await downloadAndPersistMedia(row, env, async () => ({ statusCode: 200, body: { base64: 'not-base64', mimetype: 'image/png' } }))).media_error, 'invalid_base64');
  assert.equal((await downloadAndPersistMedia(row, env, async () => ({ statusCode: 200, body: { base64: bytes.toString('base64'), mimetype: 'application/pdf' } }))).media_error, 'mime_category_mismatch');
  assert.equal((await downloadAndPersistMedia({ ...row, expected_sha256: '0'.repeat(64) }, env, async () => ({ statusCode: 200, body: { base64: bytes.toString('base64'), mimetype: 'image/png' } }))).media_error, 'sha256_mismatch');
  assert.equal((await downloadAndPersistMedia({ ...row, expected_sha256: 'not-a-sha256' }, env, async () => { throw new Error('must not call'); })).media_error, 'expected_sha256_invalid');
  console.log('Media workflow and Evolution transport contract: PASS');
})().catch((error) => { console.error(error); process.exit(1); });
NODE

if grep -R -E "mark_media_attached\(" n8n/workflows/*.json >/dev/null 2>&1; then
  echo 'U4 gate failed: workflow invokes mark_media_attached' >&2
  exit 1
fi

docker exec "$POSTGRES_CONTAINER" psql -U postgres -d postgres -v ON_ERROR_STOP=1 \
  -c "CREATE DATABASE ${TEST_DB}" >/dev/null
for migration in \
  infra/postgres/migrations/00[1-7]_*.sql \
  infra/postgres/migrations/012_create_media_attachments.sql \
  infra/postgres/migrations/016_harden_media_download_delivery.sql; do
  docker exec -i "$POSTGRES_CONTAINER" psql -U postgres -d "$TEST_DB" -v ON_ERROR_STOP=1 < "$migration" >/dev/null
done
docker exec -i "$POSTGRES_CONTAINER" psql -U postgres -d "$TEST_DB" -v ON_ERROR_STOP=1 >/dev/null <<'SQL'
INSERT INTO conversation_statuses (code, label, description, sort_order, is_active)
VALUES ('active', 'Active', 'Active', 10, TRUE) ON CONFLICT (code) DO NOTHING;
INSERT INTO whatsapp_numbers (display_name, phone_number, phone_number_id) VALUES ('Main', '+56900000000', 'pn-main');
INSERT INTO conversations (phone_number, source_number_id, conversation_status_id)
SELECT '56912345678', 1, id FROM conversation_statuses WHERE code='active';
INSERT INTO inbound_events (instance_name, external_message_id, phone_number, source_number_id, event_type, normalized_event, dedupe_key, queue_key, processing_status, event_fingerprint)
VALUES ('wahormiglass', 'MSG-1', '56912345678', 1, 'MESSAGES_UPSERT', 'MESSAGES_UPSERT', 'id:MSG-1', '1:56912345678', 'processed', md5('MSG-1'));
SQL

make_upsert_sql() {
  output=$1
  media_key=$2
  message_id=$3
  {
    printf '%s\n' 'PREPARE media_upsert(boolean,text,text,text,bigint,bigint,bigint,text,text,text,text,text,bigint,text,text,text,text,bigint,text,text) AS'
    cat db/queries/n8n/media-pipeline/01_upsert_media_attachment.sql
    printf "; EXECUTE media_upsert(TRUE,'%s','https://attacker.invalid/metadata','%s',1,1,1,'wahormiglass','56912345678','image','image/png','photo.png',16,'pending','','media:%s',\$json\${\"data\":{\"key\":{\"id\":\"%s\"}}}\$json\$,1024,'',\$json\${\"conversation_id\":1}\$json\$);\n" "$media_key" "$message_id" "$media_key" "$message_id"
  } > "$output"
}
make_upsert_sql "$TMP_DIR/upsert-a.sql" MEDIA-A MSG-A
make_upsert_sql "$TMP_DIR/upsert-b.sql" MEDIA-B MSG-B
docker exec -i "$POSTGRES_CONTAINER" psql -U postgres -d "$TEST_DB" -v ON_ERROR_STOP=1 < "$TMP_DIR/upsert-a.sql" >/dev/null
docker exec -i "$POSTGRES_CONTAINER" psql -U postgres -d "$TEST_DB" -v ON_ERROR_STOP=1 < "$TMP_DIR/upsert-b.sql" >/dev/null

make_claim_sql() {
  {
    printf '%s\n' 'PREPARE media_claim(integer,integer) AS'
    cat db/queries/n8n/media-pipeline/02_claim_due_downloads.sql
    printf '%s\n' '; EXECUTE media_claim(1,900);'
  } > "$1"
}
make_claim_sql "$TMP_DIR/claim-a.sql"
make_claim_sql "$TMP_DIR/claim-b.sql"
docker exec -i "$POSTGRES_CONTAINER" psql -U postgres -d "$TEST_DB" -At -F '|' -v ON_ERROR_STOP=1 < "$TMP_DIR/claim-a.sql" > "$TMP_DIR/claim-a.out" & p1=$!
docker exec -i "$POSTGRES_CONTAINER" psql -U postgres -d "$TEST_DB" -At -F '|' -v ON_ERROR_STOP=1 < "$TMP_DIR/claim-b.sql" > "$TMP_DIR/claim-b.out" & p2=$!
wait "$p1"; wait "$p2"
row_a=$(grep '|' "$TMP_DIR/claim-a.out" | tail -n1)
row_b=$(grep '|' "$TMP_DIR/claim-b.out" | tail -n1)
[ -n "$row_a" ] && [ -n "$row_b" ]
[ "$(printf '%s' "$row_a" | cut -d'|' -f1)" != "$(printf '%s' "$row_b" | cut -d'|' -f1)" ]

complete_row() {
  row=$1 outcome=$2 error=$3 sha=${4:-} bytes=${5:-} storage=${6:-}
  media_id=$(printf '%s' "$row" | cut -d'|' -f1)
  token=$(printf '%s' "$row" | cut -d'|' -f2)
  {
    printf '%s\n' 'PREPARE media_complete(bigint,uuid,text,text,text,text,text,text,text) AS'
    cat db/queries/n8n/media-pipeline/03_complete_download.sql
    printf "; EXECUTE media_complete(%s,'%s','%s','%s','%s','%s','%s','%s','200');\n" "$media_id" "$token" "$outcome" "$sha" "$bytes" "$storage" "sha256:$sha" "$error"
  } | docker exec -i "$POSTGRES_CONTAINER" psql -U postgres -d "$TEST_DB" -v ON_ERROR_STOP=1 >/dev/null
}

assert_sql() {
  actual=$(docker exec "$POSTGRES_CONTAINER" psql -U postgres -d "$TEST_DB" -Atqc "$1")
  [ "$actual" = "$2" ] || { echo "Assertion failed: $1 expected=$2 actual=$actual" >&2; exit 1; }
}

sha=31f5e80e4f1717f7b19547822fd63fdd2c5f49e6dc8f5bdf0f00b57d14f58c17
complete_row "$row_a" downloaded '' "$sha" 16 "media/31/$sha"
complete_row "$row_b" deferred configuration_missing
assert_sql "SELECT count(*) FROM media_attachments WHERE download_state='downloaded' AND attach_pending AND attached_to IS NULL" "1"
assert_sql "SELECT retry_count || '|' || download_state::text FROM media_attachments WHERE download_state='pending'" "0|pending"

# Retry and exhaustion: reuse deferred row, force due, and spend three real attempts.
pending_id=$(docker exec "$POSTGRES_CONTAINER" psql -U postgres -d "$TEST_DB" -Atqc "SELECT id FROM media_attachments WHERE download_state='pending'")
pending_message=$(docker exec "$POSTGRES_CONTAINER" psql -U postgres -d "$TEST_DB" -Atqc "SELECT message_id FROM media_attachments WHERE id=$pending_id")
i=1
while [ "$i" -le 3 ]; do
  docker exec "$POSTGRES_CONTAINER" psql -U postgres -d "$TEST_DB" -c "UPDATE media_attachments SET next_retry_at=NOW() WHERE id=$pending_id" >/dev/null
  make_claim_sql "$TMP_DIR/retry-$i.sql"
  docker exec -i "$POSTGRES_CONTAINER" psql -U postgres -d "$TEST_DB" -At -F '|' -v ON_ERROR_STOP=1 < "$TMP_DIR/retry-$i.sql" > "$TMP_DIR/retry-$i.out"
  retry_row=$(grep '|' "$TMP_DIR/retry-$i.out" | tail -n1)
  complete_row "$retry_row" failed timeout
  i=$((i + 1))
done
assert_sql "SELECT download_state::text || '|' || retry_count || '|' || message_id FROM media_attachments WHERE id=$pending_id" "exhausted|3|$pending_message"

# Stale downloading claims are recovered and become safely reclaimable.
make_upsert_sql "$TMP_DIR/upsert-stale.sql" MEDIA-STALE MSG-STALE
docker exec -i "$POSTGRES_CONTAINER" psql -U postgres -d "$TEST_DB" -v ON_ERROR_STOP=1 < "$TMP_DIR/upsert-stale.sql" >/dev/null
make_claim_sql "$TMP_DIR/stale-first.sql"
docker exec -i "$POSTGRES_CONTAINER" psql -U postgres -d "$TEST_DB" -At -F '|' -v ON_ERROR_STOP=1 < "$TMP_DIR/stale-first.sql" > "$TMP_DIR/stale-first.out"
stale_id=$(grep '|' "$TMP_DIR/stale-first.out" | tail -n1 | cut -d'|' -f1)
docker exec "$POSTGRES_CONTAINER" psql -U postgres -d "$TEST_DB" -c "UPDATE media_attachments SET locked_at=NOW()-INTERVAL '1 hour' WHERE id=$stale_id" >/dev/null
make_claim_sql "$TMP_DIR/stale-recover.sql"
docker exec -i "$POSTGRES_CONTAINER" psql -U postgres -d "$TEST_DB" -At -F '|' -v ON_ERROR_STOP=1 < "$TMP_DIR/stale-recover.sql" >/dev/null
assert_sql "SELECT download_state::text FROM media_attachments WHERE id=$stale_id" "failed"
make_claim_sql "$TMP_DIR/stale-reclaim.sql"
docker exec -i "$POSTGRES_CONTAINER" psql -U postgres -d "$TEST_DB" -At -F '|' -v ON_ERROR_STOP=1 < "$TMP_DIR/stale-reclaim.sql" > "$TMP_DIR/stale-reclaim.out"
[ "$(grep '|' "$TMP_DIR/stale-reclaim.out" | tail -n1 | cut -d'|' -f1)" = "$stale_id" ]

# A terminal row cannot be changed by a stale/replayed completion token.
downloaded_id=$(docker exec "$POSTGRES_CONTAINER" psql -U postgres -d "$TEST_DB" -Atqc "SELECT id FROM media_attachments WHERE download_state='downloaded'")
downloaded_message=$(docker exec "$POSTGRES_CONTAINER" psql -U postgres -d "$TEST_DB" -Atqc "SELECT message_id FROM media_attachments WHERE id=$downloaded_id")
assert_sql "SELECT message_id || '|' || download_state::text FROM media_attachments WHERE id=$downloaded_id" "$downloaded_message|downloaded"

echo 'Media pipeline local tests OK: Evolution-only transport + real bytes/hash + positional SQL + durable claim/retry/stale recovery + U4 gate'
