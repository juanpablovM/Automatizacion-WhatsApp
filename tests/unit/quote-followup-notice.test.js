import { createRequire } from 'node:module';
import { describe, expect, test } from 'vitest';

const require = createRequire(import.meta.url);
const {
  nextBusinessOpening,
  closedNotice,
  sellerDisplayName,
  buildQuoteFollowupNotice,
} = require('../fixtures/workflow-nodes/ops-lead-chat-lease-scheduler/prepare-quote-followup-notice.js');
const {
  deliveryOutcomeOf,
  finalizeQuoteFollowupAlert,
} = require('../fixtures/workflow-nodes/ops-lead-chat-lease-scheduler/post-quote-followup-comment.js');

// Santiago is UTC-3 in October 2026 (daylight saving) and UTC-4 in July.
const santiago = (local, offset = '-03:00') => new Date(`${local}:00${offset}`);

describe('business hours in America/Santiago', () => {
  test.each([
    ['Monday morning', '2026-10-19T10:00'],
    ['Tuesday afternoon', '2026-10-20T17:59'],
    ['Wednesday right at opening', '2026-10-21T08:00'],
    ['Friday after lunch', '2026-10-23T14:00'],
    ['Saturday morning', '2026-10-24T13:59'],
  ])('%s is open', (_label, local) => {
    expect(nextBusinessOpening(santiago(local))).toEqual({ open: true });
  });

  test.each([
    ['Monday lunch break', '2026-10-19T13:30', { dayOffset: 0, weekday: 1, minutes: 840 }],
    ['Monday before opening', '2026-10-19T07:15', { dayOffset: 0, weekday: 1, minutes: 480 }],
    ['Monday after 18:00', '2026-10-19T18:00', { dayOffset: 1, weekday: 2, minutes: 480 }],
    ['Wednesday after 17:00', '2026-10-21T17:30', { dayOffset: 1, weekday: 4, minutes: 480 }],
    ['Friday after 17:00 opens Saturday', '2026-10-23T17:05', { dayOffset: 1, weekday: 6, minutes: 480 }],
    ['Saturday after 14:00 opens Monday', '2026-10-24T14:00', { dayOffset: 2, weekday: 1, minutes: 480 }],
    ['Sunday opens Monday', '2026-10-25T11:00', { dayOffset: 1, weekday: 1, minutes: 480 }],
    ['Saturday night', '2026-10-24T23:50', { dayOffset: 2, weekday: 1, minutes: 480 }],
  ])('%s is closed and computes the next opening', (_label, local, expected) => {
    expect(nextBusinessOpening(santiago(local))).toEqual({ open: false, ...expected });
  });

  test('uses the Santiago clock in winter time too', () => {
    expect(nextBusinessOpening(santiago('2026-07-06T17:30', '-04:00'))).toEqual({ open: true });
    expect(nextBusinessOpening(santiago('2026-07-06T18:30', '-04:00')))
      .toEqual({ open: false, dayOffset: 1, weekday: 2, minutes: 480 });
  });

  test('a UTC instant on another calendar day still reads the Santiago day', () => {
    // 01:30 UTC on Sunday is 22:30 on Saturday in Santiago.
    expect(nextBusinessOpening(new Date('2026-10-25T01:30:00Z')))
      .toEqual({ open: false, dayOffset: 2, weekday: 1, minutes: 480 });
  });

  test.each([
    [{ open: true }, true, ''],
    [{ open: false, dayOffset: 0, weekday: 1, minutes: 840 }, true, 'Te va a responder hoy desde las 14:00.'],
    [{ open: false, dayOffset: 1, weekday: 6, minutes: 480 }, true, 'Te va a responder mañana desde las 8:00.'],
    [{ open: false, dayOffset: 2, weekday: 1, minutes: 480 }, true, 'Te va a responder el lunes desde las 8:00.'],
    [{ open: false, dayOffset: 2, weekday: 1, minutes: 480 }, false, 'Te van a responder el lunes desde las 8:00.'],
  ])('closed notice %#', (opening, singular, expected) => {
    expect(closedNotice(opening, singular)).toBe(expected);
  });
});

describe('seller display name', () => {
  test.each([
    ['Juan Pablo (Pruebas)', 'Juan Pablo'],
    ['  Carolina  ', 'Carolina'],
    ['María José Pérez Soto', 'María'],
    ['', null],
    [null, null],
    ['(Pruebas)', null],
  ])('%j -> %j', (name, expected) => {
    expect(sellerDisplayName(name)).toBe(expected);
  });
});

const claimRow = (overrides = {}) => ({
  ownership_id: 41,
  lead_id: 7,
  quote_alert_claim_token: 'token-1',
  quote_alert_message_id: 900,
  clickup_task_id: 'task-77',
  clickup_status: 'cotización enviada',
  lead_name: 'Cliente',
  seller_name: 'Juan Pablo (Pruebas)',
  seller_clickup_user_id: '4321',
  conversation_id: 55,
  phone_number: '56911112222',
  instance_name: 'hormiglass',
  waiting_minutes: 32,
  customer_messages: ['Hola', '¿Me pueden responder?'],
  ...overrides,
});

describe('quote follow-up notice', () => {
  const open = santiago('2026-10-19T10:00');
  const closed = santiago('2026-10-24T15:00');

  test('cotización enviada during business hours names the seller and offers a new quote', () => {
    const out = buildQuoteFollowupNotice(claimRow(), { now: open });
    expect(out.response_text).toBe(
      'Tu cotización ya fue enviada por Juan Pablo. Le avisé que escribiste para que te responda por aquí.'
      + '\n\n👉 ¿Quieres hacer una cotización nueva?',
    );
    expect(out).toMatchObject({
      response_kind: 'quote_followup_notice',
      message_id: 'quote-followup:41:900',
      conversation_id: 55,
      lead_id: 7,
      phone_number: '56911112222',
      instance_name: 'hormiglass',
      business_open: true,
      clickup_comment_url: 'https://api.clickup.com/api/v2/task/task-77/comment',
    });
  });

  test('seguimiento outside business hours says when the seller answers', () => {
    const out = buildQuoteFollowupNotice(claimRow({ clickup_status: 'Seguimiento' }), { now: closed });
    expect(out.response_text).toBe(
      'Juan Pablo está haciendo seguimiento de tu cotización. Le avisé que escribiste para que te responda por aquí.'
      + ' Te va a responder el lunes desde las 8:00.'
      + '\n\n👉 ¿Quieres hacer una cotización nueva?',
    );
    expect(out.business_open).toBe(false);
  });

  test('without an assigned seller it speaks for the commercial team', () => {
    const out = buildQuoteFollowupNotice(claimRow({ seller_name: null, seller_clickup_user_id: null }), { now: closed });
    expect(out.response_text).toBe(
      'Tu cotización ya fue enviada por nuestro equipo comercial. Les avisé que escribiste para que te respondan por aquí.'
      + ' Te van a responder el lunes desde las 8:00.'
      + '\n\n👉 ¿Quieres hacer una cotización nueva?',
    );
    expect(out.clickup_comment_body).not.toHaveProperty('assignee');
  });

  test('the ClickUp comment quotes the unanswered messages and assigns the seller', () => {
    const out = buildQuoteFollowupNotice(claimRow(), { now: open });
    expect(out.clickup_comment_body).toEqual({
      comment_text: '⚠️ El cliente escribió hace 32 min y no tuvo respuesta: "Hola / ¿Me pueden responder?"\n'
        + 'Hormi Atención le avisó que le vas a responder por WhatsApp y le ofreció una cotización nueva.',
      assignee: 4321,
      notify_all: false,
    });
  });

  test('a long streak is cut so the comment stays readable', () => {
    const out = buildQuoteFollowupNotice(claimRow({ customer_messages: ['x'.repeat(900)] }), { now: open });
    expect(out.clickup_comment_body.comment_text.length).toBeLessThan(700);
    expect(out.clickup_comment_body.comment_text).toContain('…"');
  });
});

describe('finalizing the alert', () => {
  const prepared = buildQuoteFollowupNotice(claimRow(), { now: santiago('2026-10-19T10:00') });

  const clickupStub = (...responses) => {
    const calls = [];
    const httpRequest = async (options) => {
      calls.push(options);
      const planned = responses[calls.length - 1];
      if (planned === undefined) throw new Error(`unplanned call ${options.method} ${options.url}`);
      if (planned instanceof Error) throw planned;
      return planned;
    };
    return { calls, httpRequest };
  };

  test.each([
    [{ delivery_status: 'sent' }, 'sent'],
    [{ outbound_dispatch_status: 'already_sent' }, 'sent'],
    [{ delivery_status: 'cancelled', human_control_cancelled: true }, 'cancelled'],
    [{ delivery_status: 'failed' }, 'failed'],
    [{ error: { message: 'Evolution API no esta configurada' } }, 'failed'],
    [{}, 'unknown'],
  ])('delivery %j is %s', (outbound, expected) => {
    expect(deliveryOutcomeOf(outbound)).toBe(expected);
  });

  test('a sent notice posts the seller comment once', async () => {
    const stub = clickupStub({ statusCode: 200, body: { id: 'c1' } });
    const out = await finalizeQuoteFollowupAlert(prepared, { delivery_status: 'sent', message_id: 3 },
      stub.httpRequest, { CLICKUP_API_TOKEN: 'tok' });
    expect(stub.calls).toHaveLength(1);
    expect(stub.calls[0]).toMatchObject({
      method: 'POST',
      url: 'https://api.clickup.com/api/v2/task/task-77/comment',
      body: prepared.clickup_comment_body,
      headers: { Authorization: 'tok', 'Content-Type': 'application/json' },
    });
    expect(out).toMatchObject({
      ownership_id: 41,
      quote_alert_claim_token: 'token-1',
      quote_alert_result: 'sent',
      quote_alert_error: null,
      comment_outcome: 'posted',
    });
  });

  test('a notice cancelled because the seller is answering posts nothing', async () => {
    const stub = clickupStub();
    const out = await finalizeQuoteFollowupAlert(prepared,
      { delivery_status: 'cancelled', human_control_cancelled: true }, stub.httpRequest, { CLICKUP_API_TOKEN: 'tok' });
    expect(stub.calls).toHaveLength(0);
    expect(out).toMatchObject({ quote_alert_result: 'cancelled', comment_outcome: 'skipped_cancelled' });
  });

  test('a failed notice still tells the seller the customer is waiting', async () => {
    const stub = clickupStub({ statusCode: 200, body: { id: 'c1' } });
    const out = await finalizeQuoteFollowupAlert(prepared, { delivery_status: 'failed', message: 'boom' },
      stub.httpRequest, { CLICKUP_API_TOKEN: 'tok' });
    expect(stub.calls).toHaveLength(1);
    expect(out).toMatchObject({ quote_alert_result: 'failed', quote_alert_error: 'boom', comment_outcome: 'posted' });
  });

  test('a ClickUp failure is recorded and never changes the notice result', async () => {
    const stub = clickupStub({ statusCode: 500, body: {} });
    const out = await finalizeQuoteFollowupAlert(prepared, { delivery_status: 'sent' }, stub.httpRequest,
      { CLICKUP_API_TOKEN: 'tok' });
    expect(out).toMatchObject({ quote_alert_result: 'sent', comment_outcome: 'failed_http_500' });

    const thrown = clickupStub(new Error('socket hang up'));
    const outThrown = await finalizeQuoteFollowupAlert(prepared, { delivery_status: 'sent' }, thrown.httpRequest,
      { CLICKUP_API_TOKEN: 'tok' });
    expect(outThrown.comment_outcome).toBe('failed_transport');
  });

  test('without a ClickUp token or task no call is made', async () => {
    const stub = clickupStub();
    const out = await finalizeQuoteFollowupAlert(prepared, { delivery_status: 'sent' }, stub.httpRequest,
      { CLICKUP_API_TOKEN: '__PENDIENTE__' });
    expect(out.comment_outcome).toBe('skipped_token_missing');
    const noTask = await finalizeQuoteFollowupAlert({ ...prepared, clickup_comment_url: null },
      { delivery_status: 'sent' }, stub.httpRequest, { CLICKUP_API_TOKEN: 'tok' });
    expect(noTask.comment_outcome).toBe('skipped_task_missing');
    expect(stub.calls).toHaveLength(0);
  });
});
