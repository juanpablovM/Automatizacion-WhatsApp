// Build CRM Event Response: one item with http_status and response_body for
// the single Respond node, from either branch (validation answer, database
// result, or database failure -> 503 so the CRM retries).
const crmInboundJson = items[0]?.json ?? {};
return [{ json: shapeCrmInboundResponse(crmInboundJson) }];
