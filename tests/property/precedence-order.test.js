// =============================================================================
// Property-based tests for escalation routing precedence (memoria #679).
// -----------------------------------------------------------------------------
// Precedence order: opt-out/abandono → humano → escalación/terminal → operacional
// → re-engagement → comercial/IA
//
// These tests verify that the precedence resolution is deterministic and
// follows the specified order regardless of the combination of candidate motives.
// =============================================================================

const fc = require('fast-check');

// Import the module under test (the fixture)
const { PRECEDENCE_ORDER, resolvePrecedence, motiveFromReason, routeEscalation } = require('../fixtures/workflow-nodes/wa-inbound-downstream-dispatcher/ensure-escalation-handoff.js');

describe('Precedence Order Resolution (memoria #679)', () => {
  describe('resolvePrecedence', () => {
    test('returns highest precedence motive from a set', () => {
      // opt-out should win over everything
      expect(resolvePrecedence(['b2b', 'opt_out'])).toBe('opt_out');
      expect(resolvePrecedence(['talk_human', 'opt_out'])).toBe('opt_out');
      expect(resolvePrecedence(['frustration', 'opt_out'])).toBe('opt_out');
      expect(resolvePrecedence(['complaint', 'opt_out'])).toBe('opt_out');
      expect(resolvePrecedence(['loop', 'opt_out'])).toBe('opt_out');
      expect(resolvePrecedence(['reengagement', 'opt_out'])).toBe('opt_out');
    });

    test('humano (talk_human) wins over escalation/terminal and below', () => {
      expect(resolvePrecedence(['frustration', 'talk_human'])).toBe('talk_human');
      expect(resolvePrecedence(['complaint', 'talk_human'])).toBe('talk_human');
      expect(resolvePrecedence(['b2b', 'talk_human'])).toBe('talk_human');
      expect(resolvePrecedence(['loop', 'talk_human'])).toBe('talk_human');
    });

    test('escalation/terminal wins over operacional and below', () => {
      const escalationMotives = ['frustration', 'complaint', 'high_urgency', 'large_project', 'complex_installation', 'discount', 'special_payment_condition'];
      const lowerMotives = ['warranty', 'payment_proof', 'invoice', 'scheduling_change', 'committed_issue', 'stock_confirm', 'photos_eval', 'loop', 'reengagement', 'b2b', 'purchase_order'];

      for (const esc of escalationMotives) {
        for (const lower of lowerMotives) {
          expect(resolvePrecedence([lower, esc])).toBe(esc);
        }
      }
    });

    test('operacional wins over re-engagement and comercial/IA', () => {
      const operacionalMotives = ['warranty', 'payment_proof', 'invoice', 'scheduling_change', 'committed_issue', 'stock_confirm', 'photos_eval'];
      const lowerMotives = ['loop', 'reengagement', 'b2b', 'purchase_order'];

      for (const op of operacionalMotives) {
        for (const lower of lowerMotives) {
          expect(resolvePrecedence([lower, op])).toBe(op);
        }
      }
    });

    test('re-engagement wins over comercial/IA', () => {
      expect(resolvePrecedence(['b2b', 'loop'])).toBe('loop');
      expect(resolvePrecedence(['purchase_order', 'reengagement'])).toBe('reengagement');
      expect(resolvePrecedence(['b2b', 'loop', 'reengagement'])).toBe('loop'); // loop before reengagement
    });

    test('returns first motive when none in precedence list', () => {
      expect(resolvePrecedence(['unknown_motive'])).toBe('unknown_motive');
      expect(resolvePrecedence(['custom_a', 'custom_b'])).toBe('custom_a');
    });

    test('returns null for empty array', () => {
      expect(resolvePrecedence([])).toBeNull();
      expect(resolvePrecedence(null)).toBeNull();
    });
  });

  describe('motiveFromReason', () => {
    test('detects opt-out patterns', () => {
      expect(motiveFromReason('no me escribas más')).toBe('opt_out');
      expect(motiveFromReason('STOP')).toBe('opt_out');
      expect(motiveFromReason('dame de baja')).toBe('opt_out');
      expect(motiveFromReason('no quiero más mensajes')).toBe('opt_out');
    });

    test('detects abandoned patterns', () => {
      expect(motiveFromReason('ya no me interesa')).toBe('abandoned');
      expect(motiveFromReason('estoy con la competencia')).toBe('abandoned');
      expect(motiveFromReason('cerremos el tema')).toBe('abandoned');
    });

    test('detects human request patterns', () => {
      expect(motiveFromReason('quiero hablar con una persona')).toBe('talk_human');
      expect(motiveFromReason('necesito una ejecutiva')).toBe('talk_human');
      expect(motiveFromReason('atención humana por favor')).toBe('talk_human');
    });

    test('detects escalation/terminal patterns', () => {
      expect(motiveFromReason('reclamo por mala atención')).toBe('complaint');
      expect(motiveFromReason('no me escuchas')).toBe('frustration');
      expect(motiveFromReason('proyecto de 2.000.000')).toBe('large_project');
      expect(motiveFromReason('necesito descuento')).toBe('discount');
    });

    test('detects operacional patterns', () => {
      expect(motiveFromReason('garantía del producto')).toBe('warranty');
      expect(motiveFromReason('comprobante de pago')).toBe('payment_proof');
      expect(motiveFromReason('factura por favor')).toBe('invoice');
      expect(motiveFromReason('reagendar despacho')).toBe('scheduling_change');
    });

    test('detects re-engagement patterns', () => {
      expect(motiveFromReason('hola de nuevo')).toBe('reengagement');
      expect(motiveFromReason('volví a escribir')).toBe('reengagement');
      expect(motiveFromReason('retomar la anterior')).toBe('reengagement');
    });

    test('detects B2B patterns', () => {
      expect(motiveFromReason('somos una constructora')).toBe('b2b');
      expect(motiveFromReason('orden de compra lista')).toBe('purchase_order');
      expect(motiveFromReason('empresa con volumen')).toBe('b2b');
    });

    test('returns null for unrecognized text', () => {
      expect(motiveFromReason('hola')).toBeNull();
      expect(motiveFromReason('')).toBeNull();
      expect(motiveFromReason(null)).toBeNull();
    });
  });

  describe('routeEscalation - property-based tests', () => {
    // Property: precedence resolution is deterministic for same input
    test('same input always produces same resolved motive', () => {
      fc.assert(fc.property(
        fc.array(fc.string(), { minLength: 1, maxLength: 5 }),
        (motives) => {
          const result1 = resolvePrecedence([...motives]);
          const result2 = resolvePrecedence([...motives]);
          expect(result1).toBe(result2);
        }
      ), { numRuns: 100 });
    });

    // Property: opt-out always wins when present
    test('opt_out always wins when present in candidates', () => {
      fc.assert(fc.property(
        fc.array(fc.string(), { minLength: 0, maxLength: 10 }).filter(arr => !arr.includes('opt_out')),
        (otherMotives) => {
          const allMotives = [...otherMotives, 'opt_out'];
          // Shuffle to test order independence
          for (let i = allMotives.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [allMotives[i], allMotives[j]] = [allMotives[j], allMotives[i]];
          }
          expect(resolvePrecedence(allMotives)).toBe('opt_out');
        }
      ), { numRuns: 100 });
    });

    // Property: precedence order is total order (transitive)
    test('precedence order is transitive', () => {
      for (let i = 0; i < PRECEDENCE_ORDER.length; i++) {
        for (let j = i + 1; j < PRECEDENCE_ORDER.length; j++) {
          for (let k = j + 1; k < PRECEDENCE_ORDER.length; k++) {
            // If A > B and B > C, then A > C
            expect(resolvePrecedence([PRECEDENCE_ORDER[k], PRECEDENCE_ORDER[i]])).toBe(PRECEDENCE_ORDER[i]);
            expect(resolvePrecedence([PRECEDENCE_ORDER[k], PRECEDENCE_ORDER[j]])).toBe(PRECEDENCE_ORDER[j]);
            expect(resolvePrecedence([PRECEDENCE_ORDER[j], PRECEDENCE_ORDER[i]])).toBe(PRECEDENCE_ORDER[i]);
          }
        }
      }
    });

    // Property: routeEscalation returns consistent structure
    test('routeEscalation returns valid structure for escalated conversations', () => {
      const baseRow = {
        conversation_id: 123,
        phone_number: 'test-contact-precedence-001',
        should_escalate: true,
        escalation_reason: 'reclamo',
        intent: 'complaint',
        escalation_area: 'sales',
      };

      const result = routeEscalation(baseRow);
      expect(result).toHaveProperty('escalated', true);
      expect(result).toHaveProperty('write', true);
      expect(result).toHaveProperty('motivo');
      expect(result).toHaveProperty('routing');
      expect(result).toHaveProperty('idempotency_key');
      expect(result).toHaveProperty('precedence_level');
      expect(result).toHaveProperty('all_candidate_motives');
      expect(Array.isArray(result.all_candidate_motives)).toBe(true);
      expect(typeof result.precedence_level).toBe('number');
      expect(result.precedence_level).toBeGreaterThan(0);
    });

    // Property: idempotency key format is consistent
    test('idempotency_key follows {conversation_id}:{motivo}:{trigger} format', () => {
      const baseRow = {
        conversation_id: 456,
        phone_number: 'test-contact-precedence-002',
        should_escalate: true,
        escalation_reason: 'frustración detectada',
        intent: 'talk_to_human',
      };

      const result = routeEscalation(baseRow);
      const parts = result.idempotency_key.split(':');
      expect(parts).toHaveLength(3);
      expect(Number(parts[0])).toBe(456);
      expect(parts[1]).toBe(result.motivo);
      expect(parts[2]).toBe(result.trigger);
    });
  });

  describe('PRECEDENCE_ORDER constant', () => {
    test('contains all expected motives in correct order', () => {
      expect(PRECEDENCE_ORDER[0]).toBe('opt_out');
      expect(PRECEDENCE_ORDER[1]).toBe('abandoned');
      expect(PRECEDENCE_ORDER[2]).toBe('talk_human');
      // Escalation/terminal group
      expect(PRECEDENCE_ORDER.indexOf('complaint')).toBeLessThan(PRECEDENCE_ORDER.indexOf('warranty'));
      expect(PRECEDENCE_ORDER.indexOf('frustration')).toBeLessThan(PRECEDENCE_ORDER.indexOf('warranty'));
      // Operacional group
      expect(PRECEDENCE_ORDER.indexOf('warranty')).toBeLessThan(PRECEDENCE_ORDER.indexOf('loop'));
      expect(PRECEDENCE_ORDER.indexOf('payment_proof')).toBeLessThan(PRECEDENCE_ORDER.indexOf('loop'));
      // Re-engagement before comercial/IA
      expect(PRECEDENCE_ORDER.indexOf('loop')).toBeLessThan(PRECEDENCE_ORDER.indexOf('b2b'));
      expect(PRECEDENCE_ORDER.indexOf('reengagement')).toBeLessThan(PRECEDENCE_ORDER.indexOf('b2b'));
      // Last should be comercial/IA
      expect(PRECEDENCE_ORDER[PRECEDENCE_ORDER.length - 2]).toBe('b2b');
      expect(PRECEDENCE_ORDER[PRECEDENCE_ORDER.length - 1]).toBe('purchase_order');
    });

    test('all HANDOFF_ROUTING keys have precedence defined', () => {
      const { HANDOFF_ROUTING } = require('../fixtures/workflow-nodes/wa-inbound-downstream-dispatcher/ensure-escalation-handoff.js');
      for (const motive of Object.keys(HANDOFF_ROUTING)) {
        expect(PRECEDENCE_ORDER).toContain(motive);
      }
    });
  });
});
