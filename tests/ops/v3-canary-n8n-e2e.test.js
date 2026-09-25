import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { describe, expect, test } from 'vitest';
import { createMockAiServer } from '../fixtures/mock-ai-server.mjs';
import { prepareIsolatedV3Workflow } from '../../scripts/ops/prepare-v3-isolated-workflows.mjs';

const require = createRequire(import.meta.url);
const { buildV3PolicyInput } = require('../fixtures/workflow-nodes/shared/v3-policy-builder.js');
const { compileV3TurnPolicy, validateV3AiProposal } = require('../fixtures/workflow-nodes/shared/v3-contract-runtime.js');

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(testDirectory, '..', '..');
const harnessPath = path.join(repositoryRoot, 'scripts', 'ops', 'test-v3-canary-n8n-e2e.sh');
const mockAiPath = path.join(repositoryRoot, 'tests', 'fixtures', 'mock-ai-server.mjs');
const mockClickUpPath = path.join(repositoryRoot, 'tests', 'fixtures', 'mock-clickup-server.mjs');
const composePath = path.join(repositoryRoot, 'docker-compose.test.yml');
const packagePath = path.join(repositoryRoot, 'package.json');

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
    expect(harness).toContain('TEST_MOCK_CLICKUP_PORT=58083');
    expect(harness).toContain('AI_DIRECT_API_BASE_URL=http://mock-ai:8081');
    expect(harness).toContain('test "$EVOLUTION_API_BASE_URL" = http://mock-evolution:8080');
    expect(harness).toContain('test "$CLICKUP_API_BASE_URL" = http://mock-clickup:8083/api/v2');
    expect(harness).toContain('label=com.docker.compose.project=$PRODUCTION_COMPOSE_PROJECT');
    expect(harness).toContain('production-containers-before.txt');
    expect(harness).toContain('production-containers-after.txt');
    expect(harness).toContain('{{.State.StartedAt}}|{{.State.Status}}|{{.RestartCount}}');
    expect(harness).not.toMatch(/curl[^\n]+https?:\/\/[A-Za-z0-9]/);
    expect(harness).toContain("curl --noproxy '*'");
  });

  test('drives the valid lane, not only contingency', () => {
    // Two contingency turns prove the failure path and nothing else: thirteen
    // nodes of the valid lane — authority, execution, the effect loop, the lead
    // executor, the state commit — never run. A third turn installs a plan on
    // the AI mock so the proposal is valid, and asserts what only that lane
    // produces: a persisted authority, an executed effect and a real lead.
    const harness = source(harnessPath);
    const seed = harness.match(/# WU4_SEED_BEGIN([\s\S]*?)# WU4_SEED_END/)?.[1] || '';

    // Grounding authority comes from the catalog, so the valid turn needs one.
    expect(seed).toContain('INSERT INTO catalog_items');
    expect(seed).toContain('INSERT INTO sellers');
    expect(harness).toContain('synthetic-v3-canary-003');
    expect(harness).toContain('/plan');

    for (const invariant of [
      // Authorized, not a fallback: the contingency lane writes a different
      // decision type and never leaves an effect or state receipt behind.
      '.decision_type == "conversation_v3_authorized"',
      '.decision_version == "validated_conversation_decision/v3"',
      '.state_receipt_schema == "conversation_state_receipt/v3"',
      '.effect_receipt_version == "v3_effect_receipt/v1"',
      '.effect_receipt_status == "succeeded"',
      // The point of the lane: a real lead, created by the effect executor.
      '.leads_for_conversation == 1',
      '.clickup_task_id != null',
      '.seller_notification_status == "succeeded"',
      '.outgoing_text == .decision_reply_text',
    ]) {
      expect(harness, `missing valid-lane invariant: ${invariant}`).toContain(invariant);
    }
  });

  test('audits the delivery transition where the transition happens', () => {
    // `db/queries/.../10_transition_v3_execution.sql` is a generic compare-and-set
    // that audits `v3_turn_transitioned` with from/to state. It is orphaned: not
    // in the sync manifest, not embedded in any node, and no workflow emits that
    // event. The runtime moved the transition inline, into the same statement
    // that writes the receipt, so the effect and the state change commit
    // together — a stronger guarantee than a second round trip. The canary must
    // assert the audit that lane actually writes, and that audit must still
    // carry the state it moved to.
    const harness = source(harnessPath);

    expect(harness).not.toContain('v3_turn_transitioned');
    expect(harness).toContain("audit.event_name='v3_delivery_recorded'");
    expect(harness).toContain("audit.metadata->>'to_state'='delivered'");
  });

  test('reads decisions by version and receipts by schema', () => {
    // The v3 contracts split the two deliberately: a decision declares
    // `version` (`buildV3ContingencyDecision` emits it, and `Commit V3
    // Contingency` filters on `output_payload->>'version'`), while a receipt
    // declares `schema` (`internal_handoff_receipt/v3`, `v3_delivery_receipt/v1`).
    // The canary read decisions by `schema`, which is always NULL, so the whole
    // assertion could only ever be false once a turn reached it.
    const harness = source(harnessPath);

    expect(harness).not.toContain("decision.output_payload->>'schema'");
    expect(harness).toContain("decision.output_payload->>'version'");
    expect(harness).toContain("receipt->>'schema' = 'internal_handoff_receipt/v3'");
  });

  test('captures the v3 ledger rows when the turn never reaches delivered', () => {
    // The stack is torn down with `compose down -v` on the way out, so anything
    // not written to the evidence directory is gone. The n8n execution data
    // shows which node returned no rows but never why, and every v3 commit is a
    // single statement whose WHERE clause spans four tables.
    const harness = source(harnessPath);

    expect(harness).toContain('v3-ledger-state.json');
    for (const table of [
      'conversation_turn_executions',
      'advisor_decisions',
      'inbound_events',
      'handoffs',
      'messages',
    ]) {
      expect(harness, `ledger evidence misses ${table}`).toMatch(
        new RegExp(`v3_ledger_evidence[\\s\\S]*?FROM ${table}`, 'i'),
      );
    }
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
      "decision.output_payload->>'version' = 'system_contingency_decision/v3'",
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

  test('fails fast on n8n execution errors and preserves internal execution evidence', () => {
    const harness = source(harnessPath);

    expect(harness).toContain('n8n_execution_floor');
    expect(harness).toContain("''|*[!0-9]*)");
    expect(harness).not.toContain(":'execution_floor'");
    expect(harness).toContain("execution.status='error'");
    expect(harness).toContain('capture_n8n_failure_evidence');
    expect(harness).toContain('n8n-execution-summary.tsv');
    expect(harness).toContain('n8n-execution-data.tsv');
    expect(harness.indexOf('capture_n8n_failure_evidence')).toBeLessThan(
      harness.indexOf('compose down -v --remove-orphans'),
    );
  });

  test('registers dedicated local AI and ClickUp mocks and the harness command', () => {
    const compose = source(composePath);
    const packageJson = JSON.parse(source(packagePath));

    expect(compose).toContain('mock-ai:');
    expect(compose).toContain('mock-clickup:');
    expect(compose).toContain('./tests/fixtures/mock-ai-server.mjs:/app/mock-ai-server.mjs:ro');
    expect(compose).toContain('./tests/fixtures/mock-clickup-server.mjs:/app/mock-clickup-server.mjs:ro');
    expect(packageJson.scripts['test:e2e:v3-canary']).toBe('sh scripts/ops/test-v3-canary-n8n-e2e.sh');
    expect(fs.existsSync(mockAiPath)).toBe(true);
    expect(fs.existsSync(mockClickUpPath)).toBe(true);
  });

  test('restores cleanup after sourced preflight clears its temporary trap', () => {
    const harness = source(harnessPath);
    const validation = harness.indexOf('\n(validate_local)\n');
    expect(validation).toBeGreaterThan(harness.indexOf('SYNC_N8N_SOURCE_ONLY=yes'));
    const restoredTrap = harness.indexOf('trap cleanup EXIT HUP INT TERM', validation);
    expect(restoredTrap).toBeGreaterThan(validation);
    expect(restoredTrap).toBeLessThan(harness.indexOf('query_workflow_ids >', validation));
  });

  test('covers global enforce without allowlist and human ownership silence', () => {
    const harness = source(harnessPath);
    expect(harness).toContain('export TEST_AI_PRD_CONTRACT_MODE=enforce');
    expect(harness).toContain('test -z "$AI_PRD_CONTRACT_CANARY_PHONES"');
    expect(harness).toContain('synthetic-v3-enforce-005');
    expect(harness).toContain('.route_mode == "enforce"');
    expect(harness).toContain('.provider_message_id == .receipt_provider_message_id');
    expect(harness).toContain('synthetic-v3-human-owned-004');
    expect(harness).toContain('INSERT INTO lead_chat_ownerships');
    expect(harness).toContain('.outgoing_count == 0 and .v3_execution_count == 0 and .lead_count == 1');
    expect(harness).toContain('human-ai-before.json');
    expect(harness).toContain('human-ai-after.json');
    expect(harness).toContain('human-evolution-before.json');
    expect(harness).toContain('human-evolution-after.json');
  });

  test('binds distinct contingency command receipts to one preserved open handoff resource', () => {
    const harness = source(harnessPath);
    expect(harness).toContain("JOIN effect ON (effect.receipt->>'handoff_id')::BIGINT=handoff.id");
    expect(harness).toContain("effect.receipt->>'operation_key' = decision.output_payload#>>'{effect_commands,0,operation_key}'");
    expect(harness).toContain('.effect_receipt.operation_key == .requested_handoff_operation_key');
    expect(harness).toContain('.effect_receipt.persisted_resource_operation_key == .handoff_operation_key');
    expect(harness).toContain('.effect_receipt.requested_payload_digest == .requested_handoff_payload_digest');
    expect(harness).toContain('.effect_receipt.reused_existing == (.effect_receipt.operation_key != .handoff_operation_key)');
    expect(harness).toContain('.handoff_id == $first[0].handoff_id');
    expect(harness).toContain('.handoff_metadata_decision_id == $first[0].decision_id');
    expect(harness).toContain('.effect_receipt.operation_key != $first[0].effect_receipt.operation_key');
    expect(harness).toContain('and .handoffs == 1');
    expect(harness).not.toContain('and .handoffs == 2');
  });

  test('installed harness plan generates a valid strict delivery proposal, then clearing restores contingency', async () => {
    const harness = source(harnessPath);
    const plan = JSON.parse(harness.match(/<<'PLAN'\n([\s\S]*?)\nPLAN/)?.[1] || '{}');
    const message = harness.match(/turn_three_payload=\$\(build_payload[^\n]+\n\s*'([^']+)'/)?.[1];
    const policy = compileV3TurnPolicy(buildV3PolicyInput({
      inbound_event_id: 'mock-valid-turn', conversation_id: 'mock-conversation',
      external_message_id: 'mock-valid-message', text_body: message,
      qualification_context: {},
      v3_grounding: { catalog: [{ ref: 'product:H25', concept: 'product', value: 'hormigon H25' }] },
    }));
    const server = createMockAiServer();
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const endpoint = `http://127.0.0.1:${server.address().port}`;
    const call = () => fetch(`${endpoint}/chat/completions`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ messages: [{ role: 'user', content: JSON.stringify({ turn_policy: policy }) }] }),
    }).then((response) => response.json());
    try {
      const installed = await fetch(`${endpoint}/plan`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(plan),
      }).then((response) => response.json());
      expect(installed.status).toBe('planned');
      const response = await call();
      const proposal = JSON.parse(response.choices[0].message.content);
      expect(proposal.version).toBe('ai_conversation_proposal/v3');
      const validation = validateV3AiProposal(policy, proposal);
      expect(validation.errors).toEqual([]);
      expect(validation.valid).toBe(true);
      expect(validation.authorized_effect_requests.map((effect) => effect.type)).toEqual(['create_lead']);
      await fetch(`${endpoint}/plan`, { method: 'DELETE' });
      expect(JSON.parse((await call()).choices[0].message.content)).toEqual({});
    } finally {
      await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });

  test('redirects computed provider builders before import and blocks unknown endpoints', () => {
    const harness = source(harnessPath);
    expect(harness).toContain('-f "$COMPOSE_FILE" -f "$COMPOSE_EGRESS_OVERRIDE"');
    const networkOverride = source(path.join(repositoryRoot, 'docker-compose.v3-e2e.yml'));
    expect(networkOverride).toContain('internal: true');
    for (const stage of ['bootstrap', 'resolved']) {
      const guard = harness.indexOf(`prepare-v3-isolated-workflows.mjs" "$tmp_dir/${stage}"`);
      expect(guard).toBeGreaterThan(0);
      expect(guard).toBeLessThan(harness.indexOf(`copy_and_import "$tmp_dir/${stage}"`));
    }
    const workflow = JSON.parse(source(path.join(repositoryRoot, 'n8n/workflows/crm-clickup-sync-lead.json')));
    const isolated = prepareIsolatedV3Workflow(workflow);
    const builder = isolated.nodes.find((node) => node.name === 'Build ClickUp Payload');
    const env = { CLICKUP_API_TOKEN: 'test-token', CLICKUP_LEADS_LIST_ID: 'synthetic-leads' };
    const result = new Function('items', '$env', builder.parameters.jsCode)([{ json: {
      lead_id: 1, phone_number: '15550001111', whatsapp_name: 'Synthetic Contact',
      service: 'despacho', city: 'Santiago', requirement: '20 m3 hormigon H25', clickup_user_id: '7001',
    } }], env);
    expect(result[0].json.clickup_task_url).toBe('http://mock-clickup:8083/api/v2/list/synthetic-leads/task');
    expect(JSON.stringify(isolated.nodes)).not.toContain('https://api.clickup.com');
    expect(JSON.stringify(workflow.nodes)).toContain('https://api.clickup.com');
    const aiWorkflow = JSON.parse(source(path.join(repositoryRoot, 'n8n/workflows/ai-lead-qualification-assistant.json')));
    const isolatedAi = prepareIsolatedV3Workflow(aiWorkflow);
    const aiBuilder = isolatedAi.nodes.find((node) => node.name === 'Build AI Request');
    expect(aiBuilder.parameters.jsCode).toContain('http://mock-ai:8081');
    expect(JSON.stringify(isolatedAi.nodes)).not.toContain('https://api.openai.com');
    expect(JSON.stringify(aiWorkflow.nodes)).toContain('https://api.openai.com');
    const sellerWorkflow = prepareIsolatedV3Workflow(JSON.parse(source(path.join(repositoryRoot, 'n8n/workflows/crm-seller-notification-dispatch.json'))));
    const sellerBuilder = sellerWorkflow.nodes.find((node) => node.name === 'Build Seller Notification');
    const sellerResult = new Function('items', '$env', sellerBuilder.parameters.jsCode)([{ json: {
      lead_id: 1, clickup_task_id: 'synthetic-task', clickup_user_id: '7001',
    } }], env);
    expect(sellerResult[0].json.notification_url).toBe('http://mock-clickup:8083/api/v2/task/synthetic-task/comment');
    expect(() => prepareIsolatedV3Workflow({ nodes: [{ parameters: { jsCode: "fetch('https://unknown-provider.example/send')" } }] })).toThrow(/refuses external embedded URL/);
    for (const file of fs.readdirSync(path.join(repositoryRoot, 'n8n/workflows')).filter((name) => name.endsWith('.json'))) {
      expect(() => prepareIsolatedV3Workflow(JSON.parse(source(path.join(repositoryRoot, 'n8n/workflows', file))))).not.toThrow();
    }
    expect(harness).toContain('valid-clickup-provider-evidence.json');
    expect(harness).toContain('.parsed_body.assignee == 7001');
  });

  test('uses only inspected dedicated internal bridge hosts and refreshes recreated n8n', () => {
    const harness = source(harnessPath);
    expect(harness).toContain('.[0].Config.Labels["com.docker.compose.project"] == $project');
    expect(harness).toContain('(.[0].NetworkSettings.Networks | length) == 1');
    expect(harness).toContain("docker network inspect --format '{{.Internal}}'");
    expect(harness).toContain('TEST_PGHOST=$(resolve_internal_host postgres)\nexport TEST_PGHOST');
    expect(harness).toContain('export TEST_PGPORT=5432');
    expect(harness).toContain('http://${TEST_N8N_HOST}:5678/webhook/');
    expect(harness).toContain('http://${TEST_MOCK_AI_HOST}:8081/requests');
    expect(harness).toContain('http://${TEST_MOCK_EVOLUTION_HOST}:8080/requests');
    expect(harness).toContain('http://${TEST_MOCK_CLICKUP_HOST}:8083/requests');
    const recreate = harness.indexOf('compose up -d --wait --force-recreate n8n');
    const refresh = harness.indexOf('TEST_N8N_HOST=$(resolve_internal_host n8n)', recreate);
    expect(refresh).toBeGreaterThan(recreate);
    expect(refresh).toBeLessThan(harness.indexOf('post_event "$enforce_payload"', recreate));
    expect(harness).not.toContain('docker network connect');
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
