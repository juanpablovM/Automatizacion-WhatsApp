import fs from 'node:fs';
import { createRequire } from 'node:module';
import { describe, expect, test } from 'vitest';

const require = createRequire(import.meta.url);
const fixtures = '../fixtures/workflow-nodes/';

// Every place that decides "this customer asked us to stop" must answer the
// same way. A customer who writes "no me escriban más" and still gets a
// follow-up the next day is the failure this suite exists to prevent.
const detectors = {
  shared: () => require(`${fixtures}shared/customer-opt-out-vocabulary.js`),
  dispatcher: () => require(`${fixtures}wa-inbound-downstream-dispatcher/ensure-follow-up-cancellation.js`),
  followUpPolicy: () => require(`${fixtures}ops-followup-scheduler/follow-up-policy.js`),
};

const OPT_OUT_MESSAGES = [
  'no me escriban más',
  'no me escriban mas',
  'mejor no, no me escriban más',
  'mejor no, no me escriban mas',
  'No me escribas más',
  'no me escribas mas',
  'no me escriba más',
  'no me contacten',
  'no me contacten más',
  'No me llamen más',
  'no me manden más mensajes',
  'no me envíes más mensajes',
  'no quiero que me escriban',
  'No quiero que me contacten más',
  'dejen de escribirme',
  'deja de escribirme',
  'Dejen de contactarme, por favor',
  'no me sigan escribiendo',
  'no me vuelvan a escribir',
  'bórrenme de la lista',
  'borrenme de la lista',
  'sáquenme de su lista',
  'quiero darme de baja',
  'dame de baja',
  'no quiero más mensajes',
  'no me molesten más',
  'STOP',
  'stop',
];

const ORDINARY_MESSAGES = [
  'no me escribieron el precio',
  'no me contactaron todavía',
  'no sé',
  'no',
  'mejor no',
  'escríbanme mañana',
  'no me llamo Juan',
  'no me llamen, escríbanme por acá',
  'no dejen de escribirme cuando llegue el stock',
  'necesito 50 m2 de pastelones',
  '¿me pueden hacer una rebaja en los pastelones?',
  'stopper de goma',
  '¿me pueden escribir por correo?',
  'no me molesta esperar',
  '',
];

describe.each(Object.entries(detectors))('%s opt-out detection', (_name, load) => {
  test.each(OPT_OUT_MESSAGES)('treats "%s" as an opt-out', (text) => {
    expect(load().detectOptOut(text)).toBe(true);
  });

  test.each(ORDINARY_MESSAGES)('does not treat "%s" as an opt-out', (text) => {
    expect(load().detectOptOut(text)).toBe(false);
  });

  test('reads lost intent with or without accents', () => {
    expect(load().detectLostIntent('Lo pensé y no quiero seguir')).toBe(true);
    expect(load().detectLostIntent('lo pense y no quiero seguir')).toBe(true);
    expect(load().detectLostIntent('necesito 50 m2 de pastelones')).toBe(false);
  });
});

describe('one opt-out vocabulary', () => {
  test('every consumer reuses the shared patterns instead of a private copy', () => {
    const shared = detectors.shared();
    for (const load of [detectors.dispatcher, detectors.followUpPolicy]) {
      expect(load().OPT_OUT_PATTERNS).toBe(shared.OPT_OUT_PATTERNS);
      expect(load().LOST_PATTERNS).toBe(shared.LOST_PATTERNS);
    }
  });

  test('the dispatcher nodes ship the shared vocabulary in their n8n code', () => {
    const shared = fs.readFileSync(
      'tests/fixtures/workflow-nodes/shared/customer-opt-out-vocabulary.js',
      'utf8',
    );
    const workflow = JSON.parse(fs.readFileSync('n8n/workflows/wa-inbound-downstream-dispatcher.json', 'utf8'));
    for (const name of ['Ensure Follow-Up Cancellation', 'Ensure Escalation Handoff']) {
      const node = workflow.nodes.find((candidate) => candidate.name === name);
      expect(node.parameters.jsCode.startsWith(shared)).toBe(true);
    }
  });

  test('the orchestrator node ships the shared vocabulary instead of a private copy', () => {
    const shared = fs.readFileSync(
      'tests/fixtures/workflow-nodes/shared/customer-opt-out-vocabulary.js',
      'utf8',
    );
    const workflow = JSON.parse(fs.readFileSync('n8n/workflows/wa-conversation-orchestrator.json', 'utf8'));
    const node = workflow.nodes.find((candidate) => candidate.name === 'Evaluate Conversation Step');
    expect(node.parameters.jsCode.startsWith(shared)).toBe(true);
    expect(node.parameters.jsCode.match(/const OPT_OUT_PATTERNS\b/g)).toHaveLength(1);
  });
});

describe('orchestrator turn after a plural opt-out', () => {
  test('the deployed Evaluate Conversation Step closes the request as an opt-out', async () => {
    const { runEvaluate } = await import('../fixtures/conversation/engine.mjs');
    const result = await runEvaluate({
      conversation_id: 100,
      has_active_conversation: true,
      conversation_status_code: 'waiting_user',
      current_step: 'confirm',
      message_type: 'text',
      text_body: 'mejor no, no me escriban más',
    });

    expect(result.escalation_reason).toBe('opt_out');
    expect(result.conversation_status_code).toBe('closed');
    expect(result.deterministic_reply).toBe('Entendido. No te escribiremos más.');
  });
});

describe('follow-up policy after a plural opt-out', () => {
  const workflow = () => JSON.parse(fs.readFileSync('n8n/workflows/wa-inbound-downstream-dispatcher.json', 'utf8'));
  const runNode = (name, row) => {
    const node = workflow().nodes.find((candidate) => candidate.name === name);
    return new Function('items', '$env', node.parameters.jsCode)([{ json: row }], {})[0].json;
  };
  const waitingReply = {
    inbound_event_id: 991,
    message_id: 551,
    inbound_created_at: '2026-09-25T10:30:00.000Z',
    conversation_id: 100,
    conversation_status_code: 'waiting_user',
    response_text: 'Entendido, no volveremos a escribirte.',
    text_body: 'mejor no, no me escriban más',
  };

  test('resolveCancellationAction opts the customer out and schedules nothing', () => {
    const { resolveCancellationAction } = detectors.dispatcher();
    const result = resolveCancellationAction(waitingReply);

    expect(result.follow_up_cancel_action).toBe('opt_out');
    expect(result.follow_up_cancel_reason).toBe('opt_out');
    expect(result.follow_up_should_schedule).toBe(false);
    expect(result.follow_up_scheduled_at).toBeNull();
  });

  test('the deployed Ensure Follow-Up Cancellation node does the same', () => {
    const result = runNode('Ensure Follow-Up Cancellation', waitingReply);

    expect(result.follow_up_cancel_action).toBe('opt_out');
    expect(result.follow_up_should_schedule).toBe(false);
  });

  test('an escalated plural opt-out is routed with the opt-out motive', () => {
    const result = runNode('Ensure Escalation Handoff', {
      conversation_id: 100,
      phone_number: '56900000001',
      should_escalate: true,
      text_body: 'no me contacten más',
    });

    expect(result.handoff_scope.motivo).toBe('opt_out');
  });
});
