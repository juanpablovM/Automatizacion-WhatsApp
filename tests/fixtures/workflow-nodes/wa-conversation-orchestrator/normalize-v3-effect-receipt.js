const pick = (...values) => values.find((value) => value !== undefined && value !== null && value !== '');

const normalizeV3EffectReceipt = (row) => {
  const effectType = pick(row.operation_type, row.operation_type_1, row.v3_effect_command?.type);
  const operationKey = pick(row.operation_key, row.operation_key_1, row.v3_effect_command?.operation_key);
  const payloadDigest = pick(row.payload_digest, row.payload_digest_1, row.v3_effect_command?.payload_digest);
  const claimToken = pick(row.claim_token, row.claim_token_1);
  const error = pick(row.error, row.error_message, row.execution_error);

  if (error) {
    return {
      ...row,
      operation_key: operationKey,
      v3_effect_payload_digest: payloadDigest,
      v3_effect_claim_token: claimToken,
      v3_effect_outcome: 'failed',
      v3_effect_receipt: {
        version: 'v3_effect_receipt/v1', operation_key: operationKey,
        payload_digest: payloadDigest, effect_type: effectType,
        status: 'failed', error: String(error),
      },
      v3_effect_external_id: null,
      v3_effect_error: String(error),
    };
  }

  const provided = row.v3_effect_receipt && typeof row.v3_effect_receipt === 'object'
    ? row.v3_effect_receipt
    : {};
  const leadId = pick(row.lead_id_1, row.lead_id, provided.lead_id);
  const handoffId = pick(row.handoff_id, row.handoff_id_1, provided.handoff_id);
  if (effectType === 'create_lead' && !leadId) throw new Error('create_lead_receipt_missing_lead_id');
  if (effectType === 'handoff' && !handoffId) throw new Error('handoff_receipt_missing_handoff_id');
  if (!['create_lead', 'handoff'].includes(effectType)) throw new Error('unsupported_v3_effect_type');

  const receipt = {
    version: 'v3_effect_receipt/v1',
    operation_key: operationKey,
    payload_digest: payloadDigest,
    effect_type: effectType,
    status: 'succeeded',
    ...(effectType === 'create_lead' ? { lead_id: leadId } : {}),
    ...(effectType === 'handoff' ? { handoff_id: handoffId } : {}),
  };
  return {
    ...row,
    operation_key: operationKey,
    v3_effect_payload_digest: payloadDigest,
    v3_effect_claim_token: claimToken,
    v3_effect_outcome: 'succeeded',
    v3_effect_receipt: receipt,
    v3_effect_external_id: String(leadId ?? handoffId),
    v3_effect_error: null,
  };
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { normalizeV3EffectReceipt };
}

if (typeof items !== 'undefined') {
  return items.map((item) => ({ json: normalizeV3EffectReceipt(item.json ?? {}) }));
}
