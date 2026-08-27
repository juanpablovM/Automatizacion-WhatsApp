import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, test } from 'vitest';

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(testDirectory, '..', '..');
const sourceScript = path.join(repositoryRoot, 'scripts', 'ops', 'reset-controlled-test-session.sh');
const sourceSql = path.join(repositoryRoot, 'db', 'queries', 'ops', 'reset-controlled-test-session.sql');
const temporaryDirectories = [];

const createFixture = (controlledPhoneNumber = '56900000000') => {
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'controlled-reset-contract-'));
  temporaryDirectories.push(fixtureRoot);

  fs.mkdirSync(path.join(fixtureRoot, 'scripts', 'ops'), { recursive: true });
  fs.mkdirSync(path.join(fixtureRoot, 'db', 'queries', 'ops'), { recursive: true });
  fs.mkdirSync(path.join(fixtureRoot, 'bin'), { recursive: true });
  fs.copyFileSync(sourceScript, path.join(fixtureRoot, 'scripts', 'ops', path.basename(sourceScript)));
  fs.copyFileSync(sourceSql, path.join(fixtureRoot, 'db', 'queries', 'ops', path.basename(sourceSql)));
  fs.writeFileSync(path.join(fixtureRoot, 'docker-compose.yml'), 'name: controlled-reset-test\n');
  fs.writeFileSync(
    path.join(fixtureRoot, '.env'),
    `CONTROLLED_TEST_PHONE_NUMBER=${controlledPhoneNumber}\nAPP_POSTGRES_DB=test_app\nPOSTGRES_USER=test_user\n`,
  );

  const dockerLog = path.join(fixtureRoot, 'docker.log');
  const sqlLog = path.join(fixtureRoot, 'sql.log');
  fs.writeFileSync(
    path.join(fixtureRoot, 'bin', 'docker'),
    '#!/bin/sh\nprintf "%s\\n" "$*" > "$DOCKER_LOG"\ncat > "$SQL_LOG"\n',
    { mode: 0o755 },
  );

  return { fixtureRoot, dockerLog, sqlLog };
};

const runFixtureScript = ({ fixtureRoot, dockerLog, sqlLog }, phoneNumber, cwd) => spawnSync(
  'sh',
  [path.join(fixtureRoot, 'scripts', 'ops', 'reset-controlled-test-session.sh'), phoneNumber, '--apply'],
  {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${path.join(fixtureRoot, 'bin')}:${process.env.PATH}`,
      DOCKER_LOG: dockerLog,
      SQL_LOG: sqlLog,
    },
  },
);

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe('controlled test session reset contract', () => {
  test('requires a non-empty controlled phone allowlist before Docker', () => {
    const fixture = createFixture('');
    const result = runFixtureScript(fixture, '56900000000', os.tmpdir());

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('CONTROLLED_TEST_PHONE_NUMBER');
    expect(fs.existsSync(fixture.dockerLog)).toBe(false);
  });

  test('rejects a phone number outside the configured allowlist before Docker', () => {
    const fixture = createFixture();
    const result = runFixtureScript(fixture, '56911111111', os.tmpdir());

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('not authorized');
    expect(fs.existsSync(fixture.dockerLog)).toBe(false);
  });

  test('uses repository-anchored Compose paths from an arbitrary working directory', () => {
    const fixture = createFixture();
    const result = runFixtureScript(fixture, '56900000000', os.tmpdir());

    expect(result.status).toBe(0);
    const dockerArguments = fs.readFileSync(fixture.dockerLog, 'utf8');
    expect(dockerArguments).toContain(`--env-file ${path.join(fixture.fixtureRoot, '.env')}`);
    expect(dockerArguments).toContain(`-f ${path.join(fixture.fixtureRoot, 'docker-compose.yml')}`);
    expect(dockerArguments).toContain(`--project-directory ${fixture.fixtureRoot}`);
    expect(dockerArguments).toContain('-p automatizacion-whatsapp');
    expect(dockerArguments).toContain('-v phone_number=56900000000');
    expect(fs.readFileSync(fixture.sqlLog, 'utf8')).toBe(fs.readFileSync(sourceSql, 'utf8'));
  });

  test('keeps the inbound check and audited archive in one locked transaction', () => {
    const sql = fs.readFileSync(sourceSql, 'utf8');
    const beginPosition = sql.indexOf('BEGIN;');
    const lockPosition = sql.indexOf('LOCK TABLE inbound_events IN SHARE MODE;');
    const inboundCheckPosition = sql.indexOf("processing_status IN ('received', 'processing')");
    const archivePosition = sql.indexOf('UPDATE conversations AS conversation');
    const auditPosition = sql.indexOf('INSERT INTO audit_logs');
    const commitPosition = sql.indexOf('COMMIT;');

    expect(sql).toContain("SET LOCAL lock_timeout = '3s';");
    expect(sql).toContain('expected exactly one closed conversation status');
    expect(sql).toContain('controlled test session reset did not close every active conversation');
    expect(beginPosition).toBeGreaterThanOrEqual(0);
    expect(lockPosition).toBeGreaterThan(beginPosition);
    expect(inboundCheckPosition).toBeGreaterThan(lockPosition);
    expect(archivePosition).toBeGreaterThan(inboundCheckPosition);
    expect(auditPosition).toBeGreaterThan(archivePosition);
    expect(commitPosition).toBeGreaterThan(auditPosition);
    expect(sql).toContain("RAISE EXCEPTION\n      'controlled test session has % queued/processing inbound event(s)'");
  });
});
