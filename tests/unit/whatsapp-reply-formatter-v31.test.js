import fs from 'node:fs';
import { createRequire } from 'node:module';
import { describe, expect, test } from 'vitest';

// Task 3c.23 (owner request): the v3.1 prompt asks for WhatsApp presentation
// (3c.22), but the model complies only partially — the final question glued to
// the previous paragraph, or an opening "¡…!" glued to the rest. A pure,
// idempotent, whitespace-only formatter tidies every v3.1 AI reply_text before
// validation, so the validated, stored and sent text are byte-identical.

const require = createRequire(import.meta.url);
const {
  formatWhatsAppReplyV31,
  prepareV3ProposalForValidation,
  compileV3TurnPolicy,
  validateV3AiProposal,
  digestObject,
  sha256,
} = require('../fixtures/workflow-nodes/shared/v3-contract-runtime.js');
const { buildV3PolicyInput } = require('../fixtures/workflow-nodes/shared/v3-policy-builder.js');

const onlyWhitespaceDiffers = (before, after) => {
  expect(after.replace(/\s+/g, '')).toBe(before.replace(/\s+/g, ''));
};

describe('formatWhatsAppReplyV31 — conservative whitespace-only rules', () => {
  test('moves a final question glued to a paragraph (with its leading connector) to its own paragraph', () => {
    const live = 'Gracias, anoto Avenida Pajaritos 2500, en Maipú. Para definir la instalación, ¿cómo es el terreno: plano, con desnivel o rocoso?';
    expect(formatWhatsAppReplyV31(live)).toBe(
      'Gracias, anoto Avenida Pajaritos 2500, en Maipú.\n\nPara definir la instalación, ¿cómo es el terreno: plano, con desnivel o rocoso?',
    );
  });

  test('puts a blank line after a short opening exclamation followed by two or more sentences', () => {
    const live = '¡Gracias por confirmar! Tu solicitud quedó registrada. Una ejecutiva te contactará pronto.';
    expect(formatWhatsAppReplyV31(live)).toBe(
      '¡Gracias por confirmar!\n\nTu solicitud quedó registrada. Una ejecutiva te contactará pronto.',
    );
  });

  test('keeps a one-sentence opening like the prompt greeting and summary examples on one line', () => {
    expect(formatWhatsAppReplyV31('¡Hola! 👋 Soy Hormi Atención de *Hormiglass*.\n\n👉 ¿Qué producto necesitas?'))
      .toBe('¡Hola! 👋 Soy Hormi Atención de *Hormiglass*.\n\n👉 ¿Qué producto necesitas?');
    expect(formatWhatsAppReplyV31('¡Perfecto! Quedan 500 metros para cada alambre.'))
      .toBe('¡Perfecto! Quedan 500 metros para cada alambre.');
  });

  test('splits a glued greeting question without breaking the greeting line', () => {
    expect(formatWhatsAppReplyV31('¡Hola! 👋 Soy Hormi Atención de *Hormiglass*. 👉 ¿Qué producto necesitas?'))
      .toBe('¡Hola! 👋 Soy Hormi Atención de *Hormiglass*.\n\n👉 ¿Qué producto necesitas?');
  });

  test('keeps bold markers, emojis and every character; only whitespace changes', () => {
    const input = 'Gracias, anoto *Avenida Pajaritos 2500*, en *Maipú* ✅.   Para cotizar *500 m*, 👉 ¿cuál es la altura?  ';
    const output = formatWhatsAppReplyV31(input);
    expect(output).toBe('Gracias, anoto *Avenida Pajaritos 2500*, en *Maipú* ✅.\n\nPara cotizar *500 m*, 👉 ¿cuál es la altura?');
    onlyWhitespaceDiffers(input, output);
    expect(output.match(/\*/g)).toHaveLength(input.match(/\*/g).length);
  });

  test('never touches the itemized summary block', () => {
    const summary = [
      '¡Perfecto! Quedan 500 metros para cada alambre.',
      '',
      '*Resumen de tu cotización*',
      '',
      '*Productos*',
      '• Alambre Concertina — 500 m. Con instalación. ¿Ok?',
      '• Cierros de Hormigón — 500 m × 1,80 m de alto',
      '',
      '*Instalación*',
      'Zxc 2314, Lo Prado',
      '',
      '¿Está todo correcto?',
    ].join('\n');
    expect(formatWhatsAppReplyV31(summary)).toBe(summary);
    const bulletQuestion = 'Resumen:\n• Bloques — 120 u. ¿Correcto?';
    expect(formatWhatsAppReplyV31(bulletQuestion)).toBe(bulletQuestion);
  });

  test('does not split a question that is the only sentence', () => {
    expect(formatWhatsAppReplyV31('¿En qué comuna es la obra?')).toBe('¿En qué comuna es la obra?');
    expect(formatWhatsAppReplyV31('Para definir la instalación, ¿cómo es el terreno?')).toBe('Para definir la instalación, ¿cómo es el terreno?');
  });

  test('leaves text without a question untouched apart from whitespace cleanup', () => {
    expect(formatWhatsAppReplyV31('Gracias por escribir. Quedo atento.')).toBe('Gracias por escribir. Quedo atento.');
    expect(formatWhatsAppReplyV31('  Gracias.   \n\n\n\nQuedo atento. \n')).toBe('Gracias.\n\nQuedo atento.');
  });

  test('does not split at an abbreviation or a lowercase continuation', () => {
    expect(formatWhatsAppReplyV31('Anoto la Av. Pajaritos, ¿es correcto?')).toBe('Anoto la Av. Pajaritos, ¿es correcto?');
    expect(formatWhatsAppReplyV31('Son aprox. 30 m, ¿es correcto?')).toBe('Son aprox. 30 m, ¿es correcto?');
    expect(formatWhatsAppReplyV31('Son 30 mts. y algo más, ¿es correcto?')).toBe('Son 30 mts. y algo más, ¿es correcto?');
  });

  test('does not move a question followed by more text on the same line', () => {
    const text = 'Gracias. ¿Te parece bien? Quedo atento.';
    expect(formatWhatsAppReplyV31(text)).toBe(text);
  });

  test('keeps an already formatted reply byte-identical', () => {
    const formatted = 'Gracias, anoto *Avenida Pajaritos 2500*, en *Maipú*.\n\n👉 ¿Cómo es el terreno: plano, con desnivel o rocoso?';
    expect(formatWhatsAppReplyV31(formatted)).toBe(formatted);
  });

  test.each([
    'Gracias, anoto Avenida Pajaritos 2500, en Maipú. Para definir la instalación, ¿cómo es el terreno: plano, con desnivel o rocoso?',
    '¡Gracias por confirmar! Tu solicitud quedó registrada. Una ejecutiva te contactará pronto.',
    '¡Gracias! ¿Cuál es tu comuna?',
    '¡Listo! Anoto *120 unidades*. Perfecto. Para despacho, 👉 ¿cuál es la dirección?  \n\n\n',
    '  \n Hola.\n\n\n¿Algo más?',
    'Sin pregunta alguna',
    '',
  ])('is idempotent: f(f(x)) === f(x) for %j', (input) => {
    const once = formatWhatsAppReplyV31(input);
    expect(formatWhatsAppReplyV31(once)).toBe(once);
    expect(once).toBe(once.trim());
    expect(once).not.toMatch(/\n{3,}/);
    expect(once).not.toMatch(/[ \t]+\n/);
    onlyWhitespaceDiffers(input, once);
  });

  test('returns non-string input unchanged', () => {
    expect(formatWhatsAppReplyV31(null)).toBe(null);
    expect(formatWhatsAppReplyV31(42)).toBe(42);
  });
});

describe('prepareV3ProposalForValidation — v3.1 only', () => {
  test('formats a v3.1 proposal reply_text without mutating the original', () => {
    const policy = { version: 'ai_prd_turn_policy/v3.1' };
    const proposal = { version: 'ai_conversation_proposal/v3.1', reply_text: 'Anoto Maipú. ¿Cómo es el terreno?' };
    const prepared = prepareV3ProposalForValidation(policy, proposal);
    expect(prepared.reply_text).toBe('Anoto Maipú.\n\n¿Cómo es el terreno?');
    expect(proposal.reply_text).toBe('Anoto Maipú. ¿Cómo es el terreno?');
  });

  test('returns a v3 proposal (and any non-object) as the same reference', () => {
    const proposal = { version: 'ai_conversation_proposal/v3', reply_text: 'Anoto Maipú. ¿Cómo es el terreno?' };
    expect(prepareV3ProposalForValidation({ version: 'ai_prd_turn_policy/v3' }, proposal)).toBe(proposal);
    expect(prepareV3ProposalForValidation({ version: 'ai_prd_turn_policy/v3.1' }, null)).toBe(null);
    const noText = { version: 'ai_conversation_proposal/v3.1', reply_text: 7 };
    expect(prepareV3ProposalForValidation({ version: 'ai_prd_turn_policy/v3.1' }, noText)).toBe(noText);
  });
});

// The workflow node itself, as synced into the orchestrator JSON: both the
// first proposal and the repaired one pass through "Validate And Authorize V3".
describe('Validate And Authorize V3 node — formatted reply flows through validation, digests and delivery', () => {
  const workflow = JSON.parse(fs.readFileSync('n8n/workflows/wa-conversation-orchestrator.json', 'utf8'));
  const node = workflow.nodes.find((entry) => entry.name === 'Validate And Authorize V3');
  const runNode = (json) => new Function('items', 'module', 'require', node.parameters.jsCode)(
    [{ json }], { exports: {} }, require,
  )[0].json;

  const v31PolicyFor = (text = 'Gracias', context = {}) => compileV3TurnPolicy(buildV3PolicyInput({
    inbound_event_id: 3231, conversation_id: 323, external_message_id: 'format-v31-node',
    text_body: text, qualification_context: context,
  }, { version: 'v3.1' }));
  const v31Proposal = (policy, overrides = {}) => ({
    version: 'ai_conversation_proposal/v3.1', policy_digest: policy.policy_digest,
    reply_text: 'Gracias.', primary_request: null,
    catalog_resolutions: [], observations: [], state_mutations: [], effect_requests: [], ...overrides,
  });

  test('a glued v3.1 reply is formatted and validated, stored, digested and sent byte-identically', () => {
    const policy = v31PolicyFor();
    const raw = '¡Gracias por escribir! Anoto tu consulta. Para cotizar, ¿qué producto necesitas?';
    const proposal = v31Proposal(policy, { reply_text: raw });
    const out = runNode({ v3_policy: policy, ai_proposal: proposal });
    // The opening exclamation keeps its single following sentence (the prompt's
    // own greeting shape); only the glued final question moves.
    const expected = '¡Gracias por escribir! Anoto tu consulta.\n\nPara cotizar, ¿qué producto necesitas?';
    expect(out.v3_proposal_valid).toBe(true);
    expect(out.ai_proposal.reply_text).toBe(expected);
    expect(proposal.reply_text).toBe(raw);
    expect(out.reply_text).toBe(expected);
    expect(out.response_text).toBe(expected);
    expect(out.v3_decision.reply.text).toBe(expected);
    expect(out.reply_text).toBe(out.reply_text.trim());
    expect(out.v3_decision.reply.sha256).toBe(sha256(expected));
    expect(out.proposal_digest).toBe(digestObject(out.ai_proposal));
    expect(out.v3_validation.proposal_digest).toBe(out.proposal_digest);
    expect(out.decision_digest).toBe(digestObject(out.v3_decision));
    const deliveryKey = sha256(`turn_reply/v1\u0000${policy.turn.conversation_id}\u0000${policy.turn.id}\u0000${sha256(expected)}`);
    expect(out.delivery_key).toBe(deliveryKey);
  });

  test('the same content glued or pre-formatted yields the same decision and delivery key', () => {
    const policy = v31PolicyFor();
    const glued = runNode({ v3_policy: policy, ai_proposal: v31Proposal(policy, { reply_text: 'Anoto tu consulta. ¿Qué producto necesitas?' }) });
    const formatted = runNode({ v3_policy: policy, ai_proposal: v31Proposal(policy, { reply_text: 'Anoto tu consulta.\n\n¿Qué producto necesitas?' }) });
    expect(glued.decision_id).toBe(formatted.decision_id);
    expect(glued.delivery_key).toBe(formatted.delivery_key);
  });

  test('a forbidden claim is still rejected after formatting', () => {
    const policy = v31PolicyFor();
    const out = runNode({ v3_policy: policy, ai_proposal: v31Proposal(policy, { reply_text: '¡Listo! Tu solicitud ya *derivada* al equipo. ¿Algo más?' }) });
    expect(out.v3_proposal_valid).toBe(false);
    expect(out.v3_validation.errors).toContainEqual(expect.objectContaining({ code: 'forbidden_claim' }));
    expect(out.ai_proposal.reply_text).toBe('¡Listo! Tu solicitud ya *derivada* al equipo.\n\n¿Algo más?');
    expect(out.reply_text).toBe('');
    expect(out.delivery_key).toBe(null);
  });

  test('the factory address check still works on a formatted pickup summary', () => {
    const policy = v31PolicyFor('Quiero retirar en fábrica', {
      product: 'Bloques', quantity: '120 unidades', service_scope: 'material', fulfillment: 'pickup',
    });
    const finalConfirmation = (replyText) => runNode({ v3_policy: policy, ai_proposal: v31Proposal(policy, {
      reply_text: replyText, primary_request: { goal_id: 'final_confirmation', item_ref: null },
    }) });
    const accepted = finalConfirmation('Retiras en *Portezuelo 1502*, *San Bernardo*. ¿Está todo correcto?');
    expect(accepted.v3_proposal_valid).toBe(true);
    expect(accepted.reply_text).toBe('Retiras en *Portezuelo 1502*, *San Bernardo*.\n\n¿Está todo correcto?');
    const rejected = finalConfirmation('Retiras en nuestra planta. ¿Está todo correcto?');
    expect(rejected.v3_proposal_valid).toBe(false);
    expect(rejected.v3_validation.errors).toContainEqual(expect.objectContaining({ code: 'pickup_factory_address_required' }));
  });

  test('a v3 proposal passes through unchanged (golden rollback path)', () => {
    const policy = compileV3TurnPolicy(buildV3PolicyInput({
      inbound_event_id: 'format-v3-node', conversation_id: 'format-v3-node-conversation', text_body: 'Gracias', qualification_context: {},
    }));
    const raw = 'Anoto tu consulta. ¿Qué producto necesitas?';
    const proposal = {
      version: 'ai_conversation_proposal/v3', policy_digest: policy.policy_digest,
      reply_text: raw, primary_request: null,
      catalog_resolution: { status: 'not_applicable', evidence_quote: null, evidence_occurrence: null, grounding_ref: null },
      observations: [], state_mutations: [], effect_requests: [],
    };
    const out = runNode({ v3_policy: policy, ai_proposal: proposal });
    expect(out.v3_proposal_valid).toBe(true);
    expect(out.ai_proposal).toBe(proposal);
    expect(out.reply_text).toBe(raw);
    expect(out.proposal_digest).toBe(digestObject(proposal));
  });
});
