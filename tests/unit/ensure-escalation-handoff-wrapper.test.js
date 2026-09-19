import fs from 'node:fs';
import { createRequire } from 'node:module';
import { describe, expect, test } from 'vitest';

const require = createRequire(import.meta.url);

const fixturePath = 'tests/fixtures/workflow-nodes/wa-inbound-downstream-dispatcher/ensure-escalation-handoff.js';

const runCodeNode = (source, items, env = {}) => new Function('items', '$env', source)(items, env);

describe('Ensure Escalation Handoff — real n8n Code node wrapper', () => {
  test('the embedded wrapper (not the exported functions) returns a handoff scope for a real escalation', () => {
    const source = fs.readFileSync(fixturePath, 'utf8');
    const output = runCodeNode(source, [
      {
        json: {
          conversation_id: 100,
          phone_number: '56900000001',
          should_escalate: true,
          escalation_reason: 'frustration_detected',
          intent: 'complaint',
          text_body: 'Esto es un desastre, quiero hablar con una persona',
        },
      },
    ]);

    expect(output).toHaveLength(1);
    expect(output[0].json.handoff_write).toBe(true);
    expect(output[0].json.handoff_scope.conversation_id).toBe(100);
    expect(output[0].json.handoff_scope.motivo).toBe('complaint');
  });

  test('the embedded wrapper skips the handoff write when nothing escalates', () => {
    const source = fs.readFileSync(fixturePath, 'utf8');
    const output = runCodeNode(source, [
      {
        json: {
          conversation_id: 100,
          phone_number: '56900000001',
          should_escalate: false,
          escalation_area: 'none',
        },
      },
    ]);

    expect(output).toHaveLength(1);
    expect(output[0].json.handoff_write).toBe(false);
    expect(output[0].json.handoff_scope.motivo).toBeNull();
  });

  // There is no separate B2B area: it had no ClickUp assignees, so every
  // handoff routed there deferred for 6h and died in plain sight. A company or
  // a purchase order is commercial work and belongs to the sales executive, who
  // categorises the customer after the handoff.
  test.each([
    ['company reason', { escalation_reason: 'cliente es una constructora' }],
    ['purchase order reason', { escalation_reason: 'orden de compra lista' }],
    ['company intent', { intent: 'b2b_request' }],
    ['purchase order intent', { intent: 'purchase_order' }],
    ['persisted b2b area', { escalation_area: 'b2b' }],
  ])('%s routes the handoff to sales, never to the unstaffed b2b area', (_case, overrides) => {
    const source = fs.readFileSync(fixturePath, 'utf8');
    const [output] = runCodeNode(source, [{ json: {
      conversation_id: 100,
      phone_number: '56900000002',
      should_escalate: true,
      ...overrides,
    } }]);

    expect(output.json.handoff_write).toBe(true);
    expect(output.json.handoff_scope.area).toBe('sales');
    expect(output.json.handoff_scope.area_label).toBe('Ventas');
    expect(output.json.handoff_scope.responsable).toBe('Ejecutiva comercial');
  });

  test('no routing table entry can send a handoff to an area without assignees', () => {
    const { HANDOFF_ROUTING, AREA_FALLBACK, DEFAULT_ROUTING } = require(
      '../fixtures/workflow-nodes/wa-inbound-downstream-dispatcher/ensure-escalation-handoff.js',
    );

    const tables = [
      ...Object.values(HANDOFF_ROUTING),
      ...Object.values(AREA_FALLBACK),
      DEFAULT_ROUTING,
    ];
    expect(tables.length).toBeGreaterThan(0);
    for (const routing of tables) {
      expect(routing.area).not.toBe('b2b');
      expect(routing.responsable).not.toMatch(/B2B/i);
    }
  });

  // The sales area is the one this routing now depends on, so it has to be
  // deliverable end to end with an ordinary assignee mapping.
  test('a company handoff reaches a real ClickUp assignee', () => {
    const escalationSource = fs.readFileSync(fixturePath, 'utf8');
    const [escalation] = runCodeNode(escalationSource, [{ json: {
      conversation_id: 100,
      phone_number: '56900000002',
      should_escalate: true,
      intent: 'purchase_order',
    } }]);

    const clickupSource = fs.readFileSync(
      'tests/fixtures/workflow-nodes/ops-handoff-notification-scheduler/prepare-handoff-clickup-task.js',
      'utf8',
    );
    const dispatch = new Function('$json', '$env', clickupSource)({
      area: escalation.json.handoff_scope.area,
      area_label: escalation.json.handoff_scope.area_label,
      motivo: escalation.json.handoff_scope.motivo,
      prioridad: escalation.json.handoff_scope.prioridad,
      handoff_id: 11,
      operation_key: 'handoff:11',
      phone_number: '56900000002',
      conversation_id: 100,
    }, {
      CLICKUP_API_TOKEN: 'token-123',
      CLICKUP_HANDOFF_LIST_ID: '999',
      HANDOFF_CLICKUP_ASSIGNEES_JSON: JSON.stringify({ sales: [111, 222] }),
    });

    expect(dispatch.json.should_dispatch_clickup).toBe(true);
    expect(dispatch.json.clickup_config_error).toBeNull();
    expect(dispatch.json.clickup_payload.assignees).toEqual([111, 222]);
  });
});
