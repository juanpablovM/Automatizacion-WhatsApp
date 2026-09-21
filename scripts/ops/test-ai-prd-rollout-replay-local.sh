#!/bin/sh
set -eu

ROOT_DIR=$(CDPATH= cd -- "$(dirname "$0")/../.." && pwd)
cd "$ROOT_DIR"

node <<'NODE'
// El carril shadow en vivo se removio: el rollout v3 termino y v3 es el default
// aplicado. Lo que sigue verificandose aca es la resolucion de ruta de las rutas
// vivas (legacy/canary/enforce) y, sobre todo, que un rollback no mueva un turno
// canary ya activo. Esa ultima propiedad no la cubre ningun test unitario.
// planShadowEvaluation/recordShadowEvaluation sobreviven como nucleo de puntaje
// para una futura suite de evaluacion conversacional; se siguen ejercitando aca.
const {
  resolveConversationContractRoute,
  planShadowEvaluation,
  recordShadowEvaluation,
} = require('./tests/fixtures/workflow-nodes/shared/v3-rollout-runtime.js');

const fail = (message) => { throw new Error(message); };
const expected = [
  ['legacy', 'legacy'],
  ['shadow', 'legacy'],
  ['canary', 'v3'],
  ['enforce', 'v3'],
  ['legacy', 'legacy'],
];
const replay = expected.map(([mode, version], index) => {
  const route = resolveConversationContractRoute(
    { turn_id: `rollout-turn-${index + 1}` },
    { mode, rule_id: `rollout-rule-${index + 1}` },
  );
  if (route.mode !== mode || route.contract_version !== version) {
    fail(`Paso ${index + 1}: ruta ${mode}/${version} no fue conservada`);
  }
  return route;
});

const activeCanary = resolveConversationContractRoute({
  turn_id: 'rollout-active-canary',
  active_route: replay[2],
}, { mode: 'legacy', rule_id: 'rollback-new-turns' });
if (activeCanary.mode !== 'canary' || activeCanary.recovery_contract !== 'v3') {
  fail('Rollback cambio un turno canary activo');
}
if (!activeCanary.route_drift_detected || activeCanary.legacy_reinterpretation_allowed) {
  fail('Turno canary activo no cerro la deriva hacia legacy');
}

const shadowPlan = planShadowEvaluation({
  route: replay[1],
  legacy_delivery: { delivered: true, receipt_ref: 'legacy-delivery-1' },
  payload: { state_mutations: [{ field: 'product' }], effect_requests: [{ type: 'create_lead' }] },
});
if (!shadowPlan.dispatch || shadowPlan.wait_for_completion || shadowPlan.visible_latency_ms !== 0) {
  fail('Shadow no fue post-delivery y asincrono');
}
if (shadowPlan.payload.state_mutations.length || shadowPlan.payload.effect_requests.length) {
  fail('Shadow conservo autoridad de mutacion o efectos');
}
const failedShadow = recordShadowEvaluation(shadowPlan, {
  ok: false,
  error: 'provider_timeout',
  duration_ms: 120000,
});
if (failedShadow.visible_delivery_affected || failedShadow.status !== 'failed') {
  fail('Falla shadow afecto la entrega visible');
}

console.log('AI PRD rollout replay OK: 5 rutas + active-v3 rollback + aislamiento/falla del evaluador');
NODE
