// =============================================================================
// OPS - Lead Chat Lease Scheduler — Prepare Quote Follow-Up Notice
// -----------------------------------------------------------------------------
// Migration 037 (owner decision 2026-10-16). One claimed row of
// 11_claim_quote_followup_alerts.sql: a seller owns the chat of a quote that was
// already sent and the customer has waited the SLA without an answer. This node
// writes the one notice the customer gets and the ClickUp comment the seller
// gets; it sends nothing. The next node sends the notice through WA - Outbound
// Messages (response_kind 'quote_followup_notice', the only bot reply the
// outbound authority admits in a seller-owned chat while the alert is claimed).
//
// The notice never states anything about the quote beyond its status: the
// quote contents are the seller's and the bot does not know them. It ends with
// "¿Quieres hacer una cotización nueva?"; evaluate-conversation-step.js reads
// the customer's answer.
//
// Business hours (hormiglass.cl, America/Santiago): Mon–Tue 8:00–13:00 and
// 14:00–18:00; Wed–Fri 8:00–13:00 and 14:00–17:00; Sat 8:00–14:00; Sunday
// closed. Outside them the notice says when the seller will answer. There is no
// holiday calendar: a public holiday on a weekday reads as a working day.
// =============================================================================

const BUSINESS_TIME_ZONE = 'America/Santiago';
// Minutes from local midnight, per weekday (0 = Sunday).
const BUSINESS_HOURS = {
  0: [],
  1: [[480, 780], [840, 1080]],
  2: [[480, 780], [840, 1080]],
  3: [[480, 780], [840, 1020]],
  4: [[480, 780], [840, 1020]],
  5: [[480, 780], [840, 1020]],
  6: [[480, 840]],
};
const WEEKDAY_NAMES = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];
const WEEKDAY_INDEX = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
const COMMENT_MESSAGES_MAX_CHARS = 500;

const santiagoClock = (date) => {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: BUSINESS_TIME_ZONE,
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);
  const part = (type) => parts.find((entry) => entry.type === type)?.value;
  return {
    weekday: WEEKDAY_INDEX[part('weekday')],
    minutes: Number(part('hour')) * 60 + Number(part('minute')),
  };
};

// { open: true } inside business hours; otherwise the next opening as a day
// offset from today (Santiago calendar), its weekday and its local minute.
const nextBusinessOpening = (date) => {
  const { weekday, minutes } = santiagoClock(date);
  if (BUSINESS_HOURS[weekday].some(([start, end]) => minutes >= start && minutes < end)) {
    return { open: true };
  }
  const laterToday = BUSINESS_HOURS[weekday].find(([start]) => start > minutes);
  if (laterToday) return { open: false, dayOffset: 0, weekday, minutes: laterToday[0] };
  for (let dayOffset = 1; dayOffset <= 7; dayOffset += 1) {
    const day = (weekday + dayOffset) % 7;
    if (BUSINESS_HOURS[day].length) {
      return { open: false, dayOffset, weekday: day, minutes: BUSINESS_HOURS[day][0][0] };
    }
  }
  return { open: false, dayOffset: null, weekday: null, minutes: null };
};

const clockLabel = (minutes) => `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, '0')}`;

// "Te va a responder mañana desde las 8:00." — empty while open.
const closedNotice = (opening, singular = true) => {
  if (!opening || opening.open || opening.dayOffset === null) return '';
  const when = opening.dayOffset === 0 ? 'hoy'
    : opening.dayOffset === 1 ? 'mañana'
      : `el ${WEEKDAY_NAMES[opening.weekday]}`;
  return `Te ${singular ? 'va' : 'van'} a responder ${when} desde las ${clockLabel(opening.minutes)}.`;
};

// sellers.name is a display label ("Juan Pablo (Pruebas)"). The customer reads
// the name without the parenthetical; a long full name keeps the first word.
const sellerDisplayName = (name) => {
  const words = String(name ?? '').replace(/\([^)]*\)/g, ' ').trim().split(/\s+/).filter(Boolean);
  if (!words.length) return null;
  return words.length > 2 ? words[0] : words.join(' ');
};

const isFollowUpStatus = (status) => /seguimiento/i.test(String(status || ''));

const noticeText = (row, opening) => {
  const seller = sellerDisplayName(row.seller_name);
  const team = 'nuestro equipo comercial';
  const lead = isFollowUpStatus(row.clickup_status)
    ? `${seller || 'Nuestro equipo comercial'} está haciendo seguimiento de tu cotización.`
    : `Tu cotización ya fue enviada por ${seller || team}.`;
  const notified = seller
    ? 'Le avisé que escribiste para que te responda por aquí.'
    : 'Les avisé que escribiste para que te respondan por aquí.';
  const closed = closedNotice(opening, Boolean(seller));
  return `${lead} ${notified}${closed ? ` ${closed}` : ''}\n\n👉 ¿Quieres hacer una cotización nueva?`;
};

const quotedMessages = (messages) => {
  const joined = (Array.isArray(messages) ? messages : [])
    .map((text) => String(text ?? '').replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .join(' / ');
  return joined.length > COMMENT_MESSAGES_MAX_CHARS
    ? `${joined.slice(0, COMMENT_MESSAGES_MAX_CHARS)}…`
    : joined;
};

const asAssignee = (value) => {
  const parsed = Number(String(value ?? '').trim());
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
};

const buildQuoteFollowupNotice = (row, { now = new Date() } = {}) => {
  const opening = nextBusinessOpening(now);
  const taskId = String(row.clickup_task_id ?? '').trim();
  const assignee = asAssignee(row.seller_clickup_user_id);
  const minutes = Math.max(0, Number(row.waiting_minutes) || 0);
  const quoted = quotedMessages(row.customer_messages);
  return {
    ...row,
    response_text: noticeText(row, opening),
    response_kind: 'quote_followup_notice',
    // Stable per streak: a reclaimed alert reuses the same outbound idempotency
    // key, so the customer never gets the notice twice.
    message_id: `quote-followup:${row.ownership_id}:${row.quote_alert_message_id}`,
    business_open: Boolean(opening.open),
    clickup_comment_url: taskId
      ? `https://api.clickup.com/api/v2/task/${encodeURIComponent(taskId)}/comment`
      : null,
    clickup_comment_body: {
      comment_text: `⚠️ El cliente escribió hace ${minutes} min y no tuvo respuesta: "${quoted}"\n`
        + 'Hormi Atención le avisó que le vas a responder por WhatsApp y le ofreció una cotización nueva.',
      ...(assignee ? { assignee } : {}),
      notify_all: false,
    },
  };
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    BUSINESS_HOURS,
    nextBusinessOpening,
    closedNotice,
    sellerDisplayName,
    buildQuoteFollowupNotice,
  };
}

if (typeof $json !== 'undefined') {
  return { json: buildQuoteFollowupNotice($json ?? {}) };
}
