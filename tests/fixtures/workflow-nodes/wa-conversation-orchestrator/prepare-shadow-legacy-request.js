const asObject = (value) => value && typeof value === 'object' && !Array.isArray(value) ? value : {};

const prepareShadowLegacyRequest = (row = {}) => {
  const semanticPolicy = asObject(row.turn_policy);
  return {
    ...row,
    shadow_turn_policy: semanticPolicy,
    turn_policy: {
      ...semanticPolicy,
      mode: 'legacy',
    },
  };
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { prepareShadowLegacyRequest };
}

if (typeof items !== 'undefined') {
  return items.map((item) => ({ json: prepareShadowLegacyRequest(item?.json ?? {}) }));
}
