// =============================================================================
// No inbound debounce while a seller owns the chat (migration 042).
//
// While a seller owns the chat the orchestrator only persists the customer
// turn (control path, no AI), so the 6 s debounce only delays the message on
// its way to the CRM. A customer event of a seller-owned contact is claimed
// inline when the queue is idle, and the recovery claim admits a seller-owned
// queue without waiting the window. FIFO per contact is unchanged: an event
// never overtakes older pending ones.
//
// "Seller-owned" is the orchestrator's chat_authority.bot_suppressed for the
// contact's latest lead, minus the quote follow-up mode (the bot may still
// answer the new-quote offer there, from the whole burst). The parity test
// below runs the orchestrator's own CTEs to keep both readings identical.
// =============================================================================
import fs from 'node:fs';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';

const enabled = process.env.TEST_PG_INTEGRATION === '1';
const describeIntegration = enabled ? describe : describe.skip;
const connection = {
  host: process.env.TEST_PGHOST || '127.0.0.1',
  port: Number(process.env.TEST_PGPORT || 55433),
  database: process.env.TEST_PGDATABASE || 'testdb',
  user: process.env.TEST_PGUSER || 'test',
  password: process.env.TEST_PGPASSWORD || 'test',
};

const read = (file) => fs.readFileSync(file, 'utf8');
const claimSql = read('db/queries/n8n/inbound-events/01_claim_inbound_event.sql');
const recoverSql = read('db/queries/n8n/inbound-events/02_recover_and_claim_inbound_events.sql');
const markProcessedSql = JSON.parse(read('n8n/workflows/wa-inbound-downstream-dispatcher.json'))
  .nodes.find((node) => node.name === 'Mark Inbox Processed').parameters.query;

// The orchestrator's lead resolution and chat authority, verbatim from the
// Load Conversation State node.
const loadSql = JSON.parse(read('n8n/workflows/wa-conversation-orchestrator.json'))
  .nodes.find((node) => node.name === 'Load Conversation State').parameters.query;
const authorityCtes = loadSql
  .slice(loadSql.indexOf('latest_lead AS ('), loadSql.indexOf('follow_up_status AS ('))
  .trim()
  .replace(/,$/, '');
// Migration 047: the chat authority also reads the latest conversation's own
// (conversation-keyed) ownership.
const latestConversationCte = loadSql
  .slice(loadSql.indexOf('latest_conversation AS ('), loadSql.indexOf('last_persisted_inbound AS ('))
  .trim()
  .replace(/,$/, '');
const orchestratorAuthoritySql = `
  WITH input_payload AS (
    SELECT $1::text AS phone_number, $2::bigint AS source_number_id
  ),
  ${latestConversationCte},
  ${authorityCtes}
  SELECT COALESCE(ca.bot_suppressed, FALSE) AS bot_suppressed, ca.sla_mode
  FROM input_payload ip
  LEFT JOIN chat_authority ca ON TRUE
`;

const INSTANCE = 'seller-owned-debounce-test';

describeIntegration('no inbound debounce for seller-owned chats', () => {
  const client = new pg.Client(connection);
  let sourceNumberId;
  let otherSourceNumberId;
  let leadStatusId;
  let sequence = 0;

  const cleanup = async () => {
    const sources = `SELECT id FROM whatsapp_numbers WHERE instance_name LIKE '${INSTANCE}%'`;
    await client.query(`
      BEGIN;
      DELETE FROM lead_chat_ownerships WHERE lead_id IN (
        SELECT id FROM leads WHERE source_number_id IN (${sources}));
      DELETE FROM conversations WHERE source_number_id IN (${sources});
      DELETE FROM leads WHERE source_number_id IN (${sources});
      DELETE FROM inbound_events WHERE instance_name LIKE '${INSTANCE}%';
      DELETE FROM whatsapp_numbers WHERE instance_name LIKE '${INSTANCE}%';
      COMMIT;
    `);
  };

  const newPhone = () => {
    sequence += 1;
    return `5698${String(process.pid).slice(-3)}${String(sequence).padStart(4, '0')}`;
  };

  // The 22 parameters of the Persist Durable Inbox node, in order.
  const claim = async ({
    phone, text = 'Hola', fromMe = false, debounce = '6', requested = 'true', id,
  }) => {
    sequence += 1;
    const externalId = id || `seller-owned-${sequence}`;
    const { rows } = await client.query(claimSql, [
      INSTANCE, externalId, phone, 'messages.upsert', 'MESSAGES_UPSERT', requested,
      JSON.stringify({ data: { key: { id: externalId } } }), 'Customer', `${phone}@s.whatsapp.net`,
      '1789000000', 'text', text, null, null, null, null, null, null, null,
      String(fromMe), fromMe ? 'own_message' : 'customer', debounce,
    ]);
    return rows[0];
  };

  const recover = async ({ scope, debounce = 6, maxWait = 30 }) => (
    await client.query(recoverSql, [600, 20, 5, debounce, maxWait, scope == null ? '' : String(scope)])
  ).rows;

  const statuses = async (phone) => (await client.query(`
    SELECT processing_status FROM inbound_events
    WHERE instance_name = $2 AND phone_number = $1 ORDER BY id
  `, [phone, INSTANCE])).rows.map((row) => row.processing_status);

  const markProcessed = async (event) => {
    await client.query(`UPDATE inbound_events SET downstream_payload = '{"done":true}'::jsonb WHERE id = $1`, [
      event.inbound_event_id,
    ]);
    await client.query(markProcessedSql, [String(event.inbound_event_id), event.processing_token]);
  };

  const insertLead = async (phone, { source = sourceNumberId, createdAgo = '0 seconds' } = {}) => (
    await client.query(`
      INSERT INTO leads (whatsapp_name, phone_number, lead_status_id, source_number_id, channel, created_at)
      VALUES ('Cliente', $1, $2, $3, 'whatsapp', NOW() - $4::interval)
      RETURNING id
    `, [phone, leadStatusId, source, createdAgo])
  ).rows[0].id;

  const insertOwnership = async (leadId, {
    due = "NOW() + INTERVAL '2 hours'", released = 'NULL', deleted = 'NULL', mode = 'standard',
  } = {}) => {
    await client.query(`
      INSERT INTO lead_chat_ownerships (
        lead_id, clickup_task_id, response_due_at, released_at, release_reason, deleted_at, sla_mode
      )
      VALUES (
        $1::bigint, 'seller-owned-task-' || $1::text, ${due}, ${released},
        CASE WHEN ${released} IS NULL THEN NULL ELSE 'clickup_released' END, ${deleted}, $2
      )
    `, [leadId, mode]);
  };

  // Migration 047: a conversation handed off to the CRM without a lead, held
  // by a conversation-keyed ownership.
  const insertConversation = async (phone, { startedAgo = '0 seconds', source = sourceNumberId } = {}) => (
    await client.query(`
      INSERT INTO conversations (phone_number, source_number_id, conversation_status_id, started_at)
      VALUES ($1, $2, (SELECT id FROM conversation_statuses WHERE code = 'escalation_required'), NOW() - $3::interval)
      RETURNING id
    `, [phone, source, startedAgo])
  ).rows[0].id;

  const insertConversationOwnership = async (conversationId, {
    due = "NOW() + INTERVAL '2 hours'", released = 'NULL',
  } = {}) => {
    await client.query(`
      INSERT INTO lead_chat_ownerships (conversation_id, response_due_at, released_at, release_reason, acquired_via)
      VALUES ($1::bigint, ${due}, ${released}, CASE WHEN ${released} IS NULL THEN NULL ELSE 'manual' END, 'crm')
    `, [conversationId]);
  };

  const sellerOwned = async (phone, source = sourceNumberId) => (
    await client.query('SELECT inbound_contact_seller_owned($1, $2) AS owned', [source, phone])
  ).rows[0].owned;

  const orchestratorOwned = async (phone, source = sourceNumberId) => {
    const { rows: [row] } = await client.query(orchestratorAuthoritySql, [phone, source]);
    return row.bot_suppressed && row.sla_mode !== 'quote_followup';
  };

  const expectDebounced = (row) => {
    expect(row).toMatchObject({ should_process: false, duplicate_event: false, debounce_pending: true });
    expect(row.processing_token).toBeNull();
  };

  const expectInline = (row) => {
    expect(row).toMatchObject({ should_process: true, duplicate_event: false, debounce_pending: false });
    expect(row.processing_token).toEqual(expect.any(String));
  };

  // Every ownership scenario of the brief, with the expected reading.
  const scenarios = {
    'a live ownership with a pending SLA': {
      owned: true, setup: async (phone) => insertOwnership(await insertLead(phone)),
    },
    'a live ownership with no SLA deadline': {
      owned: true, setup: async (phone) => insertOwnership(await insertLead(phone), { due: 'NULL' }),
    },
    'an expired SLA': {
      owned: false,
      setup: async (phone) => insertOwnership(await insertLead(phone), { due: "NOW() - INTERVAL '1 minute'" }),
    },
    'a released ownership': {
      owned: false, setup: async (phone) => insertOwnership(await insertLead(phone), { released: 'NOW()' }),
    },
    'a deleted ownership': {
      owned: false, setup: async (phone) => insertOwnership(await insertLead(phone), { deleted: 'NOW()' }),
    },
    'a quote follow-up ownership': {
      owned: false,
      setup: async (phone) => insertOwnership(await insertLead(phone), { due: 'NULL', mode: 'quote_followup' }),
    },
    'no lead': { owned: false, setup: async () => {} },
    'a bot-owned lead': { owned: false, setup: async (phone) => { await insertLead(phone); } },
    'an ownership on an older lead of the contact only': {
      owned: false,
      setup: async (phone) => {
        await insertOwnership(await insertLead(phone, { createdAgo: '1 day' }));
        await insertLead(phone);
      },
    },
    'an ownership of the same phone on another source number': {
      owned: false,
      setup: async (phone) => insertOwnership(await insertLead(phone, { source: otherSourceNumberId })),
    },
    'a live conversation ownership without a lead': {
      owned: true, setup: async (phone) => insertConversationOwnership(await insertConversation(phone)),
    },
    'an expired conversation ownership': {
      owned: false,
      setup: async (phone) => insertConversationOwnership(await insertConversation(phone), {
        due: "NOW() - INTERVAL '1 minute'",
      }),
    },
    'a released conversation ownership': {
      owned: false,
      setup: async (phone) => insertConversationOwnership(await insertConversation(phone), { released: 'NOW()' }),
    },
    'a conversation ownership on an older conversation of the contact only': {
      owned: false,
      setup: async (phone) => {
        await insertConversationOwnership(await insertConversation(phone, { startedAgo: '1 day' }));
        await insertConversation(phone);
      },
    },
    'a conversation ownership of the same phone on another source number': {
      owned: false,
      setup: async (phone) => insertConversationOwnership(await insertConversation(phone, { source: otherSourceNumberId })),
    },
  };

  beforeAll(async () => {
    await client.connect();
    await cleanup();
    ({ rows: [{ id: leadStatusId }] } = await client.query('SELECT id FROM lead_statuses ORDER BY id LIMIT 1'));
    sourceNumberId = (await client.query(`
      INSERT INTO whatsapp_numbers (display_name, phone_number, phone_number_id, instance_name, is_active)
      VALUES ('seller-owned tests', '15550004242', 'pn-seller-owned', $1, TRUE)
      RETURNING id
    `, [INSTANCE])).rows[0].id;
    otherSourceNumberId = (await client.query(`
      INSERT INTO whatsapp_numbers (display_name, phone_number, phone_number_id, instance_name, is_active)
      VALUES ('seller-owned other', '15550004243', 'pn-seller-owned-other', $1, TRUE)
      RETURNING id
    `, [`${INSTANCE}-other`])).rows[0].id;
  });

  afterAll(async () => {
    await cleanup();
    await client.end();
  });

  describe.each(Object.entries(scenarios))('%s', (_name, scenario) => {
    test('reads the ownership exactly as the orchestrator chat authority', async () => {
      const phone = newPhone();
      await scenario.setup(phone);
      expect(await orchestratorOwned(phone)).toBe(scenario.owned);
      expect(await sellerOwned(phone)).toBe(scenario.owned);
    });

    test(scenario.owned ? 'claims a customer event inline' : 'keeps debouncing customer events', async () => {
      const phone = newPhone();
      await scenario.setup(phone);
      const row = await claim({ phone });
      if (scenario.owned) {
        expectInline(row);
        expect(await statuses(phone)).toEqual(['processing']);
      } else {
        expectDebounced(row);
        expect(await statuses(phone)).toEqual(['received']);
      }
    });
  });

  test('a seller-owned queue claims each message as soon as the previous turn ends', async () => {
    const phone = newPhone();
    await scenarios['a live ownership with a pending SLA'].setup(phone);

    const first = await claim({ phone, text: 'Hola' });
    expectInline(first);
    // Behind a busy turn the event queues and still schedules its own drain.
    const second = await claim({ phone, text: 'Necesito 50 adoquines' });
    expectDebounced(second);

    await markProcessed(first);
    // The dispatcher's next-event recovery runs with the configured window,
    // and the seller-owned queue does not wait it.
    const [next] = await recover({ scope: second.inbound_event_id });
    expect(next.inbound_event_id).toBe(second.inbound_event_id);
    expect(next.normalized_payload.text_body).toBe('Necesito 50 adoquines');
    expect(await statuses(phone)).toEqual(['processed', 'processing']);
  });

  test('older debounced events keep their FIFO turn when the chat becomes seller-owned', async () => {
    // Rolled back: the 034 rollback test refuses to run while any in-flight
    // batch is visible, and the integration files share one database.
    await client.query('BEGIN');
    try {
      await fifoAcrossOwnershipChange();
    } finally {
      await client.query('ROLLBACK');
    }
  });

  const fifoAcrossOwnershipChange = async () => {
    const phone = newPhone();
    const leadId = await insertLead(phone);
    const hola = await claim({ phone, text: 'Hola' });
    const need = await claim({ phone, text: 'Necesito 50 adoquines' });
    expectDebounced(hola);
    expectDebounced(need);

    await insertOwnership(leadId);
    const delivery = await claim({ phone, text: 'Con despacho a Maipú' });
    // Never claimed ahead of the pending burst.
    expectDebounced(delivery);
    expect(await statuses(phone)).toEqual(['received', 'received', 'received']);

    // The first waiter drains the queue without waiting for the window: the
    // oldest event leads and the rest follow in arrival order.
    const [turn] = await recover({ scope: hola.inbound_event_id });
    expect(turn.inbound_event_id).toBe(hola.inbound_event_id);
    expect(turn.inbound_batch_event_ids).toEqual([
      hola.inbound_event_id, need.inbound_event_id, delivery.inbound_event_id,
    ]);
    expect(turn.normalized_payload.text_body).toBe('Hola\nNecesito 50 adoquines\nCon despacho a Maipú');
  };

  test('a queue that is not seller-owned still waits for the window', async () => {
    const phone = newPhone();
    await scenarios['an expired SLA'].setup(phone);
    const row = await claim({ phone });
    expect(await recover({ scope: row.inbound_event_id })).toEqual([]);
    expect(await statuses(phone)).toEqual(['received']);
  });

  test('ignored events stay ignored in a seller-owned chat', async () => {
    const phone = newPhone();
    await scenarios['a live ownership with a pending SLA'].setup(phone);
    const row = await claim({ phone, requested: 'false' });
    expect(row).toMatchObject({ should_process: false, debounce_pending: false });
    expect(await statuses(phone)).toEqual(['ignored']);
  });

  test('own messages keep their inline claim in a seller-owned chat', async () => {
    const phone = newPhone();
    await scenarios['a live ownership with a pending SLA'].setup(phone);
    expectInline(await claim({ phone, fromMe: true }));
  });

  test('a window of 0 is unchanged in a seller-owned chat', async () => {
    const phone = newPhone();
    await scenarios['a live ownership with a pending SLA'].setup(phone);
    const first = await claim({ phone, debounce: '0' });
    const second = await claim({ phone, debounce: '0' });
    expectInline(first);
    expect(second).toMatchObject({ should_process: false, debounce_pending: false });
  });

  test('a duplicate delivery of a seller-owned event is still a duplicate', async () => {
    const phone = newPhone();
    await scenarios['a live ownership with a pending SLA'].setup(phone);
    const first = await claim({ phone, id: `dup-${phone}` });
    const again = await claim({ phone, id: `dup-${phone}` });
    expect(again).toMatchObject({ duplicate_event: true, should_process: false, debounce_pending: false });
    expect(again.inbound_event_id).toBe(first.inbound_event_id);
  });
});
