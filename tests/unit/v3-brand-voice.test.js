import fs from 'node:fs';
import { describe, expect, test } from 'vitest';

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

  test('carries no voseo imperatives in its own instructions', () => {
    const instructions = v3Prompt.replace(/\("necesitás", "querés", "podés"\)/, '');
    expect(instructions).not.toMatch(VOSEO_IMPERATIVES);
    expect(code).not.toMatch(/\\nDevolvé solo JSON/);
  });
});
