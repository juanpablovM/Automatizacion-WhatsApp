const hasAuthorizedPriceContext = (priceContext) => {
  const context = asObject(priceContext);
  if (!['fixed', 'reference', 'from', 'range'].includes(context.type)) return false;
  return [context.amount, context.amount_min, context.amount_max]
    .some((value) => Number.isFinite(Number(value)));
};

const normalizePrdClaimText = (value) => String(value ?? '')
  .normalize('NFD')
  .replace(/[\u0300-\u036f]/g, '')
  .toLowerCase();

const PRD_VALIDATORS = [
  {
    name: 'NO_INVENT_PRICE',
    test: (text, _catalogMatches, priceContext) => {
      const hasPrice = /\$\s*[\d.,]+/.test(text);
      const hasOfficial = hasAuthorizedPriceContext(priceContext);
      return hasPrice && !hasOfficial;
    },
    fallback: 'Para darte un valor correcto necesito revisar producto, cantidad, comuna y si buscas solo material, despacho o instalacion. Te ayudo con esos datos y te derivo para cotizacion.',
  },
  {
    name: 'NO_CONFIRM_STOCK',
    test: (text) => /\b(tenemos stock|stock disponible|hay disponibilidad|esta disponible|en stock)\b/i.test(text)
      && /\b(baldosas?|pastelones?|adocretos?|cierres?|bloques?|soleras?|placas?|postes?)\b/i.test(text),
    semanticTest: (text) => /\b(tenemos stock|stock disponible|hay disponibilidad|esta disponible|en stock)\b/i
      .test(normalizePrdClaimText(text)),
    fallback: 'Puedo levantar tu solicitud, pero la disponibilidad debe confirmarla el equipo antes de cerrar la venta.',
  },
  {
    name: 'NO_CONFIRM_PAYMENT',
    test: (text) => /\b(pago confirmado|transferencia recibida|ya puedes retirar|ya esta validado|pago acreditado)\b/i.test(text),
    semanticTest: (text) => /\b(pago(?: fue)? confirmado|transferencia recibida|ya puedes retirar|ya esta validado|pago acreditado)\b/i
      .test(normalizePrdClaimText(text)),
    fallback: 'Recibimos el comprobante. La validacion final del pago la realiza Finanzas una vez que el monto este acreditado. Te avisaremos cuando quede confirmado.',
  },
  {
    name: 'NO_DISCOUNT',
    test: (text) => /\b(te puedo hacer\s+\d+%|tenemos descuento|te bajo el precio|igualamos precio|descuento del\s+\d+%)\b/i.test(text),
    semanticTest: (text) => /(?:\b(?:te|le)\s+(?:aplico|doy|ofrezco|hago)\b[^.!?\n]{0,30}\b(?:descuento|rebaja)\b|\b\d+\s*%\s+de\s+descuento\b)/i
      .test(normalizePrdClaimText(text)),
    fallback: 'Las condiciones comerciales especiales las revisa una ejecutiva segun el caso, volumen, producto y vigencia de la cotizacion. Te puedo derivar para evaluacion.',
  },
  {
    name: 'NO_PROMISE_DELIVERY',
    test: (text) => /\b(llega el|te llega el|despacho el|te enviamos|manana|pasado manana|en \d+ dias)\b/i.test(text)
      && !/\b(revisar|confirmar|depende|sujeto|verificar|evaluar)\b/i.test(text),
    semanticTest: (text) => {
      const normalized = normalizePrdClaimText(text);
      return /\b(llega el|te llega el|despacho el|te enviamos|manana|pasado manana|en \d+ dias|entregaremos|despacharemos|llegara|llega)\b/i.test(normalized)
        && !/\b(revisar|confirmar|depende|sujet[oa]|verificar|evaluar)\b/i.test(normalized);
    },
    fallback: 'Para revisar factibilidad de despacho necesitamos comuna, producto, cantidad y fecha tentativa. Prefiero ayudarte a confirmar un plazo realista antes de prometer algo que pueda fallar.',
  },
  {
    name: 'NO_PROMISE_INSTALLATION',
    test: (text) => /\b(instalamos|te instalamos|la instalacion es|instalacion incluida|instalacion gratis)\b/i.test(text)
      && !/\b(revisar|evaluar|depende|necesitamos|sujeto|cotizar)\b/i.test(text),
    semanticTest: (text) => {
      const normalized = normalizePrdClaimText(text);
      return /\b(instalamos|te instalamos|la instalacion es|instalacion incluida|instalacion gratis|instalaremos|iremos a instalar|quedara instalado)\b/i.test(normalized)
        && !/\b(revisar|evaluar|depende|necesitamos|sujet[oa]|cotizar)\b/i.test(normalized);
    },
    fallback: 'Para instalacion necesitamos revisar medidas, comuna, terreno, acceso y si hay retiro de escombros. Con eso se puede preparar una cotizacion mas precisa.',
  },
  {
    name: 'NO_FALSE_DERIVATION_PROMISE',
    test: (text, _catalogMatches, _priceContext, ctx) => Boolean(ctx && ctx.blockDerivationPromise)
      && /\b(voy a derivar|te voy a derivar|te derivo|derivar[ée]\b|ya derive|ya derivé|he derivado|qued[oa]s? derivad[oa]|derive tu (caso|solicitud|consulta)|derivé tu (caso|solicitud|consulta)|un[ao]? (asesor|ejecutiv[oa]|persona del equipo) (te contactar[aá]|se comunicar[aá]|te escribir[aá]))\b/i.test(text),
    fallback: 'Todavia estoy reuniendo los datos que necesito antes de derivar tu caso a un asesor. Sigamos completando la informacion para poder ayudarte.',
  },
];

const validatePrdRules = (text, catalogMatches, priceContext, ctx, enabledRuleIds = null) => {
  if (!text) return { passed: true, rule: null };
  const enabledRules = Array.isArray(enabledRuleIds) ? new Set(enabledRuleIds) : null;
  for (const validator of PRD_VALIDATORS) {
    if (enabledRules && !enabledRules.has(validator.name)) continue;
    const legacyViolation = validator.test(text, catalogMatches, priceContext, ctx);
    const semanticViolation = Boolean(ctx?.semanticPolicy && validator.semanticTest?.(text));
    if (legacyViolation || semanticViolation) {
      return { passed: false, rule: validator.name, fallback: validator.fallback };
    }
  }
  return { passed: true, rule: null };
};
