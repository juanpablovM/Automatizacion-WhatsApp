// Load CRM Events Config: the gate for the whole dispatcher. Disabled (the
// default) emits nothing, so neither stage runs. Enabled but misconfigured
// fails the execution, naming the variables and never the secret, so the
// problem shows up in the n8n execution list instead of passing silently.
const crmEventsConfig = readCrmEventsConfig($env);
if (!crmEventsConfig.enabled) return [];
if (crmEventsConfig.errors.length > 0) {
  throw new Error(`CRM events misconfigured: ${crmEventsConfig.errors.join(', ')}`);
}
return [{ json: {
  since: crmEventsConfig.since,
  protocol_revision: crmEventsConfig.protocol_revision,
  enqueue_batch_size: crmEventsConfig.enqueue_batch_size,
  deliver_batch_size: crmEventsConfig.deliver_batch_size,
  stale_seconds: crmEventsConfig.stale_seconds,
} }];
