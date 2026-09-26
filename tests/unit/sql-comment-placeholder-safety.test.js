import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from 'vitest';
import { findCommentPlaceholders, scanRegions } from '../scripts/sql-comment-placeholders.mjs';

const workflowsDir = 'n8n/workflows';
const canonicalSqlDir = 'db/queries/n8n';

const listWorkflowFiles = () =>
  fs
    .readdirSync(workflowsDir)
    .filter((name) => name.endsWith('.json'))
    .map((name) => path.join(workflowsDir, name));

const listCanonicalSqlFiles = () => {
  const found = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.sql')) found.push(full);
    }
  };
  walk(canonicalSqlDir);
  return found;
};

const listParameterisedQueryNodes = () => {
  const nodes = [];
  for (const file of listWorkflowFiles()) {
    const workflow = JSON.parse(fs.readFileSync(file, 'utf8'));
    for (const node of workflow.nodes ?? []) {
      if (node.type !== 'n8n-nodes-base.postgres') continue;
      const query = node.parameters?.query;
      if (typeof query !== 'string') continue;
      if (!node.parameters?.options?.queryReplacement) continue;
      nodes.push({ file, name: node.name, query });
    }
  }
  return nodes;
};

// Mirrors how pg-promise (used by the n8n Postgres node) renders positional
// parameters: substitution happens on the query TEXT before the statement ever
// reaches PostgreSQL, so comments are substituted too.
const formatPositional = (query, values) =>
  query.replace(/\$(\d+)/g, (match, index) => {
    const value = values[Number(index) - 1];
    if (value === undefined) return match;
    if (typeof value === 'number') return String(value);
    return `'${String(value).replace(/'/g, "''")}'`;
  });

describe('SQL comment placeholder scanner', () => {
  test('reports a positional placeholder documented inside a line comment', () => {
    const findings = findCommentPlaceholders('-- $1 conversation_id\nSELECT $1::bigint;');
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ token: '$1', line: 1 });
  });

  test('reports multi-digit placeholders and every occurrence on a line', () => {
    const findings = findCommentPlaceholders('--   $9 raw_payload, $16 window_end\nSELECT 1;');
    expect(findings.map((finding) => finding.token)).toEqual(['$9', '$16']);
  });

  test('reports a placeholder inside a block comment', () => {
    const findings = findCommentPlaceholders('/* $2 action */\nSELECT $2::text;');
    expect(findings.map((finding) => finding.token)).toEqual(['$2']);
  });

  test('accepts placeholders in executable positions', () => {
    expect(findCommentPlaceholders('SELECT $1::bigint, $2::text;')).toEqual([]);
  });

  test('does not treat comment markers inside string literals as comments', () => {
    expect(findCommentPlaceholders("SELECT '-- $1 not a comment'::text;")).toEqual([]);
    expect(findCommentPlaceholders("SELECT 'it''s -- $1'::text;")).toEqual([]);
  });

  test('does not treat comment markers inside dollar-quoted bodies as comments', () => {
    expect(findCommentPlaceholders('SELECT $body$-- $1 inert$body$::text;')).toEqual([]);
  });

  test('classifies code, comment and string regions', () => {
    const regions = scanRegions("-- c\nSELECT 'x';");
    expect(regions.map((region) => region.kind)).toEqual(['comment', 'code', 'string', 'code']);
  });
});

describe('workflow queries survive a hostile positional value', () => {
  // The defect: a value carrying a newline escapes a line comment and the
  // remainder is parsed as SQL. Proven against the real query text.
  test('a newline-bearing value cannot open a statement outside a comment', () => {
    const marker = 'SELECT pg_sleep(0)';
    const hostile = `hola\n${marker}; --`;

    for (const node of listParameterisedQueryNodes()) {
      const placeholderCount = new Set(node.query.match(/\$(\d+)/g) ?? []).size;
      const values = Array.from({ length: placeholderCount }, () => hostile);
      const rendered = formatPositional(node.query, values);
      const escaped = scanRegions(rendered).some(
        (region) => region.kind === 'code' && region.text.includes(marker),
      );
      expect(escaped, `${node.file} :: ${node.name} leaked a value into executable SQL`).toBe(
        false,
      );
    }
  });
});

describe('positional placeholders are never documented inside comments', () => {
  test('every parameterised workflow query is clean', () => {
    const offenders = [];
    for (const node of listParameterisedQueryNodes()) {
      for (const finding of findCommentPlaceholders(node.query)) {
        offenders.push(`${node.file} :: ${node.name} :: line ${finding.line} :: ${finding.token}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  test('every canonical SQL asset is clean', () => {
    const offenders = [];
    for (const file of listCanonicalSqlFiles()) {
      for (const finding of findCommentPlaceholders(fs.readFileSync(file, 'utf8'))) {
        offenders.push(`${file} :: line ${finding.line} :: ${finding.token}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
