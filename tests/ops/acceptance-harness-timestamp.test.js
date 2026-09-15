import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(testDirectory, '..', '..');
const routeSql = path.join(
  repositoryRoot,
  'db', 'queries', 'n8n', 'wa-conversation-orchestrator', '07_route_v3_turn.sql',
);

// 07_route_v3_turn.sql accepts exactly these shapes and poisons the cast for
// anything else, on purpose: a malformed timestamp must fail loudly rather than
// be stored as a guess. A harness that emits a shape outside this set stalls the
// turn in `orchestrating` and the failure looks like a product bug instead of a
// harness bug, which is what it cost us once already.
const ACCEPTED = [
  /^[0-9]{10}$/,
  /^[0-9]{13}$/,
  /^[0-9]{4}-[0-9]{2}-[0-9]{2}[Tt][0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]+)?([Zz]|[+-][0-9]{2}:[0-9]{2})$/,
];

const harnesses = [
  'scripts/ops/test-e2e-lead-creation.sh',
  'scripts/ops/test-advisor-vitacura-e2e.sh',
  'scripts/ops/test-v3-canary-n8n-e2e.sh',
  'scripts/ops/test-error-handler.sh',
  'scripts/ops/test-reengagement-n8n-e2e.sh',
];

const extractExpression = (source) => {
  const match = source.match(/messageTimestamp:\s*(.+?),?\s*$/m);
  return match ? match[1].replace(/,$/, '').trim() : null;
};

// Bind the shell-supplied variables to what the scripts actually pass, so the
// expression is evaluated the way the harness evaluates it at runtime.
const evaluate = (expression) => {
  const seconds = '1789390847';
  const bound = expression
    .replace(/\$timestamp/g, `"${seconds}"`)
    .replace(/\$now/g, `"${seconds}"`);
  const result = spawnSync('jq', ['-nr', `(${bound}) | tostring`], { encoding: 'utf8' });
  return result.status === 0 ? result.stdout.trim() : `ERROR: ${result.stderr.trim()}`;
};

describe('acceptance harnesses emit a timestamp the v3 route accepts', () => {
  test('the accepted shapes still match the migration contract', () => {
    const sql = fs.readFileSync(routeSql, 'utf8');
    expect(sql).toContain("~ '^[0-9]{10}$'");
    expect(sql).toContain("~ '^[0-9]{13}$'");
    expect(sql).toContain('invalid_external_timestamp');
  });

  test.each(harnesses)('%s emits an accepted messageTimestamp', (relativePath) => {
    const source = fs.readFileSync(path.join(repositoryRoot, relativePath), 'utf8');
    const expression = extractExpression(source);

    expect(expression, `${relativePath} builds no messageTimestamp`).not.toBeNull();

    const emitted = evaluate(expression);
    const accepted = ACCEPTED.some((pattern) => pattern.test(emitted));

    expect(
      accepted,
      `${relativePath} emits "${emitted}" from \`${expression}\`, which the v3 route rejects`,
    ).toBe(true);
  });

  test('a fractional epoch is rejected, which is the defect that stalled a deploy', () => {
    const emitted = evaluate('(1789477053.123339 | tostring)');
    expect(ACCEPTED.some((pattern) => pattern.test(emitted))).toBe(false);
  });
});
