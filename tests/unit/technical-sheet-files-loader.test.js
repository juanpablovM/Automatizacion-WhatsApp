import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import {
  DEFAULT_MAP_PATH,
  DEFAULT_APPLY_PATH,
  MAX_TECHNICAL_SHEET_BYTES,
  sheetKeyFor,
  planTechnicalSheetFiles,
  buildTechnicalSheetFilesSql,
  buildTechnicalSheetFilesRollbackSql,
} from '../../scripts/catalog/technical-sheet-files.mjs';

// -----------------------------------------------------------------------------
// Task 3c.29: the PDF technical sheets the bot can send live in the
// technical_sheet_files table (public schema, migration 032). Their bytes are
// private, so the load SQL is generated locally from the private map
// (db/seeds/private/technical_sheet_files.json) plus the PDFs, into the
// gitignored db/seeds/private/. Here everything is SYNTHETIC: fake PDFs
// written to a temporary directory.
// -----------------------------------------------------------------------------

const sha256 = (buffer) => createHash('sha256').update(buffer).digest('hex');
const fakePdf = (label, size = 0) => Buffer.concat([
  Buffer.from(`%PDF-1.4\n% synthetic ${label}\n`),
  Buffer.alloc(size, 0x20),
  Buffer.from('\n%%EOF\n'),
]);

let baseDir;
const write = (relative, buffer) => {
  const target = path.join(baseDir, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, buffer);
};
const MAP = {
  base_dir: 'unused/',
  files: [
    { sku: 'demo-bloque', variant: null, file: 'originals/ficha-demo-bloque.pdf', kind: 'original', source_sheets: ['x'], covers_variants: ['Bloque Demo 1', 'Bloque Demo 2'] },
    { sku: 'demo-bloque', variant: 'Bloque Demo 2', file: 'generated/ficha-demo-bloque-bloque-demo-2.pdf', kind: 'generated', source_sheets: [], covers_variants: ['Bloque Demo 2'] },
    // Two products may share one file (the same document is listed under both).
    { sku: 'demo-placa', variant: null, file: 'originals/ficha-demo-placa-50.pdf', kind: 'original', source_sheets: [], covers_variants: ['Placa Demo 50'] },
    { sku: 'demo-placas', variant: null, file: 'originals/ficha-demo-placa-50.pdf', kind: 'original', source_sheets: [], covers_variants: ['Placa Demo 50'] },
    // A product may have two general sheets (both variant null): rows are keyed by file, not variant.
    { sku: 'demo-placas', variant: null, file: 'originals/ficha-demo-placa-60.pdf', kind: 'original', source_sheets: [], covers_variants: ['Placa Demo 60'] },
  ],
  no_sheet: [{ sku: 'demo-cemento', reason: 'synthetic' }],
};

beforeAll(() => {
  baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sheet-files-'));
  write('originals/ficha-demo-bloque.pdf', fakePdf('bloque'));
  write('generated/ficha-demo-bloque-bloque-demo-2.pdf', fakePdf('bloque 2'));
  write('originals/ficha-demo-placa-50.pdf', fakePdf('placa 50'));
  write('originals/ficha-demo-placa-60.pdf', fakePdf('placa 60'));
});
afterAll(() => fs.rmSync(baseDir, { recursive: true, force: true }));

const plan = (map = MAP, options = {}) => planTechnicalSheetFiles({ map, baseDir, ...options });

describe('sheet keys are stable file stems', () => {
  test('the ficha- prefix and the .pdf suffix are dropped', () => {
    expect(sheetKeyFor('originals/ficha-demo-placa-50.pdf')).toBe('demo-placa-50');
    expect(sheetKeyFor('generated/ficha-demo-bloque-bloque-demo-2.pdf')).toBe('demo-bloque-bloque-demo-2');
  });

  test('anything that is not a plain lowercase slug is refused', () => {
    expect(() => sheetKeyFor('originals/Ficha Demo.pdf')).toThrow(/sheet key/);
    expect(() => sheetKeyFor('originals/ficha-demo.docx')).toThrow(/pdf/);
  });
});

describe('planTechnicalSheetFiles', () => {
  test('one row per map entry, with the exact bytes, digest and size', () => {
    const { rows, excluded } = plan();
    expect(excluded).toEqual([]);
    expect(rows.map((row) => [row.sku, row.sheet_key, row.variant])).toEqual([
      ['demo-bloque', 'demo-bloque', null],
      ['demo-bloque', 'demo-bloque-bloque-demo-2', 'Bloque Demo 2'],
      ['demo-placa', 'demo-placa-50', null],
      ['demo-placas', 'demo-placa-50', null],
      ['demo-placas', 'demo-placa-60', null],
    ]);
    const row = rows[0];
    const bytes = fs.readFileSync(path.join(baseDir, 'originals/ficha-demo-bloque.pdf'));
    expect(row).toMatchObject({
      file_name: 'ficha-demo-bloque.pdf',
      mime_type: 'application/pdf',
      size_bytes: bytes.length,
      sha256: sha256(bytes),
      covers_variants: ['Bloque Demo 1', 'Bloque Demo 2'],
    });
    expect(Buffer.compare(row.content, bytes)).toBe(0);
  });

  test('a file over the size cap is excluded and reported, never truncated', () => {
    write('originals/ficha-demo-enorme.pdf', fakePdf('enorme', 4096));
    const map = { ...MAP, files: [...MAP.files, { sku: 'demo-enorme', variant: null, file: 'originals/ficha-demo-enorme.pdf', covers_variants: [] }] };
    const { rows, excluded } = plan(map, { maxBytes: 1024 });
    expect(rows.some((row) => row.sku === 'demo-enorme')).toBe(false);
    expect(excluded).toEqual([expect.objectContaining({ sku: 'demo-enorme', reason: 'size_cap', size_bytes: expect.any(Number) })]);
  });

  test('the default cap is 16 MiB, the same limit the table enforces', () => {
    expect(MAX_TECHNICAL_SHEET_BYTES).toBe(16 * 1024 * 1024);
    const migration = fs.readFileSync('infra/postgres/migrations/032_create_technical_sheet_files.sql', 'utf8');
    expect(migration).toContain(String(MAX_TECHNICAL_SHEET_BYTES));
  });

  test.each([
    ['a missing file', { file: 'originals/ficha-no-existe.pdf' }, /not found/],
    ['a path that leaves the base directory', { file: '../ficha-demo-fuera.pdf' }, /outside/],
    ['an invalid sku', { sku: 'Demo Bloque' }, /sku/],
    ['a variant that is not a non-empty string or null', { variant: '' }, /variant/],
  ])('refuses %s', (_label, override, message) => {
    const map = { ...MAP, files: [{ ...MAP.files[0], ...override }] };
    expect(() => plan(map)).toThrow(message);
  });

  test('refuses a file that is not a PDF', () => {
    write('originals/ficha-demo-texto.pdf', Buffer.from('not a pdf'));
    const map = { ...MAP, files: [{ ...MAP.files[0], file: 'originals/ficha-demo-texto.pdf' }] };
    expect(() => plan(map)).toThrow(/not a PDF/);
  });

  test('refuses the same file listed twice for one product', () => {
    const map = { ...MAP, files: [MAP.files[0], { ...MAP.files[0], variant: 'Bloque Demo 1' }] };
    expect(() => plan(map)).toThrow(/duplicate/);
  });
});

describe('the generated load SQL', () => {
  const sql = () => buildTechnicalSheetFilesSql(plan());

  test('upserts by (sku, sheet_key) and rewrites a row only when something changed', () => {
    const text = sql();
    expect(text).toContain('INSERT INTO technical_sheet_files');
    expect(text).toContain('ON CONFLICT (sku, sheet_key) DO UPDATE');
    expect(text).toMatch(/IS DISTINCT FROM/);
    expect((text.match(/INSERT INTO technical_sheet_files/g) || []).length).toBe(5);
  });

  test('carries the bytes as base64 and the digest the table verifies', () => {
    const text = sql();
    const { rows } = plan();
    expect(text).toContain(`decode('${rows[0].content.toString('base64')}', 'base64')`);
    expect(text).toContain(`'${rows[0].sha256}'`);
  });

  test('deactivates, never deletes, a sheet that is no longer in the map', () => {
    const text = sql();
    expect(text).toMatch(/UPDATE technical_sheet_files\s+SET active = FALSE/);
    expect(text).not.toMatch(/DELETE FROM/);
  });

  test('never controls the transaction: the caller wraps it (psql -1, or BEGIN...ROLLBACK for a dry run)', () => {
    expect(sql()).not.toMatch(/^\s*(BEGIN|COMMIT|ROLLBACK)\b/im);
    expect(buildTechnicalSheetFilesRollbackSql(plan())).not.toMatch(/^\s*(BEGIN|COMMIT|ROLLBACK)\b/im);
  });

  test('is deterministic', () => {
    expect(sql()).toBe(sql());
  });

  test('the rollback deletes exactly the loaded keys', () => {
    const text = buildTechnicalSheetFilesRollbackSql(plan());
    expect(text).toContain('DELETE FROM technical_sheet_files');
    expect(text).toContain("('demo-placas', 'demo-placa-60')");
    expect(text).not.toContain('decode(');
  });
});

describe('private outputs stay out of git', () => {
  test('the default paths live in the gitignored private seeds directory', () => {
    expect(DEFAULT_MAP_PATH).toBe('db/seeds/private/technical_sheet_files.json');
    expect(DEFAULT_APPLY_PATH).toBe('db/seeds/private/032_technical_sheet_files.sql');
    const gitignore = fs.readFileSync('.gitignore', 'utf8');
    expect(gitignore).toMatch(/^db\/seeds\/private\/$/m);
    expect(gitignore).toMatch(/^backups\/$/m);
  });
});

// Local only: the real map and PDFs are private (gitignored), so CI skips this.
const realMapPresent = fs.existsSync(DEFAULT_MAP_PATH);
describe.skipIf(!realMapPresent)('the private map (local only)', () => {
  test('every mapped file exists, is a PDF, and only oversized files are excluded', () => {
    const map = JSON.parse(fs.readFileSync(DEFAULT_MAP_PATH, 'utf8'));
    const result = planTechnicalSheetFiles({ map, baseDir: map.base_dir, readContent: false });
    expect(result.rows.length + result.excluded.length).toBe(map.files.length);
    expect(result.excluded.every((entry) => entry.reason === 'size_cap')).toBe(true);
    expect(new Set(result.rows.map((row) => `${row.sku}|${row.sheet_key}`)).size).toBe(result.rows.length);
  });
});
