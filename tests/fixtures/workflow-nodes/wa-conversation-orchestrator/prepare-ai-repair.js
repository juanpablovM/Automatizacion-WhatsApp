const asObject = (value) => value && typeof value === 'object' && !Array.isArray(value) ? value : {};
const asArray = (value) => Array.isArray(value) ? value : [];

const prepareAiRepair = (row = {}) => {
  const {
    ai_proposal: _initialProposal,
    ai_validation: initialValidation,
    ai_fallback_reason: _initialFallback,
    ai_parse_error: _initialParseError,
    ai_request_error: _initialRequestError,
    ...base
  } = row;
  return {
    ...base,
    repair_context: {
      attempt: 1,
      original_contract_digest: row.turn_policy_digest,
      rule_errors: asArray(asObject(initialValidation).rule_errors),
    },
    ai_attempt: 'repair',
  };
};

if (typeof module !== 'undefined' && module.exports) module.exports = { prepareAiRepair };

if (typeof items !== 'undefined') {
  return items.map((item) => ({ json: prepareAiRepair(item?.json ?? {}) }));
}
