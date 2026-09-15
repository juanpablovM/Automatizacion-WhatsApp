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

  test('the message that stalled the deploy would be rejected by this test', () => {
    const stale = normalise('Quiero cotizar hormigón armado para una losa de 100 m2 en Santiago');
    const named = [...catalogueNames()].filter((name) => stale.includes(normalise(name)));
    expect(named).toEqual([]);
  });
});
