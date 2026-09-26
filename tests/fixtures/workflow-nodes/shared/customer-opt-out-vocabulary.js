// =============================================================================
// customer-opt-out-vocabulary.js — the single source of truth for how a
// customer says "stop writing to me" (opt-out) or "I am no longer interested"
// (lost intent).
// -----------------------------------------------------------------------------
// Code nodes get this file prepended through `runtimes` in
// tests/scripts/sync-workflow-nodes.mjs; Node harnesses require it. Patterns
// run on normalizeIntentText output: no accents, lowercase, punctuation as
// spaces. They cover the tú, usted and ustedes forms Chilean customers use
// ("no me escribas", "no me escriba", "no me escriban"). An opt-out stops the
// follow-up cadence for good, so a phrase belongs here only when it cannot be
// read as an ordinary commercial reply.
// =============================================================================

const normalizeIntentText = (text) => String(text ?? '')
  .normalize('NFD')
  .replace(/[̀-ͯ]/g, '')
  .toLowerCase()
  .replace(/[^a-z0-9ñ\s]/g, ' ')
  .replace(/\s+/g, ' ')
  .trim();

// Negative commands take the subjunctive: escribas / escriba / escriban.
const WRITE_TO_ME = 'escrib(?:a|as|an)|contact(?:e|es|en)|molest(?:e|es|en)';
// "No me llamen" alone is often a channel preference ("escríbanme por acá"),
// so calling only counts as an opt-out when it says "más".
const CALL_ME_AGAIN = 'llam(?:e|es|en) mas';
const SEND_ME_MESSAGES = '(?:mand|envi)(?:e|es|en) (?:mas )?(?:mensajes|publicidad|promociones)';
const KEEP_DOING = '(?:escribiendo|contactando|llamando|molestando|mandando|enviando)';

const OPT_OUT_PATTERNS = [
  new RegExp(`\\bno (?:quiero que )?me (?:${WRITE_TO_ME}|${CALL_ME_AGAIN}|${SEND_ME_MESSAGES})\\b`),
  new RegExp(`\\bno (?:quiero que )?me (?:sig(?:a|as|an) ${KEEP_DOING}|vuelv(?:a|as|an) a (?:escribir|contactar|llamar|molestar))\\b`),
  /(?<!\bno )\bdej(?:a|e|en) de (?:escribirme|contactarme|llamarme|molestarme|mandarme mensajes|enviarme mensajes)\b/,
  /\bno quiero (?:mas )?(?:mensajes|publicidad|informacion|seguir recibiendo)\b/,
  /\b(?:borr|sac|saqu|quit|elimin)(?:a|e|en|an|ar)me de (?:la |su |sus |tu |tus |esta )?(?:lista|base|contactos)\b/,
  /\b(?:dar(?:me)?|dame|deme|denme) de baja\b/,
  /\bbaja\b.*\b(?:de la lista|mensajes|programa)\b/,
  /\bstop\b/,
];

const LOST_PATTERNS = [
  /ya no (me interesa|necesito|quiero)/i,
  /lo pense y no (voy a|quiero)/i,
  /estoy con (otra|la competencia)/i,
  /no voy a (comprar|avanzar)/i,
  /cerremos el tema/i,
];

const matchesIntent = (patterns, text) => {
  const normalized = normalizeIntentText(text);
  return Boolean(normalized) && patterns.some((pattern) => pattern.test(normalized));
};
const detectOptOut = (text) => matchesIntent(OPT_OUT_PATTERNS, text);
const detectLostIntent = (text) => matchesIntent(LOST_PATTERNS, text);

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    OPT_OUT_PATTERNS,
    LOST_PATTERNS,
    normalizeIntentText,
    detectOptOut,
    detectLostIntent,
  };
}
