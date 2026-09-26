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