#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from 'pg';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDirectory, '..', '..');
const migrationsDirectory = path.join(repositoryRoot, 'infra', 'postgres', 'migrations');
const baselineSeedFiles = [
  path.join(repositoryRoot, 'db', 'seeds', '001_lead_statuses.sql'),
  path.join(repositoryRoot, 'db', 'seeds', '002_conversation_statuses.sql'),
];

const databaseConfig = {
  // Reserved 55xxx range. The production stack publishes 5433 on this host, and
  // this script issues DROP SCHEMA public CASCADE: defaulting to the production
  // port meant one matching credential away from destroying real data.
  host: process.env.TEST_PGHOST || 'localhost',
  port: Number(process.env.TEST_PGPORT || 55433),
  database: process.env.TEST_PGDATABASE || 'testdb',
  user: process.env.TEST_PGUSER || 'test',
  password: process.env.TEST_PGPASSWORD || 'test',
};

// Databases that only ever exist on the production server. Finding any of them
// on the target proves this is not a disposable test instance.
const PRODUCTION_DATABASE_NAMES = ['crm_whatsapp', 'crm_whatsapp_app', 'evolution_api'];

// Fail closed before the destructive statement. A wrong port or a reused
// container must abort the reset, never silently drop somebody's schema.
async function assertDisposableTestDatabase(client) {
  const { rows } = await client.query(
    'SELECT datname FROM pg_database WHERE datname = ANY($1::text[])',
    [PRODUCTION_DATABASE_NAMES],
  );

  if (rows.length > 0) {
    const found = rows.map((row) => row.datname).join(', ');
    throw new Error(
      `refusing to reset ${databaseConfig.host}:${databaseConfig.port}: `
      + `the server hosts production database(s) [${found}]`,
    );
  }

  const { rows: currentDatabase } = await client.query('SELECT current_database() AS name');
  if (currentDatabase[0].name !== databaseConfig.database) {
    throw new Error(
      `refusing to reset: connected to "${currentDatabase[0].name}" `
      + `instead of "${databaseConfig.database}"`,
    );
  }
}

async function applySqlFile(client, filePath) {
  const sql = await fs.readFile(filePath, 'utf8');
  await client.query(sql);
  console.log(`Applied ${path.relative(repositoryRoot, filePath)}`);
}

async function resetTestDatabase() {
  const client = new Client(databaseConfig);

  try {
    await client.connect();
    await assertDisposableTestDatabase(client);
    await client.query('DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;');

    const migrationFiles = (await fs.readdir(migrationsDirectory))
      .filter((fileName) => /^\d+.*\.sql$/.test(fileName))
      .sort((left, right) => left.localeCompare(right));

    if (migrationFiles.length === 0) {
      throw new Error(`No migrations found in ${migrationsDirectory}`);
    }

    for (const fileName of migrationFiles) {
      await applySqlFile(client, path.join(migrationsDirectory, fileName));
    }

    for (const seedFile of baselineSeedFiles) {
      await applySqlFile(client, seedFile);
    }

    console.log(`Rebuilt test database with ${migrationFiles.length} migrations`);
  } catch (error) {
    console.error(`Failed to reset test database: ${error.message}`);
    process.exitCode = 1;
  } finally {
    await client.end();
  }
}

await resetTestDatabase();
