import fs from 'node:fs';
import { describe, expect, test } from 'vitest';
import {
  buildMigrationSql, buildRollbackSql, validateTechnicalSheetsData, DEFAULT_DATA_PATH, DEFAULT_APPLY_PATH,
  buildDeltaMigrationSql, buildDeltaRollbackSql, deltaPathFor, rollbackPathFor,
} from '../../scripts/catalog/technical-sheets.mjs';
import { splitFixture } from '../support/technical-sheets-split.mjs';

// -----------------------------------------------------------------------------
// Task 3c.20: the real technical-sheet data is private (the repository is
// public) and lives only in gitignored db/seeds/private/. The tracked
// generator turns it into private apply/rollback SQL. These tests exercise the
// generator with a SYNTHETIC fixture; nothing here comes from the real sheets.
// -----------------------------------------------------------------------------

const FIXTURE_PATH = 'tests/fixtures/catalog/technical-sheets.synthetic.json';
const fixture = () => JSON.parse(fs.readFileSync(FIXTURE_PATH, 'utf8'));

describe('private data stays out of tracked paths', () => {
  test('the default data and SQL paths live under the gitignored db/seeds/private/', () => {
    expect(DEFAULT_DATA_PATH).toBe('db/seeds/private/technical_sheets.json');
    expect(DEFAULT_APPLY_PATH).toBe('db/seeds/private/027_catalog_technical_sheets.sql');
    expect(fs.readFileSync('.gitignore', 'utf8').split('\n')).toContain('db/seeds/private/');
  });

  test('no technical-sheet SQL exists among the automatic migrations or tracked rollbacks', () => {
    expect(fs.readdirSync('infra/postgres/migrations').some((file) => file.startsWith('027'))).toBe(false);
    expect(fs.readdirSync('infra/postgres/rollback').some((file) => file.startsWith('027'))).toBe(false);
    expect(fs.existsSync('db/seeds/catalog')).toBe(false);
  });
});

describe('data validation', () => {
  test('the synthetic fixture is valid', () => {
    expect(validateTechnicalSheetsData(fixture())).toEqual([]);
  });

  test.each([
    ['a price key in other', (data) => { data.items[0].technical_sheet.variants[0].other.precio = '100'; }],
    ['a price key in general_specs', (data) => { data.items[0].technical_sheet.general_specs.price = 'x'; }],
    ['a currency amount in a value', (data) => { data.items[0].technical_sheet.variants[0].weight = '$ 4.600'; }],
    ['a CLP amount in a description', (data) => { data.items[2].short_description = 'Desde 5000 CLP'; }],
    ['a "precio" word in unconfirmed', (data) => { data.items[0].technical_sheet.unconfirmed['Precio demo'] = ['1']; }],
  ])('rejects price-like data: %s', (_label, mutate) => {
    const data = fixture();
    mutate(data);
    expect(validateTechnicalSheetsData(data).some((error) => error.startsWith('price-like data is not allowed'))).toBe(true);
    expect(() => buildMigrationSql(data)).toThrow(/price-like data/);
  });

  test('rejects structural problems', () => {
    const data = fixture();
    data.items[0].name = 'Renombrado';
    data.items[1].technical_sheet.source_files = ['carpeta/privada.pdf'];
    data.items[2].synonyms = ['demo inactivo'];
    data.items.push({ ...data.items[3] });
    const errors = validateTechnicalSheetsData(data);
    expect(errors.some((error) => error.includes('an update carries only'))).toBe(true);
    expect(errors.some((error) => error.includes('plain file names'))).toBe(true);
    expect(errors.some((error) => error.includes('also belongs to demo-inactivo'))).toBe(true);
    expect(errors.some((error) => error.includes('duplicate sku'))).toBe(true);
  });
});

describe('generated SQL', () => {
  const sql = () => buildMigrationSql(fixture());
  const rollback = () => buildRollbackSql(fixture());

  test('is deterministic', () => {
    expect(sql()).toBe(buildMigrationSql(fixture()));
    expect(rollback()).toBe(buildRollbackSql(fixture()));
  });

  test('existing rows only get metadata keys; names, skus and descriptions are never updated', () => {
    const updates = sql().split(';').filter((statement) => /\bUPDATE\b/i.test(statement));
    expect(updates.length).toBe(2);
    for (const statement of updates) {
      const [, setClause] = statement.match(/\bSET\b([\s\S]*?)(?:\bFROM\b|\bWHERE\b|$)/i);
      expect(setClause).not.toMatch(/(?:^|[\s,])(name|sku|short_description|item_type|category_id)\s*=/i);
    }
    expect(sql()).toMatch(/ON CONFLICT \(sku\) DO NOTHING/);
    expect(sql()).not.toMatch(/\b(DELETE|ALTER|DROP|TRUNCATE)\b/i);
  });

  test('keyed by sku and idempotent', () => {
    expect(sql()).toContain("jsonb_set(COALESCE(ci.metadata, '{}'::jsonb), '{technical_sheet}', data.technical_sheet, TRUE)");
    expect(sql()).toMatch(/ci\.metadata->'technical_sheet' IS DISTINCT FROM data\.technical_sheet/);
    expect(sql()).toMatch(/sku = 'demo-inactivo'\s+AND NOT is_active\s+AND deleted_at IS NULL/);
    expect(sql()).toContain("O''Demo, con apóstrofo");
  });

  test('without delta steps the rollback has no delta statement', () => {
    expect(rollback()).not.toMatch(/catalog_migration_0(?!27)/);
  });

  test('the rollback removes only what the apply SQL added', () => {
    expect(rollback()).toMatch(/DELETE FROM catalog_items\s+WHERE metadata->>'catalog_migration_027' = 'created'\s+AND sku IN \('demo-nuevo', 'demo-servicio'\)/);
    expect(rollback()).toMatch(/is_active = FALSE,\s+metadata = metadata - 'synonyms' - 'catalog_migration_027'\s+WHERE sku = 'demo-inactivo'\s+AND metadata->>'catalog_migration_027' = 'reactivated'/);
    expect(rollback()).toContain("metadata = metadata - 'technical_sheet'");
    expect(rollback()).not.toMatch(/metadata\s*=\s*'/);
  });
});

// -----------------------------------------------------------------------------
// Task 3c.27: a later change to data already applied live (the 027 SQL) ships
// as its own private delta step: `deltas[]` names the skus it touches and the
// sheets they had before, and the generator writes <id>_catalog_<name>.sql and
// .down.sql next to the 027 pair. The data file keeps the final state, so the
// regenerated 027 pair still builds (or removes) the whole catalog at once.
// -----------------------------------------------------------------------------
describe('delta steps', () => {
  const split = () => splitFixture(fixture());
  const delta = (data = split()) => data.deltas[0];

  test('the split fixture is valid and the delta paths stay under db/seeds/private/', () => {
    expect(validateTechnicalSheetsData(split())).toEqual([]);
    expect(deltaPathFor(DEFAULT_APPLY_PATH, delta())).toBe('db/seeds/private/030_catalog_demo_split.sql');
    expect(rollbackPathFor(deltaPathFor(DEFAULT_APPLY_PATH, delta()))).toBe('db/seeds/private/030_catalog_demo_split.down.sql');
  });

  test.each([
    ['an id that is not after 027', (data) => { data.deltas[0].id = '027'; }, 'id must be'],
    ['an unsafe name', (data) => { data.deltas[0].name = 'demo split'; }, 'name must match'],
    ['an unknown sku', (data) => { data.deltas[0].skus.push('demo-fantasma'); }, 'unknown sku demo-fantasma'],
    ['a reactivated sku', (data) => { data.deltas[0].skus.push('demo-inactivo'); }, 'only update and create'],
    ['an update without its previous sheet', (data) => { delete data.deltas[0].previous_technical_sheets['demo-existente']; }, 'needs its previous technical_sheet'],
    ['a previous sheet for a created sku', (data) => { data.deltas[0].previous_technical_sheets['demo-dividido'] = data.deltas[0].previous_technical_sheets['demo-existente']; }, 'only updated skus'],
    ['a previous sheet equal to the new one', (data) => { data.deltas[0].previous_technical_sheets['demo-existente'] = data.items[0].technical_sheet; }, 'equals the new one'],
    ['a malformed previous sheet', (data) => { data.deltas[0].previous_technical_sheets['demo-existente'] = { description: 'x' }; }, 'previous technical_sheet must have'],
    ['a sku in two deltas', (data) => { data.deltas.push({ ...data.deltas[0], id: '031', name: 'otra', previous_technical_sheets: { ...data.deltas[0].previous_technical_sheets } }); }, 'already in delta 030'],
  ])('rejects %s', (_label, mutate, message) => {
    const data = split();
    mutate(data);
    expect(validateTechnicalSheetsData(data).some((error) => error.includes(message)), validateTechnicalSheetsData(data).join('\n')).toBe(true);
  });

  test('rejects a price in a previous sheet', () => {
    const data = split();
    data.deltas[0].previous_technical_sheets['demo-existente'].general_specs.precio = '1';
    expect(validateTechnicalSheetsData(data).some((error) => error.startsWith('price-like data is not allowed'))).toBe(true);
  });

  test('the delta apply SQL only creates and updates its own skus, idempotently', () => {
    const sql = buildDeltaMigrationSql(split(), '030');
    expect(sql).toBe(buildDeltaMigrationSql(split(), '030'));
    expect(sql).toContain("'demo-dividido'");
    expect(sql).toContain('"catalog_migration_030":"created"');
    expect(sql).toMatch(/ON CONFLICT \(sku\) DO NOTHING/);
    expect(sql).toMatch(/ci\.metadata->'technical_sheet' IS DISTINCT FROM data\.technical_sheet/);
    for (const other of ['demo-nuevo', 'demo-servicio', 'demo-inactivo']) expect(sql).not.toContain(`'${other}'`);
    expect(sql).not.toMatch(/catalog_migration_027/);
    expect(sql).not.toMatch(/\b(DELETE|ALTER|DROP|TRUNCATE)\b/i);
    expect(sql).not.toMatch(/is_active\s*=/);
  });

  test('the delta rollback deletes what it created and restores the previous sheet only while the delta sheet is there', () => {
    const data = split();
    const sql = buildDeltaRollbackSql(data, '030');
    expect(sql).toMatch(/DELETE FROM catalog_items\s+WHERE \(metadata->>'catalog_migration_030' = 'created' OR metadata->>'catalog_migration_027' = 'created'\)\s+AND sku IN \('demo-dividido'\)/);
    expect(sql).toContain(JSON.stringify(data.deltas[0].previous_technical_sheets['demo-existente']).replace(/'/g, "''"));
    expect(sql).toMatch(/AND ci\.metadata->'technical_sheet' = data\.new_technical_sheet/);
    for (const other of ['demo-nuevo', 'demo-servicio', 'demo-inactivo']) expect(sql).not.toContain(`'${other}'`);
    expect(sql).not.toMatch(/metadata - 'technical_sheet'/);
  });

  test('the 027 rollback also deletes the rows a delta created', () => {
    const sql = buildRollbackSql(split());
    expect(sql).toMatch(/WHERE metadata->>'catalog_migration_027' = 'created'\s+AND sku IN \('demo-nuevo', 'demo-servicio', 'demo-dividido'\)/);
    expect(sql).toMatch(/DELETE FROM catalog_items\s+WHERE metadata->>'catalog_migration_030' = 'created'\s+AND sku IN \('demo-dividido'\)/);
  });

  test('an unknown delta id is an error', () => {
    expect(() => buildDeltaMigrationSql(split(), '099')).toThrow(/no delta 099/);
  });
});
