// =============================================================================
// Owner decision 2026-10-14: the business-hours FAQ states the hours published
// on hormiglass.cl, Saturdays included. The old answer told customers Saturdays
// were closed. Migration 036 rewrites the seeded row; its rollback restores it.
// Every test runs inside a transaction that is rolled back.
// =============================================================================
import fs from 'node:fs';
import pg from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'vitest';

const enabled = process.env.TEST_PG_INTEGRATION === '1';
const describeIntegration = enabled ? describe : describe.skip;
const connection = {
  host: process.env.TEST_PGHOST || '127.0.0.1',
  port: Number(process.env.TEST_PGPORT || 55433),
  database: process.env.TEST_PGDATABASE || 'testdb',
  user: process.env.TEST_PGUSER || 'test',
  password: process.env.TEST_PGPASSWORD || 'test',
};

const migrationSql = fs.readFileSync('infra/postgres/migrations/036_faq_business_hours.sql', 'utf8');
const rollbackSql = fs.readFileSync('infra/postgres/rollback/036_faq_business_hours.down.sql', 'utf8');

const OLD_QUESTION = '¿Atienden sábados?';
const OLD_ANSWER = 'Nuestro horario de atencion es de lunes a viernes en horario comercial. Los sabados, domingos y festivos no tenemos atencion presencial, pero puedes dejar tu consulta por WhatsApp y te responderemos el siguiente dia habil.';
const OLD_TAGS = ['horario', 'sabado', 'finde', 'fin de semana', 'atencion'];

describeIntegration('business-hours FAQ (migration 036)', () => {
  const client = new pg.Client(connection);
  let faqId;

  beforeAll(async () => { await client.connect(); });
  afterAll(async () => { await client.end(); });

  beforeEach(async () => {
    await client.query('BEGIN');
    ({ rows: [{ id: faqId }] } = await client.query(
      'INSERT INTO faq_entries (question, answer, tags, priority, is_active) VALUES ($1, $2, $3, 3, TRUE) RETURNING id',
      [OLD_QUESTION, OLD_ANSWER, OLD_TAGS],
    ));
  });
  afterEach(async () => { await client.query('ROLLBACK'); });

  const faq = async () => (await client.query('SELECT question, answer, tags FROM faq_entries WHERE id = $1', [faqId])).rows[0];

  test('states the published hours, Saturdays included', async () => {
    await client.query(migrationSql);
    const row = await faq();
    expect(row.question).toBe('¿Cuál es el horario de atención?');
    expect(row.answer).toContain('de lunes a martes de 8:00 a 13:00 y de 14:00 a 18:00');
    expect(row.answer).toContain('de miércoles a viernes de 8:00 a 13:00 y de 14:00 a 17:00');
    expect(row.answer).toContain('los sábados de 8:00 a 14:00');
    expect(row.answer).toContain('Domingos y festivos no atendemos');
    expect(row.tags).toEqual(expect.arrayContaining([...OLD_TAGS, 'sábado', 'domingo', 'festivo', 'hora', 'abren', 'cierran']));
  });

  test('running it twice leaves the same row', async () => {
    await client.query(migrationSql);
    const once = await faq();
    await client.query(migrationSql);
    expect(await faq()).toEqual(once);
  });

  test('the rollback restores the previous answer', async () => {
    await client.query(migrationSql);
    await client.query(rollbackSql);
    expect(await faq()).toEqual({ question: OLD_QUESTION, answer: OLD_ANSWER, tags: OLD_TAGS });
  });
});
