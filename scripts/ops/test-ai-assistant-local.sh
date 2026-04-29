#!/bin/sh
set -eu

ROOT_DIR=$(CDPATH= cd -- "$(dirname "$0")/../.." && pwd)
cd "$ROOT_DIR"

node <<'NODE'
(async () => {
  const fs = require('fs');
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  const workflow = JSON.parse(fs.readFileSync('n8n/workflows/ai-lead-qualification-assistant.json', 'utf8'));

  const nodeCode = (name) => {
    const node = workflow.nodes.find((entry) => entry.name === name);
    if (!node) throw new Error(`No existe nodo ${name}`);
    return node.parameters.jsCode;
  };

  const runCode = async (name, item, helpers = {}, env = {}) => {
    const fn = new AsyncFunction('items', 'helpers', '$env', nodeCode(name));
    const result = await fn([{ json: item }], helpers, env);
    return result[0].json;
  };

  const input = JSON.parse(fs.readFileSync('n8n/samples/ai_lead_qualification.sample.json', 'utf8'));
  const env = {
    AI_LEAD_ASSISTANT_ENABLED: 'true',
    AI_PROVIDER: 'nvidia',
    AI_BASE_URL: 'https://integrate.api.nvidia.com/v1',
    AI_API_MODE: 'chat_completions',
    AI_API_KEY: 'test-key',
    AI_MODEL: 'minimaxai/minimax-m2.5',
    EXTERNAL_HTTP_MAX_ATTEMPTS: '2',
    EXTERNAL_HTTP_RETRY_BASE_MS: '1',
    EXTERNAL_HTTP_RETRY_MAX_MS: '1',
  };

  const request = await runCode('Build AI Request', input, {}, env);
  if (!request.ai_request?.response_format?.json_schema?.schema) throw new Error('No se construyo JSON Schema');
  if (request.ai_request.response_format.json_schema.strict !== true) throw new Error('Structured Outputs no esta en strict=true');
  if (request.ai_request_path !== '/chat/completions') throw new Error('Endpoint chat_completions inesperado');

  let calls = 0;
  const helpers = {
    httpRequest: async () => {
      calls += 1;
      return {
        statusCode: 200,
        body: {
          choices: [
            {
              message: {
                content: JSON.stringify({
                  intent: 'quote_request',
                  lead_quality: 'high',
                  service: 'Baldosas',
                  city: 'Santiago',
                  requirement: 'Renovar un baño',
                  missing_fields: ['confirmation'],
                  should_create_lead: false,
                  needs_confirmation: true,
                  confidence: 0.92,
                  reply_text: 'Tengo estos datos. ¿Está correcto?',
                  clickup_summary: 'Cliente solicita baldosas en Santiago para renovar un baño.',
                }),
              },
            },
          ],
        },
        headers: {},
      };
    },
  };

  const called = await runCode('Call AI Provider', request, helpers, env);
  if (calls !== 1 || called.ai_status_code !== 200) throw new Error('Call AI Provider no devolvio respuesta mock valida');

  const normalized = await runCode('Normalize AI Result', called, {}, env);
  if (normalized.intent !== 'quote_request') throw new Error('Intent inesperado');
  if (normalized.service !== 'Baldosas') throw new Error('Servicio no normalizado');
  if (normalized.should_create_lead !== false) throw new Error('Guardrail de confirmacion fallo');

  const responsesRequest = await runCode('Build AI Request', input, {}, { ...env, AI_API_MODE: 'responses' });
  if (!responsesRequest.ai_request?.text?.format?.schema) throw new Error('No se construyo JSON Schema para responses');
  if (responsesRequest.ai_request_path !== '/responses') throw new Error('Endpoint responses inesperado');

  const skippedRequest = await runCode('Build AI Request', input, {}, { AI_LEAD_ASSISTANT_ENABLED: 'false', AI_MODEL: 'minimaxai/minimax-m2.5' });
  const skippedCall = await runCode('Call AI Provider', skippedRequest, {}, {});
  const skipped = await runCode('Normalize AI Result', skippedCall, {}, {});
  if (!skipped.ai_skipped || skipped.ai_skip_reason !== 'disabled') throw new Error('Modo disabled no funciona');

  console.log('AI assistant local contract OK');
})();
NODE
