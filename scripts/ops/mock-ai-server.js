const http = require('http');

const port = Number(process.env.MOCK_AI_PORT || 9999);
const host = process.env.MOCK_AI_HOST || '0.0.0.0';
const mode = process.env.MOCK_AI_MODE || 'valid';

process.on('uncaughtException', (error) => {
  console.error('uncaughtException:', error && error.stack ? error.stack : error);
  process.exit(1);
});

process.on('unhandledRejection', (error) => {
  console.error('unhandledRejection:', error && error.stack ? error.stack : error);
  process.exit(1);
});

const buildPayload = (overrides = {}) => ({
  intent: 'quote_request',
  lead_quality: 'high',
  customer_type: 'b2c',
  lead_class: 'A',
  modality: 'installation',
  service: 'Baldosas',
  city: 'Santiago',
  requirement: 'Instalacion de baldosas para patio',
  sales_stage: 'qualification',
  buying_intent: 'high',
  urgency: 'high',
  confidence: 0.92,
  should_create_lead: false,
  needs_confirmation: true,
  confirmation_status: 'requested',
  missing_fields: ['confirmation'],
  commercial_missing_fields: ['measurements', 'photos', 'terrain', 'debris_removal'],
  diagnostic_datos: {
    pain: 'Resolver patio con una terminacion durable',
    scope: 'Baldosas con posible instalacion en Santiago',
    timing: 'Urgente',
    obstacle: 'Faltan medidas, fotos y terreno',
    next_step: 'Pedir confirmacion y datos para derivar a ventas',
  },
  reply_text:
    'Te puedo orientar. Para cotizar bien la instalacion necesito medidas aproximadas, fotos del lugar y confirmar si requiere retiro de escombros. ¿Te parece si dejamos esos datos para que una ejecutiva lo revise?',
  catalog_matches: [{ sku: 'baldosa', name: 'Baldosas', reason: 'Producto mencionado por el cliente' }],
  price_context: { type: 'none', requires_validation: true, explanation: 'La instalacion requiere medidas y validacion humana.' },
  objection_detected: 'none',
  escalation_area: 'sales',
  next_best_action: 'handoff_sales',
  handoff_reason: 'Instalacion urgente requiere revision comercial humana.',
  executive_summary:
    'Cliente B2C consulta por instalacion de baldosas en Santiago; faltan medidas, fotos, terreno y retiro de escombros.',
  clickup_summary: '',
  explicitly_mentioned_fields: ['service', 'city', 'requirement'],
  ...overrides,
});

const validResponse = JSON.stringify({ output_text: JSON.stringify(buildPayload()) });
const lowConfidenceResponse = JSON.stringify({
  output_text: JSON.stringify(
    buildPayload({
      lead_quality: 'low',
      customer_type: 'unknown',
      lead_class: 'C',
      modality: 'unknown',
      sales_stage: 'exploration',
      buying_intent: 'low',
      urgency: 'low',
      confidence: 0.52,
      confirmation_status: 'none',
      commercial_missing_fields: ['measurements', 'modality'],
      diagnostic_datos: { pain: '', scope: '', timing: '', obstacle: '', next_step: 'Pedir datos' },
      reply_text: '',
      catalog_matches: [],
      objection_detected: 'none',
      escalation_area: 'none',
      next_best_action: 'ask_data',
      handoff_reason: '',
      executive_summary: '',
      explicitly_mentioned_fields: [],
    })
  ),
});
const invalidJsonResponse = JSON.stringify({ output_text: 'esto no es json' });
const timeoutDelay = 15000;

const server = http.createServer((req, res) => {
  console.log(`${new Date().toISOString()} ${req.method} ${req.url}`);

  if (req.method !== 'POST' || req.url !== '/chat/completions') {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not Found');
    return;
  }

  if (mode === 'timeout') {
    setTimeout(() => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ output_text: 'timeout_elapsed' }));
    }, timeoutDelay);
    return;
  }

  req.on('error', (error) => {
    console.error('request error:', error && error.stack ? error.stack : error);
  });
  res.on('error', (error) => {
    console.error('response error:', error && error.stack ? error.stack : error);
  });

  req.on('data', () => {});
  req.on('end', () => {
    const responseBody = mode === 'invalid_json'
      ? invalidJsonResponse
      : mode === 'low_confidence'
        ? lowConfidenceResponse
        : validResponse;

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(responseBody);
  });
});

server.listen(port, host, () => {
  console.log(`mock-ai-server escuchando en http://${host}:${port}/chat/completions (modo: ${mode})`);
});
