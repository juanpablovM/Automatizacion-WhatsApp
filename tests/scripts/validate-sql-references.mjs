#!/usr/bin/env node
// =============================================================================
// Validate canonical SQL embedded in workflows and explicit SQL references.
// -----------------------------------------------------------------------------
// Memoria #679: CI job paridad fixtures ↔ workflow ↔ SQL
// =============================================================================
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');

const workflowsDir = path.join(repoRoot, 'n8n', 'workflows');
const sqlDir = path.join(repoRoot, 'db', 'queries', 'n8n');

let errors = 0;
let warnings = 0;

function logError(msg) {
  console.error(`[ERROR] ${msg}`);
  errors++;
}

function logWarn(msg) {
  console.warn(`[WARN]  ${msg}`);
  warnings++;
}

function logInfo(msg) {
  console.log(`[INFO]  ${msg}`);
}

// Collect all SQL files
function collectSqlFiles(dir) {
  const files = new Map();
  function walk(d) {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.name.endsWith('.sql')) {
        const rel = path.relative(sqlDir, full).replace(/\\/g, '/');
        files.set(rel, full);
      }
    }
  }
  walk(dir);
  return files;
}

// Extract explicit SQL file references from workflow JSON.
function extractSqlReferences(workflow) {
  const refs = [];
  for (const node of workflow.nodes) {
    if (node.type === 'n8n-nodes-base.postgres' && node.parameters?.query) {
      // Look for comments referencing SQL files
      const query = node.parameters.query;
      // Match file paths with directory structure (e.g., handoff-routing/01_upsert_handoff.sql)
      // but ignore bare filenames that are just documentation comments
      const commentMatches = query.matchAll(/--\s*((?:\w+\/)+\w+\.sql)/g);
      for (const match of commentMatches) {
        refs.push({
          node: node.name,
          file: match[1],
          workflow: workflow.name || 'unknown',
        });
      }
      // Also check queryReplacement for parameter patterns that might indicate SQL
    }
  }
  return refs;
}

// Check if a SQL file exists
function validateSqlReferences() {
  const sqlFiles = collectSqlFiles(sqlDir);
  logInfo(`Found ${sqlFiles.size} SQL files in ${sqlDir}`);

  const workflowFiles = fs.readdirSync(workflowsDir).filter(f => f.endsWith('.json'));
  logInfo(`Checking ${workflowFiles.length} workflow files...`);

  const postgresNodes = [];
  const referencedSql = new Set();

  for (const wfFile of workflowFiles) {
    const wfPath = path.join(workflowsDir, wfFile);
    const workflow = JSON.parse(fs.readFileSync(wfPath, 'utf8'));
    for (const node of workflow.nodes) {
      if (node.type === 'n8n-nodes-base.postgres' && typeof node.parameters?.query === 'string') {
        postgresNodes.push({ workflow: workflow.name || wfFile, node: node.name, query: node.parameters.query });
      }
    }
    const refs = extractSqlReferences(workflow);

    for (const ref of refs) {
      // Normalize the reference path
      let sqlRelPath = ref.file;
      if (!sqlRelPath.startsWith('db/')) {
        // Try to find it under db/queries/n8n
        const possiblePaths = [
          sqlRelPath,
          path.join('n8n', sqlRelPath).replace(/\\/g, '/'),
        ];

        let found = false;
        for (const p of possiblePaths) {
          if (sqlFiles.has(p)) {
            found = true;
            break;
          }
        }

        if (!found) {
          logError(`Workflow "${workflow.name}" node "${ref.node}" references SQL "${ref.file}" but file not found in db/queries/n8n/`);
        } else {
          referencedSql.add(sqlRelPath);
        }
      }
    }
  }

  for (const [sqlRel, sqlAbs] of sqlFiles) {
    const source = fs.readFileSync(sqlAbs, 'utf8');
    if (postgresNodes.some((entry) => entry.query === source)) {
      referencedSql.add(sqlRel);
    }
  }

  const requiredCanonicalSql = [
    'wa-conversation-orchestrator/01_load_active_context.sql',
    'follow-up-pipeline/05_cancel_pending_follow_ups.sql',
    'handoff-routing/02_claim_notification.sql',
  ];
  for (const sqlRel of requiredCanonicalSql) {
    if (!referencedSql.has(sqlRel)) {
      logError(`Canonical SQL "${sqlRel}" is not embedded byte-for-byte in any workflow Postgres node`);
    }
  }

  logInfo(`${referencedSql.size} SQL files are explicitly referenced or embedded byte-for-byte`);
  logInfo(`${sqlFiles.size - referencedSql.size} SQL files are library/query assets and are outside this parity gate`);

  // Summary
  console.log(`\n--- SQL Reference Validation Summary ---`);
  console.log(`Errors: ${errors}`);
  console.log(`Warnings: ${warnings}`);

  if (errors > 0) {
    process.exit(1);
  }
}

validateSqlReferences();
