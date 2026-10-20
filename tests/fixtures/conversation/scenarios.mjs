// =============================================================================
// Executable conversation catalogue.
// -----------------------------------------------------------------------------
// Every entry is replayed through the real engine by
// tests/contract/conversation-scenarios.test.js. Adding a scenario is adding a
// row here, not writing a test.
//
// A turn declares what the customer sent (`inbound`), optionally what the model
// proposed (`ai`), and what must hold afterwards (`expect`). Field names in
// `expect` address the applied output; prefix with `deterministic.` to address
// the step before the proposal was applied, or `qualification_context.` to
// address one key of the captured context.
// =============================================================================

export const scenarios = [
  {
    id: 'CTRL-01',
    title: 'a control phrase answering the previous-context offer never becomes a data field',
    // The customer already has a lead but no live conversation, so the engine
    // opens a fresh one. Its first question is the city, and the customer's
    // reply is a menu choice, not an answer.
    given: {
      lead: { service: 'Baldosas', city: 'Santiago', requirement: 'Patio' },
    },
    turns: [
      {
        at: '2026-09-21T10:00:00-03:00',
        inbound: { text: 'Iniciar una nueva' },
        ai: {
          ai_skipped: false,
          intent: 'new_request',
          confidence: 0.95,
          service: 'Baldosas',
          city: 'Santiago',
          requirement: 'Patio',
          explicitly_mentioned_fields: [],
          field_updates: {
            measurements: '40 m2',
            modality: 'installation',
            company: 'Empresa antigua',
          },
          customer_type: 'b2b',
          lead_class: 'D',
          reply_text: 'Perfecto, iniciemos una nueva solicitud. ¿En qué ciudad necesitas cotizar?',
        },
        expect: {
          reset_conversation_lead: true,
          service: null,
          city: null,
          requirement: null,
          'qualification_context.commune': undefined,
        },
      },
    ],
  },
];
