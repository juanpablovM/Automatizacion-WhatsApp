// `Prepare Lead Assignment` refuses to create a lead unless `service`, `city`
// and `requirement` all carry a value. This node fed it from
// `qualification_context`, which a v3 turn never fills: v3 names its facts
// `product`, `commune`, `quantity` and `modality`, and commits them to the
// context only *after* the effect has run. So the first authorized turn to
// reach the real executor died on "faltan servicio, ciudad o requerimiento".
//
// The mapping is the PRD's, not an invention:
//   - PRD §25.1 lists the commercial fields as Producto de interés, Comuna,
//     Cantidad aproximada and Modalidad — exactly the four v3 concepts.
//   - The PRD product-vs-service rule, transcribed in normalize-ai-result.js:
//     "los unicos servicios reales son instalacion, retiro de escombros,
//     suministro (solo material) y despacho". The legacy `service` field holds
//     the modality, which is why a real lead in docs/estado-actual.md reads
//     servicio `instalación`, ciudad `Santiago`, requerimiento
//     `hormigón armado para losa de 100 m2`.
//   - The modality labels come from `resolveCommercialProfile`, the declared
//     source of truth in apply-ai-assistance.js.
import { createRequire } from 'node:module';
import { describe, expect, test } from 'vitest';

// The fixture ends in the top-level `return` n8n needs, so it loads as CommonJS.
const require = createRequire(import.meta.url);
const { buildV3LeadEffect } = require(
  '../fixtures/workflow-nodes/wa-conversation-orchestrator/build-v3-lead-effect.js',
);

const decision = (mutations) => ({
  version: 'validated_conversation_decision/v3',
  state_mutations: mutations,
});

const mutation = (field, projected_value) => ({
  operation: 'set',
  field,
  observation_id: `obs-${field}`,
  replaces_fact_id: null,
  projected_value,
});

const authorizedTurn = (overrides = {}) => ({
  operation_key: 'v3-lead:abc',
  conversation_id: 7,
  phone_number: '15550001111',
  source_number_id: 2,
  qualification_context: {},
  v3_decision: decision([
    mutation('product', 'hormigon H25'),
    mutation('commune', 'Santiago'),
    mutation('quantity', '20 m3'),
    mutation('modality', 'delivery'),
  ]),
  ...overrides,
});

describe('Build V3 Lead Effect — the v3 decision reaches the lead contract', () => {
  test('projects the authorized mutations, which the context does not carry yet', () => {
    const lead = buildV3LeadEffect(authorizedTurn());

    expect(lead.service).toBe('despacho');
    expect(lead.city).toBe('Santiago');
    expect(lead.requirement).toBe('hormigon H25 20 m3');
  });

  test('translates every modality the policy can authorize', () => {
    const serviceFor = (modality) => buildV3LeadEffect(authorizedTurn({
      v3_decision: decision([
        mutation('product', 'baldosa'),
        mutation('commune', 'Maipu'),
        mutation('quantity', '5 m2'),
        mutation('modality', modality),
      ]),
    })).service;

    expect(serviceFor('installation')).toBe('instalacion');
    expect(serviceFor('delivery')).toBe('despacho');
    expect(serviceFor('pickup')).toBe('retiro');
    expect(serviceFor('material')).toBe('material');
  });

  test('falls back to the persisted context for facts this turn did not restate', () => {
    // A later turn may authorize a lead from facts an earlier turn already
    // committed, so it proposes no mutation for them.
    const lead = buildV3LeadEffect(authorizedTurn({
      qualification_context: { service: 'instalacion', city: 'Providencia', requirement: 'poste de cierre' },
      v3_decision: decision([mutation('quantity', '10 unidades')]),
    }));

    expect(lead.service).toBe('instalacion');
    expect(lead.city).toBe('Providencia');
    expect(lead.requirement).toBe('poste de cierre');
  });

  test('leaves the lead incomplete rather than inventing a requirement', () => {
    // `Prepare Lead Assignment` counts these three and blocks below three. A
    // fabricated value would buy a lead the PRD says must not exist.
    const lead = buildV3LeadEffect(authorizedTurn({
      v3_decision: decision([mutation('commune', 'Santiago')]),
    }));

    expect(lead.city).toBe('Santiago');
    expect(lead.service).toBeNull();
    expect(lead.requirement).toBeNull();
  });
});
