import fs from 'node:fs';
import { describe, expect, test } from 'vitest';

// Slice 2b (design.md D7, D11 Supersession note), dark: v3.1 stays unreachable
// until compile-v3-turn.js's switch (Slice 2b) is set to canary/enabled, which
// nothing in production does yet. This file only proves the schema Build AI
// Request emits for a v3.1 turn_policy pins policy_digest and item_ref the same
// way the v3 schema already pins policy_digest — never letting the model
// hallucinate a digest or an item identity outside a known, bounded set.
const fixturePath = 'tests/fixtures/workflow-nodes/ai-lead-qualification-assistant/build-ai-request.js';

const runCodeNode = (source, items, env = {}) => new Function('items', '$env', source)(items, env);

const baseEnv = { AI_DIRECT_API_KEY: 'fake-key-123', AI_DIRECT_API_MODEL: 'test-model' };

const v31Policy = (overrides = {}) => ({
  version: 'ai_prd_turn_policy/v3.1',
  policy_digest: 'c'.repeat(64),
  facts: [],
  goals: [{ goal_id: 'line_items' }],
  state_authority: { allowed_mutations: [] },
  effect_authority: { permissions: [] },
  grounding: {},
  ...overrides,
});

const responseSchemaFor = (turnPolicy, env = baseEnv) => {
  const source = fs.readFileSync(fixturePath, 'utf8');
  return runCodeNode(source, [{ json: { contract_version: 'v3', turn_policy: turnPolicy } }], env)[0].json.response_schema;
};


// Task 3c.18: live 2026-09-28 the 3c.17 repair ("ask which items the
// distributive value applies to, with primary_request {goal_id:"quantity",
// item_ref}") came back with goal_id "name": every repair turn replaced the
// v3.1 goal enum with the quote-level list, which never contains an item
// field, so "quantity" was unrepresentable. A repair with no
// primary_request.goal_id lock keeps the first-pass v3.1 enum; a real lock
// stays exactly the lock.
const repairSchemaFor = (turnPolicy, repairErrors) => {
  const source = fs.readFileSync(fixturePath, 'utf8');
  return runCodeNode(source, [{ json: {
    contract_version: 'v3', turn_policy: turnPolicy, ai_repair_request: { errors: repairErrors },
  } }], baseEnv)[0].json.response_schema;
};

describe('Build AI Request — v3.1 primary_request goal enum in a repair turn', () => {
  const policy = () => v31Policy({ goals: [{ goal_id: 'name' }, { goal_id: 'commune' }, { goal_id: 'line_items' }] });

  test('a repair without a goal lock (distributive_assignment_unconfirmed) still offers the item goals', () => {
    const schema = repairSchemaFor(policy(), [{
      code: 'distributive_assignment_unconfirmed', path: 'primary_request', related_ids: ['li_a', 'li_b'], allowed_values: ['li_a', 'li_b'],
    }]);

    expect(schema.properties.primary_request.properties.goal_id.enum)
      .toEqual(['name', 'commune', 'line_items', 'final_confirmation', 'product', 'quantity', 'measurements']);
  });

  test('a repair that locks primary_request.goal_id keeps exactly the locked goals', () => {
    const schema = repairSchemaFor(policy(), [{
      code: 'final_confirmation_not_ready', path: 'primary_request.goal_id', related_ids: ['commune'], allowed_values: ['commune'],
    }]);

    expect(schema.properties.primary_request.properties.goal_id.enum).toEqual(['commune']);
  });
});

describe('Build AI Request — v3.1 line-items schema pins', () => {
  test('pins policy_digest to this turn, the same way the v3 schema does', () => {
    const digest = 'd'.repeat(64);
    const schema = responseSchemaFor(v31Policy({ policy_digest: digest }));

    expect(schema.properties.version).toEqual({ type: 'string', enum: ['ai_conversation_proposal/v3.1'] });
    expect(schema.properties.policy_digest).toEqual({ type: 'string', enum: [digest] });
  });

  test('pins item_ref to new-item handles new:1..new:10 when the turn has no existing items', () => {
    const schema = responseSchemaFor(v31Policy());

    const itemRefSchema = schema.properties.primary_request.properties.item_ref;
    expect(itemRefSchema.enum).toEqual([
      'new:1', 'new:2', 'new:3', 'new:4', 'new:5', 'new:6', 'new:7', 'new:8', 'new:9', 'new:10', null,
    ]);
  });

  // Triangulation: a different existing-item count must produce a different,
  // shorter list of new-item slots plus the real existing item ids — proving
  // the enum is computed from policy facts, not hardcoded.
  test('pins item_ref to existing item ids plus only the remaining new-item slots', () => {
    const schema = responseSchemaFor(v31Policy({
      facts: [
        { fact_id: 'fact:item:li_a:product', field: 'product', value: 'Bloques de Hormigón' },
        { fact_id: 'fact:item:li_a:quantity', field: 'quantity', value: '10 m2' },
      ],
    }));

    const itemRefSchema = schema.properties.primary_request.properties.item_ref;
    expect(itemRefSchema.enum).toEqual([
      'li_a', 'new:1', 'new:2', 'new:3', 'new:4', 'new:5', 'new:6', 'new:7', 'new:8', 'new:9', null,
    ]);
  });

  test('requires the v3.1 top-level shape with catalog_resolutions (plural), not the v3 singular field', () => {
    const schema = responseSchemaFor(v31Policy());

    expect(schema.required).toEqual([
      'version', 'policy_digest', 'reply_text', 'primary_request',
      'catalog_resolutions', 'observations', 'state_mutations', 'effect_requests',
    ]);
    expect(schema.properties.catalog_resolutions.type).toBe('array');
    expect(schema.properties.catalog_resolution).toBeUndefined();
  });

  test('catalog_resolutions entries require a non-null item_ref and only the three item statuses', () => {
    const schema = responseSchemaFor(v31Policy());

    const statuses = schema.properties.catalog_resolutions.items.anyOf.map((variant) => variant.properties.status.enum[0]);
    expect(statuses).toEqual(['matched', 'unsupported', 'ambiguous']);
    for (const variant of schema.properties.catalog_resolutions.items.anyOf) {
      expect(variant.required).toContain('item_ref');
      expect(variant.properties.item_ref.type).toBe('string');
      expect(variant.properties.item_ref.enum).toEqual(expect.arrayContaining(['new:1']));
    }
  });

  test('observations and state_mutations variants require item_ref alongside the v3 keys', () => {
    const schema = responseSchemaFor(v31Policy({
      grounding: { catalog: [{ ref: 'product:bloques', concept: 'product', value: 'Bloques de Hormigón' }] },
    }));

    for (const variant of schema.properties.observations.items.anyOf) {
      expect(variant.required).toContain('item_ref');
      expect(variant.properties.item_ref).toEqual({
        type: ['string', 'null'],
        enum: ['new:1', 'new:2', 'new:3', 'new:4', 'new:5', 'new:6', 'new:7', 'new:8', 'new:9', 'new:10', null],
      });
    }

    const mutationsSchema = responseSchemaFor(v31Policy({
      state_authority: { allowed_mutations: [{ operation: 'set', concept: 'quantity', field: 'quantity' }] },
    })).properties.state_mutations;
    expect(mutationsSchema.items.anyOf[0].required).toContain('item_ref');
  });

  test('still builds a real request payload for the provider, not just a schema', () => {
    const output = runCodeNode(
      fs.readFileSync(fixturePath, 'utf8'),
      [{ json: { contract_version: 'v3', turn_policy: v31Policy() } }],
      baseEnv,
    );

    expect(output[0].json.ai_skipped).toBe(false);
    expect(output[0].json.ai_request.response_format.json_schema.schema.properties.version.enum)
      .toEqual(['ai_conversation_proposal/v3.1']);
  });
});
