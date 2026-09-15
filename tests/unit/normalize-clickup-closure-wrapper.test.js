import crypto from 'node:crypto';
import fs from 'node:fs';
import { describe, expect, test } from 'vitest';

const fixturePath = 'tests/fixtures/workflow-nodes/ops-handoff-clickup-closure/normalize-clickup-closure.js';

// Runs in n8n's "run once for all items" mode: reads `items` and returns an
// array of `{ json }` objects.
const runCodeNode = (source, items, env = {}) =>
  new Function('items', '$env', 'require', source)(items, env, (name) => {
    if (name !== 'crypto') throw new Error(`unexpected require: ${name}`);
    return crypto;
  });

const SECRET = 'clickup-webhook-secret';

const sign = (body, secret = SECRET) => crypto
  .createHmac('sha256', secret)
  .update(JSON.stringify(body), 'utf8')
  .digest('hex');

// Builds the webhook item exactly as n8n hands it to the Code node, with a
// signature that matches the body — the shape of a genuine ClickUp delivery.
const delivery = (body, { secret = SECRET, signature, rawBody } = {}) => {
  const item = {
    headers: { 'x-signature': signature ?? sign(body, secret) },
    body,
  };
  if (rawBody !== undefined) item.rawBody = rawBody;
  return item;
};

const statusBody = (status, overrides = {}) => ({
  event: 'taskStatusUpdated',
  task_id: 'clickup-task-1',
  webhook_id: 'wh-1',
  history_items: [{ field: 'status', after: { status } }],
  ...overrides,
});

const run = (item, env = { CLICKUP_WEBHOOK_SECRET: SECRET }) => runCodeNode(
  fs.readFileSync(fixturePath, 'utf8'),
  [{ json: item }],
  env,
)[0].json;

describe('Normalize ClickUp Closure — inbound webhook contract', () => {
  describe('signature verification', () => {
    test('fails closed when no secret is configured', () => {
      const output = run(delivery(statusBody('complete')), {});

      expect(output.authorized).toBe(false);
      expect(output.actionable).toBe(false);
      expect(output.reason).toBe('clickup_webhook_secret_not_configured');
    });

    test('accepts a correctly signed delivery', () => {
      const output = run(delivery(statusBody('complete')));

      expect(output.authorized).toBe(true);
      expect(output.actionable).toBe(true);
    });

    test('rejects a delivery with no signature header', () => {
      const item = delivery(statusBody('complete'));
      delete item.headers['x-signature'];

      expect(run(item).reason).toBe('missing_signature');
    });

    test('rejects a signature produced with the wrong secret', () => {
      const item = delivery(statusBody('complete'), { secret: 'not-the-secret' });

      const output = run(item);

      expect(output.authorized).toBe(false);
      expect(output.clickup_task_id).toBeNull();
      expect(output.reason).toBe('invalid_signature');
    });

    test('rejects a tampered body whose signature no longer matches', () => {
      const item = delivery(statusBody('complete'));
      // An attacker swaps the task id after the signature was computed.
      item.body.task_id = 'clickup-task-victim';

      expect(run(item).reason).toBe('invalid_signature');
    });

    test('rejects a signature of the wrong length without throwing', () => {
      const item = delivery(statusBody('complete'), { signature: 'abc123' });

      expect(run(item).reason).toBe('invalid_signature');
    });

    test('verifies against the raw body when the webhook node supplies one', () => {
      const body = statusBody('complete');
      // Raw bytes ClickUp actually sent, with a key order the re-serialization
      // would not reproduce.
      const rawBody = JSON.stringify({ task_id: body.task_id, event: body.event, webhook_id: body.webhook_id, history_items: body.history_items });
      const item = delivery(body, {
        rawBody,
        signature: crypto.createHmac('sha256', SECRET).update(rawBody, 'utf8').digest('hex'),
      });

      expect(run(item).actionable).toBe(true);
    });

    test('never accepts a plaintext token in the query string', () => {
      const item = delivery(statusBody('complete'), { signature: 'wrong' });
      item.query = { token: SECRET };

      expect(run(item).reason).toBe('invalid_signature');
    });
  });

  describe('event filtering', () => {
    test('ignores a ClickUp event that is not a status change', () => {
      const output = run(delivery(statusBody('complete', { event: 'taskCommentPosted' })));

      expect(output.authorized).toBe(true);
      expect(output.actionable).toBe(false);
      expect(output.reason).toBe('unsupported_event:taskCommentPosted');
    });

    test('ignores a status event with no task id', () => {
      expect(run(delivery(statusBody('complete', { task_id: '' }))).reason)
        .toBe('missing_task_id');
    });

    test('ignores a status event carrying no status transition', () => {
      const output = run(delivery(statusBody('complete', { history_items: [] })));

      expect(output.actionable).toBe(false);
      expect(output.reason).toBe('missing_status_change');
      expect(output.clickup_task_id).toBe('clickup-task-1');
    });
  });

  describe('status mapping', () => {
    test('maps a default resolved status', () => {
      const output = run(delivery(statusBody('Complete')));

      expect(output.actionable).toBe(true);
      expect(output.estado).toBe('resolved');
      expect(output.clickup_task_id).toBe('clickup-task-1');
    });

    test('maps a default acknowledged status', () => {
      expect(run(delivery(statusBody('In Progress'))).estado).toBe('acknowledged');
    });

    test('tolerates casing and surrounding whitespace in ClickUp labels', () => {
      expect(run(delivery(statusBody('  CERRADO  '))).estado).toBe('resolved');
    });

    test('honours configured status lists over the defaults', () => {
      const output = run(delivery(statusBody('archivado')), {
        CLICKUP_WEBHOOK_SECRET: SECRET,
        CLICKUP_STATUS_RESOLVED: 'archivado, finalizado',
      });

      expect(output.estado).toBe('resolved');
    });

    test('ignores an unmapped status instead of guessing', () => {
      const output = run(delivery(statusBody('waiting on client')));

      expect(output.actionable).toBe(false);
      expect(output.estado).toBeNull();
      expect(output.reason).toBe('unmapped_status:waiting on client');
    });

    test('prefers resolved when a status appears in both lists', () => {
      const output = run(delivery(statusBody('revision')), {
        CLICKUP_WEBHOOK_SECRET: SECRET,
        CLICKUP_STATUS_ACKNOWLEDGED: 'revision',
        CLICKUP_STATUS_RESOLVED: 'revision',
      });

      expect(output.estado).toBe('resolved');
    });

    test('uses the last status transition when ClickUp batches several', () => {
      const output = run(delivery(statusBody('complete', {
        history_items: [
          { field: 'status', after: { status: 'in progress' } },
          { field: 'assignee', after: { status: 'ignored' } },
          { field: 'status', after: { status: 'closed' } },
        ],
      })));

      expect(output.estado).toBe('resolved');
    });
  });

  // ---------------------------------------------------------------------------
  // The same signed webhook now also drives commercial lead chat ownership: a
  // task moving into 'in progress' hands the chat to the salesperson, and any
  // transition away from it hands the chat back. The closure lane keeps its
  // exact meaning; these fields ride alongside it.
  // ---------------------------------------------------------------------------
  describe('lead chat ownership fields', () => {
    // A complete ClickUp status history entry. The closure lane only ever read
    // `after.status`; the ownership lane also needs the entry identity, its
    // timestamp and the status the task is coming from.
    const leadBody = (before, after, overrides = {}) => statusBody(after, {
      history_items: [{
        id: 'hist-abc-1',
        field: 'status',
        date: '1568036964079',
        before: { status: before },
        after: { status: after },
      }],
      ...overrides,
    });

    test('captures the previous ClickUp status verbatim, casing and accents intact', () => {
      const output = run(delivery(leadBody('Revisión Comercial', 'in progress')));

      // This exact string is what a expired lease will write back to ClickUp,
      // so a lowercased or trimmed copy would restore a status that does not
      // exist in the space.
      expect(output.clickup_previous_status).toBe('Revisión Comercial');
      expect(output.clickup_new_status).toBe('in progress');
      expect(output.clickup_history_id).toBe('hist-abc-1');
    });

    test('converts the ClickUp epoch-millisecond date to an ISO-8601 timestamp', () => {
      const output = run(delivery(leadBody('open', 'in progress')));

      expect(output.clickup_history_at).toBe('2019-09-09T13:49:24.079Z');
    });

    test('routes an unmapped new status to the lead lane even though the handoff mapping failed', () => {
      const output = run(delivery(leadBody('in progress', 'waiting on client')));

      // The regression this guards: ownership must be released on ANY exit from
      // 'in progress', including one the handoff mapping does not know. Reading
      // `actionable` alone would silently drop the release.
      expect(output.actionable).toBe(false);
      expect(output.estado).toBeNull();
      expect(output.reason).toBe('unmapped_status:waiting on client');
      expect(output.lead_routable).toBe(true);
      expect(output.is_ownership_acquisition).toBe(false);
      expect(output.clickup_task_id).toBe('clickup-task-1');
      expect(output.clickup_new_status).toBe('waiting on client');
      expect(output.clickup_previous_status).toBe('in progress');
    });

    test('marks a transition to complete as a release, not an acquisition', () => {
      const output = run(delivery(leadBody('in progress', 'complete')));

      expect(output.lead_routable).toBe(true);
      expect(output.is_ownership_acquisition).toBe(false);
      expect(output.estado).toBe('resolved');
    });

    test('marks a transition to in progress as an acquisition', () => {
      const output = run(delivery(leadBody('open', 'In Progress')));

      expect(output.lead_routable).toBe(true);
      expect(output.is_ownership_acquisition).toBe(true);
      expect(output.estado).toBe('acknowledged');
    });

    test('honours CLICKUP_STATUS_ACKNOWLEDGED when deciding an acquisition', () => {
      const env = {
        CLICKUP_WEBHOOK_SECRET: SECRET,
        CLICKUP_STATUS_ACKNOWLEDGED: 'atendiendo, en curso',
      };

      expect(run(delivery(leadBody('nuevo', 'Atendiendo')), env).is_ownership_acquisition)
        .toBe(true);
      // The default list stops applying once the override is in force.
      expect(run(delivery(leadBody('nuevo', 'in progress')), env).is_ownership_acquisition)
        .toBe(false);
    });

    test('does not route a ClickUp event that is not a status change', () => {
      const output = run(delivery(leadBody('open', 'in progress', { event: 'taskCommentPosted' })));

      expect(output.authorized).toBe(true);
      expect(output.lead_routable).toBe(false);
      expect(output.is_ownership_acquisition).toBe(false);
    });

    test('does not route a delivery carrying no status transition', () => {
      const output = run(delivery(statusBody('complete', { history_items: [] })));

      expect(output.lead_routable).toBe(false);
      expect(output.clickup_previous_status).toBeNull();
      expect(output.clickup_new_status).toBeNull();
      expect(output.clickup_history_id).toBeNull();
      expect(output.clickup_history_at).toBeNull();
    });

    test('leaves the previous status null for a task with no prior state', () => {
      const output = run(delivery(statusBody('in progress', {
        history_items: [
          { id: 'hist-1', field: 'status', date: '1568036964079', after: { status: 'in progress' } },
        ],
      })));

      expect(output.clickup_previous_status).toBeNull();
      expect(output.lead_routable).toBe(true);
    });

    test('takes the identity of the last status entry when ClickUp batches several', () => {
      const output = run(delivery(statusBody('complete', {
        history_items: [
          { id: 'hist-1', field: 'status', date: '1568036964079', before: { status: 'open' }, after: { status: 'in progress' } },
          { id: 'hist-2', field: 'assignee', date: '1568036965000', after: { status: 'ignored' } },
          { id: 'hist-3', field: 'status', date: '1568036966000', before: { status: 'In Progress' }, after: { status: 'Cerrado' } },
        ],
      })));

      expect(output.clickup_history_id).toBe('hist-3');
      expect(output.clickup_history_at).toBe('2019-09-09T13:49:26.000Z');
      expect(output.clickup_previous_status).toBe('In Progress');
      expect(output.clickup_new_status).toBe('Cerrado');
    });

    test('an invalid signature stays unauthorized and emits no lead fields', () => {
      const output = run(delivery(leadBody('Revisión Comercial', 'in progress'), {
        secret: 'not-the-secret',
      }));

      expect(output.authorized).toBe(false);
      expect(output.reason).toBe('invalid_signature');
      expect(output).not.toHaveProperty('lead_routable');
      expect(output).not.toHaveProperty('is_ownership_acquisition');
      expect(output).not.toHaveProperty('clickup_previous_status');
      expect(output).not.toHaveProperty('clickup_new_status');
      expect(output).not.toHaveProperty('clickup_history_id');
      expect(output).not.toHaveProperty('clickup_history_at');
    });
  });
});
