import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(testDirectory, '..', '..');
const harness = path.join(repositoryRoot, 'scripts', 'ops', 'test-e2e-lead-creation.sh');
const seeds = [
  'db/seeds/006_catalogo_hormiglass.sql',
  'db/seeds/007_catalogo_hormiglass_actualizacion.sql',
];

// The advisor refuses to quote anything outside the official catalogue, which is
// the guardrail working, not a defect. Note the two layers do not agree by
// accident: classification can call something a product (a material rather than
// a service) while the catalogue still does not carry it, and the catalogue
// wins. An acceptance message naming such an item can therefore never reach a
// lead, and the run fails as though the product were broken. It cost us a deploy.
// Products only. A service such as "Instalación" is also a catalogue row, but
// naming it does not tell the advisor what to quote, so a message that mentions
// only a service still cannot reach a lead.
const catalogueNames = () => {
  const names = new Set();
  for (const seed of seeds) {
    const sql = fs.readFileSync(path.join(repositoryRoot, seed), 'utf8');
    // Rows look like: ('sku', 'Display Name', 'product', ...
    for (const match of sql.matchAll(/\(\s*'[a-z0-9-]+'\s*,\s*'([^']+)'\s*,\s*'product'/g)) {
      names.add(match[1].toLowerCase());
    }
  }
  return names;
};

const normalise = (value) => value
  .toLowerCase()
  .normalize('NFD')
  .replace(/[̀-ͯ]/g, '');

describe('the acceptance message asks for something Hormiglass actually sells', () => {
  test('the catalogue seed is readable and non-trivial', () => {
    const names = catalogueNames();
    expect(names.size).toBeGreaterThan(10);
    expect(names).toContain('pastelones');
  });

  test('TEST_MESSAGE names at least one catalogue product', () => {
    const source = fs.readFileSync(harness, 'utf8');
    const match = source.match(/^TEST_MESSAGE="([^"]+)"/m);
    expect(match, 'the harness defines no TEST_MESSAGE').not.toBeNull();

    const message = normalise(match[1]);
    const named = [...catalogueNames()].filter((name) => message.includes(normalise(name)));

    expect(
      named.length,
      `TEST_MESSAGE asks for something outside the catalogue: "${match[1]}"`,
    ).toBeGreaterThan(0);
  });

  test('TEST_MESSAGE exercises private factory pickup with an explicit quantity', () => {
    const source = fs.readFileSync(harness, 'utf8');
    const match = source.match(/^TEST_MESSAGE="([^"]+)"/m);

    expect(match, 'the harness defines no TEST_MESSAGE').not.toBeNull();
    expect(match[1]).toMatch(/\b100\s+unidades\b/i);
    expect(match[1]).toMatch(/\bsolo material\b/i);
    expect(match[1]).toMatch(/\bretirar en fábrica\b/i);
    expect(match[1]).not.toMatch(/\b(?:comuna|dirección|avenida|calle|pasaje|camino)\b/i);
  });

  test('the harness waits for the exact first inbound event to finish', () => {
    const source = fs.readFileSync(harness, 'utf8');

    expect(source).toContain("ie.external_message_id = 'e2e-test-${timestamp}-complete'");
    expect(source).toContain("[ \"${1:-}\" = processed ] && [ \"${2:-}\" = completed ]");
    expect(source).toContain('[ "${4:-}" = accepted ]');
    expect(source).toContain('LEFT JOIN conversation_turn_executions turn ON turn.inbound_event_id = ie.id');
    expect(source).toContain('LEFT JOIN advisor_decisions ad ON ad.id = turn.advisor_decision_id');
    expect(source).toContain('E2E_WAIT_SECONDS=${E2E_WAIT_SECONDS:-240}');
  });

  test('the harness verifies the pickup address without persisting a client location', () => {
    const source = fs.readFileSync(harness, 'utf8');

    expect(source).toContain("m.text_body ILIKE '%Portezuelo 1502%'");
    expect(source).toContain("m.text_body ILIKE '%San Bernardo%'");
    expect(source).toContain('[ "$servicio" != retiro ] || [ -n "$ciudad" ]');
    expect(source).toContain("qualification_context->>'fulfillment'='pickup'");
    expect(source).toContain("NULLIF(qualification_context->>'commune','') IS NULL");
    expect(source).toContain("NULLIF(qualification_context->>'debris_removal','') IS NULL");
  });

  test('the final acceptance proves durable delivery without coupling to AI wording', () => {
    const source = fs.readFileSync(harness, 'utf8');

    expect(source).toContain('m.inbound_event_id=ie.id');
    expect(source).toContain("m.delivery_status='sent'");
    expect(source).toContain('m.idempotency_key IS NOT NULL');
    expect(source).not.toContain("m.text_body LIKE '%quedó asignada%'");
  });

  test('the message that stalled the deploy would be rejected by this test', () => {
    const stale = normalise('Quiero cotizar hormigón armado para una losa de 100 m2 en Santiago');
    const named = [...catalogueNames()].filter((name) => stale.includes(normalise(name)));
    expect(named).toEqual([]);
  });
});
