// Verify CRM Event: the webhook node runs with the Raw Body option, so the
// exact request bytes arrive as the binary property "data" (base64 in memory
// mode, a stored id in filesystem mode). The HMAC is computed over those bytes,
// never over n8n's parsed JSON: a re-serialization would accept a body the CRM
// never signed. The output carries no binary, no raw body and no secret.
const crmInboundCrypto = require('crypto');
const crmInboundItem = items[0] ?? { json: {} };
const crmInboundBinary = crmInboundItem.binary?.data;

let crmInboundRaw = null;
if (crmInboundBinary && typeof crmInboundBinary.data === 'string' && crmInboundBinary.data !== ''
  && !crmInboundBinary.id) {
  crmInboundRaw = Buffer.from(crmInboundBinary.data, 'base64');
} else if (crmInboundBinary && typeof helpers?.getBinaryDataBuffer === 'function') {
  try {
    crmInboundRaw = await helpers.getBinaryDataBuffer(0, 'data');
  } catch (_error) {
    crmInboundRaw = null;
  }
}

const crmInboundResult = verifyCrmInboundRequest({
  rawBody: Buffer.isBuffer(crmInboundRaw) ? crmInboundRaw : null,
  headers: crmInboundItem.json?.headers ?? {},
  env: $env,
  now: Date.now(),
  crypto: crmInboundCrypto,
});
return [{ json: crmInboundResult }];
