import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, test } from 'vitest';

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(testDirectory, '..', '..');
const scriptPath = path.join(repositoryRoot, 'scripts', 'dev', 'sync-n8n-workflows.sh');
const temporaryDirectories = [];

// A failed deploy must leave the bot exactly as it was before. Twice this
// broke the same way: a helper installed its own EXIT trap, replacing the
// deploy's rollback trap, so a failed acceptance left the candidate imported
// and every inbound caller paused. It was fixed in August and came back, so
// these tests pin the behaviour instead of trusting that nobody reintroduces it.
const sourceAndRun = (body, env = {}) => spawnSync(
  'sh',
  ['-c', `SYNC_N8N_SOURCE_ONLY=yes . "$0"\n${body}`, scriptPath],
  { cwd: repositoryRoot, encoding: 'utf8', env: { ...process.env, ...env } },
);

const tempDir = (prefix) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  temporaryDirectories.push(dir);
  return dir;
};

afterEach(() => {
  while (temporaryDirectories.length > 0) {
    fs.rmSync(temporaryDirectories.pop(), { recursive: true, force: true });
  }
});

describe('deploy rollback transaction', () => {
  test('a failing remote verification keeps the caller rollback trap armed', () => {
    const exportFile = path.join(tempDir('rollback-trap-'), 'remote.json');
    fs.writeFileSync(exportFile, '[]');

    const result = sourceAndRun(
      `trap 'echo ROLLBACK_TRAP_RAN' EXIT\nverify_remote_export "${exportFile}" no ""`,
    );

    expect(result.status).not.toBe(0);
    expect(result.stdout).toContain('ROLLBACK_TRAP_RAN');
  });

  test('a successful rollback reactivates exactly what the snapshot had active', () => {
    const snapshotDir = tempDir('rollback-snapshot-');
    const workflows = [
      { name: 'WA - Inbound Entry', id: 'entry', active: true },
      { name: 'WA - Inbound Recovery', id: 'recovery', active: true },
      { name: 'OPS - Follow-Up Scheduler', id: 'followup', active: true },
      { name: 'WA - Conversation Orchestrator', id: 'orchestrator', active: false },
    ].map((workflow) => ({ ...workflow, nodes: [], connections: {}, settings: {} }));
    workflows.forEach((workflow) => {
      fs.writeFileSync(path.join(snapshotDir, `${workflow.id}.json`), JSON.stringify(workflow));
    });
    const activations = path.join(snapshotDir, 'activations.log');

    // Runtime side effects are stubbed: the remote export echoes the snapshot,
    // so the restore verifies, and activation calls are recorded.
    const result = sourceAndRun(`
      set_callers_active() { :; }
      copy_and_import() { :; }
      cleanup_bootstrap_workflows() { :; }
      compose_cmd() { :; }
      export_remote_definitions() { jq -s '.' "${snapshotDir}"/*.json > "$1"; }
      set_named_workflows_active() { state="$1"; shift; for name do printf '%s|%s\\n' "$state" "$name" >> "${activations}"; done; }
      verify_webhook_ready() { echo WEBHOOKS_VERIFIED >> "${activations}"; }
      restore_runtime_workflows "${snapshotDir}"
    `);

    expect(result.status, result.stderr).toBe(0);
    const log = fs.readFileSync(activations, 'utf8').trim().split('\n');
    expect(log.filter((line) => line.startsWith('true|')).sort()).toEqual([
      'true|OPS - Follow-Up Scheduler',
      'true|WA - Inbound Entry',
      'true|WA - Inbound Recovery',
    ]);
    expect(log).toContain('WEBHOOKS_VERIFIED');
  });

  test('a rollback that fails verification reactivates nothing', () => {
    const snapshotDir = tempDir('rollback-mismatch-');
    fs.writeFileSync(path.join(snapshotDir, 'entry.json'), JSON.stringify({
      name: 'WA - Inbound Entry', id: 'entry', active: true, nodes: [], connections: {}, settings: {},
    }));
    const activations = path.join(snapshotDir, 'activations.log');

    const result = sourceAndRun(`
      set_callers_active() { :; }
      copy_and_import() { :; }
      cleanup_bootstrap_workflows() { :; }
      compose_cmd() { :; }
      export_remote_definitions() { printf '[{"name":"WA - Inbound Entry","id":"entry","nodes":[{"changed":true}],"connections":{},"settings":{}}]' > "$1"; }
      set_named_workflows_active() { state="$1"; shift; for name do printf '%s|%s\\n' "$state" "$name" >> "${activations}"; done; }
      verify_webhook_ready() { echo WEBHOOKS_VERIFIED >> "${activations}"; }
      # Same call shape as the deploy EXIT trap. "|| ..." disables set -e inside
      # the whole function, so the restore must stop on its own.
      restore_runtime_workflows "${snapshotDir}" || echo RESTORE_FAILED
    `);

    expect(result.stdout).toContain('RESTORE_FAILED');
    const log = fs.existsSync(activations) ? fs.readFileSync(activations, 'utf8') : '';
    expect(log).not.toContain('true|');
  });

  test('no brace-bodied helper installs an EXIT trap outside the deploy transaction', () => {
    // POSIX EXIT traps are global even inside functions. A helper that needs
    // its own cleanup trap must run in a subshell body: name() ( ... ).
    const source = fs.readFileSync(scriptPath, 'utf8');
    const offenders = [];
    let current = null;
    for (const line of source.split('\n')) {
      const start = line.match(/^([a-z_]+)\(\) ([{(])$/);
      if (start) { current = { name: start[1], braces: start[2] === '{' }; continue; }
      if (/^[})]$/.test(line)) { current = null; continue; }
      if (current?.braces && current.name !== 'sync_workflows' && /(?:^|[;&|]\s*)trap\s/.test(line.trim())) {
        offenders.push(`${current.name}: ${line.trim()}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
