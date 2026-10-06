#!/usr/bin/env node
// Technical-sheet PDF files (task 3c.29): load SQL generator for PRIVATE data.
//
// The PDFs and the map that assigns them to catalog products are the owner's
// private material and are never committed (the GitHub repository is public):
//   db/seeds/private/technical_sheet_files.json          <- map (private)
//   backups/.../final/{originals,generated}/*.pdf        <- PDFs (private, base_dir of the map)
//   db/seeds/private/032_technical_sheet_files.sql       <- generated load SQL (private)
//   db/seeds/private/032_technical_sheet_files.down.sql  <- generated rollback (private)
// The table itself is public schema: infra/postgres/migrations/032_create_technical_sheet_files.sql.
//
// Usage (from the repository root):
//   node scripts/catalog/technical-sheet-files.mjs            # validate, write both SQL files
//   node scripts/catalog/technical-sheet-files.mjs --check    # fail if the SQL files are missing or stale
//   node scripts/catalog/technical-sheet-files.mjs --map <json> --out <apply.sql>
//
// Map shape: { base_dir, files: [{ sku, variant|null, file, covers_variants[] , ... }] }, where
// `file` is relative to base_dir. Each entry becomes one row keyed by (sku, sheet_key); sheet_key
// is the file stem without its "ficha-" prefix, and the assistant names the sheet `sheet:<sheet_key>`.
//
// The generated SQL never controls the transaction. Apply it atomically, after the public 032
// migration:
//   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -1 -f db/seeds/private/032_technical_sheet_files.sql
// Dry run: BEGIN; \i <migration>; \i <load>; <checks>; ROLLBACK;
// It is idempotent: a row is rewritten only when its bytes (sha256), variant, covers or file name
// changed, and a loaded sheet that is no longer in the map is deactivated (never deleted).
// A file over MAX_TECHNICAL_SHEET_BYTES is excluded (reported on stdout and in the SQL header);
// recompress it and run the generator again.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const DEFAULT_MAP_PATH = 'db/seeds/private/technical_sheet_files.json';
export const DEFAULT_APPLY_PATH = 'db/seeds/private/032_technical_sheet_files.sql';
// Same limit as the table CHECK (migration 032).
export const MAX_TECHNICAL_SHEET_BYTES = 16 * 1024 * 1024;
const PDF_MAGIC = Buffer.from('%PDF-');
const SLUG = /^[a-z0-9-]+$/;

export const sheetKeyFor = (file) => {
  const base = path.posix.basename(String(file));
  if (!base.endsWith('.pdf')) throw new Error(`technical sheet file must be a .pdf: ${file}`);
  const key = base.slice(0, -'.pdf'.length).replace(/^ficha-/, '');
  if (!SLUG.test(key)) throw new Error(`invalid sheet key "${key}" for ${file}: use a lowercase slug file name`);
  return key;
};

const readHead = (filePath, length) => {
  const handle = fs.openSync(filePath, 'r');
  try {
    const buffer = Buffer.alloc(length);
    const read = fs.readSync(handle, buffer, 0, length, 0);
    return buffer.subarray(0, read);
  } finally {
    fs.closeSync(handle);
  }
};

// Validates the map against the files on disk and returns the rows to load plus the files excluded
// by the size cap. `readContent: false` checks everything but the bytes and digest (local audits).
export const planTechnicalSheetFiles = ({ map, baseDir, maxBytes = MAX_TECHNICAL_SHEET_BYTES, readContent = true }) => {
  if (!map || !Array.isArray(map.files) || map.files.length === 0) throw new Error('map.files must be a non-empty array');
  const root = path.resolve(repoRoot, baseDir);
  const rows = [];
  const excluded = [];
  const seen = new Set();
  map.files.forEach((entry, index) => {
    const where = `files[${index}]`;
    if (typeof entry?.sku !== 'string' || !SLUG.test(entry.sku)) throw new Error(`${where}: invalid sku`);
    if (!(entry.variant === null || (typeof entry.variant === 'string' && entry.variant.trim() !== ''))) {
      throw new Error(`${where}: variant must be null or a non-empty string`);
    }
    const covers = Array.isArray(entry.covers_variants) ? entry.covers_variants : [];
    if (!covers.every((value) => typeof value === 'string' && value.trim() !== '')) throw new Error(`${where}: covers_variants must be strings`);
    const filePath = path.resolve(root, String(entry.file ?? ''));
    if (!filePath.startsWith(`${root}${path.sep}`)) throw new Error(`${where}: file is outside the base directory`);
    const sheetKey = sheetKeyFor(entry.file);
    const identity = `${entry.sku}|${sheetKey}`;
    if (seen.has(identity)) throw new Error(`${where}: duplicate sheet ${identity}`);
    seen.add(identity);
    if (!fs.existsSync(filePath)) throw new Error(`${where}: file not found: ${entry.file}`);
    const sizeBytes = fs.statSync(filePath).size;
    if (!readHead(filePath, PDF_MAGIC.length).equals(PDF_MAGIC)) throw new Error(`${where}: not a PDF: ${entry.file}`);
    if (sizeBytes > maxBytes) {
      excluded.push({ sku: entry.sku, sheet_key: sheetKey, file: entry.file, size_bytes: sizeBytes, reason: 'size_cap' });
      return;
    }
    const row = {
      sku: entry.sku,
      sheet_key: sheetKey,
      variant: entry.variant,
      covers_variants: covers,
      file_name: path.posix.basename(entry.file),
      mime_type: 'application/pdf',
      size_bytes: sizeBytes,
    };
    if (readContent) {
      const content = fs.readFileSync(filePath);
      row.content = content;
      row.sha256 = createHash('sha256').update(content).digest('hex');
    }
    rows.push(row);
  });
  return { rows, excluded };
};

const literal = (value) => (value === null ? 'NULL' : `'${String(value).replace(/'/g, "''")}'`);
const textArray = (values) => (values.length === 0 ? "'{}'::text[]" : `ARRAY[${values.map(literal).join(', ')}]::text[]`);
const keyList = (rows) => rows.map((row) => `(${literal(row.sku)}, ${literal(row.sheet_key)})`).join(',\n  ');

export const buildTechnicalSheetFilesSql = ({ rows, excluded = [] }) => {
  if (rows.some((row) => !Buffer.isBuffer(row.content))) throw new Error('the load SQL needs every file content');
  const header = [
    '-- Technical-sheet PDF files (task 3c.29). PRIVATE generated SQL: never commit it.',
    '-- GENERATED by scripts/catalog/technical-sheet-files.mjs; apply after the public 032 migration,',
    '-- inside one transaction (psql -1). It never issues BEGIN/COMMIT itself.',
    `-- Rows: ${rows.length}. Excluded by the size cap: ${excluded.length === 0 ? 'none' : excluded.map((entry) => `${entry.sku}|${entry.sheet_key} (${entry.size_bytes} bytes)`).join(', ')}.`,
    '',
  ];
  const upserts = rows.map((row) => `INSERT INTO technical_sheet_files (
  sku, sheet_key, variant, covers_variants, file_name, mime_type, content, sha256, size_bytes, active
) VALUES (
  ${literal(row.sku)}, ${literal(row.sheet_key)}, ${literal(row.variant)}, ${textArray(row.covers_variants)},
  ${literal(row.file_name)}, ${literal(row.mime_type)},
  decode('${row.content.toString('base64')}', 'base64'),
  ${literal(row.sha256)}, ${row.size_bytes}, TRUE
)
ON CONFLICT (sku, sheet_key) DO UPDATE SET
  variant = EXCLUDED.variant,
  covers_variants = EXCLUDED.covers_variants,
  file_name = EXCLUDED.file_name,
  mime_type = EXCLUDED.mime_type,
  content = EXCLUDED.content,
  sha256 = EXCLUDED.sha256,
  size_bytes = EXCLUDED.size_bytes,
  active = TRUE
WHERE (technical_sheet_files.sha256, technical_sheet_files.variant, technical_sheet_files.covers_variants,
       technical_sheet_files.file_name, technical_sheet_files.active)
  IS DISTINCT FROM (EXCLUDED.sha256, EXCLUDED.variant, EXCLUDED.covers_variants, EXCLUDED.file_name, TRUE);
`);
  const retire = `-- Sheets no longer in the map stay for the record but are never offered or sent again.
UPDATE technical_sheet_files
SET active = FALSE
WHERE active
  AND (sku, sheet_key) NOT IN (
  ${keyList(rows)}
  );
`;
  return [...header, ...upserts, retire].join('\n');
};

export const buildTechnicalSheetFilesRollbackSql = ({ rows }) => `-- Rollback of the technical-sheet PDF files load (task 3c.29). PRIVATE generated SQL: never commit it.
-- GENERATED by scripts/catalog/technical-sheet-files.mjs. Removes exactly the loaded sheets.
DELETE FROM technical_sheet_files
WHERE (sku, sheet_key) IN (
  ${keyList(rows)}
);
`;

const argValue = (name, fallback) => {
  const index = process.argv.indexOf(name);
  return index === -1 ? fallback : process.argv[index + 1];
};

const main = () => {
  const mapPath = path.resolve(repoRoot, argValue('--map', DEFAULT_MAP_PATH));
  const applyPath = path.resolve(repoRoot, argValue('--out', DEFAULT_APPLY_PATH));
  const rollbackPath = applyPath.replace(/\.sql$/, '.down.sql');
  if (!fs.existsSync(mapPath)) {
    console.error(`private map not found: ${path.relative(repoRoot, mapPath)} (it is never committed; ask the owner for it)`);
    process.exit(1);
  }
  const map = JSON.parse(fs.readFileSync(mapPath, 'utf8'));
  const plan = planTechnicalSheetFiles({ map, baseDir: argValue('--base-dir', map.base_dir) });
  const outputs = [[applyPath, buildTechnicalSheetFilesSql(plan)], [rollbackPath, buildTechnicalSheetFilesRollbackSql(plan)]];
  for (const entry of plan.excluded) {
    console.warn(`excluded (over ${MAX_TECHNICAL_SHEET_BYTES} bytes): ${entry.sku} ${entry.file} (${entry.size_bytes} bytes)`);
  }
  if (process.argv.includes('--check')) {
    const stale = outputs.filter(([file, sql]) => !fs.existsSync(file) || fs.readFileSync(file, 'utf8') !== sql);
    if (stale.length > 0) {
      console.error(`stale or missing: ${stale.map(([file]) => path.relative(repoRoot, file)).join(', ')}`);
      process.exit(1);
    }
    console.log(`up to date: ${plan.rows.length} sheets`);
    return;
  }
  for (const [file, sql] of outputs) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, sql);
    console.log(`wrote ${path.relative(repoRoot, file)}`);
  }
  console.log(`${plan.rows.length} sheets, ${plan.rows.reduce((total, row) => total + row.size_bytes, 0)} bytes`);
};

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
