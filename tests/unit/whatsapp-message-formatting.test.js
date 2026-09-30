import fs from 'node:fs';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { describe, expect, test } from 'vitest';
import { evaluateConversationStep } from '../fixtures/workflow-nodes/wa-conversation-orchestrator/evaluate-conversation-step.js';
import { checkItemizedFinalConfirmation } from '../ops/v3-line-items-live-replay.mjs';

// Task 3c.22 (owner request): every message the bot sends on WhatsApp uses the
// same presentation — short paragraphs separated by a blank line, the question
// last and alone on its line (optionally prefixed with "👉 "), *bold* with
// single asterisks only for key data and summary section titles, and at most
// three emojis from a fixed set. The final confirmation summary carries no
// emoji at all. Presentation only: no message changes what it promises.

const require = createRequire(import.meta.url);
const { buildV3PolicyInput } = require('../fixtures/workflow-nodes/shared/v3-policy-builder.js');
const { compileV3TurnPolicy, validateV3AiProposal } = require('../fixtures/workflow-nodes/shared/v3-contract-runtime.js');
const sagaRuntime = require('../fixtures/workflow-nodes/shared/v3-saga-runtime.js');
// build-v3-repair.js is the workflow node itself: load only its runtime half
// (everything before the node's own item handling).
const repairNode = (() => {
  const source = fs.readFileSync('tests/fixtures/workflow-nodes/wa-conversation-orchestrator/build-v3-repair.js', 'utf8');
  const module = { exports: {} };
  new Function('module', 'require', source.slice(0, source.indexOf('\nconst mergedInput')))(module, require);
  return module.exports;
})();
const followUpPolicy = require('../fixtures/workflow-nodes/ops-followup-scheduler/follow-up-policy.js');

const ALLOWED_EMOJIS = new Set(['👋', '👉', '✅', '👍', '📋']);
const emojisOf = (text) => text.match(/\p{Extended_Pictographic}/gu) || [];

// The shared presentation contract, checked on every fixed message.
const expectWhatsAppStyle = (text) => {
  expect(text).not.toMatch(/\*\*/);
  expect(text).not.toMatch(/^\s*#/m);
  expect(text).toBe(text.trim());
  expect(text).not.toMatch(/\n{3,}/);
  const emojis = emojisOf(text);
  expect(emojis.length).toBeLessThanOrEqual(3);
  for (const emoji of emojis) expect(ALLOWED_EMOJIS.has(emoji), `emoji ${emoji} is outside the fixed set`).toBe(true);
  const questionLines = text.split('\n').filter((line) => line.includes('?'));
  expect(questionLines.length).toBeLessThanOrEqual(1);
  if (questionLines.length === 1) {
    const lines = text.split('\n');
    expect(lines[lines.length - 1]).toBe(questionLines[0]);
    expect(questionLines[0]).toMatch(/^(?:👉 )?¿[^?]*\?$/u);
  }
};

const fixturePath = 'tests/fixtures/workflow-nodes/ai-lead-qualification-assistant/build-ai-request.js';
const openAiEnv = { AI_PROVIDER: 'openai', OPENAI_API_KEY: 'fake-key-123' };
const turnPolicy = (version) => ({
  version, policy_digest: 'a'.repeat(64), facts: [],
  goals: version === 'ai_prd_turn_policy/v3.1' ? [{ goal_id: 'line_items' }] : [{ goal_id: 'product' }, { goal_id: 'quantity' }],
  state_authority: { allowed_mutations: [] }, effect_authority: { permissions: [] }, grounding: {},
});
const systemPromptFor = (version) => {
  const source = fs.readFileSync(fixturePath, 'utf8');
  const output = new Function('items', '$env', source)([{ json: { contract_version: 'v3', turn_policy: turnPolicy(version) } }], openAiEnv);
  return output[0].json.ai_request.input[0].content;
};

describe('v3.1 prompt — WhatsApp presentation rules (task 3c.22)', () => {
  const v31Prompt = systemPromptFor('ai_prd_turn_policy/v3.1');
  const v3Prompt = systemPromptFor('ai_prd_turn_policy/v3');

  test('asks for short paragraphs, the question last on its own line and single-asterisk bold for key data', () => {
    expect(v31Prompt).toContain('Formato de WhatsApp para reply_text');
    expect(v31Prompt).toContain('párrafos cortos separados por una línea en blanco');
    expect(v31Prompt).toContain('la pregunta va siempre al final, sola en su propia línea');
    expect(v31Prompt).toContain('"👉 "');
    expect(v31Prompt).toContain('*negrita* con un solo asterisco');
    expect(v31Prompt).toContain('nombres de productos, cantidades y medidas');
    expect(v31Prompt).toContain('Nunca uses encabezados con #, doble asterisco');
    expect(v31Prompt).toContain('¡Hola! 👋 Soy Hormi Atención de *Hormiglass*.');
    expect(v31Prompt).toContain('sin espacios ni saltos de línea al inicio o al final');
  });

  test('limits emojis to the fixed set, at most three per message, instead of the v3 one-emoji rule', () => {
    expect(v31Prompt).toContain('solo de este conjunto: 👋 👉 ✅ 👍 📋');
    expect(v31Prompt).toContain('como máximo tres por mensaje');
    expect(v31Prompt).not.toContain('como máximo uno por mensaje');
    expect(v3Prompt).toContain('como máximo uno por mensaje');
  });

  test('carries the exact final confirmation summary template, with no emojis in the summary', () => {
    for (const piece of [
      '*Resumen de tu cotización*', '*Productos*', '• Alambre Concertina — 500 m',
      '• Cierros de Hormigón — 500 m × 1,80 m de alto', '*Instalación*', '*Despacho*',
      '*Retiro en fábrica*', 'Portezuelo 1502, San Bernardo', '*Datos de facturación*',
      '¿Está todo correcto?', 'sin emojis',
    ]) {
      expect(v31Prompt).toContain(piece);
    }
    expect(v31Prompt).toContain('una línea "•" por cada ítem');
    expect(v31Prompt).not.toContain('resume los datos en una lista breve (una línea por dato, con "•") antes de la pregunta');
    expect(v3Prompt).toContain('resume los datos en una lista breve (una línea por dato, con "•") antes de la pregunta');
  });

  test('the new-request example uses an emoji from the fixed set in v3.1 only', () => {
    expect(v31Prompt).toContain('"¡Claro! Empecemos una nueva cotización 👍"');
    expect(v31Prompt).not.toContain('Empecemos una nueva cotización 😊');
    expect(v3Prompt).toContain('Empecemos una nueva cotización 😊');
  });

  test('keeps the multi-item "•" rule the harness relies on', () => {
    expect(v31Prompt).toContain('resume con una línea "•" por ítem indicando su cantidad');
  });
});

describe('v3.1 validator — formatted replies keep every guardrail (task 3c.22)', () => {
  const v31PolicyFor = (text = 'Gracias', context = {}, extra = {}) => compileV3TurnPolicy(buildV3PolicyInput({
    inbound_event_id: 3221, conversation_id: 322, external_message_id: 'format-v31',
    text_body: text, qualification_context: context, ...extra,
  }, { version: 'v3.1' }));
  const v31Proposal = (policy, overrides = {}) => ({
    version: 'ai_conversation_proposal/v3.1', policy_digest: policy.policy_digest,
    reply_text: 'Gracias.', primary_request: null,
    catalog_resolutions: [], observations: [], state_mutations: [], effect_requests: [], ...overrides,
  });
  const claimCodes = (validation) => validation.errors
    .filter((error) => error.code === 'forbidden_claim')
    .flatMap((error) => error.related_ids);

  test.each([
    ['plain', 'Listo, ya derivado al equipo.', 'no_unreceipted_derivation'],
    ['bold word', 'Listo, ya *derivado* al equipo.', 'no_unreceipted_derivation'],
    ['bold phrase', 'Listo, *ya derivado* al equipo 👍', 'no_unreceipted_derivation'],
    ['bold across the claim', '*Tu cotización* ya está en proceso.', 'no_unreceipted_quote_progress'],
    ['strikethrough and italics', 'Tu _cotización_ ~ya~ está en proceso.', 'no_unreceipted_quote_progress'],
    ['bold stock', 'Tenemos *stock* disponible.', 'no_stock_confirmation'],
    ['paragraphs', 'Gracias por esperar.\n\nCoordinaremos todo para que *recibas tu material pronto*.', 'no_unreceipted_delivery_progress'],
  ])('a forbidden claim is still rejected when formatted (%s)', (_label, replyText, ruleId) => {
    const policy = v31PolicyFor();
    const validation = validateV3AiProposal(policy, v31Proposal(policy, { reply_text: replyText }));
    expect(validation.valid).toBe(false);
    expect(claimCodes(validation)).toContain(ruleId);
  });

  test('a formatted reply with no forbidden claim is accepted', () => {
    const policy = v31PolicyFor();
    const validation = validateV3AiProposal(policy, v31Proposal(policy, {
      reply_text: '¡Gracias! 👍\n\nQuedo atento a lo que necesites.',
    }));
    expect(validation.errors).toEqual([]);
  });

  const pickupContext = { product: 'Bloques', quantity: '120 unidades', service_scope: 'material', fulfillment: 'pickup' };
  const pickupFinalConfirmation = (replyText) => {
    const policy = v31PolicyFor('Quiero retirar en fábrica', pickupContext);
    return validateV3AiProposal(policy, v31Proposal(policy, {
      reply_text: replyText, primary_request: { goal_id: 'final_confirmation', item_ref: null },
    }));
  };

  test('the formatted pickup summary satisfies the factory address rule', () => {
    const validation = pickupFinalConfirmation([
      '¡Perfecto! Quedan 120 unidades de bloques.',
      '',
      '*Resumen de tu cotización*',
      '',
      '*Productos*',
      '• Bloques de Hormigón — 120 unidades',
      '',
      '*Retiro en fábrica*',
      'Portezuelo 1502, San Bernardo',
      '',
      '¿Está todo correcto?',
    ].join('\n'));
    expect(validation.valid).toBe(true);
  });

  test('a bolded factory address still satisfies the rule', () => {
    expect(pickupFinalConfirmation('Retiras en *Portezuelo 1502*, *San Bernardo*.\n\n¿Está todo correcto?').valid).toBe(true);
    expect(pickupFinalConfirmation('Retiras en Portezuelo *1502, San* Bernardo.\n\n¿Está todo correcto?').valid).toBe(true);
  });

  test('a formatted pickup summary without the factory address is still rejected', () => {
    const validation = pickupFinalConfirmation('*Resumen de tu cotización*\n\n*Retiro en fábrica*\nEn nuestra planta\n\n¿Está todo correcto?');
    expect(validation.valid).toBe(false);
    expect(validation.errors).toContainEqual(expect.objectContaining({ code: 'pickup_factory_address_required' }));
  });
});

describe('v3 validator — formatted replies keep every guardrail on the rollback path (task 3c.22)', () => {
  const validateV3Reply = (replyText) => {
    const policy = compileV3TurnPolicy(buildV3PolicyInput({
      inbound_event_id: 'format-v3', conversation_id: 'format-v3-conversation', text_body: 'Gracias', qualification_context: {},
    }));
    return validateV3AiProposal(policy, {
      version: 'ai_conversation_proposal/v3', policy_digest: policy.policy_digest,
      reply_text: replyText, primary_request: null,
      catalog_resolution: { status: 'not_applicable', evidence_quote: null, evidence_occurrence: null, grounding_ref: null },
      observations: [], state_mutations: [], effect_requests: [],
    });
  };

  test.each([
    ['Tu solicitud ya *derivada* al equipo.', 'no_unreceipted_derivation'],
    ['*Tu cotización* ya está en proceso.', 'no_unreceipted_quote_progress'],
  ])('still rejects %s', (replyText, ruleId) => {
    expect(validateV3Reply(replyText).errors).toContainEqual(expect.objectContaining({ code: 'forbidden_claim', related_ids: [ruleId] }));
  });

  test('accepts a formatted reply with no forbidden claim', () => {
    expect(validateV3Reply('¡Gracias! 👍\n\nQuedo atento.').errors).toEqual([]);
  });
});

describe('live-replay harness — the owner summary template keeps one "•" line per item', () => {
  test('the exact owner template counts one bullet per item', () => {
    const text = [
      '¡Perfecto! Quedan 500 metros para cada alambre.',
      '',
      '*Resumen de tu cotización*',
      '',
      '*Productos*',
      '• Alambre Concertina — 500 m',
      '• Alambre de Púas — 500 m',
      '• Cierros de Hormigón — 500 m × 1,80 m de alto',
      '',
      '*Instalación*',
      'Zxc 2314, Lo Prado',
      'Terreno con desniveles · camión llega hasta cierto punto',
      'Con retiro de escombros',
      '',
      '¿Está todo correcto?',
    ].join('\n');
    const result = checkItemizedFinalConfirmation({
      decision: { primary_request: { goal_id: 'final_confirmation', item_ref: null }, reply: { text } },
      qualificationContext: { line_items: [{ item_id: 'li_a' }, { item_id: 'li_b' }, { item_id: 'li_c' }] },
    });
    expect(result).toEqual({ checked: true, itemCount: 3, bulletCount: 3, matches: true });
    expect(emojisOf(text)).toEqual([]);
  });
});

describe('fixed messages — WhatsApp presentation (task 3c.22)', () => {
  const root = 'tests/fixtures/workflow-nodes/';
  const code = (path, row) => new Function('items', '$env', fs.readFileSync(root + path, 'utf8'))([{ json: row }], {})[0].json;
  const baseRow = {
    phone_number: 'format-fixed', conversation_id: 322, target_conversation_id: 322,
    has_existing_conversation: true, has_active_conversation: true, is_recent_conversation: true,
    is_stale_context: false, is_reengagement: false, conversation_status_code: 'waiting_user',
    current_step: 'requirement', message_type: 'text', qualification_context: {},
  };
  // The deterministic step hands its copy over as deterministic_reply; Apply AI
  // Assistance sends it verbatim on these control turns.
  const evaluate = (text, extra = {}) => evaluateConversationStep({ ...baseRow, ...extra, text_body: text }).json;
  const reengagement = {
    has_active_conversation: false, is_recent_conversation: false, is_stale_context: true,
    is_reengagement: true, elapsed_hours_since_last_inbound: 78,
  };

  test('previous-context choice', () => {
    const out = evaluate('Hola', reengagement);
    expect(out.response_kind).toBe('previous_context_choice');
    expect(out.deterministic_reply).toBe('¡Hola de nuevo! 👋\n\n👉 ¿Prefieres continuar con la solicitud anterior o iniciar una nueva?');
    expectWhatsAppStyle(out.deterministic_reply);
  });

  test.each([
    ['Háblame mañana', 'De acuerdo, dejamos la conversación pendiente para mañana 👍\n\nCuando retomes, seguimos con tu solicitud.'],
    ['Háblame pasado mañana', 'De acuerdo, lo dejamos pendiente 👍\n\nCuando quieras retomar, seguimos con tu solicitud.'],
    ['Gracias', '¡Gracias! 👋\n\nAquí estaremos cuando quieras retomar.'],
  ])('previous-context courtesy reply to %s', (text, expected) => {
    const out = evaluate(text, reengagement);
    expect(out.deterministic_reply).toBe(expected);
    expectWhatsAppStyle(out.deterministic_reply);
  });

  test('opt-out confirmation stays one short line with no emoji', () => {
    const out = evaluate('No me escribas más');
    expect(out.deterministic_reply).toBe('Entendido. No te escribiremos más.');
    expect(emojisOf(out.deterministic_reply)).toEqual([]);
  });

  test('lost-interest closure splits into two paragraphs with no emoji', () => {
    const out = evaluate('Ya no me interesa');
    expect(out.escalation_reason).toBe('abandoned');
    expect(out.deterministic_reply).toBe('Entendido, cerramos tu solicitud.\n\nSi necesitas algo más, aquí estaremos.');
    expect(emojisOf(out.deterministic_reply)).toEqual([]);
    expectWhatsAppStyle(out.deterministic_reply);
  });

  test('escalation already required', () => {
    const out = evaluate('Hola?', { conversation_status_code: 'escalation_required', escalation_reason: 'human_requested' });
    expect(out.deterministic_reply).toBe('Tu solicitud ya está derivada a una persona del equipo 👍\n\nSi necesitas una cotización distinta, escribe *nueva cotización*.');
    expectWhatsAppStyle(out.deterministic_reply);
  });

  test('commercial review pending', () => {
    const out = evaluate('Gracias', { conversation_status_code: 'handed_to_sales', lead_id: 90 });
    expect(out.response_kind).toBe('commercial_review_pending');
    expect(out.deterministic_reply).toBe('Tu solicitud ya está registrada ✅\n\nEstá pendiente de revisión por el equipo comercial.');
    expectWhatsAppStyle(out.deterministic_reply);
  });

  const escalationRow = {
    ...baseRow, response_kind: 'escalation_routing', should_create_lead: false, should_escalate: true,
    escalation_area: '', intent: 'provide_info', confidence: 0.9, commercial_missing_fields: [],
    catalog_matches: [], price_context: {}, objection_detected: 'none', customer_type: '', lead_class: '',
  };

  test.each([
    ['confirmation_rejection_loop', 'No quiero hacerte repetir lo mismo.\n\nTe derivaré con una persona del equipo para continuar.'],
    ['human_requested', 'Por supuesto 👍\n\nTe derivaré con una persona del equipo para que continúe contigo.'],
  ])('escalation routing copy for %s', (reason, expected) => {
    const out = code('wa-conversation-orchestrator/apply-ai-assistance.js', { ...escalationRow, escalation_reason: reason });
    expect(out.response_text).toBe(expected);
    expectWhatsAppStyle(out.response_text);
  });

  test.each([
    ['provider_outage', 'No pude completar la gestión automática.\n\nDerivé el caso al equipo para revisión.'],
    ['no_progress_commercial_question_loop', 'No quiero hacerte repetir lo mismo.\n\nRegistré el caso para revisión por una persona del equipo.'],
  ])('contingency copy for %s is the same in the shared runtime and the workflow node', (reason, expected) => {
    for (const runtime of [sagaRuntime, repairNode]) {
      const decision = runtime.buildV3ContingencyDecision({
        policy: { version: 'ai_prd_turn_policy/v3.1', policy_digest: 'digest-format', turn: { id: 'turn-format' } },
        reason, expectedSnapshotDigest: 'snapshot',
      });
      expect(decision.reply.text).toBe(expected);
      expect(decision.reply.sha256).toBe(runtime.sha256(expected));
      expectWhatsAppStyle(decision.reply.text);
    }
  });

  const prepareVerifiedHandoff = (row) => {
    const workflow = JSON.parse(fs.readFileSync('n8n/workflows/wa-inbound-downstream-dispatcher.json', 'utf8'));
    const node = workflow.nodes.find((candidate) => candidate.name === 'Prepare Verified Handoff');
    return new vm.Script(`(() => { ${node.parameters.jsCode} })()`).runInNewContext({ items: [{ json: row }] })[0].json;
  };

  test('lead handoff confirmation, assigned and unassigned', () => {
    const assigned = prepareVerifiedHandoff({
      lead_id: 75, conversation_id: 95, phone_number: '56900000000', assignment_result: 'assigned', assigned_seller_id: 4,
    });
    expect(assigned.response_text).toBe('Gracias, ya registré tu solicitud y quedó asignada al equipo comercial ✅\n\nUna ejecutiva revisará los antecedentes para preparar una cotización acorde a tu proyecto.');
    expect(assigned.message).toBe(assigned.response_text);
    expectWhatsAppStyle(assigned.response_text);

    const unassigned = prepareVerifiedHandoff({
      lead_id: 76, conversation_id: 96, phone_number: '56900000001', assignment_result: 'failed', assigned_seller_id: null,
    });
    expect(unassigned.response_text).toBe('Gracias, ya registré tu solicitud ✅\n\nEl equipo comercial podrá revisar el caso sin que tengas que repetir la información.');
    expect(unassigned.response_text).not.toContain('asignada');
    expectWhatsAppStyle(unassigned.response_text);
  });

  const prepareFollowUpSource = fs.readFileSync(root + 'ops-followup-scheduler/prepare-follow-up-message.js', 'utf8');
  const followUpModule = (() => {
    const module = { exports: {} };
    new Function('module', 'items', '$env', prepareFollowUpSource)(module, undefined, {});
    return module.exports;
  })();
  const allFollowUps = (messages) => Object.values(messages)
    .flatMap((entry) => (typeof entry === 'string' ? [entry] : Object.values(entry)));

  test('follow-up templates use tú, accents and the shared presentation', () => {
    const templates = [...allFollowUps(followUpModule.MESSAGES), ...allFollowUps(followUpModule.FALLBACK_MESSAGES)];
    expect(templates.length).toBe(15);
    for (const template of templates) {
      const filled = followUpModule.fillTemplate(template, 'Juan');
      expect(filled.startsWith('Hola Juan 👋\n\n')).toBe(true);
      expect(filled).not.toMatch(/\b(?:queres|seguis|avisanos|escribinos|disposicion|cotizacion|ultimo|aqui|queriamos)\b/i);
      expectWhatsAppStyle(filled);
    }
  });

  test('follow-up templates without a contact name greet cleanly', () => {
    expect(followUpModule.fillTemplate(followUpModule.MESSAGES.cotizacion_lead[7], null))
      .toBe('Hola 👋\n\nTe recordamos que tu cotización sigue vigente.\n\n👉 ¿Quieres que la retomemos hoy?');
  });

  test('the follow-up policy library carries the same templates as the scheduler node', () => {
    expect(followUpPolicy.MESSAGES).toEqual(followUpModule.MESSAGES);
  });

  // Only reachable when neither the deterministic step nor the model produced a
  // reply, so it is pinned at the source.
  test('the no-processing fallback', () => {
    const source = fs.readFileSync(root + 'wa-conversation-orchestrator/apply-ai-assistance.js', 'utf8');
    expect(source).toContain("'No pude procesar tu respuesta.\\n\\n👉 ¿Podrías intentarlo nuevamente?'");
    expect(source).not.toContain("'No pude procesar tu respuesta. ¿Podrías intentarlo nuevamente?'");
  });
});
