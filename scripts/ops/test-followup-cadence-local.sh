#!/bin/sh
set -eu
ROOT_DIR=$(CDPATH= cd -- "$(dirname "$0")/../.." && pwd)
cd "$ROOT_DIR"
POSTGRES_CONTAINER=${POSTGRES_CONTAINER:-$(docker ps --format '{{.Names}}' | grep -E 'postgres$' | head -1)}
[ -n "$POSTGRES_CONTAINER" ] || { echo 'Postgres container not found' >&2; exit 1; }
TEST_DB="followup_u6_$$_$(date +%s)"
cleanup() { docker exec "$POSTGRES_CONTAINER" psql -U postgres -d postgres -c "DROP DATABASE IF EXISTS $TEST_DB WITH (FORCE)" >/dev/null 2>&1 || true; }
trap cleanup EXIT INT TERM

node <<'NODE'
const fs=require('fs');
const wf=JSON.parse(fs.readFileSync('n8n/workflows/ops-followup-scheduler.json'));
const outbound=JSON.parse(fs.readFileSync('n8n/workflows/wa-outbound-messages.json'));
const dispatcher=JSON.parse(fs.readFileSync('n8n/workflows/wa-inbound-downstream-dispatcher.json'));
const links=JSON.parse(fs.readFileSync('n8n/workflow-links.json'));
const assert=(v,m)=>{if(!v)throw new Error(m)};
const validate=(w)=>{const names=new Set(w.nodes.map(n=>n.name)); for(const [src,c] of Object.entries(w.connections)){assert(names.has(src),`missing source ${src}`); for(const lane of c.main||[])for(const e of lane){assert(e.node&&names.has(e.node),`broken edge ${src}`)}}};
validate(wf); validate(dispatcher);
assert(wf.active===true && String(wf.id||'').length>0,'scheduler must be active with stable id');
assert(wf.nodes.some(n=>n.type==='n8n-nodes-base.executeWorkflowTrigger'),'manual/subworkflow trigger missing');
const outboundCall=wf.nodes.find(n=>n.name==='Send Via Outbound Rail');
assert(String(outbound.id||'').length>0,'outbound workflow stable id missing');
assert(outboundCall.parameters.workflowId.cachedResultName==='WA - Outbound Messages','outbound target missing');
assert(outboundCall.parameters.workflowId.value===outbound.id,'outbound target id must be explicit and match workflow id');
assert(links.links.some(l=>l.sourceWorkflow===wf.name&&l.node==='Send Via Outbound Rail'&&l.targetWorkflow==='WA - Outbound Messages'),'manifest outbound link missing');
const old=['Follow-Up Opt-Out?','Apply Follow-Up Opt-Out','Cancel Follow-Ups'];
assert(old.every(n=>!dispatcher.nodes.some(x=>x.name===n)),'broken legacy follow-up nodes remain');
assert(dispatcher.connections['Ensure Follow-Up Cancellation'].main[0][0].node==='Apply Inbound Follow-Up Policy','dispatcher policy write disconnected');
for(const file of fs.readdirSync('db/queries/n8n/follow-up-pipeline').filter(f=>f.endsWith('.sql'))){const sql=fs.readFileSync('db/queries/n8n/follow-up-pipeline/'+file,'utf8'); assert(!/(^|[^:]):[a-z_][a-z0-9_]*/im.test(sql),`${file} contains named placeholders`)}
const policy=require('./tests/fixtures/workflow-nodes/wa-inbound-downstream-dispatcher/ensure-follow-up-cancellation.js');
let r=policy.resolveCancellationAction({conversation_id:7,message_id:11,text_body:'hola',response_text:'te ayudo',conversation_status_code:'waiting_user'},new Date('2026-08-08T10:00:00Z'));
assert(r.follow_up_cancel_reason==='client_replied'&&r.follow_up_should_schedule&&r.follow_up_cycle_key==='inbound:11','real inbound payload must cancel and schedule');
r=policy.resolveCancellationAction({conversation_id:7,message_id:12,text_body:'no me escribas mas',response_text:'x',conversation_status_code:'waiting_user'});
assert(r.follow_up_cancel_action==='opt_out'&&!r.follow_up_should_schedule,'opt-out must dominate scheduling');
r=policy.resolveCancellationAction({conversation_id:7,message_id:13,text_body:'',message_type:'image'});
assert(r.follow_up_cancel_reason==='client_replied','media inbound must count as customer reply without fake direction flags');
const normalize=require('./tests/fixtures/workflow-nodes/ops-followup-scheduler/normalize-follow-up-delivery.js').normalizeFollowUpDelivery;
assert(normalize({id:1},{delivery_status:'sent'}).follow_up_outcome==='sent','sent mapping');
assert(normalize({id:1},{delivery_status:'failed'}).follow_up_outcome==='failed','failed mapping');
assert(normalize({id:1},{delivery_status:'unknown'}).follow_up_outcome==='unknown','unknown mapping');
assert(normalize({id:1},{}).follow_up_outcome==='unknown','missing result must never default to sent');
console.log('Follow-up runtime contract: PASS');
NODE

node tests/scripts/sync-workflow-nodes.mjs --check >/dev/null

docker exec "$POSTGRES_CONTAINER" psql -U postgres -d postgres -v ON_ERROR_STOP=1 -c "CREATE DATABASE $TEST_DB" >/dev/null
for migration in infra/postgres/migrations/00[1-7]_*.sql infra/postgres/migrations/010_create_opportunities.sql infra/postgres/migrations/013_create_follow_ups.sql infra/postgres/migrations/017_harden_follow_up_delivery.sql; do
  docker exec -i "$POSTGRES_CONTAINER" psql -U postgres -d "$TEST_DB" -v ON_ERROR_STOP=1 < "$migration" >/dev/null
done
docker exec -i "$POSTGRES_CONTAINER" psql -U postgres -d "$TEST_DB" -v ON_ERROR_STOP=1 < db/seeds/002_conversation_statuses.sql >/dev/null

docker exec -i "$POSTGRES_CONTAINER" psql -U postgres -d "$TEST_DB" -v ON_ERROR_STOP=1 >/dev/null <<'SQL'
INSERT INTO whatsapp_numbers(display_name,phone_number,phone_number_id,instance_name)
VALUES('Main','+56900000000','pn-main','main');
INSERT INTO conversations(phone_number,source_number_id,conversation_status_id)
SELECT p,1,id FROM conversation_statuses CROSS JOIN unnest(ARRAY['56911111111','56922222222','56933333333','56944444444']) p WHERE code='active';
SQL

python3 <<'PY'
from pathlib import Path
import re
Q=Path('db/queries/n8n/follow-up-pipeline')
def lit(v):
 if v is None or v=='': return "''"
 if isinstance(v,bool): return 'TRUE' if v else 'FALSE'
 if isinstance(v,(int,float)): return str(v)
 return "'"+str(v).replace("'","''")+"'"
def render(name, values, out):
 s=(Q/name).read_text()
 for i in range(len(values),0,-1): s=s.replace(f'${i}',lit(values[i-1]))
 Path('/tmp/'+out).write_text(s)
render('05_cancel_pending_follow_ups.sql',[4,'opt_out','opt_out','no me escribas mas','',False,'56944444444',1,'inbound:40','lead_sin_respuesta','2026-08-09T10:00:00Z'],'u6-optout.sql')
render('01_schedule_follow_up.sql',[4,'','56944444444',1,'lead_sin_respuesta',1,'2026-08-09T10:00:00Z','inbound:40'],'u6-blocked.sql')
render('05_cancel_pending_follow_ups.sql',[1,'cancel','client_replied','hola','',True,'56911111111',1,'inbound:10','lead_sin_respuesta','2026-08-08T10:00:00Z'],'u6-policy.sql')
render('02_claim_due_follow_ups.sql',[50,'00:00','23:59','2026-08-08T10:05:00Z',300],'u6-claim.sql')
render('01_schedule_follow_up.sql',[2,'','56922222222',1,'lead_sin_respuesta',1,'2026-08-08T10:00:00Z','inbound:20'],'u6-stale-schedule.sql')
render('01_schedule_follow_up.sql',[3,'','56933333333',1,'lead_sin_respuesta',1,'2026-08-08T10:00:00Z','inbound:30'],'u6-unknown-schedule.sql')
PY
run(){ docker exec -i "$POSTGRES_CONTAINER" psql -U postgres -d "$TEST_DB" -v ON_ERROR_STOP=1 -At < "$1"; }
val(){ docker exec "$POSTGRES_CONTAINER" psql -U postgres -d "$TEST_DB" -Atqc "$1"; }
[ "$(run /tmp/u6-optout.sql | tail -1 | cut -d'|' -f4)" = opted_out ]
[ "$(val 'SELECT opted_out::text FROM follow_up_preferences WHERE conversation_id=4')" = true ]
[ "$(run /tmp/u6-blocked.sql | tail -1 | cut -d'|' -f1)" = opted_out_blocked ]
[ "$(run /tmp/u6-policy.sql | tail -1 | cut -d'|' -f4)" = scheduled ]
[ "$(val "SELECT cycle_key||'|'||step_dia FROM follow_ups WHERE conversation_id=1")" = 'inbound:10|1' ]
run /tmp/u6-claim.sql >/dev/null
FID=$(val 'SELECT id FROM follow_ups WHERE conversation_id=1 AND step_dia=1')
TOKEN=$(val "SELECT claim_token FROM follow_ups WHERE id=$FID")
python3 - "$FID" "$TOKEN" <<'PY'
from pathlib import Path
import sys
s=Path('db/queries/n8n/follow-up-pipeline/03_apply_send_result.sql').read_text(); vals=[int(sys.argv[1]),sys.argv[2],'failed','provider_429','failed','501']
def lit(v): return str(v) if isinstance(v,int) else "'"+str(v).replace("'","''")+"'"
for i in range(len(vals),0,-1):s=s.replace(f'${i}',lit(vals[i-1]))
Path('/tmp/u6-failed.sql').write_text(s)
PY
run /tmp/u6-failed.sql >/dev/null
[ "$(val "SELECT estado||'|'||(next_retry_at IS NOT NULL)::text FROM follow_ups WHERE id=$FID")" = 'error|true' ]
# Retry due error with a new durable claim.
docker exec "$POSTGRES_CONTAINER" psql -U postgres -d "$TEST_DB" -c "UPDATE follow_ups SET next_retry_at=NOW()-INTERVAL '1 second' WHERE id=$FID" >/dev/null
docker exec "$POSTGRES_CONTAINER" psql -U postgres -d "$TEST_DB" -c "SELECT * FROM claim_due_follow_ups(10,'00:00','23:59',NOW(),30)" >/dev/null
TOKEN2=$(val "SELECT claim_token FROM follow_ups WHERE id=$FID")
[ "$TOKEN" != "$TOKEN2" ]
python3 - "$FID" "$TOKEN2" <<'PY'
from pathlib import Path
import sys
s=Path('db/queries/n8n/follow-up-pipeline/03_apply_send_result.sql').read_text(); vals=[int(sys.argv[1]),sys.argv[2],'sent','','sent','502']
def lit(v): return str(v) if isinstance(v,int) else "'"+str(v).replace("'","''")+"'"
for i in range(len(vals),0,-1):s=s.replace(f'${i}',lit(vals[i-1]))
Path('/tmp/u6-sent.sql').write_text(s)
PY
run /tmp/u6-sent.sql >/dev/null
[ "$(val "SELECT estado||'|'||send_attempt_count FROM follow_ups WHERE id=$FID")" = 'sent|2' ]
[ "$(val "SELECT count(*) FROM follow_ups WHERE conversation_id=1 AND cycle_key='inbound:10' AND step_dia=3")" = 1 ]
# Completion replay is rejected and cannot duplicate next step.
[ "$(run /tmp/u6-sent.sql | tail -1 | cut -d'|' -f4)" = claim_rejected ]
[ "$(val "SELECT count(*) FROM follow_ups WHERE conversation_id=1 AND cycle_key='inbound:10' AND step_dia=3")" = 1 ]
# Stale sending claims are reclaimed with a new token.
run /tmp/u6-stale-schedule.sql >/dev/null
docker exec "$POSTGRES_CONTAINER" psql -U postgres -d "$TEST_DB" -c "UPDATE follow_ups SET estado='sending',claim_token=gen_random_uuid(),claimed_at=NOW()-INTERVAL '10 minutes' WHERE conversation_id=2" >/dev/null
OLD=$(val 'SELECT claim_token FROM follow_ups WHERE conversation_id=2')
docker exec "$POSTGRES_CONTAINER" psql -U postgres -d "$TEST_DB" -c "SELECT * FROM claim_due_follow_ups(10,'00:00','23:59',NOW(),30)" >/dev/null
NEW=$(val 'SELECT claim_token FROM follow_ups WHERE conversation_id=2')
[ "$OLD" != "$NEW" ]
# Outbound known failure reclaims; unknown remains quarantined.
OUT=$(val "SELECT should_send::text FROM claim_outbound_message(1,NULL,'text','x','{\"number\":\"56911111111\"}'::jsonb,'follow_up','main','u6-outbound',30)")
[ "$OUT" = true ]
docker exec "$POSTGRES_CONTAINER" psql -U postgres -d "$TEST_DB" -c "UPDATE messages SET delivery_status='failed',dispatch_phase='failed',reconciliation_required=false WHERE idempotency_key='u6-outbound'" >/dev/null
[ "$(val "SELECT should_send::text FROM claim_outbound_message(1,NULL,'text','x','{\"number\":\"56911111111\"}'::jsonb,'follow_up','main','u6-outbound',30)")" = true ]
docker exec "$POSTGRES_CONTAINER" psql -U postgres -d "$TEST_DB" -c "UPDATE messages SET delivery_status='unknown',dispatch_phase='unknown',reconciliation_required=true WHERE idempotency_key='u6-outbound'" >/dev/null
[ "$(val "SELECT should_send::text FROM claim_outbound_message(1,NULL,'text','x','{\"number\":\"56911111111\"}'::jsonb,'follow_up','main','u6-outbound',30)")" = false ]

echo 'Follow-up cadence local tests OK: real inbound producer + durable opt-out + positional SQL + retry/stale recovery + atomic next step + outbound ambiguity quarantine'
