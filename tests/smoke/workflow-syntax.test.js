// =============================================================================
// Smoke Test — Workflow JSON Syntax
// =============================================================================

import { describe, test, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');
const workflowsDir = path.join(repoRoot, 'n8n', 'workflows');

describe('Smoke — Workflow JSON Syntax', () => {
  const workflowFiles = fs.readdirSync(workflowsDir).filter(f => f.endsWith('.json'));

  for (const file of workflowFiles) {
    test(`${file} is valid JSON`, () => {
      const content = fs.readFileSync(path.join(workflowsDir, file), 'utf8');
      expect(() => JSON.parse(content)).not.toThrow();
    });
  }

  // scripts/dev/sync-n8n-workflows.sh activates these two by name because the
  // deploy imports Entry paused, runs the controlled acceptance, and only then
  // turns it on. Every other trigger-driven workflow reaches the runtime active
  // solely because its own JSON declares it, so a false here silently disables
  // that trigger on the next deploy.
  const ACTIVATED_BY_DEPLOY_SCRIPT = new Set([
    'wa-inbound-entry.json',
    'wa-inbound-recovery.json',
  ]);

  const isTriggerDriven = (workflow) => (workflow.nodes || []).some(
    (node) => /webhook|scheduleTrigger/.test(node.type || ''),
  );

  for (const file of workflowFiles) {
    const workflow = JSON.parse(fs.readFileSync(path.join(workflowsDir, file), 'utf8'));
    if (!isTriggerDriven(workflow) || ACTIVATED_BY_DEPLOY_SCRIPT.has(file)) continue;

    test(`${file} declares itself active so a deploy does not disable its trigger`, () => {
      expect(workflow.active).toBe(true);
    });
  }
});