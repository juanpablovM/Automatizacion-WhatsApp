// =============================================================================
// prepare-follow-up-message.js — Nodo "Prepare Follow-Up Message"
// (OPS - Follow-Up Scheduler). SOURCE OF TRUTH de la eleccion del texto por
// step y motivo y de la plantilla final del envio.
// -----------------------------------------------------------------------------
// In: item reclamado por claim_due_follow_ups (fila follow_ups).
// Out: texto final + guardrail de ventana. El claim ya solo reclama items
// dentro de la ventana configurable; el chequeo aqui cubre relojes
// desalineados (follow_up_window_ok=false => follow_up_will_send=false).
// =============================================================================

const MESSAGES = {
  cotizacion_lead: {
    0: 'Hola {{nombre}} 👋\n\nQuedamos a tu disposición por la cotización que consultaste.\n\n👉 ¿Seguimos avanzando?',
    1: 'Hola {{nombre}} 👋\n\nTe escribimos para saber si quieres seguir avanzando con tu consulta sobre la cotización.',
    3: 'Hola {{nombre}} 👋\n\nAún no tenemos novedades tuyas. Si ya lo resolviste, avísanos; si no, seguimos a tu disposición.',
    7: 'Hola {{nombre}} 👋\n\nTe recordamos que tu cotización sigue vigente.\n\n👉 ¿Quieres que la retomemos hoy?',
    14: 'Hola {{nombre}} 👋\n\nEste es nuestro último recordatorio por este tema. Si sigues necesitando la cotización, escríbenos cuando quieras.',
  },
  lead_sin_respuesta: {
    0: 'Hola {{nombre}} 👋\n\nVimos que nos escribiste antes y nos quedamos con tu consulta.\n\n👉 ¿En qué podemos ayudarte?',
    1: 'Hola {{nombre}} 👋\n\nQueríamos retomar la consulta que nos dejaste.\n\n👉 ¿Sigues necesitando algo?',
    3: 'Hola {{nombre}} 👋\n\nTe buscamos por tu consulta anterior. Si ya no te hace falta, avísanos; si sigues interesado, aquí estamos.',
    7: 'Hola {{nombre}} 👋\n\nTe volvemos a escribir por tu consulta en *Hormiglass*.\n\n👉 ¿Quieres retomarla?',
    14: 'Hola {{nombre}} 👋\n\nÚltimo recordatorio por tu consulta en *Hormiglass*. Cuando quieras, seguimos a tu disposición.',
  },
};

const FALLBACK_MESSAGES = {
  0: 'Hola {{nombre}} 👋\n\nQuedamos a tu disposición por tu consulta.\n\n👉 ¿Seguimos avanzando?',
  1: 'Hola {{nombre}} 👋\n\nTe escribimos para retomar tu consulta en *Hormiglass*.',
  3: 'Hola {{nombre}} 👋\n\nNos gustaría saber si sigues necesitando algo.',
  7: 'Hola {{nombre}} 👋\n\nTe recordamos que seguimos a tu disposición.',
  14: 'Hola {{nombre}} 👋\n\nÚltimo recordatorio por tu consulta. Cuando quieras, aquí estamos.',
};

const WINDOW_START_DEFAULT = '09:00';
const WINDOW_END_DEFAULT = '20:00';

const pickMessage = (motivo, stepDia) =>
  (MESSAGES[motivo]?.[stepDia] ?? FALLBACK_MESSAGES[stepDia]) || null;

// Without a contact name the greeting reads "Hola 👋", never "Hola  👋".
const fillTemplate = (message, contactName) => {
  const name = contactName ? String(contactName).trim() : '';
  return (message || '').replace(/ ?\{\{nombre\}\}/g, name ? ` ${name}` : '');
};

const inWindow = (timestamp, windowStart, windowEnd) => {
  const date = timestamp ? new Date(timestamp) : new Date();
  const minutes = date.getHours() * 60 + date.getMinutes();
  const [h0, m0] = String(windowStart || WINDOW_START_DEFAULT).split(':').map(Number);
  const [h1, m1] = String(windowEnd || WINDOW_END_DEFAULT).split(':').map(Number);
  return minutes >= h0 * 60 + m0 && minutes <= h1 * 60 + m1;
};

const prepareFollowUp = (row, { windowStart, windowEnd, contactName } = {}) => {
  const motivo = String(row.motivo || '').trim() || 'lead_sin_respuesta';
  const stepDia = Number(row.step_dia);
  const scheduledAt = row.claimed_at || row.scheduled_at || null;
  const message = fillTemplate(pickMessage(motivo, stepDia), contactName);
  const windowOk = inWindow(scheduledAt, windowStart, windowEnd);

  return {
    ...row,
    follow_up_text: message,
    follow_up_window_ok: windowOk,
    follow_up_will_send: Boolean(message.trim()) && windowOk,
    response_text: message,
    response_kind: `follow_up_day_${stepDia}`,
    message_id: `follow-up:${row.id}`,
  };
};

// ---------------------------------------------------------------------------
// Seccion n8n: procesa el item del claim.
// ---------------------------------------------------------------------------
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    MESSAGES,
    FALLBACK_MESSAGES,
    WINDOW_START_DEFAULT,
    WINDOW_END_DEFAULT,
    pickMessage,
    fillTemplate,
    inWindow,
    prepareFollowUp,
  };
}

if (typeof items !== 'undefined') {
  return items.map((item) => {
    const row = item.json ?? {};
    const contactName = row.lead_name || row.customer_name || null;
    return { json: prepareFollowUp(row, {
      windowStart: row.follow_up_window_start || $env.FOLLOW_UP_WINDOW_START,
      windowEnd: row.follow_up_window_end || $env.FOLLOW_UP_WINDOW_END,
      contactName,
    }) };
  });
}
