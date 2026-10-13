import fs from 'node:fs';
import { describe, expect, test } from 'vitest';

// Owner request 2026-10-10: the model kept opening consecutive replies with the
// same word ("Gracias", then "Perfecto", then "Entiendo"), whatever example the
// prompt offered. The model still chooses the opener, but the request now tells
// it, already computed, which opener its previous reply used.
const fixturePath = 'tests/fixtures/workflow-nodes/ai-lead-qualification-assistant/build-ai-request.js';
const runCodeNode = (source, items, env = {}) => new Function('items', '$env', source)(items, env);
const openAiEnv = { AI_PROVIDER: 'openai', OPENAI_API_KEY: 'fake-key-123' };

const requestFor = (version, historyMessages) => {
  const turnPolicy = {
    version, policy_digest: 'a'.repeat(64), facts: [],
    goals: [{ goal_id: 'line_items' }],
    history: { messages: historyMessages, truncated: false },
    state_authority: { allowed_mutations: [] }, effect_authority: { permissions: [] }, grounding: {},
  };
  const source = fs.readFileSync(fixturePath, 'utf8');
  const output = runCodeNode(source, [{ json: { contract_version: 'v3', turn_policy: turnPolicy } }], openAiEnv);
  const request = output[0].json.ai_request;
  return { system: request.input[0].content, user: JSON.parse(request.input[1].content) };
};

const v31 = (history) => requestFor('ai_prd_turn_policy/v3.1', history);

describe('v3.1 request — opener guidance', () => {
  // Live 2026-10-13: with only the previous opener, the model alternated
  // "Gracias" with another word (6 of 10 replies). The last three are blocked.
  test('reports the openers of the last three assistant replies, most recent first', () => {
    const { user } = v31([
      { role: 'assistant', content: 'Gracias, Juan Pablo.' },
      { role: 'user', content: 'a' },
      { role: 'assistant', content: 'Perfecto, la solera recta.' },
      { role: 'user', content: 'b' },
      { role: 'assistant', content: 'Ñuñoa está dentro de nuestra zona.' },
      { role: 'user', content: 'c' },
      { role: 'assistant', content: 'Entiendo, solo material.' },
      { role: 'user', content: 'd' },
      { role: 'assistant', content: '¡Muy bien! Seguimos.' },
      { role: 'user', content: 'e' },
    ]);
    expect(user.opener_guidance.recent_reply_openers).toEqual(['Muy bien', 'Entiendo']);
  });

  test('reports the opener of the previous assistant reply', () => {
    const { user } = v31([
      { role: 'assistant', content: 'Gracias, Juan Pablo.\n\n¿Qué producto necesitas?' },
      { role: 'user', content: 'Soleras' },
      { role: 'assistant', content: 'Entiendo, serían unos *80 metros*.\n\n¿Necesitas despacho?' },
      { role: 'user', content: 'Sí' },
    ]);
    expect(user.opener_guidance.recent_reply_openers).toEqual(['Entiendo', 'Gracias']);
    expect(user.opener_guidance.allowed_openers).toEqual(
      ['Muy bien', 'Gracias', 'Perfecto', 'Entiendo', 'Excelente', 'Con gusto', 'De acuerdo'],
    );
  });

  test('recognizes multi-word and exclamation openers', () => {
    expect(v31([{ role: 'assistant', content: '¡Muy bien! Quedan 500 metros.' }]).user.opener_guidance.recent_reply_openers).toEqual(['Muy bien']);
    expect(v31([{ role: 'assistant', content: 'Muchas gracias. Tu corrección quedó registrada.' }]).user.opener_guidance.recent_reply_openers).toEqual(['Muchas gracias']);
    expect(v31([{ role: 'assistant', content: 'excelente, avanzamos.' }]).user.opener_guidance.recent_reply_openers).toEqual(['Excelente']);
  });

  test('reports no opener when the previous reply had none or there is no previous reply', () => {
    expect(v31([{ role: 'assistant', content: 'Con esa dirección podemos revisar el acceso.' }]).user.opener_guidance.recent_reply_openers).toEqual([]);
    expect(v31([]).user.opener_guidance.recent_reply_openers).toEqual([]);
  });

  test('the prompt tells the model how to use the guidance', () => {
    const { system } = v31([]);
    expect(system).toContain('opener_guidance.recent_reply_openers son las palabras con que abriste tus últimas tres respuestas: nunca abras esta respuesta con ninguna de ellas');
    expect(system).toContain('"Anoto", "Consideraré" o "Bacán"');
    expect(system).toContain('elígela tú de opener_guidance.allowed_openers');
    expect(system).toContain('En un saludo, un reclamo o una respuesta negativa no uses palabra de apertura');
  });

  test('v3 requests are unchanged', () => {
    const { user, system } = requestFor('ai_prd_turn_policy/v3', [{ role: 'assistant', content: 'Entiendo.' }]);
    expect(user.opener_guidance).toBeUndefined();
    expect(system).not.toContain('opener_guidance');
  });
});
