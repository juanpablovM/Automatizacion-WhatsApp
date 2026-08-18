#!/usr/bin/env node
// =============================================================================
// Sync de nodos de workflow desde fixtures (Unit 1 — Gate de campos PRD).
// -----------------------------------------------------------------------------
// Los workflows n8n son JSON self-contained: el codigo de los nodos Code vive
// dentro del nodo como jsCode. Para mantener una fuente unica y revisable de la
// politica PRD determinista, la fuente canonica de cada nodo alterado se guarda
// en tests/fixtures/workflow-nodes/<workflow>/<node>.js y se reinyecta aqui.
//
// Uso:
//   node tests/scripts/sync-workflow-nodes.mjs            # aplica fixtures a workflows
//   node tests/scripts/sync-workflow-nodes.mjs --check    # solo verifica divergencia
//   node tests/scripts/sync-workflow-nodes.mjs --backup-only
//
// Idempotente: reescribe jsCode solo si difiere del fixture. Antes de mutar
// crea un backup en n8n/workflows/backup/ como los backups manuales del repo.
// =============================================================================
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');
const fixturesRoot = path.join(repoRoot, 'tests', 'fixtures', 'workflow-nodes');

const INDENT = 2;

const NODES = [
  {
    workflow: 'n8n/workflows/wa-conversation-orchestrator.json',
    node: 'Apply AI Assistance',
    fixture: 'wa-conversation-orchestrator/apply-ai-assistance.js',
  },
  {
    workflow: 'n8n/workflows/wa-conversation-orchestrator.json',
    node: 'Evaluate Conversation Step',
    fixture: 'wa-conversation-orchestrator/evaluate-conversation-step.js',
  },
  {
    workflow: 'n8n/workflows/ai-lead-qualification-assistant.json',
    node: 'Build AI Request',
    fixture: 'ai-lead-qualification-assistant/build-ai-request.js',
  },
  {
    workflow: 'n8n/workflows/ai-lead-qualification-assistant.json',
    node: 'Normalize AI Result',
    fixture: 'ai-lead-qualification-assistant/normalize-ai-result.js',
  },
  {
    workflow: 'n8n/workflows/crm-lead-creation-and-assignment.json',
    node: 'Prepare Lead Assignment',
    fixture: 'crm-lead-creation-and-assignment/prepare-lead-assignment.js',
  },
  {
    workflow: 'n8n/workflows/wa-inbound-downstream-dispatcher.json',
    node: 'Ensure Early Opportunity',
    fixture: 'wa-inbound-downstream-dispatcher/ensure-early-opportunity.js',
  },
  {
    workflow: 'n8n/workflows/wa-inbound-downstream-dispatcher.json',
    node: 'Ensure Escalation Handoff',
    fixture: 'wa-inbound-downstream-dispatcher/ensure-escalation-handoff.js',
  },
  {
    workflow: 'n8n/workflows/ops-handoff-notification-scheduler.json',
    node: 'Prepare Handoff ClickUp Task',
    fixture: 'ops-handoff-notification-scheduler/prepare-handoff-clickup-task.js',
  },
  {
    workflow: 'n8n/workflows/ops-handoff-notification-scheduler.json',
    node: 'Dispatch Handoff ClickUp Task',
    fixture: 'ops-handoff-notification-scheduler/dispatch-handoff-clickup-task.js',
  },
  {
    workflow: 'n8n/workflows/ops-handoff-notification-scheduler.json',
    node: 'Claim Pending Handoff Notifications',
    fixture: 'db/queries/n8n/handoff-routing/02_claim_notification.sql',
    type: 'n8n-nodes-base.postgres',
    parameter: 'query',
  },
  {
    workflow: 'n8n/workflows/wa-inbound-downstream-dispatcher.json',
    node: 'Ensure Media Attachment',
    fixture: 'wa-inbound-downstream-dispatcher/ensure-media-attachment.js',
  },
  {
    workflow: 'n8n/workflows/ops-media-download-scheduler.json',
    node: 'Download and Persist Media',
    fixture: 'ops-media-download-scheduler/download-and-persist-media.js',
  },
  {
    workflow: 'n8n/workflows/wa-inbound-downstream-dispatcher.json',
    node: 'Ensure Follow-Up Cancellation',
    fixture: 'wa-inbound-downstream-dispatcher/ensure-follow-up-cancellation.js',
  },
  {
    workflow: 'n8n/workflows/ops-followup-scheduler.json',
    node: 'Prepare Follow-Up Message',
    fixture: 'ops-followup-scheduler/prepare-follow-up-message.js',
  },
  {
    workflow: 'n8n/workflows/ops-followup-scheduler.json',
    node: 'Normalize Follow-Up Delivery',
    fixture: 'ops-followup-scheduler/normalize-follow-up-delivery.js',
  },
];

const mode = process.argv.includes('--check') ? 'check' : process.argv.includes('--backup-only') ? 'backup' : 'patch';

const loadJson = (rel) => JSON.parse(fs.readFileSync(path.join(repoRoot, rel), 'utf8'));
const loadFixture = (fixture) => fs.readFileSync(path.join(fixturesRoot, fixture), 'utf8');

let patchedCount = 0;
let checkedCount = 0;

for (const entry of NODES) {
  const workflowPath = path.join(repoRoot, entry.workflow);
  const workflow = loadJson(entry.workflow);
  const target = workflow.nodes.find((n) => n.name === entry.node && n.type === (entry.type || 'n8n-nodes-base.code'));
  if (!target) {
    console.error(`[ERROR] Nodo '${entry.node}' no encontrado en ${entry.workflow}`);
    process.exitCode = 1;
    continue;
  }

  const source = entry.fixture.startsWith('db/')
    ? fs.readFileSync(path.join(repoRoot, entry.fixture), 'utf8')
    : loadFixture(entry.fixture);
  const parameter = entry.parameter || 'jsCode';
  if (mode === 'check') {
    checkedCount += 1;
    if (target.parameters[parameter] !== source) {
      console.log(`[DRIFT] ${entry.workflow} :: ${entry.node} difiere del fixture`);
      process.exitCode = 1;
    } else {
      console.log(`[OK]    ${entry.workflow} :: ${entry.node}`);
    }
    continue;
  }

  const serialized = JSON.stringify(workflow, null, INDENT) + '\n';

  const backupFile = () => {
    const basename = path.basename(entry.workflow);
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const bakDir = path.join(repoRoot, 'n8n', 'workflows', 'backup');
    fs.mkdirSync(bakDir, { recursive: true });
    const bak = path.join(bakDir, `${basename}.${stamp}.bak`);
    fs.writeFileSync(bak, serialized, 'utf8');
    return bak;
  };

  if (mode === 'backup') {
    console.log(`[BAK]   ${backupFile()}`);
    continue;
  }

  if (target.parameters[parameter] === source) {
    console.log(`[SKIP]  ${entry.workflow} :: ${entry.node} ya sincronizado`);
    continue;
  }

  target.parameters[parameter] = source;
  const bak = backupFile();
  fs.writeFileSync(workflowPath, JSON.stringify(workflow, null, INDENT) + '\n', 'utf8');
  patchedCount += 1;
  console.log(`[PATCH] ${entry.workflow} :: ${entry.node} -> ${bak}`);
}

if (mode === 'patch') {
  console.log(`\nSincronizados ${patchedCount} nodos. Backups creados en n8n/workflows/backup/ (patron del repo).`);
}
