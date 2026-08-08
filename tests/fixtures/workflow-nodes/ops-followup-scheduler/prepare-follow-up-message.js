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
    0: 'Hola {{nombre}}, quedamos a tu disposicion por la cotizacion que consultaste. ¿Seguimos avanzando?',
    1: 'Hola {{nombre}}, te escribimos para saber si queres seguir avanzando con tu consulta sobre la cotizacion.',
    3: 'Hola {{nombre}}, aun no tuvimos novedades tuyas. Si ya resolviste, avisanos; si no, seguimos a disposicion.',
    7: 'Hola {{nombre}}, te recordamos que tu cotizacion sigue vigente. ¿Queres que la retomemos hoy?',
    14: 'Hola {{nombre}}, este es nuestro ultimo recordatorio por este tema. Si seguis necesitando la cotizacion, escribinos cuando quieras.',
  },
  lead_sin_respuesta: {
    0: 'Hola {{nombre}}, te vimos escribiendo antes y nos quedamos con tu consulta. ¿En que podemos ayudarte?',
    1: 'Hola {{nombre}}, queriamos retomar la consulta que nos dejaste. ¿Seguimos necesitando algo?',
    3: 'Hola {{nombre}}, te buscamos por tu consulta anterior. Si ya no te hace falta, avisanos; si seguis interesado, aqui estamos.',
    7: 'Hola {{nombre}}, te volvemos a escribir por tu consulta en Hormiglass. ¿Queres retomarla?',
    14: 'Hola {{nombre}}, ultimo recordatorio por tu consulta en Hormiglass. Cuando quieras, seguimos a disposicion.',
  },
};

const FALLBACK_MESSAGES = {
  0: 'Hola {{nombre}}, quedamos a tu disposicion por tu consulta. ¿Seguimos avanzando?',
  1: 'Hola {{nombre}}, te escribimos para retomar tu consulta en Hormiglass.',
  3: 'Hola {{nombre}}, nos gustaria saber si seguis necesitando algo.',
  7: 'Hola {{nombre}}, te recordamos que seguimos a tu disposicion.',
  14: 'Hola {{nombre}}, ultimo recordatorio por tu consulta. Cuando quieras, aqui estamos.',
};

const WINDOW_START_DEFAULT = '09:00';
const WINDOW_END_DEFAULT = '20:00';

const pickMessage = (motivo, stepDia) =>
  (MESSAGES[motivo]?.[stepDia] ?? FALLBACK_MESSAGES[stepDia]) || null;

const fillTemplate = (message, contactName) =>
  (message || '').replace(/\{\{nombre\}\}/g, contactName ? String(contactName).trim() : '');

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
