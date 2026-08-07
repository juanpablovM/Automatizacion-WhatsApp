// =============================================================================
// follow-up-policy.js — Cadencia de seguimiento A-010 (PRD 25.4 / seccion 20).
// SOURCE OF TRUTH de la cadencia 0/1/3/7/14, los textos por step/motivo, la
// ventana de envio horaria y el fraseario de opt-out / perdida de interes.
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

// Frases de opt-out: ante cualquiera de estas expresiones la cadencia se
// cancela para SIEMPRE (estado opted_out) y no se vuelve a enviar nada.
const OPT_OUT_PATTERNS = [
  /no me escribas mas/i,
  /escribas mas/i,
  /baja.*(de la lista|pas|mensajes|programa)/i,
  /stop/i,
  /no quiero (mas )?(mensajes|publicidad|informacion|seguir recibiendo)/i,
  /dej[a|en] de escribirme/i,
  /no me envies mas mensajes/i,
  /darme de baja/i,
  /quitar(me)? de la lista/i,
  /no me molestes/i,
];

const detectOptOut = (text) => {
  const source = String(text ?? '').trim().toLowerCase();
  if (!source) return false;
  return OPT_OUT_PATTERNS.some((pattern) => pattern.test(source));
};

// Frases de perdida de interes: al detectarlas la cadencia se cancela con
// motivo 'lost' (se guarda lost_reason con la frase normalizada).
const LOST_PATTERNS = [
  /ya no (me interesa|necesito|quiero)/i,
  /lo pense y no (voy a|quiero)/i,
  /estoy con (otra|la competencia)/i,
  /no voy a (comprar|avanzar)/i,
  /cerremos el tema/i,
];

const detectLostIntent = (text) => {
  const source = String(text ?? '').trim();
  return LOST_PATTERNS.some((pattern) => pattern.test(source));
};

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