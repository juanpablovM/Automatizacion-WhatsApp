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

const promptOf = (body) => {
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const userMessage = [...messages].reverse().find((message) => message?.role === 'user');
  try {
    return JSON.parse(String(userMessage?.content || '{}'));
  } catch (_error) {
    return {};
  }
};

const inspectPrompt = (body) => {
  const prompt = promptOf(body);
  return {
    turn_id: String(prompt.turn_policy?.turn?.id || ''),
    policy_digest: String(prompt.turn_policy?.policy_digest || ''),
    repair: Boolean(prompt.repair_request),
    repair_schema: prompt.repair_request?.schema || null,
  };
};

// A v3 proposal is accepted only if every key is exactly right, every quote is
// literally present in the turn message, every grounded value matches an entry
// the policy carries, and every mutation and effect is one the policy already
// authorizes. The plan says what the customer was understood to have said; the
// policy decides what may be claimed about it, and this assembles the two.
export const buildValidProposal = (policy, plan) => {
  const messageText = String(policy?.turn?.message?.text || '');
  const allowedMutations = policy?.state_authority?.allowed_mutations || [];
  const permitted = new Set((policy?.effect_authority?.permissions || []).map(({ type }) => type));

  const observations = (plan?.observations || [])
    // A quote the message does not contain is unevidenced, and proposing it
    // would invalidate the whole turn rather than just that observation.
    .filter(({ quote }) => messageText.includes(quote))
    .map((observation) => ({
      id: observation.id,
      concept: observation.concept,
      raw_value: observation.quote,
      normalized_value: observation.normalized_value,
      evidence_quote: observation.quote,
      // Offsets are derived here, never taken from the plan: the contract
      // resolves the quote against the message itself.
      evidence_occurrence: 1,
      grounding_ref: observation.grounding_ref ?? null,
      resolves_goal_ids: observation.resolves_goal_ids || [],
    }));

  const state_mutations = observations.flatMap((observation) => {
    const authorized = allowedMutations.find((entry) => entry.concept === observation.concept);
    if (!authorized) return [];
    return [{
      operation: authorized.operation,
      field: authorized.field,
      observation_id: observation.id,
      replaces_fact_id: authorized.operation === 'replace' ? authorized.current_fact_id : null,
    }];
  });

  const effect_requests = (plan?.effects || [])
    .filter((type) => permitted.has(type))
    .map((type) => ({ type, reason_observation_ids: observations.map(({ id }) => id) }));

  return {
    version: 'ai_conversation_proposal/v3',
    policy_digest: policy?.policy_digest ?? null,
    reply_text: plan?.reply_text || '',
    primary_request: null,
    observations,
    state_mutations,
    effect_requests,
  };
};

export const createMockAiServer = () => {
  const requests = [];
  // No plan means the historical behaviour: an empty object, which the v3
  // contract rejects. The contingency canary depends on that, so a plan is
  // installed per run by the scenario that wants a valid turn.
  let plan = null;
  return http.createServer(async (request, response) => {
    try {
      if (request.method === 'GET' && request.url === '/health') {
        jsonResponse(response, 200, { status: 'ok' });
        return;
      }
      if (request.method === 'POST' && request.url === '/plan') {
        const { value } = await readJsonBody(request);
        plan = value;
        jsonResponse(response, 200, { status: 'planned' });
        return;
      }
      if (request.method === 'DELETE' && request.url === '/plan') {
        plan = null;
        jsonResponse(response, 200, { status: 'cleared' });
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
        const policy = promptOf(body).turn_policy;
        const content = plan && policy
          ? JSON.stringify(buildValidProposal(policy, plan))
          : '{}';
        jsonResponse(response, 200, {
          id: `synthetic-ai-response-${requestRecord.index}`,
          object: 'chat.completion',
          choices: [{
            index: 0,
            finish_reason: 'stop',
            message: { role: 'assistant', content },
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
