import fs from 'node:fs';
import { createRequire } from 'node:module';
import { describe, expect, test } from 'vitest';

const require = createRequire(import.meta.url);

// The v3 prompt is the only one sent on the v3 lane. When it carried contract
// rules alone, replies lost the Hormi Atención identity, and its voseo wording
// leaked into customer replies ("¿Querés...?"). These checks bind the prompt
// that ships in the workflow, not the fixture.
const workflow = JSON.parse(fs.readFileSync('n8n/workflows/ai-lead-qualification-assistant.json', 'utf8'));
const code = workflow.nodes.find((node) => node.name === 'Build AI Request').parameters.jsCode;
const start = code.indexOf('const v3SystemPrompt = [');
const v3Prompt = code.slice(start, code.indexOf("].filter(Boolean).join('\\n');", start));

const VOSEO_IMPERATIVES = /\b(?:Sos|Respondé|Devolvé|Conservá|Usá|usá|Emití|emití|Citá|citá|Copiá|copiá|Hacé|hacé|Resumí|resumí|Interpretá|Indicá|indicá|Ofrecé|ofrecé|Omití|omití|registrá|pedís|limitate|incluí)\b/;

describe('v3 brand voice', () => {
  test('opens with the Hormi Atención identity', () => {
    expect(start).toBeGreaterThan(-1);
    expect(v3Prompt).toMatch(/'Eres Hormi Atención, el asesor comercial virtual de Hormiglass/);
    expect(v3Prompt.indexOf('Eres Hormi Atención')).toBeLessThan(v3Prompt.indexOf('policy_digest'));
  });

  test('asks for Chilean tú and moderate emojis', () => {
    expect(v3Prompt).toMatch(/español de Chile, tuteando/);
    expect(v3Prompt).toMatch(/como máximo uno por mensaje/);
  });

  test('sets expectations after create_lead without promising prices or dates', () => {
    expect(v3Prompt).toMatch(/Cuando emitas create_lead[^']*una ejecutiva de Hormiglass[^']*No prometas plazos ni precios/);
  });

  // A new quote opens a new conversation with no history, so without this the
  // model welcomed a returning customer as if it were the first contact.
  test('does not re-introduce itself when the customer asks for a new quote', () => {
    expect(v3Prompt).toMatch(/pide una nueva cotización u otra solicitud[^']*no te presentes/);
  });

  // "el camión grande no entra" answered access_restrictions, but the optional
  // truck_access goal was dropped although the customer stated it outright.
  test('records every explicit fact, optional goals included', () => {
    expect(v3Prompt).toMatch(/Registra todo dato que el cliente exprese explícitamente[^']*aunque su goal sea opcional[^']*truck_access/);
  });

  // A bare "sí" to "¿puede entrar un camión?" was recorded only 4/10 times on
  // the real model: the generic-acceptance rule for pickup/delivery was read as
  // "a bare yes answers nothing". With this rule it is recorded 10/10.
  test('treats a bare yes or no as the full answer to a yes/no question', () => {
    expect(v3Prompt).toMatch(/Esa regla aplica solo a preguntas con alternativas[^']*truck_access o debris_removal[^']*es la respuesta completa/);
    expect(v3Prompt).toMatch(/Nunca vuelvas a hacer la misma pregunta de sí o no/);
  });

  // "Una pandereta ... con alambre púa" marked pandereta ambiguous but recorded
  // Alambre de Púas as the product in the same turn; the contract rejected the
  // contradiction twice and the turn fell to contingency (3/10 valid on replay).
  test('records no product while another product in the message is ambiguous', () => {
    expect(v3Prompt).toMatch(/Con catalog_resolution ambiguous o unsupported no emitas ninguna observación ni mutación de product en ese turno, aunque el mensaje también nombre otro producto/);
  });

  // turn_policy.goals is compiled before the message, so "adoquines con
  // instalación" looked complete and the model asked for final confirmation
  // (13/20 invalid on replay). The prompt now states the conditional rules; this
  // binds them to the policy builder so the two cannot drift apart.
  test('states the same conditional required goals as the policy builder', () => {
    const { buildV3PolicyInput } = require('../fixtures/workflow-nodes/shared/v3-policy-builder.js');
    const required = (context) => new Set(buildV3PolicyInput({
      inbound_event_id: 1, conversation_id: 1, external_message_id: 'm1', text_body: 'x',
      qualification_context: context,
    }).goals.filter((goal) => goal.importance === 'required_for_effect').map((goal) => goal.goal_id));
    const clause = (label) => {
      const match = v3Prompt.match(new RegExp(`${label}: ([a-z_, ]+?)\\.`));
      expect(match, `prompt clause "${label}"`).toBeTruthy();
      return new Set(match[1].split(/, | y /).map((field) => field.trim()));
    };
    const always = clause('Siempre');
    const withAlways = (fields) => new Set([...always, ...fields]);

    expect(required({})).toEqual(always);
    expect(required({ service_scope: 'material' })).toEqual(withAlways(clause('Si service_scope es material o both')));
    expect(required({ service_scope: 'installation' })).toEqual(withAlways(clause('Si service_scope es installation o both')));
    expect(required({ service_scope: 'material', fulfillment: 'delivery' })).toEqual(withAlways([
      ...clause('Si service_scope es material o both'), ...clause('Si fulfillment es delivery'),
    ]));
  });

  test('carries no voseo imperatives in its own instructions', () => {
    const instructions = v3Prompt.replace(/\("necesitás", "querés", "podés"\)/, '');
    expect(instructions).not.toMatch(VOSEO_IMPERATIVES);
    expect(code).not.toMatch(/\\nDevolvé solo JSON/);
  });
});
