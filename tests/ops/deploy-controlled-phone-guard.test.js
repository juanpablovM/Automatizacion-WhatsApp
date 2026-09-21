import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, test } from 'vitest';

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(testDirectory, '..', '..');
const sourceScript = path.join(repositoryRoot, 'scripts', 'dev', 'sync-n8n-workflows.sh');
const temporaryDirectories = [];

// The deploy drives a real acceptance: the inbound is synthetic, but the reply
// leaves through Evolution and the run creates a lead, an assignment and a
// ClickUp task. A mistyped digit would aim all of that at a stranger, so the
// number must match the one the repository authorises before anything runs.
const createFixture = (controlledPhoneNumber = '56900000000') => {
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'deploy-phone-guard-'));
  temporaryDirectories.push(fixtureRoot);

  fs.mkdirSync(path.join(fixtureRoot, 'scripts', 'dev'), { recursive: true });
  fs.mkdirSync(path.join(fixtureRoot, 'bin'), { recursive: true });
  fs.copyFileSync(sourceScript, path.join(fixtureRoot, 'scripts', 'dev', 'sync-n8n-workflows.sh'));
  fs.writeFileSync(path.join(fixtureRoot, 'docker-compose.yml'), 'name: deploy-phone-guard-test\n');
  fs.writeFileSync(
    path.join(fixtureRoot, '.env'),
    `CONTROLLED_TEST_PHONE_NUMBER=${controlledPhoneNumber}\nPOSTGRES_USER=test_user\n`,
  );

  // Any real tool call means the guard let an unauthorised number through.
  const reachedLog = path.join(fixtureRoot, 'reached.log');
  for (const tool of ['docker', 'curl', 'jq', 'node']) {
    fs.writeFileSync(
      path.join(fixtureRoot, 'bin', tool),
      `#!/bin/sh\nprintf '%s %s\\n' "${tool}" "$*" >> "$REACHED_LOG"\nexit 0\n`,
      { mode: 0o755 },
    );
  }

  return { fixtureRoot, reachedLog };
};

const runDeploy = ({ fixtureRoot, reachedLog }, phoneNumber) => spawnSync(
  'sh',
  [path.join(fixtureRoot, 'scripts', 'dev', 'sync-n8n-workflows.sh'), '--deploy', phoneNumber],
  {
    cwd: fixtureRoot,
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${path.join(fixtureRoot, 'bin')}:${process.env.PATH}`,
      REACHED_LOG: reachedLog,
      E2E_ALLOW_EXTERNAL_EFFECTS: 'yes',
    },
  },
);

afterEach(() => {
  while (temporaryDirectories.length > 0) {
    fs.rmSync(temporaryDirectories.pop(), { recursive: true, force: true });
  }
});

describe('deploy refuses any phone number the repository did not authorise', () => {
  test('refuses a number that is not the configured controlled one', () => {
    const fixture = createFixture('56900000000');
    const result = runDeploy(fixture, '56911111111');

    expect(result.status).not.toBe(0);
    expect(`${result.stderr}${result.stdout}`).toMatch(/no esta autorizado|not authorized/i);
    expect(fs.existsSync(fixture.reachedLog)).toBe(false);
  });

  test('refuses a single mistyped digit', () => {
    const fixture = createFixture('56997093038');
    const result = runDeploy(fixture, '56997093039');

    expect(result.status).not.toBe(0);
    expect(fs.existsSync(fixture.reachedLog)).toBe(false);
  });

  test('refuses when the repository authorises no number at all', () => {
    const fixture = createFixture('');
    const result = runDeploy(fixture, '56997093038');

    expect(result.status).not.toBe(0);
    expect(`${result.stderr}${result.stdout}`).toMatch(/CONTROLLED_TEST_PHONE_NUMBER/);
    expect(fs.existsSync(fixture.reachedLog)).toBe(false);
  });

  test('refuses a phone argument that is not digits', () => {
    const fixture = createFixture('56997093038');
    const result = runDeploy(fixture, '569970930ab');

    expect(result.status).not.toBe(0);
    expect(fs.existsSync(fixture.reachedLog)).toBe(false);
  });

  test('lets the authorised number through to the release gate', () => {
    const fixture = createFixture('56997093038');
    const result = runDeploy(fixture, '56997093038');
    const output = `${result.stderr}${result.stdout}`;

    // The run still fails further along, because the fixture has no repository
    // to deploy. What matters is that it failed for some later reason and not
    // because the guard rejected an authorised number.
    expect(output).not.toMatch(/no esta autorizado/i);
    expect(output).not.toMatch(/CONTROLLED_TEST_PHONE_NUMBER/);
    expect(output).not.toMatch(/solo digitos/i);
  });

  test('checks the number before it reaches the release gate', () => {
    const source = fs.readFileSync(sourceScript, 'utf8');
    const guard = source.indexOf('CONTROLLED_TEST_PHONE_NUMBER');
    const acceptance = source.indexOf('run_controlled_acceptance "$controlled_phone"');

    expect(guard).toBeGreaterThan(-1);
    expect(acceptance).toBeGreaterThan(-1);
  });
});
