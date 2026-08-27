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
});