import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, test } from 'vitest';
import { validateV3WorkflowContract } from '../../scripts/dev/validate-v3-workflow-contract.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const temporaryDirectories = [];
const orchestratorFile = 'wa-conversation-orchestrator.json';
function copyWorkflows() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'v3-default-contract-'));
  temporaryDirectories.push(directory);
  fs.cpSync(path.join(root, 'n8n/workflows'), directory, { recursive: true });
  return directory;
}
function mutate(directory, file, change) {
  const filename = path.join(directory, file);
  const workflow = JSON.parse(fs.readFileSync(filename, 'utf8'));
  change(workflow);
  fs.writeFileSync(filename, JSON.stringify(workflow));
}
afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

describe('project default v3 deployment contract', () => {
  test('uses enforce for production defaults and retains isolated test legacy defaults', () => {
    const compose = fs.readFileSync(path.join(root, 'docker-compose.yml'), 'utf8');
    const example = fs.readFileSync(path.join(root, '.env.example'), 'utf8');
    const testCompose = fs.readFileSync(path.join(root, 'docker-compose.test.yml'), 'utf8');
    expect(compose).toContain('AI_PRD_CONTRACT_MODE: ${AI_PRD_CONTRACT_MODE:-enforce}');
    expect(compose).toContain('AI_PRD_CONTRACT_RULE_ID: ${AI_PRD_CONTRACT_RULE_ID:-rollout:enforce:v3-default}');
    expect(example).toContain('AI_PRD_CONTRACT_MODE=enforce');
    expect(testCompose).toContain('name: automatizacion-whatsapp-test');
    expect(testCompose).toContain('AI_PRD_CONTRACT_MODE: ${TEST_AI_PRD_CONTRACT_MODE:-legacy}');
    expect(testCompose).toContain('${TEST_N8N_PORT:-55678}');
    expect(testCompose).toContain('${TEST_POSTGRES_PORT:-55433}');
  });

  test('accepts the current v3 sources and local deterministic preflight', () => {
    validateV3WorkflowContract(path.join(root, 'n8n/workflows'));
    const output = execFileSync('sh', ['scripts/dev/sync-n8n-workflows.sh', '--preflight'], {
      cwd: root, encoding: 'utf8', env: { ...process.env, AI_PRD_CONTRACT_MODE: 'legacy' },
    });
    expect(output).toContain('v3 default workflow contract OK');
    expect(output).toContain('Preflight local OK');
  }, 60000);

  test('rejects a valid named legacy workflow set even with a legacy env override', () => {
    const directory = copyWorkflows();
    mutate(directory, orchestratorFile, (workflow) => {
      workflow.nodes = workflow.nodes.filter((node) => !node.name.includes('V3'));
      workflow.connections = {};
    });
    expect(() => validateV3WorkflowContract(directory)).toThrow(/v3 default requires node/);
    const result = spawnSync('node', ['scripts/dev/validate-v3-workflow-contract.mjs', directory], {
      cwd: root, encoding: 'utf8', env: { ...process.env, AI_PRD_CONTRACT_MODE: 'legacy' },
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('refusing workflows that remove the project default v3 pipeline');
  });

  test('rejects a missing flat handoff decision binding or a silent zero-row handoff', () => {
    const missingBinding = copyWorkflows();
    mutate(missingBinding, orchestratorFile, (workflow) => {
      const node = workflow.nodes.find((entry) => entry.name === 'Prepare V3 Effect');
      node.parameters.query = node.parameters.query.replace('       command.decision_id,\n', '');
    });
    expect(() => validateV3WorkflowContract(missingBinding)).toThrow(/flat normal-handoff decision binding/);

    const silentZeroRows = copyWorkflows();
    mutate(silentZeroRows, orchestratorFile, (workflow) => {
      const node = workflow.nodes.find((entry) => entry.name === 'Persist V3 Handoff Effect');
      delete node.alwaysOutputData;
    });
    expect(() => validateV3WorkflowContract(silentZeroRows)).toThrow(/visible exact normal-handoff binding failures/);
  });

  test('rejects disconnected routing, executor and delivery receipt nodes', () => {
    const directory = copyWorkflows();
    mutate(directory, orchestratorFile, (workflow) => {
      workflow.connections['Load Conversation State'].main[0] = [{ node: 'Evaluate Conversation Step', type: 'main', index: 0 }];
    });
    expect(() => validateV3WorkflowContract(directory)).toThrow(/requires connection/);

    const executorDirectory = copyWorkflows();
    mutate(executorDirectory, orchestratorFile, (workflow) => {
      for (const connections of Object.values(workflow.connections)) {
        for (const [type, branches] of Object.entries(connections)) {
          connections[type] = branches.map((branch) => branch.filter((edge) => edge.node !== 'Execute V3 Lead Effect'));
        }
      }
    });
    expect(() => validateV3WorkflowContract(executorDirectory)).toThrow(/requires reachable node: Execute V3 Lead Effect/);

    const receiptDirectory = copyWorkflows();
    mutate(receiptDirectory, 'wa-inbound-downstream-dispatcher.json', (workflow) => {
      workflow.connections['V3 Delivery Result?'].main[0] = [];
    });
    expect(() => validateV3WorkflowContract(receiptDirectory)).toThrow(/connected downstream delivery receipt/);
  });

  test('rejects removed durable dispatch wiring and lost post-receipt claim context', () => {
    const durableDirectory = copyWorkflows();
    mutate(durableDirectory, orchestratorFile, (workflow) => {
      workflow.nodes = workflow.nodes.filter((node) => node.name !== 'Persist V3 Durable Dispatch');
    });
    expect(() => validateV3WorkflowContract(durableDirectory)).toThrow(/requires node: Persist V3 Durable Dispatch/);
    const sqlDirectory = copyWorkflows();
    mutate(sqlDirectory, orchestratorFile, (workflow) => {
      workflow.nodes.find((node) => node.name === 'Persist V3 Durable Dispatch').parameters.query = 'SELECT 1';
    });
    expect(() => validateV3WorkflowContract(sqlDirectory)).toThrow(/canonical durable dispatch/);
    const contextDirectory = copyWorkflows();
    mutate(contextDirectory, 'wa-inbound-downstream-dispatcher.json', (workflow) => {
      workflow.nodes.find((node) => node.name === 'Outbound Lane Complete').parameters.jsCode = 'return items;';
    });
    expect(() => validateV3WorkflowContract(contextDirectory)).toThrow(/restored outbound inbox event/);
  });

  test('runs deployment validation before the import and preserves source-only harness overrides', () => {
    const source = fs.readFileSync(path.join(root, 'scripts/dev/sync-n8n-workflows.sh'), 'utf8');
    const deployment = source.slice(source.indexOf('sync_workflows() {'));
    expect(deployment.indexOf('validate_local')).toBeLessThan(deployment.indexOf('copy_and_import'));
    expect(source).toContain('node "$PROJECT_ROOT/scripts/dev/validate-v3-workflow-contract.mjs" "$WORKFLOW_DIR"');
    expect(source).toContain('if [ "${SYNC_N8N_SOURCE_ONLY:-no}" = yes ]; then');
    const validation = source.slice(source.indexOf('validate_local() {'), source.indexOf('compose_cmd() {'));
    expect(validation).not.toMatch(/\.env|compose_cmd|curl|docker compose/);
  });
});
