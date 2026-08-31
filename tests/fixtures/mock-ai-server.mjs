import http from 'node:http';
import { fileURLToPath } from 'node:url';

const jsonResponse = (response, statusCode, payload) => {
  response.statusCode = statusCode;
  response.setHeader('content-type', 'application/json');
  response.end(JSON.stringify(payload));
};

const readJsonBody = async (request) => {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const rawBody = Buffer.concat(chunks).toString('utf8');
  return { rawBody, value: rawBody ? JSON.parse(rawBody) : {} };
};

const inspectPrompt = (body) => {
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const userMessage = [...messages].reverse().find((message) => message?.role === 'user');
  let prompt = {};
  try {
    prompt = JSON.parse(String(userMessage?.content || '{}'));
  } catch (_error) {
    prompt = {};
  }
  return {
    turn_id: String(prompt.turn_policy?.turn?.id || ''),
    policy_digest: String(prompt.turn_policy?.policy_digest || ''),
    repair: Boolean(prompt.repair_request),
    repair_schema: prompt.repair_request?.schema || null,
  };
};

export const createMockAiServer = () => {
  const requests = [];
  return http.createServer(async (request, response) => {
    try {
      if (request.method === 'GET' && request.url === '/health') {
        jsonResponse(response, 200, { status: 'ok' });
        return;
      }
      if (request.method === 'GET' && request.url === '/requests') {
        jsonResponse(response, 200, { count: requests.length, requests });
        return;
      }
      if (request.method === 'POST' && request.url === '/chat/completions') {
        const { rawBody, value: body } = await readJsonBody(request);
        const requestRecord = {
          index: requests.length + 1,
          method: request.method,
          url: request.url,
          ...inspectPrompt(body),
          body,
          raw_body: rawBody,
        };
        requests.push(requestRecord);
        jsonResponse(response, 200, {
          id: `synthetic-ai-response-${requestRecord.index}`,
          object: 'chat.completion',
          choices: [{
            index: 0,
            finish_reason: 'stop',
            message: { role: 'assistant', content: '{}' },
          }],
        });
        return;
      }
      jsonResponse(response, 404, { error: 'not_found' });
    } catch (error) {
      jsonResponse(response, 400, { error: 'invalid_request', message: error.message });
    }
  });
};

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const port = Number(process.env.PORT || 8081);
  createMockAiServer().listen(port, '0.0.0.0');
}
