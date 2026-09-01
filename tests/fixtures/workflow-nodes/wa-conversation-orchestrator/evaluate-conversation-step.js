// =============================================================================
// Evaluate Conversation Step — Conversation Orchestrator (fixture canonico)
// -----------------------------------------------------------------------------
// Contrato temporal (memoria #677, #686):
// - ≤48h: continuación (conversation activa)
// - >48h y ≤30d: re-engagement desde último inbound persistido
// - >30d: solicitud nueva con recuperación opcional
//
// Precedencia (memoria #679):
// opt-out/abandono → humano → escalación/terminal → operacional → re-engagement → comercial/IA
//
// previous_context PRESERVA conversation_id (no resetear).
// Re-engagement copy NEUTRAL: sin claims falsos de "te escribimos varias veces".
//
// Export: evaluateConversationStep(inputRow) -> [{ json: output }]
// =============================================================================

const FIXTURE_VERSION = "2026-08-20-v4";

// Evidencia de medida o cantidad ("50 metros", "100 m2", "3 palets"). Es la
// respuesta mas precisa que un cliente puede dar en el paso de requerimiento,
// pero ocupa dos o tres palabras y no superaba el umbral de verbosidad de
// isConcreteRequirement, de modo que el bot volvia a preguntar lo ya contestado
// y a partir del tercer turno escalaba como loop_detected (memoria #668).
//
// Definicion canonica del nodo: cualquier otro chequeo de medida en este
// archivo debe reusar MEASURE_EVIDENCE_RE en lugar de declarar su propio patron.
// Se evalua sobre texto ya normalizado por normalizeText, que elimina los
// simbolos: "100 m²" llega como "100 m" y "1.000 m2" llega como "1 000 m2".
const MEASURE_UNITS = [
  'm2', 'mts', 'mt', 'ml', 'metros', 'metro',
  'centimetros', 'centimetro', 'milimetros', 'milimetro',
  'cm', 'mm', 'km', 'kg', 'lt',
  'litros', 'litro', 'toneladas', 'tonelada', 'kilos', 'kilo',
  'unidades', 'unidad', 'piezas', 'pieza',
  'sacos', 'saco', 'pallets', 'pallet', 'palets', 'palet',
  'bolsas', 'bolsa', 'cajas', 'caja', 'rollos', 'rollo',
  'm',
];
const MEASURE_EVIDENCE_RE = new RegExp('\\b\\d+(?:\\s*\\d{3})*\\s*(?:' + MEASURE_UNITS.join('|') + ')\\b');
const hasMeasureEvidence = (normalized) => MEASURE_EVIDENCE_RE.test(normalized);

function evaluateConversationStep(row) {
  // row is the input item (items[0]?.json in n8n context)

  const baseQuestions = {
    city: 'Para orientarte mejor, ¿desde qué ciudad o comuna nos escribes?',
    service: '¿Qué necesitas resolver? Trabajamos con pastelones, baldosas, adocretos, cierros bulldog, adoquines, solerillas, bloques y maceteros de hormigón.',
    requirement: 'Cuéntame un poco más sobre tu proyecto. ¿Es para cerrar un terreno, patio, entrada vehicular, jardín o una obra? ¿Necesitas solo material o también instalación?',
  };

  // Regla PRD (clasificacion product vs service): los unicos servicios reales
  // son instalacion, retiro de escombros, suministro (solo material) y despacho.
  // Todo lo demas es producto (hormigon, losas, vigas, muros, cierres, etc.).
  const knownServices = [
    'instalacion',
    'retiro de escombros',
    'retiro escombros',
    'retiro',
    'suministro',
    'suministros',
    'despacho',
  ];

  const knownProducts = [
    'adocesped',
    'adocreto',
    'adoquines',
    'adoquin',
    'baldosas',
    'baldosa',
    'pastelones',
    'pastelon',
    'cierro bulldog',
    'cierre bulldog',
    'bloques',
    'bloque',
    'solerillas',
    'solerilla',
    'soleras',
    'solera',
    'postes',
    'poste',
    'placas',
    'placa',
    'maceteros',
    'macetero',
    'tapas de camara',
    'tapa de camara',
    'cemento',
    'pigmento',
    'cuarzo',
    'hormigon',
    'losas',
    'losa',
    'vigas',
    'viga',
    'muros',
    'muro',
    'loseta',
    'cierre',
    'cierro',
  ];

  const knownCities = [
    'santiago',
    'vina del mar',
    'viña del mar',
    'valparaiso',
    'concepcion',
    'antofagasta',
    'temuco',
    'rancagua',
    'talca',
    'puerto montt',
    'la serena',
    'iquique',
    'copiapo',
    'arica',
    'chillan',
    'osorno',
    'punta arenas',
    'las condes',
    'providencia',
    'nunoa',
    'ñuñoa',
    'la reina',
    'vitacura',
    'lo barnechea',
    'santiago centro',
    'estacion central',
    'maipu',
    'pudahuel',
    'quilicura',
    'huechuraba',
    'recoleta',
    'independencia',
    'conchali',
    'renca',
    'la florida',
    'puente alto',
    'macul',
    'penalolen',
    'peñalolen',
    'san miguel',
    'san joaquin',
    'la cisterna',
    'el bosque',
    'la granja',
    'san bernardo',
    'cerrillos',
    'colina',
    'lampa',
    'til til',
    'padre hurtado',
    'penaflor',
    'peñaflor',
    'talagante',
    'melipilla',
    'buin',
    'paine',
    'vina del mar',
    'concon',
    'quilpue',
    'villa alemana',
    'limache',
    'olmue',
    'casablanca',
    'san antonio',
  ];

  const greetingOnly = [
    'hola',
    'buenas',
    'buenos dias',
    'buen día',
    'buen dia',
    'buenas tardes',
    'buenas noches',
    'hello',
    'hi',
  ];

  // Model C: B2B keyword detection
  const b2bKeywords = [
    'constructora',
    'inmobiliaria',
    'empresa',
    'licitacion',
    'licitación',
    'orden de compra',
    'oc',
    'proveedor',
    'volumen',
    'pago a 30 dias',
    'pago a 30 días',
    'factura empresa',
    'rut empresa',
    'contratista',
    'supervisor',
    'jefe de obra',
    'compras',
    'factura',
  ];

  const intentKeywords = [
    'cotizar',
    'cotizacion',
    'precio',
    'presupuesto',
    'informacion',
    'info',
    'necesito',
    'quiero',
    'me interesa',
    'estoy interesado',
    'comprar',
    'instalar',
    'reparar',
    'mantener',
    'mantencion',
    'cambiar',
    'renovar',
  ];

  const normalizeText = (value) =>
    String(value ?? '')
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9ñ\s]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();

  const toTitleCase = (value) =>
    String(value ?? '')
      .trim()
      .split(/\s+/)
      .filter(Boolean)
      .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
      .join(' ');

  const compact = (value) => String(value ?? '').trim();
  const hasValue = (value) => compact(value).length > 0;
  const wordCount = (value) => normalizeText(value).split(' ').filter(Boolean).length;

  const decodeStepState = (encoded) => {
    if (!encoded) return {};
    try {
      const parsed = JSON.parse(decodeURIComponent(encoded));
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch (_error) {
      return {};
    }
  };

  const encodeStep = (field, state) => {
    const payload = {
      service: state.service || null,
      city: state.city || null,
      requirement: state.requirement || null,
    };
    const hasPayload = Object.values(payload).some((value) => String(value || '').trim());
    if (!hasPayload) return field;
    return field + '|' + encodeURIComponent(JSON.stringify(payload));
  };

  const parseStep = (value) => {
    const raw = String(value || 'city').trim();
    const [stepValue, encodedState] = raw.split('|');
    const match = stepValue.match(/^(service|city|requirement|confirm|previous_context|complete|escalation)(?:_retry_(\d+))?$/);

    if (!match) {
      return { field: 'service', retry: 0, state: decodeStepState(encodedState) };
    }

    return {
      field: match[1],
      retry: Number(match[2] || 0),
      state: decodeStepState(encodedState),
    };
  };

  const stripCity = (text) => {
    let result = text;
    for (const city of knownCities) {
      result = result.replace(new RegExp('\\b' + city + '\\b', 'gi'), ' ');
    }
    return result.replace(/\s+/g, ' ').trim();
  };

  const stripIntentWords = (text) => {
    let result = text;
    for (const word of intentKeywords) {
      result = result.replace(new RegExp('\\b' + word + '\\b', 'gi'), ' ');
    }
    return result
      .replace(/\b(en|para|por|de|del|la|el|un|una|al|los|las|mi|mis|su|sus)\b/gi, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  };

  const messageType = row.message_type || 'unknown';
  const rawText = String(row.text_body || '').trim();
  const normalizedText = normalizeText(rawText);
  const isGreetingOnly = greetingOnly.includes(normalizedText);
  const usefulText = rawText.length > 0 && !isGreetingOnly;
  const textHasIntent = intentKeywords.some((keyword) => normalizedText.includes(keyword));

  // ============================================================
  // RE-ENGAGEMENT DETECTION — INPUT FROM SQL (single source)
  // ============================================================
  // SQL must provide:
  //   - is_reengagement: true if >48h and ≤30d since LAST PERSISTED INBOUND
  //   - elapsed_hours_since_last_inbound: hours since last inbound_event created_at
  //   - last_known_service/city/requirement: from last lead/conversation state
  //   - has_active_conversation: true if ≤48h since last inbound AND status active
  //
  // SQL separates identity (existing), recency, staleness and re-engagement.
  // ============================================================
  const isReengagement = Boolean(row.is_reengagement);
  const elapsedHoursSinceLastInbound = row.elapsed_hours_since_last_inbound ?? null;
  const lastKnownService = row.last_known_service || null;
  const lastKnownCity = row.last_known_city || null;
  const lastKnownRequirement = row.last_known_requirement || null;

  const hasExistingConversation = Boolean(row.has_existing_conversation ?? row.conversation_id);
  const isRecentConversation = Boolean(row.is_recent_conversation ?? row.has_active_conversation);
  const isStaleContext = Boolean(row.is_stale_context ?? (hasExistingConversation && !isRecentConversation));
  const startsNewRequest = !hasExistingConversation || (isStaleContext && !isReengagement);
  const firstInteraction = !hasExistingConversation;
  const targetConversationId = row.target_conversation_id || row.conversation_id || null;

  const pickRicherStep = (preferred, fallback) => {
    const a = String(preferred || '').trim();
    const b = String(fallback || '').trim();
    if (a.includes('|') && !b.includes('|')) return a;
    if (b.includes('|') && !a.includes('|')) return b;
    return a || b || '';
  };

  const activeStep = (row.has_active_conversation || isReengagement)
    ? (pickRicherStep(row.state_current_step, row.current_step) || 'city')
    : 'city';
  const stepInfo = parseStep(activeStep);
  const isHandoffAlreadyDone = row.has_active_conversation && (row.conversation_status_code === 'handed_to_sales' || stepInfo.field === 'complete');
  const isTerminalConversation = ['handed_to_sales', 'closed', 'inactive_timeout'].includes(row.conversation_status_code);

  const detectCity = (text) => {
    const hit = knownCities.find((city) => text.includes(city));
    return hit ? toTitleCase(hit) : null;
  };

  const detectActionIntent = (text) => {
    if (!text) return null;
    const actions = [
      { action: 'comprar', label: 'Comprar', patterns: [/\bcomprar\b/, /\bcompra\b/, /\bquiero comprar\b/] },
      { action: 'cotizar', label: 'Cotizar', patterns: [/\bcotizar\b/, /\bcotizacion\b/, /\bprecio\b/, /\bpresupuesto\b/, /\bvalor\b/] },
      { action: 'instalar', label: 'Instalar', patterns: [/\binstalar\b/, /\binstalacion\b/] },
      { action: 'reparar', label: 'Reparar', patterns: [/\breparar\b/, /\breparacion\b/, /\bfalla\b/, /\bproblema\b/] },
      { action: 'mantener', label: 'Mantención', patterns: [/\bmantener\b/, /\bmantencion\b/, /\bmantenimiento\b/] },
      { action: 'cambiar', label: 'Cambiar', patterns: [/\bcambiar\b/, /\bcambio\b/, /\breemplazar\b/] },
      { action: 'renovar', label: 'Renovar', patterns: [/\brenovar\b/, /\brenovacion\b/] },
      { action: 'consultar', label: 'Consultar', patterns: [/\binformacion\b/, /\binfo\b/, /\bconsulta\b/, /\bconsultar\b/, /\bme interesa\b/] },
    ];
    return actions.find((entry) => entry.patterns.some((pattern) => pattern.test(text))) || null;
  };

  const isVagueAnswer = (text) => {
    if (!text) return true;
    return /^(no se|nose|depende|ayuda|ayudenme|me ayudan|me ayudas|no entiendo|mmm|ok|vale|dale|si|sí)$/i.test(text);
  };

  const isGenericIntentOnly = (text) => {
    const withoutCity = stripCity(text);
    const withoutIntent = stripIntentWords(withoutCity);
    return withoutIntent.length === 0 || withoutIntent.split(' ').filter(Boolean).length <= 1;
  };

  // Model C: B2B detection function
  const detectB2bSignal = (text) => {
    const normalized = normalizeText(text);
    return b2bKeywords.some(kw => normalized.includes(normalizeText(kw)));
  };

  const isLikelyCityAnswer = (text, originalText) => {
    if (knownProducts.some((product) => text.includes(product))) return false;
    if (detectCity(text)) return true;
    if (/\b(soy de|estoy en|estamos en|desde|ubicad[oa] en|vivo en)\b/.test(text)) return true;
    if (wordCount(originalText) <= 4 && /^[A-ZÁÉÍÓÚÑ][A-Za-zÁÉÍÓÚáéíóúÑñ\s.-]+$/.test(originalText) && !detectActionIntent(text)) {
      const productHints = /\b(baldosa|baldosas|ceramica|ceramicas|piso|pisos|porcelanato|cemento|arena|grava|ladrillo|ladrillos|madera|puerta|ventana|techo|tejas)\b/;
      return !productHints.test(text);
    }
    return false;
  };

  const extractProductAfterAction = (text) => {
    const withoutCity = stripCity(text);
    const match = withoutCity.match(/(?:comprar|cotizar|precio|presupuesto|instalar|instalacion|reparar|reparacion|mantencion|mantenimiento|cambiar|renovar|informacion|info)\s+(?:de|del|para|por|sobre)?\s*(.+)$/i);
    if (!match?.[1]) return null;
    const candidate = stripIntentWords(match[1]);
    if (!candidate || candidate.length < 3 || candidate.split(' ').filter(Boolean).length > 8) return null;
    return toTitleCase(candidate);
  };

  const isLikelyServiceAnswer = (text, originalText) => {
    if (!text || isGreetingOnly) return false;
    if (knownServices.some((service) => text.includes(service))) return true;
    if (extractProductAfterAction(text)) return true;
    if (detectCity(text) && wordCount(originalText) <= 4) return false;
    if (detectActionIntent(text) && isGenericIntentOnly(text)) return false;
    return originalText.length >= 3 && originalText.length <= 80 && wordCount(originalText) <= 8 && !isVagueAnswer(text);
  };

  const detectService = (text, originalText, forceFromAnswer = false) => {
    const productHit = knownProducts.find((product) => text.includes(product));
    if (productHit) return toTitleCase(productHit);

    const hit = knownServices.find((service) => text.includes(service));
    if (hit) return toTitleCase(hit);

    const productAfterAction = extractProductAfterAction(text);
    if (productAfterAction) return productAfterAction;

    if (forceFromAnswer && isLikelyServiceAnswer(text, originalText)) return originalText;
    if (isGenericIntentOnly(text)) return null;

    const candidate = stripIntentWords(stripCity(text));
    if (!candidate || candidate.length < 3 || candidate.split(' ').filter(Boolean).length > 8) return null;
    return toTitleCase(candidate);
  };

  const isConcreteRequirement = (text) => {
    const normalized = normalizeText(text);
    if (!normalized) return false;
    // La medida se evalua antes del umbral de palabras: "50m2" es una sola
    // palabra y sigue siendo la respuesta correcta. Un numero sin unidad ("50")
    // no llega aca y se sigue repreguntando, que es lo que corresponde.
    if (hasMeasureEvidence(normalized)) return true;
    if (wordCount(normalized) < 2) return false;
    if (detectActionIntent(normalized) && !isGenericIntentOnly(normalized)) return true;
    if (wordCount(normalized) >= 4 && !isVagueAnswer(normalized)) return true;
    return false;
  };

  const buildRequirementFromContext = (actionIntent, service, text) => {
    if (!actionIntent || !hasValue(service)) return null;
    const normalized = normalizeText(text);
    const serviceNormalized = normalizeText(service);
    if (normalized && !isGenericIntentOnly(normalized) && normalized.includes(serviceNormalized)) return text;
    return actionIntent.label + ' ' + String(service).trim().toLowerCase();
  };

  const nextQuestionForMissingField = (missing, state, retry, actionIntent) => {
    if (missing === 'city') {
      return retry > 0
        ? '¿En qué ciudad necesitas el servicio? Por ejemplo: Santiago, Valparaíso o Concepción.'
        : baseQuestions.city;
    }
    if (missing === 'service') {
      return retry > 0
        ? '¿Qué producto o servicio necesitas? Por ejemplo: baldosas, instalación, reparación o mantención.'
        : baseQuestions.service;
    }
    if (missing === 'requirement') {
      if (actionIntent && state.service) {
        return 'Perfecto, quieres ' + actionIntent.label.toLowerCase() + ' ' + String(state.service).trim().toLowerCase() + '. ¿Tienes alguna medida, cantidad o tipo específico en mente?';
      }
      return retry > 0
        ? 'Cuéntame un poco más para derivarte bien. Por ejemplo: cantidad, medida, tipo de producto o problema que necesitas resolver.'
        : baseQuestions.requirement;
    }
    return baseQuestions[missing] || baseQuestions.city;
  };

  const previous = {
    whatsapp_name: row.previous_whatsapp_name || row.input_whatsapp_name || null,
    service: row.previous_service || null,
    city: row.previous_city || null,
    requirement: row.previous_requirement || null,
  };

  const stepState = stepInfo.state || {};
  const current = {
    whatsapp_name: row.input_whatsapp_name || previous.whatsapp_name,
    service: row.has_active_conversation ? row.state_service || stepState.service || null : null,
    city: row.has_active_conversation ? row.state_city || stepState.city || null : null,
    requirement: row.has_active_conversation ? row.state_requirement || stepState.requirement || null : null,
  };

  const completedFields = () => ['service', 'city', 'requirement'].filter((key) => hasValue(current[key]));
  const nextMissingField = () => {
    if (!hasValue(current.city)) return 'city';
    if (!hasValue(current.service)) return 'service';
    if (!hasValue(current.requirement)) return 'requirement';
    return 'confirm';
  };
  const confirmationText = () => [
    'Tengo esto:',
    'Servicio: ' + current.service,
    'Ciudad: ' + current.city,
    'Requerimiento: ' + current.requirement,
    '',
    '¿Está correcto?',
  ].join('\n');

  // conversation-flow-v2: Frustration/loop detection keywords
  const frustrationPatterns = [
    /\b(no me estai|no me está|no me estas|no me estás)\b/i,
    /\b(no escuchai|no escucha|no entendi|no entiendes)\b/i,
    /\b(llamar|hablar con alguien|atencion humana|ejecutiva|operador|persona real)\b/i,
    /\b(que lata|aburrido|fome|pesimo|mal servicio)\b/i,
    /\b(no sirve|no funciona|no me gusta|decepcionado|decepcionante)\b/i,
    /\b(ayuda|no entiendo nada|que hay que hacer)\b/i,
    /\b(quejarme|reclamo|queja|problema contigo)\b/i,
  ];
  // Opt-out / lost intent detection (memoria #686)
  const OPT_OUT_PATTERNS = [
    /no me escribas mas/i,
    /escribas mas/i,
    /baja.*(de la lista|pas|mensajes|programa)/i,
    /\bstop\b/i,
    /no quiero (mas )?(mensajes|publicidad|informacion|seguir recibiendo)/i,
    /dej(?:a|en) de escribirme/i,
    /no me envies mas mensajes/i,
    /darme de baja/i,
    /quitarme de la lista/i,
    /no me molestes/i,
  ];

  const LOST_PATTERNS = [
    /ya no (me interesa|necesito|quiero)/i,
    /lo pense y no (voy a|quiero)/i,
    /estoy con (otra|la competencia)/i,
    /no voy a (comprar|avanzar)/i,
    /cerremos el tema/i,
  ];

  const detectOptOut = (text) => OPT_OUT_PATTERNS.some(p => p.test(String(text || '').trim()));
  const detectLostIntent = (text) => LOST_PATTERNS.some(p => p.test(String(text || '').trim()));

  const detectFrustration = (text) => {
    if (!text) return false;
    const normalized = text.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
    return frustrationPatterns.some(p => p.test(normalized));
  };

  const isConfirmation = (text) => /^(si|s|ok|okay|dale|correcto|correcta|confirmo|esta correcto|asi es|si esta correcto|si por favor|si correcto|si correcta|de acuerdo)$/.test(normalizeText(text));
  const isRejection = (text) => /^(no|nop|incorrecto|incorrecta|no esta correcto|no es correcto|quiero cambiar|cambiar|modificar|corregir)$/.test(normalizeText(text));
  const wantsPrevious = (text) => /\b(continuar|seguir|retomar)\b.*\b(anterior|misma|mismo|solicitud|cotizacion)\b|\b(la anterior|lo anterior|misma solicitud|misma cotizacion)\b/.test(text);
  const wantsNew = (text) => /\b(nueva|nuevo|iniciar|empezar|otra|otro|desde cero|partir de cero)\b(?:.*\b(cotizacion|solicitud|pedido|proyecto)\b)?/.test(text);
  const wantsHuman = (text) => /\b(hablar|contactar|comunicarme)\b.*\b(persona|humano|humana|ejecutiva|ejecutivo|asesor|operador)\b|\b(atencion humana|persona real)\b|^(?:una?\s+)?(?:ejecutiva|ejecutivo|asesor|asesora|humano|humana|operador)(?:\s+por\s+favor)?$/.test(text);
  const operationalPatterns = [
    /\b(reclamo|queja|postventa|post venta)\b/,
    /\b(garantia|garantía)\b/,
    /\b(comprobante|transferencia|pago realizado|pague|pagué)\b/,
    /\b(factura|boleta|nota de credito|nota de crédito)\b/,
    /\b(reagendar|reprogramar|cambiar fecha)\b.*\b(despacho|instalacion|instalación|entrega)\b/,
  ];
  const isOperationalMessage = operationalPatterns.some((pattern) => pattern.test(normalizedText));

  const actionIntent = detectActionIntent(normalizedText);
  const isB2bSignal = detectB2bSignal(rawText);
  let inferredRequirement = null;
  let antiLoopApplied = false;
  let missingField = null;

  const applyDetectedFields = () => {
    if (!usefulText) return;

    const detectedCity = detectCity(normalizedText);
    const detectedService = detectService(normalizedText, rawText, stepInfo.field === 'service');
    const isCityAnswer = isLikelyCityAnswer(normalizedText, rawText);
    const isServiceAnswer = isLikelyServiceAnswer(normalizedText, rawText);

    if (detectedCity && !current.city) current.city = detectedCity;

    if (!current.service && detectedService && (stepInfo.field !== 'city' || !isCityAnswer || Boolean(detectedCity))) {
      current.service = detectedService;
    } else if (!current.service && isServiceAnswer && !isCityAnswer) {
      current.service = rawText;
    }

    if (stepInfo.field === 'city' && !current.city && isCityAnswer && !isServiceAnswer) {
      current.city = detectedCity || toTitleCase(rawText.replace(/^(soy de|estoy en|estamos en|desde|vivo en)\s+/i, ''));
    }

    if (!current.requirement) {
      if (stepInfo.field === 'requirement' && isConcreteRequirement(rawText)) {
        current.requirement = rawText;
        return;
      }

      const contextualRequirement = buildRequirementFromContext(actionIntent, current.service, rawText);
      if (contextualRequirement) {
        current.requirement = contextualRequirement;
        inferredRequirement = contextualRequirement;
        return;
      }

      if (isConcreteRequirement(rawText) && detectedService && actionIntent) {
        current.requirement = rawText;
      }
    }
  };

  let conversationStatusCode = 'waiting_user';
  let currentStepField = stepInfo.field;
  let shouldCreateLead = false;
  let shouldEscalate = false;
  let escalationReason = '';
  let isPartial = false;
  let responseText = '';
  let responseKind = 'question';
  let usedPreviousContext = false;
  let resetConversationLead = startsNewRequest
    && !wantsPrevious(normalizedText)
    && row.conversation_status_code !== 'escalation_required';
  let pendingQuestionKey = row.pending_question_key || null;
  const isEscalationAlreadyRequired = row.conversation_status_code === 'escalation_required'
    || stepInfo.field === 'escalation';
  const handleConfirmationRejection = () => {
    const rejectionAttempts = stepInfo.field === 'confirm' ? stepInfo.retry + 1 : 1;
    if (rejectionAttempts > 2) {
      shouldEscalate = true;
      escalationReason = 'confirmation_rejection_loop';
      currentStepField = 'escalation';
      pendingQuestionKey = null;
      responseKind = 'escalation_routing';
      responseText = '';
      conversationStatusCode = 'escalation_required';
      return;
    }
    currentStepField = 'confirm_retry_' + rejectionAttempts;
    pendingQuestionKey = 'confirmation_correction';
    responseKind = 'confirmation_correction_requested';
    responseText = 'Entiendo. ¿Qué dato de la solicitud quieres corregir?';
  };

  // ============================================================
  // PRECEDENCE ORDER — opt-out/abandono → humano → escalación/terminal
  // → operacional → re-engagement → comercial/IA
  // ============================================================

  // 1. OPT-OUT / abandono: siempre gana, incluso si el mensaje también pide retomar.
  if (detectOptOut(normalizedText) || detectLostIntent(normalizedText)) {
    shouldEscalate = true;
    shouldCreateLead = false;
    escalationReason = detectOptOut(normalizedText) ? 'opt_out' : 'abandoned';
    currentStepField = 'escalation';
    pendingQuestionKey = null;
    responseKind = 'escalation_routing';
    responseText = detectOptOut(normalizedText)
      ? 'Entendido. No te escribiremos más.'
      : 'Entendido. Cerramos tu solicitud. Si necesitas algo más, aquí estaremos.';
    conversationStatusCode = 'closed';
  }

  // 2. HUMANO: solicitud explícita de hablar con persona
  else if (wantsHuman(normalizedText)) {
    shouldEscalate = true;
    shouldCreateLead = false;
    escalationReason = 'human_requested';
    currentStepField = 'escalation';
    pendingQuestionKey = null;
    responseKind = 'escalation_routing';
    responseText = 'Claro. Te derivaré con una persona del equipo para continuar la atención.';
    conversationStatusCode = 'escalation_required';
  }

  // 3. ESCALACIÓN/TERMINAL: ya existente
  else if (isEscalationAlreadyRequired && !wantsNew(normalizedText)) {
    shouldEscalate = true;
    escalationReason = row.escalation_reason || 'escalation_already_required';
    currentStepField = 'escalation';
    pendingQuestionKey = null;
    responseKind = 'escalation_already_required';
    responseText = 'Tu solicitud ya está derivada a una persona del equipo. Si necesitas una cotización distinta, escribe "nueva cotización".';
    conversationStatusCode = 'escalation_required';
  }

  // 4. TERMINAL: una conversación cerrada no puede reaparecer como re-engagement.
  else if (isTerminalConversation) {
    current.service = null;
    current.city = null;
    current.requirement = null;
    resetConversationLead = true;
    pendingQuestionKey = null;
    currentStepField = 'city';
    applyDetectedFields();
    currentStepField = nextMissingField();
    responseKind = 'new_request_started';
    responseText = isGreetingOnly
      ? 'Hola, gracias por escribirnos nuevamente. ' + nextQuestionForMissingField(currentStepField, current, 0, actionIntent)
      : nextQuestionForMissingField(currentStepField, current, 0, actionIntent);
  }

  // 5. OPERACIONAL: no interceptar con el saludo de re-engagement; la IA clasifica y deriva.
  else if (isOperationalMessage) {
    resetConversationLead = false;
    currentStepField = stepInfo.field;
    pendingQuestionKey = row.pending_question_key || null;
    responseKind = 'operational_passthrough';
    responseText = '';
  }

  // 5. Retomar contexto anterior de forma explícita conserva identidad.
  else if (hasExistingConversation && row.previous_lead_id && wantsPrevious(normalizedText)) {
    current.service = previous.service;
    current.city = previous.city;
    current.requirement = previous.requirement;
    usedPreviousContext = true;
    resetConversationLead = false;
    currentStepField = nextMissingField();
    pendingQuestionKey = null;
    responseKind = 'previous_context_resumed';
    responseText = 'Entendido, retomamos tu solicitud anterior.';
  }

  // 6. RECHAZO DE CONFIRMACIÓN (legacy drift repair)
  else if (pendingQuestionKey === 'final_confirmation' && isRejection(normalizedText)) {
    handleConfirmationRejection();
  }

  // 7. RE-ENGAGEMENT: pedir consentimiento antes de recuperar datos anteriores.
  else if (isReengagement && targetConversationId) {
    current.service = null;
    current.city = null;
    current.requirement = null;
    currentStepField = 'previous_context';
    resetConversationLead = false;
    usedPreviousContext = false;
    pendingQuestionKey = 'previous_context_choice';
    responseKind = 'previous_context_choice';
    responseText = '¡Hola de nuevo! ¿Preferís continuar con la solicitud anterior o iniciar una nueva?';
  }

  // 6. NUEVA SOLICITUD: handoff ya hecho O firstInteraction + quiere nueva
  else if (isHandoffAlreadyDone || (wantsNew(normalizedText) && (startsNewRequest || isEscalationAlreadyRequired))) {
    current.service = null;
    current.city = null;
    current.requirement = null;
    resetConversationLead = true;
    pendingQuestionKey = null;
    currentStepField = 'city';
    applyDetectedFields();
    const freshMissing = nextMissingField();
    currentStepField = freshMissing;
    responseKind = isGreetingOnly ? 'recontact_greeting' : 'new_request_started';
    responseText = freshMissing === 'confirm' ? confirmationText() : nextQuestionForMissingField(freshMissing, current, 0, actionIntent);
  }

  // 7. PREVIOUS_CONTEXT CHOICE: step explícito esperando decisión
  else if (stepInfo.field === 'previous_context') {
    if (wantsPrevious(normalizedText)) {
      current.service = previous.service;
      current.city = previous.city;
      current.requirement = previous.requirement;
      usedPreviousContext = true;
    } else if (wantsNew(normalizedText)) {
      current.service = null;
      current.city = null;
      current.requirement = null;
      resetConversationLead = true;
      currentStepField = 'city';
      responseKind = 'question';
      responseText = baseQuestions.city;
    } else {
      currentStepField = 'previous_context';
      responseKind = 'previous_context_choice';
      responseText = '¿Prefieres continuar con la solicitud anterior o iniciar una nueva?';
    }
  }

  // 7. B2B / COMERCIAL: detección temprana (precedencia comercial/IA)
  else if (isB2bSignal && !shouldCreateLead) {
    responseKind = 'b2b_redirect';
    responseText = 'Detecto que eres de una empresa o constructora. Para atenderte mejor, necesito algunos datos adicionales:\n\n- Nombre de la empresa\n- RUT\n- Obra o proyecto\n- Comuna\n- Producto que necesitas\n- Cantidad aproximada\n- Plazo requerido\n- Si tienen Orden de Compra o condicion de pago definida\n\nCon esa informacion te puedo derivar con el area B2B de Hormiglass.';
  }

  // 8. CONFIRMACIÓN EXPLÍCITA
  else if (stepInfo.field === 'confirm') {
    const isFinalConfirmationQuestion = !row.pending_question_key || row.pending_question_key === 'final_confirmation';
    const isCorrectionQuestion = row.pending_question_key === 'confirmation_correction';
    if (isFinalConfirmationQuestion && isConfirmation(normalizedText) && completedFields().length === 3) {
      currentStepField = 'complete';
      pendingQuestionKey = null;
      conversationStatusCode = 'handed_to_sales';
      shouldCreateLead = true;
      isPartial = false;
      responseKind = 'handoff_ready';
      responseText = 'Gracias por la información. Para seguir correctamente te derivaré con una ejecutiva del equipo Hormiglass, quien revisará tu caso y continuará la atención.';
    } else if ((isFinalConfirmationQuestion || isCorrectionQuestion) && isRejection(normalizedText)) {
      handleConfirmationRejection();
    } else {
      // Model C: B2B detection - redirect to B2B flow (PRECEDENCIA: comercial/IA)
      if (isB2bSignal && !shouldCreateLead) {
        responseKind = 'b2b_redirect';
        responseText = 'Detecto que eres de una empresa o constructora. Para atenderte mejor, necesito algunos datos adicionales:\n\n- Nombre de la empresa\n- RUT\n- Obra o proyecto\n- Comuna\n- Producto que necesitas\n- Cantidad aproximada\n- Plazo requerido\n- Si tienen Orden de Compra o condicion de pago definida\n\nCon esa informacion te puedo derivar con el area B2B de Hormiglass.';
      } else {
        currentStepField = 'confirm';
        responseKind = 'confirmation_question';
        responseText = 'Para avanzar necesito confirmar los datos. ' + confirmationText();
      }
    }
  }

  // 9. FLUJO NORMAL: detección de campos + frustración/loop
  else if (!responseText
    && responseKind !== 'escalation_routing'
    && responseKind !== 'escalation_already_required'
    && responseKind !== 'operational_passthrough') {
    if (isGreetingOnly && startsNewRequest) {
      currentStepField = nextMissingField();
      responseKind = 'welcome_and_question';
      responseText = 'Hola, gracias por escribir a Hormiglass. Soy el asistente virtual y te ayudaré a orientar tu solicitud para que una ejecutiva pueda cotizarte correctamente.\n\n' + nextQuestionForMissingField(currentStepField, current, stepInfo.retry, actionIntent);
    } else if (isGreetingOnly && !firstInteraction && row.previous_lead_id) {
      // Recontact greeting para clientes recurrentes SIN re-engagement
      currentStepField = nextMissingField();
      responseKind = 'recontact_greeting';
      let recontactGreeting = 'Hola, gracias por escribirnos de nuevo. ';
      if (previous.service || previous.city) {
        recontactGreeting += 'Vi que anteriormente consultaste por ';
        if (previous.service) recontactGreeting += previous.service;
        if (previous.city) recontactGreeting += ' en ' + previous.city;
        recontactGreeting += '. ';
      }
      recontactGreeting += 'En que te puedo ayudar?';
      responseText = recontactGreeting;
    } else {
      applyDetectedFields();
      const missing = nextMissingField();
      missingField = missing;

      if (missing === 'confirm') {
        currentStepField = 'confirm';
        responseKind = 'confirmation_question';
        responseText = confirmationText();
      } else {
        const sameField = missing === stepInfo.field;
        const nextRetry = sameField ? stepInfo.retry + 1 : 0;
        // conversation-flow-v2: Escalation on loop (3+ turns without progress) or frustration
        const isStuck = sameField && stepInfo.retry >= 2;
        const isFrustrated = detectFrustration(rawText);
        if (isStuck || isFrustrated) {
          // PRECEDENCIA: escalación/terminal (frustración o loop)
          shouldEscalate = true;
          escalationReason = isFrustrated ? 'frustration_detected' : 'loop_detected';
          shouldCreateLead = false;
          currentStepField = 'escalation';
          responseKind = 'escalation_routing';
          responseText = '';
          conversationStatusCode = 'escalation_required';
        } else {
          currentStepField = nextRetry > 0 ? missing + '_retry_' + Math.min(nextRetry, 2) : missing;
          responseKind = startsNewRequest ? 'welcome_and_question' : nextRetry > 0 ? 'specific_followup' : 'question';
          antiLoopApplied = sameField && nextRetry > 0;
          const question = nextQuestionForMissingField(missing, current, nextRetry, actionIntent);
          responseText = startsNewRequest
            ? 'Hola, gracias por escribir a Hormiglass. Soy el asistente virtual y te ayudaré a orientar tu solicitud para que una ejecutiva pueda cotizarte correctamente.\n\n' + question
            : question;
        }
      }
    }
  }

  if (shouldEscalate) shouldCreateLead = false;
  if (shouldCreateLead) shouldEscalate = false;

  const finalCompletedFields = completedFields();
  const completedCount = finalCompletedFields.length;
  const currentStep = encodeStep(currentStepField, current);
  const hasIntent = Boolean(textHasIntent || actionIntent || (usefulText && normalizedText.length >= 12) || (messageType !== 'text' && row.attachment_type));

  const beforePayload = {
    conversation_id: row.conversation_id || null,
    target_conversation_id: targetConversationId,
    has_active_conversation: row.has_active_conversation || false,
    current_step: row.current_step || null,
    previous_lead_id: row.previous_lead_id || null,
    state_service: row.state_service || stepState.service || null,
    state_city: row.state_city || stepState.city || null,
    state_requirement: row.state_requirement || stepState.requirement || null,
  };

  const afterPayload = {
    service: current.service || null,
    city: current.city || null,
    requirement: current.requirement || null,
    current_step: currentStep,
    current_step_field: currentStepField,
    conversation_status_code: conversationStatusCode,
    should_create_lead: shouldCreateLead,
    is_partial: isPartial,
    reset_conversation_lead: resetConversationLead,
  };

  return {
      json: {
        // La ruta del contrato la decide Resolve Conversation Contract Route, el
        // nodo inmediatamente anterior. Este nodo arma un objeto nuevo, asi que
        // lo que no se nombre aqui se pierde antes de llegar a
        // `Use V3 Contract?`, cuya condicion es contract_version === 'v3'.
        // Sin estos cinco campos esa comparacion recibia undefined en todos los
        // turnos y v3 no podia activarse con ningun valor de
        // AI_PRD_CONTRACT_MODE. apply-ai-assistance ya los declara como campos
        // deterministas: el contrato esperaba que fluyeran, nadie los emitia.
        contract_route: row.contract_route ?? null,
        contract_version: row.contract_version ?? null,
        contract_mode: row.contract_mode ?? null,
        route_mode: row.route_mode ?? null,
        route_rule_id: row.route_rule_id ?? null,
        // The catalog `Load Conversation State` publishes is the grounding
        // authority the v3 policy compiles from. Dropped here it never reaches
        // `Compile V3 Turn Policy`, and every grounded observation fails.
        v3_grounding: row.v3_grounding ?? null,
        phone_number: row.phone_number,
        source_number_id: row.input_source_number_id || row.source_number_id || null,
        instance_name: row.instance_name || null,
        inbound_event_id: row.inbound_event_id || null,
        processing_token: row.processing_token || null,
        whatsapp_name: current.whatsapp_name || null,
        external_contact_id: row.input_external_contact_id || null,
        external_message_id: row.input_external_message_id || null,
        external_timestamp: row.input_external_timestamp || null,
        message_type: messageType,
        text_body: rawText || null,
        raw_payload_json: row.raw_payload_json || '{}',
        attachment_type: row.attachment_type || null,
        mime_type: row.mime_type || null,
        filename: row.filename || null,
        external_media_id: row.external_media_id || null,
        external_url: row.external_url || null,
        sha256: row.sha256 || null,
        file_size: row.file_size_raw || null,
        target_conversation_id: targetConversationId,
        original_conversation_id: targetConversationId,
        has_existing_conversation: hasExistingConversation,
        is_recent_conversation: isRecentConversation,
        is_stale_context: isStaleContext,
        // conversation_id is reset only when persistence must create a new request.
        conversation_id: resetConversationLead
              ? null
              : row.conversation_id || null,
        lead_id: resetConversationLead ? null : row.lead_id || null,
        reset_conversation_lead: resetConversationLead,
        previous_lead_id: usedPreviousContext ? row.previous_lead_id || null : null,
        service: current.service || null,
        city: current.city || null,
        requirement: current.requirement || null,
        qualification_context: resetConversationLead
          ? {}
          : row.qualification_context && typeof row.qualification_context === 'object'
            ? row.qualification_context
            : {},
        pending_question_key: pendingQuestionKey,
        recent_messages: resetConversationLead
          ? []
          : (Array.isArray(row.recent_messages) ? row.recent_messages : []),
        current_step: currentStepField,
            current_step_encoded: currentStep,
            conversation_status_code: conversationStatusCode,
        should_create_lead: shouldCreateLead,
        is_partial: isPartial,
        should_escalate: shouldEscalate,
        escalation_reason: escalationReason,
        response_text: '',
        deterministic_reply: responseText,
        response_kind: responseKind,
        normalized_text: normalizedText || null,
        completed_fields_count: completedCount,
            has_intent: hasIntent,
            used_previous_context: usedPreviousContext,
            current_step_field: currentStepField,
            audit_event_name: 'conversation_state_evaluated',
        audit_result: shouldCreateLead ? 'handed_to_sales' : 'waiting_user',
        before_payload_json: JSON.stringify(beforePayload),
        after_payload_json: JSON.stringify(afterPayload),
        metadata_json: JSON.stringify({
          first_interaction: firstInteraction,
          step_field: stepInfo.field,
          next_step_field: currentStepField,
          retry: stepInfo.retry,
          message_type: messageType,
          response_kind: responseKind,
          has_intent: hasIntent,
          used_previous_context: usedPreviousContext,
      reengagement_triggered: isReengagement && row.conversation_id,
          reset_conversation_lead: resetConversationLead,
          detected_action: actionIntent?.action || null,
          inferred_requirement: inferredRequirement,
          anti_loop_applied: antiLoopApplied,
          missing_field: missingField,
          // Re-engagement structured logging (memoria #679, #686)
          reengagement_stage: isReengagement ? 'detected' : null,
          reengagement_decision: isReengagement ? responseKind : null,
          reengagement_elapsed_hours: elapsedHoursSinceLastInbound,
        }),
      },
  };
    }

const runN8nCode = (inputItems) => inputItems.map((item) => evaluateConversationStep(item.json));

// Export for tests; sync-workflow-nodes appends the explicit n8n return boundary.
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { evaluateConversationStep, runN8nCode };
}
