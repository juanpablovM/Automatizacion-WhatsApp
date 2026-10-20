import fs from 'node:fs';
import { createRequire } from 'node:module';
import { describe, expect, test } from 'vitest';

const require = createRequire(import.meta.url);
const { buildV3PolicyInput } = require('../fixtures/workflow-nodes/shared/v3-policy-builder.js');
const { compileV3TurnPolicy, validateV3AiProposal } = require('../fixtures/workflow-nodes/shared/v3-contract-runtime.js');

// Live conversation 475 (2026-10-13): the customer quoting baldosas and
// solerillas asked "¿Cómo son las 14 listones y las de 4 listones?", then
// "Quiero verlas", then "Quiero ver las fichas técnicas". The bot described
// the variants but never sent their sheets, and finally asked whether it meant
// the baldosas or the soleras. Owner decision: comparing or describing
// variants (or asking to see them) gets the info plus the sheet of each named
// variant; a single specific datum still gets no PDF. Everything here is
// SYNTHETIC.

const GROUNDING = Object.freeze({
  catalog: [
    {
      ref: 'product:demo-baldosas', concept: 'product', value: 'Baldosas Demo', synonyms: ['baldosas demo'],
      technical_sheet_files: [
        { ref: 'sheet:demo-baldosa-14-listones', variant: 'Baldosa 14 Listones (Andalucía)', covers: [] },
        { ref: 'sheet:demo-baldosa-4-listones', variant: 'Baldosa 4 Listones', covers: [] },
        { ref: 'sheet:demo-baldosa-lisa', variant: 'Baldosa Lisa', covers: [] },
      ],
    },
    {
      ref: 'product:demo-soleras', concept: 'product', value: 'Soleras y Solerillas Demo', synonyms: ['solerillas demo'],
      technical_sheet_files: [
        { ref: 'sheet:demo-solerilla-canto-redondo', variant: 'Solerilla canto redondo 50 cm', covers: [] },
      ],
    },
  ],
});
const QUOTE = {
  line_items_schema: 'line_items/v1',
  line_items: ['Baldosas Demo', 'Soleras y Solerillas Demo'].map((product, index) => ({
    item_id: `li_demo_${index}`, product, quantity: null, measurements: null, catalog_ref: null, requested_label: null,
  })),
};
const VARIANTS_REPLY = 'Las dos son de *40 × 40 cm*. La diferencia está en el diseño: una tiene 14 listones y la otra, 4.\n\n¿Cuál de las dos prefieres?';

const policyFor = (text, recentMessages = []) => compileV3TurnPolicy(buildV3PolicyInput({
  inbound_event_id: 'event-sheet-variants',
  conversation_id: 'conversation-sheet-variants',
  external_message_id: 'message-sheet-variants',
  text_body: text,
  qualification_context: QUOTE,
  v3_grounding: GROUNDING,
  recent_messages: recentMessages,
}, { version: 'v3.1' }));
const send = (policy, refs) => validateV3AiProposal(policy, {
  version: 'ai_conversation_proposal/v3.1',
  policy_digest: policy.policy_digest,
  reply_text: 'Te dejo las fichas técnicas 👇',
  primary_request: null,
  catalog_resolutions: [],
  observations: [],
  state_mutations: [],
  effect_requests: refs.map((ref) => ({ type: 'send_technical_sheet', reason_observation_ids: [], sheet_ref: ref })),
});
const codes = (validation) => validation.errors.map((error) => error.code);
const afterVariantsReply = (text) => policyFor(text, [
  { role: 'user', content: '¿Cómo son las 14 listones y las de 4 listones?' },
  { role: 'assistant', content: VARIANTS_REPLY },
  { role: 'user', content: text },
]);

describe('a variant comparison gets the sheet of each named variant', () => {
  const policy = policyFor('Como son las 14 listones y las de 4 listones?');

  test('both named variant sheets are valid, even though several quoted products have sheets', () => {
    expect(send(policy, ['sheet:demo-baldosa-14-listones', 'sheet:demo-baldosa-4-listones']).errors).toEqual([]);
  });

  test('a sheet of another product or of a variant not named is rejected', () => {
    expect(codes(send(policy, ['sheet:demo-solerilla-canto-redondo']))).toEqual(['technical_sheet_product_mismatch']);
    expect(codes(send(policy, ['sheet:demo-baldosa-lisa']))).toEqual(['technical_sheet_variant_mismatch']);
  });

  test('describing, comparing or asking to see a product is a sheet-worthy question', () => {
    for (const [text, refs] of [
      ['¿Cómo es la baldosa lisa?', ['sheet:demo-baldosa-lisa']],
      ['¿Qué diferencia hay entre la 14 listones y la 4 listones?', ['sheet:demo-baldosa-14-listones', 'sheet:demo-baldosa-4-listones']],
      ['Quiero ver la baldosa lisa', ['sheet:demo-baldosa-lisa']],
      ['¿Tienes fotos de la baldosa lisa?', ['sheet:demo-baldosa-lisa']],
    ]) {
      expect(send(policyFor(text), refs).errors, text).toEqual([]);
    }
  });

  test('a message that is neither a question about the product nor a request still gets no sheet', () => {
    expect(codes(send(policyFor('A ver, lo voy a pensar con la baldosa lisa'), ['sheet:demo-baldosa-lisa'])))
      .toEqual(['technical_sheet_not_requested']);
  });
});

describe('a follow-up naming no product resolves to the variants of the previous reply', () => {
  test('"Quiero verlas" gets the two variants the bot just described', () => {
    const policy = afterVariantsReply('Quiero verlas');
    expect(send(policy, ['sheet:demo-baldosa-14-listones', 'sheet:demo-baldosa-4-listones']).errors).toEqual([]);
    expect(codes(send(policy, ['sheet:demo-solerilla-canto-redondo']))).toEqual(['technical_sheet_product_mismatch']);
  });

  test('"Quiero ver las fichas técnicas" is not ambiguous after that reply', () => {
    const policy = afterVariantsReply('Quiero ver las fichas técnicas');
    expect(send(policy, ['sheet:demo-baldosa-14-listones', 'sheet:demo-baldosa-4-listones']).errors).toEqual([]);
  });

  test('without a previous reply naming a product or variant, it stays ambiguous', () => {
    expect(codes(send(policyFor('Quiero ver las fichas técnicas'), ['sheet:demo-baldosa-14-listones'])))
      .toEqual(['technical_sheet_product_ambiguous']);
  });
});

describe('the v3.1 prompt states the comparison rule', () => {
  const source = fs.readFileSync('tests/fixtures/workflow-nodes/ai-lead-qualification-assistant/build-ai-request.js', 'utf8');
  const rule = source.match(/const V31_TECHNICAL_SHEET_RULE = '([^']*)'/)[1];
  const filesRule = source.match(/const V31_TECHNICAL_SHEET_FILES_RULE = '([^']*)'/)[1];

  test('a comparison or a request to see variants gets the data and their sheets in the same reply', () => {
    expect(rule).toContain('Si el cliente pregunta cómo es o cómo son, compara variantes o quiere verlas');
    expect(rule).toContain('respóndele con los datos de la technical_sheet y, en la misma respuesta, envíale la ficha de cada variante que nombra');
    expect(rule).toContain('si es un dato puntual que puedes responder con la technical_sheet, respóndelo y no envíes el PDF');
  });

  test('a follow-up without a product uses the product or variants of the previous reply', () => {
    expect(filesRule).toContain('si no nombra un producto, usa el producto o las variantes de los que hablaba tu mensaje anterior');
  });

  test('the product is named as the customer named it', () => {
    expect(rule).toContain('Nombra cada producto como lo nombró el cliente o como aparece en el grounding');
    expect(rule).toContain('nunca cambies Solerillas por Soleras');
  });
});

// Owner decision 2026-10-13: "Las fichas técnicas de ambas baldosas ya están
// en el chat" sounds like a reproach. A customer who asks again for, or asks
// to see, a sheet already sent gets it again without comment; otherwise the
// bot carries on without mentioning the sheet.
describe('a sheet already sent is resent, never pointed at', () => {
  const sentPolicy = (text) => compileV3TurnPolicy(buildV3PolicyInput({
    inbound_event_id: 'event-sheet-resend',
    conversation_id: 'conversation-sheet-resend',
    external_message_id: 'message-sheet-resend',
    text_body: text,
    qualification_context: QUOTE,
    v3_grounding: { ...GROUNDING, technical_sheets_sent: ['sheet:demo-baldosa-14-listones', 'sheet:demo-baldosa-4-listones'] },
    recent_messages: [{ role: 'assistant', content: VARIANTS_REPLY }],
  }, { version: 'v3.1' }));
  const both = ['sheet:demo-baldosa-14-listones', 'sheet:demo-baldosa-4-listones'];

  test('asking to see them again resends them', () => {
    expect(send(sentPolicy('Quiero verlas'), both).errors).toEqual([]);
    expect(send(sentPolicy('¿Puedo ver la 14 listones?'), ['sheet:demo-baldosa-14-listones']).errors).toEqual([]);
  });

  test('a specific technical question still does not resend them', () => {
    expect(codes(send(sentPolicy('¿Cuánto pesa la 14 listones?'), ['sheet:demo-baldosa-14-listones'])))
      .toEqual(['technical_sheet_already_sent']);
  });

  test('no instruction tells the model to say the sheet is in the chat', () => {
    const runtime = fs.readFileSync('tests/fixtures/workflow-nodes/shared/v3-contract-runtime.js', 'utf8');
    expect(runtime).not.toMatch(/in the chat/);
    const validation = send(sentPolicy('¿Cuánto pesa la 14 listones?'), ['sheet:demo-baldosa-14-listones']);
    expect(validation.errors[0].instruction ?? validation.errors[0].message ?? '').toContain('without mentioning the sheet');
  });

  test('the prompt resends without comment and never says it is already in the chat', () => {
    const source = fs.readFileSync('tests/fixtures/workflow-nodes/ai-lead-qualification-assistant/build-ai-request.js', 'utf8');
    const filesRule = source.match(/const V31_TECHNICAL_SHEET_FILES_RULE = '([^']*)'/)[1];
    expect(filesRule).toContain('Si el cliente vuelve a pedir o quiere ver una ficha con sent=true, reenvíasela sin comentar que ya la enviaste');
    expect(filesRule).toContain('"Con gusto, te dejo de nuevo las fichas técnicas 👇"');
    expect(filesRule).toContain('nunca le digas que la ficha ya está en el chat');
  });
});
