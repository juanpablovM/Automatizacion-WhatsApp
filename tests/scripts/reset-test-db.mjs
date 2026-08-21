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
  host: process.env.TEST_PGHOST || 'localhost',
  port: Number(process.env.TEST_PGPORT || 5433),
  database: process.env.TEST_PGDATABASE || 'testdb',
  user: process.env.TEST_PGUSER || 'test',
  password: process.env.TEST_PGPASSWORD || 'test',
};

async function applySqlFile(client, filePath) {
  const sql = await fs.readFile(filePath, 'utf8');
  await client.query(sql);
  console.log(`Applied ${path.relative(repositoryRoot, filePath)}`);
}

async function resetTestDatabase() {
  const client = new Client(databaseConfig);

  try {
    await client.connect();
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
