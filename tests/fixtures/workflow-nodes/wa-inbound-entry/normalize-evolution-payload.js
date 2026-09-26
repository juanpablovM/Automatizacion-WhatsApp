const item = items[0]?.json ?? {};
const body = item.body ?? item;
const headers = item.headers ?? {};
const query = item.query ?? {};

const headerValue = (name) => {
  const wanted = name.toLowerCase();
  const hit = Object.keys(headers).find((key) => key.toLowerCase() === wanted);
  return hit ? headers[hit] : null;
};

const expectedWebhookSecret = String($env.EVOLUTION_WEBHOOK_SECRET || '').trim();
const receivedWebhookSecret = String(
  headerValue('x-evolution-webhook-secret') ??
    headerValue('x-webhook-secret') ??
    query.token ??
    query.secret ??
    body.webhook_secret ??
    ''
).trim();

if (expectedWebhookSecret && receivedWebhookSecret !== expectedWebhookSecret) {
  return [
    {
      json: {
        should_process: false,
        security_rejected: true,
        event_type: 'webhook_secret_mismatch',
        normalized_event: 'SECURITY_REJECTED',
        raw_payload_json: JSON.stringify(body),
      },
    },
  ];
}

if (body && body.__force_error_handler_test === true) {
  throw new Error('Forced OPS Error Handler smoke test');
}

const normalizeFileSize = (value) => {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value === 'number') return Number.isFinite(value) ? Math.trunc(value) : null;
  if (typeof value === 'bigint') {
    const maxSafe = BigInt(Number.MAX_SAFE_INTEGER);
    return value <= maxSafe ? Number(value) : null;
  }
  if (typeof value === 'string') {
    const cleaned = value.trim();
    if (!/^\d+$/.test(cleaned)) return null;
    const parsed = Number(cleaned);
    return Number.isSafeInteger(parsed) ? parsed : null;
  }
  if (typeof value === 'object') {
    if (typeof value.low === 'number') {
      const low = value.low >>> 0;
      const high = typeof value.high === 'number' ? value.high : 0;
      const computed = high * 4294967296 + low;
      return Number.isSafeInteger(computed) ? computed : null;
    }
    if (typeof value.value === 'string' || typeof value.value === 'number') {
      return normalizeFileSize(value.value);
    }
  }
  return null;
};

const normalizeTextValue = (value) => {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') return String(value);
  if (Array.isArray(value) && value.every((entry) => Number.isInteger(entry) && entry >= 0 && entry <= 255)) {
    return Buffer.from(value).toString('base64');
  }
  if (typeof value === 'object') {
    if (value.type === 'Buffer' && Array.isArray(value.data)) {
      return Buffer.from(value.data).toString('base64');
    }
    if (typeof value.url === 'string') return value.url;
    try {
      return JSON.stringify(value);
    } catch (_error) {
      return null;
    }
  }
  return null;
};

const eventName = String(body.event || body.type || '').trim();
const normalizedEvent = eventName.replace(/[.:-]+/g, '_').toUpperCase();
const instanceName = body.instance || body.instanceName || body.sender || $env.EVOLUTION_DEFAULT_INSTANCE || null;
const data = body.data ?? body.message ?? {};
const key = data.key ?? {};
const primaryRemoteJid = String(key.remoteJid || data.key?.remoteJid || '').trim();
const alternateRemoteJid = String(key.remoteJidAlt || data.key?.remoteJidAlt || '').trim();
const remoteJid = primaryRemoteJid.endsWith('@lid') && alternateRemoteJid ? alternateRemoteJid : primaryRemoteJid;
const isGroup = remoteJid.endsWith('@g.us');
const isFromMe = Boolean(key.fromMe ?? data.fromMe ?? false);

const pickText = (message) => {
  if (!message || typeof message !== 'object') return null;
  if (typeof message.conversation === 'string') return message.conversation;
  if (typeof message.extendedTextMessage?.text === 'string') return message.extendedTextMessage.text;
  if (typeof message.imageMessage?.caption === 'string') return message.imageMessage.caption;
  if (typeof message.videoMessage?.caption === 'string') return message.videoMessage.caption;
  if (typeof message.documentMessage?.caption === 'string') return message.documentMessage.caption;
  if (typeof message.buttonsResponseMessage?.selectedButtonId === 'string') return message.buttonsResponseMessage.selectedButtonId;
  if (typeof message.listResponseMessage?.title === 'string') return message.listResponseMessage.title;
  if (typeof message.templateButtonReplyMessage?.selectedDisplayText === 'string') return message.templateButtonReplyMessage.selectedDisplayText;
  if (typeof message.locationMessage?.name === 'string') return message.locationMessage.name;
  return null;
};

const buildAttachment = (message) => {
  const definitions = [
    ['imageMessage', 'image'],
    ['audioMessage', 'audio'],
    ['documentMessage', 'document'],
    ['videoMessage', 'video'],
    ['stickerMessage', 'sticker'],
  ];

  for (const [field, attachmentType] of definitions) {
    if (message?.[field]) {
      const attachment = message[field];
      return {
        attachment_type: attachmentType,
        mime_type: normalizeTextValue(attachment.mimetype),
        filename: normalizeTextValue(attachment.fileName),
        external_media_id: normalizeTextValue(attachment.mediaKey ?? attachment.directPath),
        external_url: normalizeTextValue(attachment.url),
        sha256: normalizeTextValue(attachment.fileSha256),
        file_size: normalizeFileSize(attachment.fileLength),
      };
    }
  }

  return {
    attachment_type: null,
    mime_type: null,
    filename: null,
    external_media_id: null,
    external_url: null,
    sha256: null,
    file_size: null,
  };
};

if (normalizedEvent !== 'MESSAGES_UPSERT' || !remoteJid || isGroup) {
  return [
    {
      json: {
        should_process: false,
        event_type: eventName || 'ignored_event',
        normalized_event: normalizedEvent,
        raw_payload_json: JSON.stringify(body),
      },
    },
  ];
}

// A counterpart that runs its own bot answers every reply on its own cadence,
// and two bots sharing a thread feed each other until the inbox is theirs. The
// terminal-reply cooldown bounds what we say back, but the events keep arriving
// and keep taking a turn slot from real customers, so a number named here is
// dropped before the durable inbox: no turn, no conversation, nothing to reset
// later. The row is still written as ignored, because a drop nobody can see is
// indistinguishable from an outage. Empty means nobody is blocked.
const digitsOnly = (value) => String(value ?? '').replace(/\D/g, '');
const blockedPhones = new Set(
  String($env.INBOUND_BLOCKED_PHONES || '')
    .split(',')
    .map(digitsOnly)
    .filter(Boolean),
);
const phoneNumber = remoteJid.includes('@') ? remoteJid.split('@')[0] : remoteJid;

if (blockedPhones.has(digitsOnly(phoneNumber))) {
  return [
    {
      json: {
        should_process: false,
        event_type: 'blocked_number',
        normalized_event: normalizedEvent,
        phone_number: phoneNumber || null,
        raw_payload_json: JSON.stringify(body),
      },
    },
  ];
}

const message = data.message ?? {};
const textBody = pickText(message);
const attachment = buildAttachment(message);
const externalTimestamp = data.messageTimestamp || body.date_time || null;

return [
  {
    json: {
      should_process: true,
      event_type: eventName,
      normalized_event: normalizedEvent,
      instance_name: instanceName,
      phone_number: phoneNumber || null,
      source_number_id: null,
      whatsapp_name: data.pushName || data.pushname || data.notifyName || null,
      external_contact_id: primaryRemoteJid || remoteJid || null,
      external_message_id: key.id || data.key?.id || null,
      external_timestamp: externalTimestamp,
      is_from_me: isFromMe,
      sender_type_candidate: isFromMe ? 'own_message' : 'customer',
      message_type: attachment.attachment_type ? attachment.attachment_type : 'text',
      text_body: textBody,
      raw_payload_json: JSON.stringify(body),
      ...attachment,
    },
  },
];
