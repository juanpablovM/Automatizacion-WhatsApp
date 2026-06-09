#!/usr/bin/env node
/**
 * Hormi Atencion — Puente HTTP entre n8n y OpenClaw
 * 
 * Recibe requests de n8n con el mensaje del cliente y el contexto,
 * ejecuta `openclaw agent` como subprocess, y devuelve la respuesta.
 * 
 * Puerto: 9090
 * Endpoint POST /api/evaluate
 */

const http = require('http');
const { execFile } = require('child_process');
const path = require('path');

const PORT = Number(process.env.OPENCLAW_BRIDGE_PORT || 9090);
const OPENCLAW_BIN = process.env.OPENCLAW_BIN || '/home/agentesai/.npm-global/bin/openclaw';
const OPENCLAW_AGENT = process.env.OPENCLAW_AGENT || 'hormi-atencion';
const OPENCLAW_TIMEOUT_SECONDS = Number(process.env.OPENCLAW_TIMEOUT_SECONDS || 25);
const AGENT_TIMEOUT = Number(process.env.OPENCLAW_PROCESS_TIMEOUT_MS || 30000);
const BRIDGE_TOKEN = safe(process.env.OPENCLAW_BRIDGE_TOKEN);

function safe(value, fallback = '') {
  return String(value ?? fallback).trim();
}

function unauthorized(res, statusCode, message) {
  res.writeHead(statusCode, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ ok: false, error: message }));
}

function requestToken(req) {
  const headerToken = safe(req.headers['x-openclaw-bridge-token']);
  if (headerToken) return headerToken;

  const auth = safe(req.headers.authorization);
  const match = auth.match(/^Bearer\s+(.+)$/i);
  return match ? safe(match[1]) : '';
}

function isAuthorized(req) {
  if (!BRIDGE_TOKEN) return false;
  return requestToken(req) === BRIDGE_TOKEN;
}

function openClawTarget(data) {
  const sessionId = safe(data.session_id, process.env.OPENCLAW_SESSION_ID);
  if (sessionId) return ['--session-id', sessionId];

  const sessionKey = safe(data.session_key, process.env.OPENCLAW_SESSION_KEY);
  if (sessionKey) return ['--session-key', sessionKey];

  const to = safe(data.to, process.env.OPENCLAW_TO);
  if (to) return ['--to', to];

  const agent = safe(data.agent, OPENCLAW_AGENT);
  return ['--agent', agent];
}

function extractOpenClawText(result) {
  if (!result || typeof result !== 'object') return '';
  if (typeof result.reply === 'string') return result.reply;
  if (typeof result.text === 'string') return result.text;
  if (typeof result.finalAssistantVisibleText === 'string') return result.finalAssistantVisibleText;
  if (typeof result.finalAssistantRawText === 'string') return result.finalAssistantRawText;

  const payloads = Array.isArray(result.payloads) ? result.payloads : [];
  const payloadText = payloads
    .map((payload) => safe(payload?.text))
    .filter(Boolean)
    .join('\n')
    .trim();
  return payloadText;
}

function runOpenClawAgent(data) {
  return new Promise((resolve, reject) => {
    const message = safe(data.message);
    const context = safe(data.context);
    const model = safe(data.model);
    const timeoutSeconds = Number(data.timeout_seconds || OPENCLAW_TIMEOUT_SECONDS);
    const fullPrompt = context
      ? `[CONTEXT]\n${context}\n[/CONTEXT]\n\n[MESSAGE]\n${message}\n[/MESSAGE]`
      : message;

    const args = [
      'agent',
      '--local',
      '--json',
      ...openClawTarget(data),
      '-m', fullPrompt,
      '--timeout', String(timeoutSeconds)
    ];

    if (data.deliver === true) {
      args.push('--deliver');
      if (data.reply_channel) args.push('--reply-channel', safe(data.reply_channel));
      if (data.reply_to) args.push('--reply-to', safe(data.reply_to));
    }

    if (model) {
      args.push('--model', model);
    }

    execFile(OPENCLAW_BIN, args, {
      timeout: AGENT_TIMEOUT,
      env: {
        ...process.env,
        HOME: '/home/agentesai',
        PATH: '/home/agentesai/.npm-global/bin:/usr/local/bin:/usr/bin:/bin'
      }
    }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(`openclaw agent failed: ${error.message}`));
        return;
      }
      try {
        const result = JSON.parse(stdout);
        resolve(result);
      } catch (e) {
        // Si no es JSON, devolver el texto crudo
        resolve({ reply: stdout.trim(), raw: true });
      }
    });
  });
}

const server = http.createServer(async (req, res) => {
  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-OpenClaw-Bridge-Token');

  if (req.method === 'OPTIONS') {
    res.writeHead(200);
    res.end();
    return;
  }

  // Health check
  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      ok: true,
      service: 'hormi-atencion-bridge',
      openclaw_bin: OPENCLAW_BIN,
      default_agent: OPENCLAW_AGENT,
      timeout_seconds: OPENCLAW_TIMEOUT_SECONDS,
      auth_required: true,
      auth_configured: Boolean(BRIDGE_TOKEN),
      has_session_id: Boolean(process.env.OPENCLAW_SESSION_ID),
      has_session_key: Boolean(process.env.OPENCLAW_SESSION_KEY),
      has_to: Boolean(process.env.OPENCLAW_TO),
    }));
    return;
  }

  // Endpoint principal
  if (req.method === 'POST' && req.url === '/api/evaluate') {
    if (!BRIDGE_TOKEN) {
      unauthorized(res, 503, 'OPENCLAW_BRIDGE_TOKEN is not configured');
      return;
    }
    if (!isAuthorized(req)) {
      unauthorized(res, 401, 'unauthorized');
      return;
    }

    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', async () => {
      try {
        const data = JSON.parse(body);
        const { message } = data;

        if (!safe(message)) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'message is required' }));
          return;
        }

        console.log(`[${new Date().toISOString()}] Evaluating: "${safe(message).substring(0, 80)}..."`);

        const result = await runOpenClawAgent(data);
        const reply = extractOpenClawText(result);

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          ok: true,
          reply: reply || result.reply || result.text || result,
          raw: result
        }));
      } catch (err) {
        console.error(`[${new Date().toISOString()}] Error: ${err.message}`);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
    return;
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'not found' }));
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Hormi Atencion Bridge running on port ${PORT}`);
  console.log(`Health check: http://localhost:${PORT}/health`);
  console.log(`API endpoint: POST http://localhost:${PORT}/api/evaluate`);
});

server.on('error', (err) => {
  console.error('Server error:', err.message);
  process.exit(1);
});
