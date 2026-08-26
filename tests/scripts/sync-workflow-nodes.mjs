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
//
// Validación de timeouts (memoria #679, #686):
// - workflow.settings.executionTimeout: en segundos
// - Execute Workflow nodes: NO deben tener timeout/executionTimeout en options
//   (solo opcion valida: waitForSubWorkflow). Timeout controlado a nivel workflow.
// - AI timeout: consistente en ms
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
    node: 'Load Conversation State',
    fixture: 'db/queries/n8n/wa-conversation-orchestrator/01_load_active_context.sql',
    type: 'n8n-nodes-base.postgres',
    parameter: 'query',
  },
  {
    workflow: 'n8n/workflows/wa-conversation-orchestrator.json',
    node: 'Apply AI Assistance',
    fixture: 'wa-conversation-orchestrator/apply-ai-assistance.js',
  },
  {
    workflow: 'n8n/workflows/wa-conversation-orchestrator.json',
    node: 'Evaluate Conversation Step',
    fixture: 'wa-conversation-orchestrator/evaluate-conversation-step.js',
    transform: 'n8n-explicit-return',
  },
  {
    workflow: 'n8n/workflows/wa-conversation-orchestrator.json',
    node: 'Prepare Conversation Output',
    fixture: 'wa-conversation-orchestrator/prepare-conversation-output.js',
  },
  {
    workflow: 'n8n/workflows/wa-conversation-orchestrator.json',
    node: 'Build V3 Repair',
    fixture: 'wa-conversation-orchestrator/build-v3-repair.js',
  },
  {
    workflow: 'n8n/workflows/wa-conversation-orchestrator.json',
    node: 'Resolve Conversation Contract Route',
    fixture: 'wa-conversation-orchestrator/resolve-conversation-contract-route.js',
    runtimes: ['shared/v3-rollout-runtime.js'],
  },
  {
    workflow: 'n8n/workflows/wa-conversation-orchestrator.json',
    node: 'Compile V3 Turn Policy',
    fixture: 'wa-conversation-orchestrator/compile-v3-turn.js',
    runtimes: ['shared/v3-contract-runtime.js', 'shared/v3-rollout-runtime.js'],
  },
  {
    workflow: 'n8n/workflows/wa-conversation-orchestrator.json',
    node: 'Validate And Authorize V3',
    fixture: 'wa-conversation-orchestrator/validate-and-authorize-v3.js',
    runtimes: ['shared/v3-contract-runtime.js'],
  },
  {
    workflow: 'n8n/workflows/wa-conversation-orchestrator.json',
    node: 'Fix V3 Route',
    fixture: 'db/queries/n8n/wa-conversation-orchestrator/07_route_v3_turn.sql',
    type: 'n8n-nodes-base.postgres',
    parameter: 'query',
  },
  {
    workflow: 'n8n/workflows/wa-conversation-orchestrator.json',
    node: 'Persist V3 Turn Authority',
    fixture: 'db/queries/n8n/wa-conversation-orchestrator/16_persist_v3_turn_authority.sql',
    type: 'n8n-nodes-base.postgres',
    parameter: 'query',
  },
  ...[
    ['Prepare V3 Execution', '08_prepare_v3_decision.sql'],
    ['Prepare V3 Effect', '11_prepare_v3_effect.sql'],
    ['Reconcile V3 Effect', '13_reconcile_v3_effect.sql'],
    ['Commit V3 State And Outbox', '09_commit_v3_turn.sql'],
    ['Record V3 Delivery', '10_transition_v3_execution.sql'],
    ['Record V3 Effect Result', '12_record_v3_effect_result.sql'],
    ['Prepare V3 Contingency Decision', '15_prepare_v3_contingency.sql'],
    ['Commit V3 Contingency', '14_commit_v3_contingency.sql'],
  ].map(([node, file]) => ({
    workflow: 'n8n/workflows/wa-conversation-orchestrator.json',
    node,
    fixture: `db/queries/n8n/wa-conversation-orchestrator/${file}`,
    type: 'n8n-nodes-base.postgres',
    parameter: 'query',
  })),
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
    workflow: 'n8n/workflows/ops-handoff-clickup-closure.json',
    node: 'Normalize ClickUp Closure',
    fixture: 'ops-handoff-clickup-closure/normalize-clickup-closure.js',
  },
  {
    workflow: 'n8n/workflows/ops-handoff-clickup-closure.json',
    node: 'Close Handoff From ClickUp',
    fixture: 'db/queries/n8n/handoff-routing/05_close_handoff_from_clickup.sql',
    type: 'n8n-nodes-base.postgres',
    parameter: 'query',
  },
  {
    workflow: 'n8n/workflows/wa-inbound-downstream-dispatcher.json',
    node: 'Apply Inbound Follow-Up Policy',
    fixture: 'db/queries/n8n/follow-up-pipeline/05_cancel_pending_follow_ups.sql',
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

const V3_CONTRACT_WRAPPERS = [
  {
    fixture: 'wa-conversation-orchestrator/compile-v3-turn-policy.js',
    exportName: 'compileV3TurnPolicy',
  },
  {
    fixture: 'wa-conversation-orchestrator/validate-v3-ai-proposal.js',
    exportName: 'validateV3AiProposal',
  },
  {
    fixture: 'wa-conversation-orchestrator/authorize-v3-conversation-decision.js',
    exportName: 'authorizeV3ConversationDecision',
  },
];
const V3_CONTRACT_RUNTIME = 'shared/v3-contract-runtime.js';
const V3_SAGA_RUNTIME = 'shared/v3-saga-runtime.js';
const V3_SAGA_FIXTURE = 'wa-conversation-orchestrator/build-v3-repair.js';
const v3WrapperSource = (exportName) =>
  `const { ${exportName} } = require('../shared/v3-contract-runtime.js');\n\nmodule.exports = { ${exportName} };\n`;

const mode = process.argv.includes('--check') ? 'check' : process.argv.includes('--backup-only') ? 'backup' : 'patch';

const loadJson = (rel) => JSON.parse(fs.readFileSync(path.join(repoRoot, rel), 'utf8'));
const loadFixture = (fixture) => fs.readFileSync(path.join(fixturesRoot, fixture), 'utf8');

let patchedCount = 0;
let checkedCount = 0;

const validateV3ContractLibrary = () => {
  const runtimePath = path.join(fixturesRoot, V3_CONTRACT_RUNTIME);
  const runtime = fs.readFileSync(runtimePath, 'utf8');
  const requiredCanonicalSymbols = [
    'V3_CONTRACTS',
    'CONCEPT_TO_FIELD',
    'GROUNDED_CONCEPTS',
    'canonicalJson',
    'sha256',
    'digestObject',
    'compileV3TurnPolicy',
    'validateV3AiProposal',
    'authorizeV3ConversationDecision',
  ];
  for (const symbol of requiredCanonicalSymbols) {
    if (!runtime.includes(symbol)) {
      console.error(`[ERROR] ${V3_CONTRACT_RUNTIME} no contiene el simbolo canonico ${symbol}`);
      process.exitCode = 1;
    }
  }
  try {
    new Function(runtime);
  } catch (error) {
    console.error(`[ERROR] ${V3_CONTRACT_RUNTIME} no compila: ${error.message}`);
    process.exitCode = 1;
  }

  for (const entry of V3_CONTRACT_WRAPPERS) {
    const wrapperPath = path.join(fixturesRoot, entry.fixture);
    const expected = v3WrapperSource(entry.exportName);
    const actual = fs.existsSync(wrapperPath) ? fs.readFileSync(wrapperPath, 'utf8') : '';
    checkedCount += 1;
    if (actual === expected) {
      console.log(`[OK]    tests/fixtures/workflow-nodes/${entry.fixture}`);
    } else if (mode === 'check') {
      console.log(`[DRIFT] tests/fixtures/workflow-nodes/${entry.fixture} difiere del wrapper v3 canonico`);
      process.exitCode = 1;
    } else if (mode === 'patch') {
      fs.mkdirSync(path.dirname(wrapperPath), { recursive: true });
      fs.writeFileSync(wrapperPath, expected, 'utf8');
      patchedCount += 1;
      console.log(`[PATCH] tests/fixtures/workflow-nodes/${entry.fixture}`);
    }
  }
};

validateV3ContractLibrary();

const validateV3SagaLibrary = () => {
  const runtime = loadFixture(V3_SAGA_RUNTIME);
  for (const symbol of [
    'buildV3RepairRequest',
    'buildV3ContingencyDecision',
    'planV3Recovery',
    'releaseV3Contingency',
    'reconcileV3Operation',
  ]) {
    if (!runtime.includes(symbol)) {
      console.error(`[ERROR] ${V3_SAGA_RUNTIME} no contiene el simbolo canonico ${symbol}`);
      process.exitCode = 1;
    }
  }
  const adapter = `${runtime}\n\nconst input = items[0]?.json ?? {};\nconst v3Recovery = planV3Recovery({\n  policy: input.v3_policy,\n  validation: input.v3_validation ?? null,\n  repairAttempt: Number(input.v3_repair_attempt || 0),\n  providerOutcome: input.v3_provider_outcome || 'accepted',\n  preTurnState: input.qualification_context || {},\n  expectedSnapshotDigest: input.expected_snapshot_digest || null,\n});\nreturn [{ json: {\n  ...input,\n  v3_recovery: v3Recovery,\n  v3_repair_attempt: v3Recovery.action === 'repair' ? 1 : Number(input.v3_repair_attempt || 0),\n  ai_repair_request: v3Recovery.repair_request || null,\n  turn_policy: v3Recovery.repair_request?.policy || input.turn_policy || input.v3_policy,\n  v3_recovery_decision: v3Recovery.decision || null,\n  decision_id: v3Recovery.decision?.decision_id || input.decision_id || null,\n  delivery_key: v3Recovery.decision?.reply?.delivery_key || input.delivery_key || null,\n} }];\n`;
  const fixturePath = path.join(fixturesRoot, V3_SAGA_FIXTURE);
  const actual = fs.existsSync(fixturePath) ? fs.readFileSync(fixturePath, 'utf8') : '';
  checkedCount += 1;
  if (actual === adapter) {
    console.log(`[OK]    tests/fixtures/workflow-nodes/${V3_SAGA_FIXTURE}`);
  } else if (mode === 'check') {
    console.log(`[DRIFT] tests/fixtures/workflow-nodes/${V3_SAGA_FIXTURE} difiere del runtime saga v3 canonico`);
    process.exitCode = 1;
  } else if (mode === 'patch') {
    fs.mkdirSync(path.dirname(fixturePath), { recursive: true });
    fs.writeFileSync(fixturePath, adapter, 'utf8');
    patchedCount += 1;
    console.log(`[PATCH] tests/fixtures/workflow-nodes/${V3_SAGA_FIXTURE}`);
  }
};

validateV3SagaLibrary();

// =============================================================================
// Timeout validation helpers (memoria #679, #686)
// =============================================================================
const validateTimeouts = (workflow, workflowPath) => {
  const errors = [];
  const warnings = [];

  // 1. Workflow-level executionTimeout uses seconds in n8n.
  if (workflow.settings?.executionTimeout !== undefined) {
    const execTimeout = workflow.settings.executionTimeout;
    if (!Number.isInteger(execTimeout) || execTimeout < 1 || execTimeout > 3600) {
      errors.push(`workflow.settings.executionTimeout (${execTimeout}) debe ser un entero entre 1 y 3600 segundos`);
    }
  }

  // 2. Validate Execute Workflow nodes - they should NOT have timeout/executionTimeout in options
  // (only valid option is waitForSubWorkflow). Timeout controlled at workflow level.
  for (const node of workflow.nodes) {
    if (node.type === 'n8n-nodes-base.executeWorkflow') {
      const timeout = node.parameters?.options?.timeout;
      const executionTimeout = node.parameters?.options?.executionTimeout;
      const nodeName = node.name || node.id;

      if (timeout !== undefined) {
        errors.push(`Nodo "${nodeName}" (Execute Workflow): options.timeout no es una opción válida; usa workflow.settings.executionTimeout`);
      }
      if (executionTimeout !== undefined) {
        errors.push(`Nodo "${nodeName}" (Execute Workflow): options.executionTimeout no es una opción válida; usa workflow.settings.executionTimeout`);
      }
    }

    // 3. Validate AI timeout in code nodes (Build AI Request, Call AI Provider)
    if (node.type === 'n8n-nodes-base.code' && node.parameters?.jsCode) {
      const code = node.parameters.jsCode;
      const nodeName = node.name || node.id;

      // Check for AI_DIRECT_API_TIMEOUT_MS usage
      const timeoutMsMatches = code.match(/AI_DIRECT_API_TIMEOUT_MS\s*\|\|\s*(\d+)/g);
      if (timeoutMsMatches) {
        for (const match of timeoutMsMatches) {
          const value = Number(match.match(/\d+/)[0]);
          if (value < 1000) {
            errors.push(`Nodo "${nodeName}": AI_DIRECT_API_TIMEOUT_MS fallback (${value}) parece estar en segundos`);
          } else if (value > 300000) {
            warnings.push(`Nodo "${nodeName}": AI_DIRECT_API_TIMEOUT_MS fallback (${value}ms = ${(value/60000).toFixed(1)}min) es muy alto`);
          }
        }
      }

      // Check for hardcoded timeout values that might be in seconds
      const hardcodedTimeouts = code.match(/timeout\s*[:=]\s*(\d{1,3})(?!\d)/g);
      if (hardcodedTimeouts) {
        for (const match of hardcodedTimeouts) {
          const value = Number(match.match(/\d+/)[0]);
          if (value >= 1 && value <= 300) {
            warnings.push(`Nodo "${nodeName}": timeout hardcodeado (${value}) podría estar en segundos en lugar de milisegundos`);
          }
        }
      }
    }
  }

  return { errors, warnings };
};

for (const entry of NODES) {
  const workflowPath = path.join(repoRoot, entry.workflow);
  const workflow = loadJson(entry.workflow);
  const target = workflow.nodes.find((n) => n.name === entry.node && n.type === (entry.type || 'n8n-nodes-base.code'));
  if (!target) {
    console.error(`[ERROR] Nodo '${entry.node}' no encontrado en ${entry.workflow}`);
    process.exitCode = 1;
    continue;
  }

  const canonicalSource = entry.fixture.startsWith('db/')
    ? fs.readFileSync(path.join(repoRoot, entry.fixture), 'utf8')
    : loadFixture(entry.fixture);
  const composedSource = [
    ...(entry.runtimes || []).map((runtime) => loadFixture(runtime)),
    canonicalSource,
  ].join('\n\n');
  const source = entry.transform === 'n8n-explicit-return'
    ? composedSource + '\nreturn runN8nCode(items);\n'
    : composedSource;
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

// Run timeout validation after patch/check
if (mode === 'patch' || mode === 'check') {
  console.log('\n--- Validación de timeouts (memoria #679, #686) ---');
  let totalErrors = 0;
  let totalWarnings = 0;

  for (const entry of NODES) {
    const workflowPath = path.join(repoRoot, entry.workflow);
    const workflow = loadJson(entry.workflow);
    const { errors, warnings } = validateTimeouts(workflow, workflowPath);

    for (const err of errors) {
      console.log(`[TIMEOUT ERROR] ${entry.workflow}: ${err}`);
      totalErrors++;
    }
    for (const warn of warnings) {
      console.log(`[TIMEOUT WARN]  ${entry.workflow}: ${warn}`);
      totalWarnings++;
    }
  }

  // Also validate entry workflows that have Execute Workflow nodes
  const entryWorkflows = [
    'n8n/workflows/wa-inbound-entry.json',
    'n8n/workflows/wa-inbound-recovery.json',
  ];

  for (const wfRel of entryWorkflows) {
    const wfPath = path.join(repoRoot, wfRel);
    if (fs.existsSync(wfPath)) {
      const workflow = loadJson(wfRel);
      const { errors, warnings } = validateTimeouts(workflow, wfRel);
      for (const err of errors) {
        console.log(`[TIMEOUT ERROR] ${wfRel}: ${err}`);
        totalErrors++;
      }
      for (const warn of warnings) {
        console.log(`[TIMEOUT WARN]  ${wfRel}: ${warn}`);
        totalWarnings++;
      }
    }
  }

  if (totalErrors > 0) {
    console.log(`\n❌ Validación de timeouts: ${totalErrors} error(es), ${totalWarnings} advertencia(s)`);
    if (mode === 'check') process.exitCode = 1;
  } else {
    console.log(`\n✅ Validación de timeouts: OK (${totalWarnings} advertencia(s))`);
  }
}

if (mode === 'patch') {
  console.log(`\nSincronizados ${patchedCount} nodos. Backups creados en n8n/workflows/backup/ (patron del repo).`);
}
