return items.map((item) => ({ json: {
  ...item.json,
  delivery_key: item.json.delivery_key || item.json.idempotency_key || null,
  provider_external_message_id: item.json.provider_external_message_id
    || item.json.external_message_id
    || null,
  outbound_dispatch_status: item.json.already_sent === true ? 'already_sent' : 'not_dispatched',
} }));
