#!/usr/bin/env bash
set -euo pipefail
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"
node <<'NODE'
const fs=require('fs');
const AsyncFunction=Object.getPrototypeOf(async function(){}).constructor;
const fail=(m)=>{throw new Error(m)};
const leadWorkflow=JSON.parse(fs.readFileSync('n8n/workflows/crm-lead-creation-and-assignment.json','utf8'));
const leadQuery=leadWorkflow.nodes.find(n=>n.name==='Load CRM Context').parameters.query;
if (!leadQuery.includes('AND ip.source_number_id IS NOT NULL') || !leadQuery.includes('AND l.source_number_id = ip.source_number_id')) fail('latest_lead debe exigir source exacto y no nulo');
const workflow=JSON.parse(fs.readFileSync('n8n/workflows/crm-seller-notification-dispatch.json','utf8'));
const node=(name)=>workflow.nodes.find(n=>n.name===name);
const loadQuery=node('Load Notification Context').parameters.query;
const persistQuery=node('Persist Notification Result').parameters.query;
const dispatchCode=node('Dispatch Notification').parameters.jsCode;
if (!loadQuery.includes('external_operations') || !loadQuery.includes('should_dispatch_notification')) fail('Notificacion debe reclamar una operacion exclusiva');
if (!loadQuery.includes("eo.status='failed' AND eo.retry_safe=TRUE") || !loadQuery.includes("status='unknown'")) fail('Ledger de notificacion debe bloquear unknown y reclamar solo retry seguro');
if (!persistQuery.includes("WHEN $7::text='unknown' THEN 'unknown'") || !persistQuery.includes('reconciliation_required=$8::boolean')) fail('Resultado de notificacion debe persistir unknown/reconciliacion');
async function run(response,row={should_dispatch_notification:true,notification_url:'https://clickup.test/comment',notification_payload:{comment_text:'Lead'}}){
 let calls=0; const helpers={httpRequest:async()=>{calls++;if(response instanceof Error)throw response;return response;}};
 const fn=new AsyncFunction('items','$env','helpers',dispatchCode);
 const result=await fn([{json:row}],{CLICKUP_API_TOKEN:'test'},helpers);return{calls,output:result[0].json};
}
(async()=>{
 const five=await run({statusCode:500,body:{message:'server'}});
 if(five.calls!==1||five.output.operation_outcome!=='unknown'||!five.output.reconciliation_required)fail('Notificacion 5xx no debe repetir POST y debe quedar unknown');
 const timeout=await run(new Error('ETIMEDOUT'));
 if(timeout.calls!==1||timeout.output.operation_outcome!=='unknown')fail('Timeout de notificacion no debe repetir POST');
 const unsafeReplay=await run(null,{should_dispatch_notification:false,notification_operation_status:'unknown',notification_reconciliation_required:true});
 if(unsafeReplay.calls!==0||unsafeReplay.output.operation_outcome!=='unknown')fail('Notificacion unknown no debe volver a ejecutar POST');
 const rate=await run({statusCode:429,body:{message:'rate'}});
 if(rate.calls!==1||rate.output.operation_outcome!=='failed'||!rate.output.retry_safe)fail('429 debe quedar retry_safe sin retry dentro del mismo run');
 console.log('Secondary effects local tests OK: source isolation, comment ambiguity, seller notification ledger');
})().catch(e=>{console.error(e.message);process.exit(1)});
NODE
