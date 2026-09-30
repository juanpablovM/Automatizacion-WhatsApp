// =============================================================================
// follow-up-policy.js — Cadencia de seguimiento A-010 (PRD 25.4 / seccion 20).
// SOURCE OF TRUTH de la cadencia 0/1/3/7/14, los textos por step/motivo y la
// ventana de envio horaria. El fraseario de opt-out / perdida de interes vive
// en ../shared/customer-opt-out-vocabulary.js y se reexporta aqui.
// -----------------------------------------------------------------------------
// El PRD no fija textos literales para A-010: esta es la libreria unica donde
// se editan (es inferida por el scheduler y por los harness). Guardrails:
// textos sin precios, sin promesas, sin descuentos y tono neutro.
// =============================================================================

const CADENCE_STEPS = [1, 3, 7, 14];
const DAY_ZERO_STEP = 0;
const ALL_CADENCE_STEPS = [0, 1, 3, 7, 14];

// Ventana de envio (hora local del proyecto): nunca despachar fuera.
const DEFAULT_WINDOW = { start: '09:00', end: '20:00' };

const FOLLOW_UP_MOTIVES = ['cotizacion_lead', 'lead_sin_respuesta'];

// Mensajes por step y motivo. {{nombre}} se reemplaza si hay dato de contacto.
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

// Opt-out cancels the cadence for good (opted_out); lost intent cancels it with
// reason 'lost'. Both share one normalized vocabulary with the dispatcher.
const {
  OPT_OUT_PATTERNS,
  LOST_PATTERNS,
  detectOptOut,
  detectLostIntent,
} = require('../shared/customer-opt-out-vocabulary.js');

const buildCadence = ({ withDayZero = false, startOn = null, now = null }) => {
  const base = now ? new Date(now) : startOn ? new Date(startOn) : new Date();
  const steps = withDayZero ? ALL_CADENCE_STEPS : CADENCE_STEPS;
  return steps.map((step) => ({
    step_dia: step,
    scheduled_at: new Date(base.getTime() + step * 86400000).toISOString(),
  }));
};

const canonicalIdempotency = (conversationId, stepDia) =>
  `${conversationId}:${stepDia}`;

module.exports = {
  CADENCE_STEPS,
  DAY_ZERO_STEP,
  ALL_CADENCE_STEPS,
  DEFAULT_WINDOW,
  FOLLOW_UP_MOTIVES,
  MESSAGES,
  OPT_OUT_PATTERNS,
  LOST_PATTERNS,
  detectOptOut,
  detectLostIntent,
  buildCadence,
  canonicalIdempotency,
};