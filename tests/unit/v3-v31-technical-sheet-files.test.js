import fs from 'node:fs';
import { createRequire } from 'node:module';
import { describe, expect, test } from 'vitest';

const require = createRequire(import.meta.url);
const { buildV3PolicyInput } = require('../fixtures/workflow-nodes/shared/v3-policy-builder.js');
const {
  compileV3TurnPolicy, validateV3AiProposal, authorizeV3ConversationDecision, digestObject,
} = require('../fixtures/workflow-nodes/shared/v3-contract-runtime.js');

// -----------------------------------------------------------------------------
// Task 3c.29 (v3.1 only): the assistant can send a product's technical sheet
// as a PDF. The policy exposes which sheets exist for the products relevant
// to the turn (refs only, never content), whether each was already sent in
// this conversation and whether it is the one offered in the previous turn.
// The send_technical_sheet effect is authorized only for a sheet the policy
// lists, when the current message asks for a sheet or accepts the pending
// offer, never twice unless asked again, and at most three per turn.
// Everything here is SYNTHETIC.
// -----------------------------------------------------------------------------

const LOAD_SQL = 'db/queries/n8n/wa-conversation-orchestrator/01_load_active_context.sql';
const SHEET_FILES_MAX_BYTES = 3072;
const TECHNICAL_SHEETS_MAX_BYTES = 6144;
const utf8Bytes = (value) => Buffer.byteLength(JSON.stringify(value), 'utf8');

const BLOQUE_FILES = [
  { ref: 'sheet:demo-bloque', variant: null, covers: ['Bloque Demo 1', 'Bloque Demo 2'] },
  { ref: 'sheet:demo-bloque-bloque-demo-2', variant: 'Bloque Demo 2', covers: ['Bloque Demo 2'] },
];
const BALDOSA_FILES = [
  { ref: 'sheet:demo-baldosa-listones', variant: 'Baldosa Demo Listones', covers: ['Baldosa Demo Listones'] },
];
const GROUNDING = Object.freeze({
  catalog: [
    {
      ref: 'product:demo-bloque', concept: 'product', value: 'Producto Demo Bloque', synonyms: ['bloque demo'],
      technical_sheet: { description: 'Ficha inventada.', general_specs: {}, variants: [{ name: 'Bloque Demo 1' }, { name: 'Bloque Demo 2' }], unconfirmed: {} },
      technical_sheet_files: BLOQUE_FILES,
    },
    {
      ref: 'product:demo-baldosa', concept: 'product', value: 'Baldosa Demo', synonyms: ['baldosa listones demo'],
      technical_sheet_files: BALDOSA_FILES,
    },
    { ref: 'product:demo-cemento', concept: 'product', value: 'Cemento Demo' },
  ],
});
const withoutFiles = (grounding) => ({
  ...grounding,
  catalog: grounding.catalog.map(({ technical_sheet_files: _files, ...entry }) => entry),
});
const baseRow = (overrides = {}) => ({
  inbound_event_id: 'event-sheet-files',
  conversation_id: 'conversation-sheet-files',
  external_message_id: 'message-sheet-files',
  text_body: 'Mándame la ficha técnica del bloque demo',
  qualification_context: {},
  v3_grounding: GROUNDING,
  ...overrides,
});
const v31Input = (row) => buildV3PolicyInput(row, { version: 'v3.1' });
const v31Policy = (row) => compileV3TurnPolicy(v31Input(row));
const entryFor = (input, ref) => input.grounding.catalog.find((entry) => entry.ref === ref);
const proposalFor = (policy, overrides = {}) => ({
  version: 'ai_conversation_proposal/v3.1',
  policy_digest: policy.policy_digest,
  reply_text: 'Te dejo la ficha técnica de *Producto Demo Bloque* 👇',
  primary_request: null,
  catalog_resolutions: [],
  observations: [],
  state_mutations: [],
  effect_requests: [],
  ...overrides,
});
const sendSheet = (sheetRef) => ({ type: 'send_technical_sheet', reason_observation_ids: [], sheet_ref: sheetRef });
const codes = (validation) => validation.errors.map((error) => error.code);

describe('the load query exposes sheet refs, never their bytes', () => {
  const sql = fs.readFileSync(LOAD_SQL, 'utf8');

  test('catalog entries list their active sheets as {ref, variant, covers}', () => {
    expect(sql).toContain("'technical_sheet_files'");
    expect(sql).toContain("'ref', 'sheet:' || sheet.sheet_key");
    expect(sql).toContain('sheet.active');
    expect(sql).not.toMatch(/sheet\.content/);
  });

  test('the grounding carries the sheets already sent in this conversation and the pending offer', () => {
    expect(sql).toContain("'technical_sheets_sent'");
    expect(sql).toContain("'technical_sheet_offer_ref'");
    expect(sql).toContain("'technical_sheet_offer'");
  });
});

describe('v3 (the rollback path) never sees sheet files', () => {
  test('its policy is identical to one built without them', () => {
    const row = baseRow({
      v3_grounding: { ...GROUNDING, technical_sheets_sent: ['sheet:demo-bloque'], technical_sheet_offer_ref: 'sheet:demo-bloque' },
    });
    const withFiles = compileV3TurnPolicy(buildV3PolicyInput(row));
    const without = compileV3TurnPolicy(buildV3PolicyInput(baseRow({ v3_grounding: withoutFiles(GROUNDING) })));
    expect(withFiles.grounding.catalog.some((entry) => 'technical_sheet_files' in entry)).toBe(false);
    expect(withFiles.effect_authority.permissions.map((permission) => permission.type)).toEqual(['create_lead', 'handoff']);
    expect(withFiles.policy_digest).toBe(without.policy_digest);
  });
});

describe('v3.1 exposes the sheets of the products relevant to the turn', () => {
  test('a product the message names gets its sheet refs; others get none', () => {
    const input = v31Input(baseRow());
    expect(entryFor(input, 'product:demo-bloque').technical_sheet_files).toEqual(BLOQUE_FILES.map((file) => (
      file.variant === null ? file : { ref: file.ref, variant: file.variant }
    )));
    expect(entryFor(input, 'product:demo-baldosa')).not.toHaveProperty('technical_sheet_files');
  });

  test('a product in the quote line items is relevant even when the message does not name it', () => {
    const input = v31Input(baseRow({
      text_body: '¿y cuánto pesa?',
      qualification_context: { line_items: [{ item_id: 'li_baldosa00001', product: 'Baldosa Demo', quantity: null, measurements: null }] },
    }));
    expect(entryFor(input, 'product:demo-baldosa').technical_sheet_files).toEqual([
      { ref: 'sheet:demo-baldosa-listones', variant: 'Baldosa Demo Listones' },
    ]);
  });

  test('sent sheets are marked sent; the pending offer is marked offered and stays exposed on a bare "sí"', () => {
    const input = v31Input(baseRow({
      text_body: 'sí',
      pending_question_key: 'technical_sheet_offer',
      v3_grounding: {
        ...GROUNDING,
        technical_sheets_sent: ['sheet:demo-bloque'],
        technical_sheet_offer_ref: 'sheet:demo-baldosa-listones',
      },
    }));
    expect(entryFor(input, 'product:demo-baldosa').technical_sheet_files).toEqual([
      { ref: 'sheet:demo-baldosa-listones', variant: 'Baldosa Demo Listones', offered: true },
    ]);
    expect(entryFor(input, 'product:demo-bloque')).not.toHaveProperty('technical_sheet_files');
  });

  test('the effect is permitted only when at least one sheet is exposed', () => {
    const permitted = (row) => v31Input(row).effect_permissions.map((permission) => permission.type);
    expect(permitted(baseRow())).toEqual(['create_lead', 'handoff', 'send_technical_sheet']);
    expect(permitted(baseRow({ text_body: 'Necesito cemento demo' }))).toEqual(['create_lead', 'handoff']);
    expect(v31Input(baseRow()).effect_requirements).toContainEqual({ effect_type: 'send_technical_sheet', required_goal_ids: [] });
  });

  test('without sheet files the v3.1 policy is unchanged', () => {
    const plain = compileV3TurnPolicy(v31Input(baseRow({ v3_grounding: withoutFiles(GROUNDING) })));
    const sentOnly = compileV3TurnPolicy(v31Input(baseRow({
      v3_grounding: { ...withoutFiles(GROUNDING), technical_sheets_sent: ['sheet:x'] },
    })));
    expect(sentOnly.policy_digest).toBe(plain.policy_digest);
  });

  test('malformed sheet entries are dropped', () => {
    const input = v31Input(baseRow({
      v3_grounding: {
        catalog: [{
          ...GROUNDING.catalog[0],
          technical_sheet_files: [{ ref: 'not-a-sheet', variant: null }, { ref: 'sheet:ok', variant: 7 }, 'x', { ref: 'sheet:demo-bloque', variant: null, content: 'JVBER' }],
        }],
      },
    }));
    expect(entryFor(input, 'product:demo-bloque').technical_sheet_files).toEqual([{ ref: 'sheet:demo-bloque', variant: null }]);
  });

  test('file refs share the technical-sheet byte cap and are truncated deterministically', () => {
    const many = Array.from({ length: 60 }, (_, index) => ({ ref: `sheet:demo-bloque-variante-larga-${index}`, variant: `Variante demo larga ${index}` }));
    const row = baseRow({ v3_grounding: { catalog: [{ ...GROUNDING.catalog[0], technical_sheet_files: many }] } });
    const entry = entryFor(v31Input(row), 'product:demo-bloque');
    expect(utf8Bytes(entry.technical_sheet_files)).toBeLessThanOrEqual(SHEET_FILES_MAX_BYTES);
    expect(entry.technical_sheet_files_omitted).toBe(60 - entry.technical_sheet_files.length);
    expect(utf8Bytes(entry.technical_sheet_files) + utf8Bytes(entry.technical_sheet)).toBeLessThanOrEqual(TECHNICAL_SHEETS_MAX_BYTES);
    expect(compileV3TurnPolicy(v31Input(row)).policy_digest).toBe(compileV3TurnPolicy(v31Input(structuredClone(row))).policy_digest);
  });
});

describe('send_technical_sheet validation (v3.1)', () => {
  test('an explicit request for a listed sheet is valid and becomes an effect command with its product and variant', () => {
    const policy = v31Policy(baseRow());
    const proposal = proposalFor(policy, { effect_requests: [sendSheet('sheet:demo-bloque')] });
    const validation = validateV3AiProposal(policy, proposal);
    expect(validation.errors).toEqual([]);
    const decision = authorizeV3ConversationDecision(policy, proposal, validation);
    const [command] = decision.effect_commands;
    expect(command).toMatchObject({
      type: 'send_technical_sheet',
      required_before_reply: true,
      payload: {
        conversation_id: 'conversation-sheet-files',
        turn_id: 'event-sheet-files',
        reason_observation_ids: [],
        technical_sheet: { ref: 'sheet:demo-bloque', sku: 'demo-bloque', variant: null },
      },
    });
    expect(command.payload_digest).toBe(digestObject(command.payload));
  });

  test.each([
    '¿tienes la ficha del bloque demo?',
    'me pasas la ficha tecnica del bloque demo',
    '¿me puedes enviar el pdf del bloque demo?',
  ])('"%s" is an explicit request', (text) => {
    const policy = v31Policy(baseRow({ text_body: text }));
    expect(validateV3AiProposal(policy, proposalFor(policy, { effect_requests: [sendSheet('sheet:demo-bloque')] })).errors).toEqual([]);
  });

  test('accepting the offered sheet is valid', () => {
    const policy = v31Policy(baseRow({
      text_body: 'Sí, dale',
      pending_question_key: 'technical_sheet_offer',
      v3_grounding: { ...GROUNDING, technical_sheet_offer_ref: 'sheet:demo-baldosa-listones' },
    }));
    const proposal = proposalFor(policy, {
      reply_text: 'Te dejo la ficha técnica de la *Baldosa Demo Listones* 👇',
      effect_requests: [sendSheet('sheet:demo-baldosa-listones')],
    });
    expect(validateV3AiProposal(policy, proposal).errors).toEqual([]);
  });

  test('an unsolicited sheet is rejected', () => {
    const policy = v31Policy(baseRow({ text_body: '¿Cuánto pesa el bloque demo?' }));
    const validation = validateV3AiProposal(policy, proposalFor(policy, { effect_requests: [sendSheet('sheet:demo-bloque')] }));
    expect(codes(validation)).toEqual(['technical_sheet_not_requested']);
    expect(validation.errors[0].instruction).toMatch(/technical_sheet_offer/);
  });

  test('a "sí" with no pending offer, or for a sheet other than the offered one, is not a request', () => {
    const noOffer = v31Policy(baseRow({ text_body: 'sí' }));
    expect(codes(validateV3AiProposal(noOffer, proposalFor(noOffer, { effect_requests: [sendSheet('sheet:demo-bloque')] }))))
      .toEqual(['effect_not_permitted']);
    const offered = v31Policy(baseRow({
      text_body: 'sí, el bloque demo',
      pending_question_key: 'technical_sheet_offer',
      v3_grounding: { ...GROUNDING, technical_sheet_offer_ref: 'sheet:demo-baldosa-listones' },
    }));
    expect(codes(validateV3AiProposal(offered, proposalFor(offered, { effect_requests: [sendSheet('sheet:demo-bloque')] }))))
      .toEqual(['technical_sheet_not_requested', 'technical_sheet_offer_unanswered']);
  });

  test('declining the offer sends nothing and needs no effect', () => {
    const policy = v31Policy(baseRow({
      text_body: 'no, gracias',
      pending_question_key: 'technical_sheet_offer',
      v3_grounding: { ...GROUNDING, technical_sheet_offer_ref: 'sheet:demo-baldosa-listones' },
    }));
    const proposal = proposalFor(policy, { reply_text: 'Perfecto, sin problema.' });
    expect(validateV3AiProposal(policy, proposal).errors).toEqual([]);
  });

  test('accepting the offer without sending it is rejected', () => {
    const policy = v31Policy(baseRow({
      text_body: 'ya, mándala',
      pending_question_key: 'technical_sheet_offer',
      v3_grounding: { ...GROUNDING, technical_sheet_offer_ref: 'sheet:demo-baldosa-listones' },
    }));
    const validation = validateV3AiProposal(policy, proposalFor(policy, { reply_text: 'Perfecto.' }));
    expect(codes(validation)).toEqual(['technical_sheet_offer_unanswered']);
    expect(validation.errors[0].allowed_values).toEqual(['sheet:demo-baldosa-listones']);
  });

  test('an unknown sheet is rejected with the listed refs', () => {
    const policy = v31Policy(baseRow());
    const validation = validateV3AiProposal(policy, proposalFor(policy, { effect_requests: [sendSheet('sheet:inventada')] }));
    expect(codes(validation)).toEqual(['technical_sheet_unknown']);
    expect(validation.errors[0].allowed_values).toEqual(['sheet:demo-bloque', 'sheet:demo-bloque-bloque-demo-2']);
  });

  test('a sheet already sent is rejected unless the customer asks for it again', () => {
    const sentGrounding = { ...GROUNDING, technical_sheets_sent: ['sheet:demo-baldosa-listones'], technical_sheet_offer_ref: 'sheet:demo-baldosa-listones' };
    const accepted = v31Policy(baseRow({ text_body: 'dale', pending_question_key: 'technical_sheet_offer', v3_grounding: sentGrounding }));
    expect(codes(validateV3AiProposal(accepted, proposalFor(accepted, { effect_requests: [sendSheet('sheet:demo-baldosa-listones')] }))))
      .toEqual(['technical_sheet_already_sent']);
    const askedAgain = v31Policy(baseRow({ text_body: '¿me mandas de nuevo la ficha de la baldosa listones demo?', v3_grounding: sentGrounding }));
    expect(validateV3AiProposal(askedAgain, proposalFor(askedAgain, { effect_requests: [sendSheet('sheet:demo-baldosa-listones')] })).errors)
      .toEqual([]);
  });

  test('the same sheet twice in one turn, or more than three sheets, is rejected', () => {
    const many = Array.from({ length: 4 }, (_, index) => ({ ref: `sheet:demo-bloque-${index}`, variant: `Bloque Demo ${index}` }));
    const policy = v31Policy(baseRow({ v3_grounding: { catalog: [{ ...GROUNDING.catalog[0], technical_sheet_files: many }] } }));
    expect(codes(validateV3AiProposal(policy, proposalFor(policy, {
      effect_requests: [sendSheet('sheet:demo-bloque-0'), sendSheet('sheet:demo-bloque-0')],
    })))).toEqual(['technical_sheet_duplicate']);
    expect(codes(validateV3AiProposal(policy, proposalFor(policy, {
      effect_requests: many.map((file) => sendSheet(file.ref)),
    })))).toEqual(['technical_sheet_limit_exceeded']);
  });

  test('the reply must announce the sheet', () => {
    const policy = v31Policy(baseRow());
    const validation = validateV3AiProposal(policy, proposalFor(policy, {
      reply_text: 'Listo 👍', effect_requests: [sendSheet('sheet:demo-bloque')],
    }));
    expect(codes(validation)).toEqual(['technical_sheet_announcement_required']);
  });

  test('a reply that claims to send a sheet without the effect is rejected; an offer question is fine', () => {
    const policy = v31Policy(baseRow());
    expect(codes(validateV3AiProposal(policy, proposalFor(policy)))).toEqual(['technical_sheet_send_claim_unauthorized']);
    const offerPolicy = v31Policy(baseRow({ text_body: '¿Cuánto pesa el bloque demo 2?' }));
    expect(validateV3AiProposal(offerPolicy, proposalFor(offerPolicy, {
      reply_text: 'Ese dato no lo tengo confirmado.\n\n👉 ¿Te mando la ficha técnica del *Bloque Demo 2*?',
      primary_request: { goal_id: 'technical_sheet_offer', item_ref: 'sheet:demo-bloque-bloque-demo-2' },
    })).errors).toEqual([]);
  });

  test('other effects must not carry a sheet_ref', () => {
    const policy = v31Policy(baseRow({ text_body: 'quiero hablar con una persona' }));
    const validation = validateV3AiProposal(policy, proposalFor(policy, {
      reply_text: 'Te contacto con el equipo.',
      effect_requests: [{ type: 'handoff', reason_observation_ids: [], sheet_ref: 'sheet:demo-bloque' }],
    }));
    expect(codes(validation)).toEqual(['effect_shape_invalid']);
    const nullRef = validateV3AiProposal(policy, proposalFor(policy, {
      reply_text: 'Te contacto con el equipo.',
      effect_requests: [{ type: 'handoff', reason_observation_ids: [], sheet_ref: null }],
    }));
    expect(nullRef.errors).toEqual([]);
  });

  test('without exposed sheets the effect is not permitted', () => {
    const policy = v31Policy(baseRow({ text_body: 'mándame la ficha del cemento demo' }));
    expect(codes(validateV3AiProposal(policy, proposalFor(policy, {
      reply_text: 'Te dejo la ficha técnica del *Cemento Demo* 👇', effect_requests: [sendSheet('sheet:demo-bloque')],
    })))).toEqual(['effect_not_permitted']);
  });
});

describe('the technical_sheet_offer pending question (v3.1)', () => {
  const offerPolicy = () => v31Policy(baseRow({ text_body: '¿Cuánto pesa el bloque demo 2?' }));
  const offer = (itemRef) => ({ goal_id: 'technical_sheet_offer', item_ref: itemRef });

  test('the offer names one listed sheet', () => {
    const policy = offerPolicy();
    const reply = 'No lo tengo confirmado.\n\n👉 ¿Te mando la ficha técnica?';
    expect(codes(validateV3AiProposal(policy, proposalFor(policy, { reply_text: reply, primary_request: offer(null) }))))
      .toEqual(['technical_sheet_offer_invalid']);
    expect(codes(validateV3AiProposal(policy, proposalFor(policy, { reply_text: reply, primary_request: offer('sheet:otra') }))))
      .toEqual(['technical_sheet_offer_invalid']);
  });

  test('an already sent sheet is not offered again', () => {
    const policy = v31Policy(baseRow({
      text_body: '¿Cuánto pesa el bloque demo 2?',
      v3_grounding: { ...GROUNDING, technical_sheets_sent: ['sheet:demo-bloque-bloque-demo-2'] },
    }));
    expect(codes(validateV3AiProposal(policy, proposalFor(policy, {
      reply_text: '👉 ¿Te mando la ficha técnica?', primary_request: offer('sheet:demo-bloque-bloque-demo-2'),
    })))).toEqual(['technical_sheet_offer_already_sent']);
  });

  test('the goal does not exist when no sheet is exposed', () => {
    const policy = v31Policy(baseRow({ text_body: '¿Cuánto pesa el cemento demo?' }));
    expect(codes(validateV3AiProposal(policy, proposalFor(policy, {
      reply_text: '👉 ¿Te mando la ficha técnica?', primary_request: offer('sheet:demo-bloque'),
    })))).toEqual(['primary_request_invalid']);
  });

  test('v3 never accepts the offer goal or the effect', () => {
    const policy = compileV3TurnPolicy(buildV3PolicyInput(baseRow()));
    const validation = validateV3AiProposal(policy, {
      version: 'ai_conversation_proposal/v3',
      policy_digest: policy.policy_digest,
      reply_text: 'Hola',
      primary_request: null,
      catalog_resolution: null,
      observations: [],
      state_mutations: [],
      effect_requests: [{ type: 'send_technical_sheet', reason_observation_ids: [] }],
    });
    expect(codes(validation)).toContain('effect_not_permitted');
  });
});

describe('the v3.1 request: prompt rules and response schema for sheets', () => {
  const BUILD_AI_REQUEST = 'tests/fixtures/workflow-nodes/ai-lead-qualification-assistant/build-ai-request.js';
  const runBuild = (turnPolicy) => new Function('items', '$env', fs.readFileSync(BUILD_AI_REQUEST, 'utf8'))(
    [{ json: { contract_version: 'v3', turn_policy: turnPolicy } }],
    { AI_PROVIDER: 'openai', OPENAI_API_KEY: 'fake-key-123' },
  )[0].json;
  const systemPrompt = (turnPolicy) => runBuild(turnPolicy).ai_request.input[0].content;
  const schema = (turnPolicy) => runBuild(turnPolicy).response_schema;

  test('the technical-sheet rule offers the sheet before deferring to an executive', () => {
    const lines = systemPrompt(v31Policy(baseRow())).split('\n');
    const rule = lines.find((line) => line.startsWith('Algunas entradas del grounding traen technical_sheet:'));
    expect(rule).toContain('Ese detalle viene en la ficha técnica de la *Baldosa 14 Listones*. ¿Te la mando?');
    expect(rule).toContain('"goal_id": "technical_sheet_offer"');
    expect(rule).toContain('si no hay una ficha para enviar, ofrece que una ejecutiva de Hormiglass te lo indique');
    expect(rule).toContain('nunca inventes ni estimes');
    expect(rule).toContain('Nunca des precios');
  });

  test('the sheet-files rule follows it and states every sending condition', () => {
    const lines = systemPrompt(v31Policy(baseRow())).split('\n');
    const index = lines.findIndex((line) => line.startsWith('Algunas entradas del grounding traen technical_sheet_files'));
    expect(lines[index - 1]).toMatch(/^Algunas entradas del grounding traen technical_sheet:/);
    const rule = lines[index];
    for (const fragment of [
      '"type": "send_technical_sheet"', 'sent=true', 'offered=true', 'como máximo tres por mensaje',
      'Te dejo la ficha técnica de *Bloques de Hormigón 15* 👇', 'Nunca envíes fichas que el cliente no pidió',
      'Nunca digas que enviaste o adjuntaste una ficha sin ese effect_request', 'sheet_ref null',
    ]) expect(rule).toContain(fragment);
  });

  test('v3 gets neither rule nor any sheet-related schema', () => {
    const policy = compileV3TurnPolicy(buildV3PolicyInput(baseRow()));
    expect(systemPrompt(policy)).not.toContain('technical_sheet_files');
    expect(JSON.stringify(schema(policy))).not.toContain('sheet');
  });

  test('with exposed sheets, effects carry sheet_ref and the offer goal takes a sheet ref', () => {
    const responseSchema = schema(v31Policy(baseRow()));
    const effectItem = responseSchema.properties.effect_requests.items;
    expect(effectItem.required).toEqual(['type', 'reason_observation_ids', 'sheet_ref']);
    expect(effectItem.properties.type.enum).toEqual(['create_lead', 'handoff', 'send_technical_sheet']);
    expect(effectItem.properties.sheet_ref.enum).toEqual(['sheet:demo-bloque', 'sheet:demo-bloque-bloque-demo-2', null]);
    const primary = responseSchema.properties.primary_request.properties;
    expect(primary.goal_id.enum).toContain('technical_sheet_offer');
    expect(primary.item_ref.enum).toEqual(expect.arrayContaining(['sheet:demo-bloque', 'new:1', null]));
    expect(responseSchema.properties.observations.items.anyOf[0].properties.item_ref.enum).not.toContain('sheet:demo-bloque');
  });

  test('without exposed sheets the v3.1 schema is unchanged', () => {
    const plain = schema(v31Policy(baseRow({ text_body: 'Necesito cemento demo', v3_grounding: withoutFiles(GROUNDING) })));
    const unrelated = schema(v31Policy(baseRow({ text_body: 'Necesito cemento demo' })));
    expect(JSON.stringify(unrelated).replace(/[a-f0-9]{64}/g, 'digest')).toBe(JSON.stringify(plain).replace(/[a-f0-9]{64}/g, 'digest'));
    expect(JSON.stringify(plain)).not.toContain('sheet');
  });
});

describe('task 3c.30: the commit closes an answered technical_sheet_offer', () => {
  const commitSql = fs.readFileSync('db/queries/n8n/wa-conversation-orchestrator/09_commit_v3_turn.sql', 'utf8');
  const caseFor = (column) => commitSql.match(new RegExp(`\\n      ${column} = CASE([\\s\\S]*?)\\n      END,`))[1];

  test('a turn without a new primary_request clears the offer and returns to service', () => {
    for (const [column, closed] of [['pending_question_key', 'NULL'], ['current_step', "'service'"]]) {
      const body = caseFor(column);
      const offerBranch = `WHEN conversation.pending_question_key = 'technical_sheet_offer' THEN ${closed}`;
      expect(body).toContain(offerBranch);
      // The new primary_request is evaluated first, so a re-asked offer (or
      // any other question) wins over the closing branch.
      expect(body.indexOf("{reply,primary_request,goal_id}")).toBeLessThan(body.indexOf(offerBranch));
      expect(body.trimEnd().endsWith(`ELSE conversation.${column}`)).toBe(true);
    }
  });
});

// Owner feedback 2026-10-07: offering the sheet must not first say the datum is
// "no confirmado"; the sheet is presented as where that detail lives.
describe('the sheet offer never talks about unconfirmed data', () => {
  const source = fs.readFileSync('tests/fixtures/workflow-nodes/ai-lead-qualification-assistant/build-ai-request.js', 'utf8');
  const rule = source.match(/const V31_TECHNICAL_SHEET_RULE = '([^']*)'/)[1];

  test('the rule forbids mentioning unconfirmed or missing data when offering the sheet', () => {
    expect(rule).toContain('nunca digas que el dato no está confirmado, no aparece o no lo tienes');
    expect(rule).toContain('"Ese detalle viene en la ficha técnica de la *Baldosa 14 Listones*. ¿Te la mando?"');
  });

  test('without a sheet, the executive confirms it, still without saying it is unconfirmed', () => {
    expect(rule).toContain('ofrece que una ejecutiva de Hormiglass te lo indique');
  });
});
