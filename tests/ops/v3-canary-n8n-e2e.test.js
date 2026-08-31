import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import { createMockAiServer } from '../fixtures/mock-ai-server.mjs';

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(testDirectory, '..', '..');
const harnessPath = path.join(repositoryRoot, 'scripts', 'ops', 'test-v3-canary-n8n-e2e.sh');
const mockAiPath = path.join(repositoryRoot, 'tests', 'fixtures', 'mock-ai-server.mjs');
const composePath = path.join(repositoryRoot, 'docker-compose.test.yml');
const packagePath = path.join(repositoryRoot, 'package.json');
const workflowPath = path.join(repositoryRoot, '.github', 'workflows', 'parity-validation.yml');

const source = (filePath) => fs.readFileSync(filePath, 'utf8');

describe('v3 canary E2E binding contract', () => {
  test('isolates every mutable boundary and refuses non-local providers', () => {
    const harness = source(harnessPath);

    expect(harness).toContain('whatsapp-v3-canary-e2e');
    expect(harness).toContain('docker compose --env-file /dev/null');
    expect(harness).not.toContain('E2E_COMPOSE_PROJECT_NAME');
    expect(harness).not.toContain('--env-file "$ROOT_DIR/.env"');
    expect(harness).toContain('TEST_POSTGRES_PORT=55434');
    expect(harness).toContain('TEST_N8N_PORT=55679');
    expect(harness).toContain('TEST_MOCK_AI_PORT=58081');
    expect(harness).toContain('TEST_MOCK_EVOLUTION_PORT=58082');
    expect(harness).toContain('AI_DIRECT_API_BASE_URL=http://mock-ai:8081');
    expect(harness).toContain('test "$EVOLUTION_API_BASE_URL" = http://mock-evolution:8080');
    expect(harness).toContain('label=com.docker.compose.project=$PRODUCTION_COMPOSE_PROJECT');
    expect(harness).toContain('production-containers-before.txt');
    expect(harness).toContain('production-containers-after.txt');
    expect(harness).toContain('{{.State.StartedAt}}|{{.State.Status}}|{{.RestartCount}}');
    expect(harness).not.toMatch(/curl[^\n]+https?:\/\/(?!127\.0\.0\.1)/);
  });

  test('seeds only the WhatsApp source number and binds the two turns plus replay', () => {
    const harness = source(harnessPath);
    const seed = harness.match(/# WU4_SEED_BEGIN([\s\S]*?)# WU4_SEED_END/)?.[1] || '';

    expect(seed).toContain('INSERT INTO whatsapp_numbers');
    expect(seed).not.toMatch(/INSERT INTO\s+(conversations|messages|inbound_events|handoffs|advisor_decisions)/i);
    expect(harness).toContain('synthetic-v3-canary-001');
    expect(harness).toContain('synthetic-v3-canary-002');
    expect(harness).toContain('post_event "$turn_two_payload" "$EVIDENCE_DIR/replay-response.json"');
    expect(harness).toContain('.status == "accepted" and .duplicate == true');
  });

  test('requires v3 authority, repair, exact delivery receipt, effects, and anti-legacy evidence', () => {
    const harness = source(harnessPath);

    for (const invariant of [
      "execution.contract_version = 'v3'",
      "execution.route_mode = 'canary'",
      "execution.route_rule_id = 'rollout:canary'",
      "execution.state = 'delivered'",
      "decision.decision_type = 'v3_system_contingency'",
      "decision.output_payload->>'schema' = 'system_contingency_decision/v3'",
      'execution.delivery_message_id = outgoing.id',
      'outgoing.idempotency_key = execution.delivery_key',
      "execution.delivery_receipt_ref->>'provider_message_id' = outgoing.external_message_id",
      "execution.delivery_receipt_ref->>'delivered_bytes_sha256' = decision.output_payload#>>'{reply,sha256}'",
      "receipt->>'schema' = 'internal_handoff_receipt/v3'",
      "receipt->>'status' = 'succeeded'",
      "legacy.idempotency_key LIKE 'evolution:%'",
    ]) {
      expect(harness, `missing invariant: ${invariant}`).toContain(invariant);
    }

    expect(harness).toContain("map(.repair) == [false, true]");
    expect(harness).toContain('before-replay.json');
    expect(harness).toContain('after-replay.json');
  });

  test('registers a dedicated local AI mock and an isolated CI job', () => {
    const compose = source(composePath);
    const packageJson = JSON.parse(source(packagePath));
    const workflow = source(workflowPath);

    expect(compose).toContain('mock-ai:');
    expect(compose).toContain('./tests/fixtures/mock-ai-server.mjs:/app/mock-ai-server.mjs:ro');
    expect(packageJson.scripts['test:e2e:v3-canary']).toBe('sh scripts/ops/test-v3-canary-n8n-e2e.sh');
    expect(workflow).toContain("- 'scripts/ops/test-v3-canary-n8n-e2e.sh'");
    expect(workflow).toContain('n8n-v3-canary-e2e:');
    expect(workflow).toContain('npm run test:e2e:v3-canary');
    expect(workflow).toContain('v3-canary-n8n-e2e-evidence');
    expect(fs.existsSync(mockAiPath)).toBe(true);
  });

  test('AI mock records initial and complete-repair prompts while returning invalid proposals', async () => {
    const server = createMockAiServer();
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address();
    const endpoint = `http://127.0.0.1:${port}`;
    const policy = { turn: { id: 'turn-7' }, policy_digest: 'a'.repeat(64) };
    const call = (repairRequest) => fetch(`${endpoint}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        messages: [{
          role: 'user',
          content: JSON.stringify({
            turn_policy: policy,
            ...(repairRequest ? { repair_request: repairRequest } : {}),
          }),
        }],
      }),
    }).then((response) => response.json());

    try {
      const initial = await call(null);
      const repaired = await call({ schema: 'ai_conversation_repair_request/v3' });
      const evidence = await fetch(`${endpoint}/requests`).then((response) => response.json());

      expect(JSON.parse(initial.choices[0].message.content)).toEqual({});
      expect(JSON.parse(repaired.choices[0].message.content)).toEqual({});
      expect(evidence.requests.map((request) => request.repair)).toEqual([false, true]);
      expect(evidence.requests.map((request) => request.turn_id)).toEqual(['turn-7', 'turn-7']);
      expect(evidence.requests.map((request) => request.policy_digest)).toEqual([
        'a'.repeat(64),
        'a'.repeat(64),
      ]);
    } finally {
      await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    }
  });
});
