import fs from 'node:fs';
import { createRequire } from 'node:module';
import { describe, expect, test } from 'vitest';
import { parse } from 'acorn';

const require = createRequire(import.meta.url);
const RUNTIME_PATH = require.resolve('../fixtures/workflow-nodes/shared/v3-contract-runtime.js');

// -----------------------------------------------------------------------------
// design.md D11 (orchestrator follow-up, gap 1) — the behavioral differential
// test (v3-v31-composition-differential.test.js) proves composition holds for
// the rules it enumerates as cases, but it cannot prove a BRAND NEW v3 rule
// (one nobody remembered to add as a case) is covered. This test proves that
// structurally instead: it parses v3-contract-runtime.js into a real AST
// (acorn), statically resolves every `validationError('<code>', ...)` call
// reachable from `validateV3AiProposalV3` — directly in its body, or
// transitively through every helper function it calls, resolved within this
// same file — and does the same for `validateV3AiProposalV31`. It then
// asserts every v3 code is either also reachable from v3.1, or is one of the
// two closed-allowlist D5 carve-outs. Because this walks the CALL GRAPH
// textually, a future v3 rule added as a literal `validationError('new_code',
// ...)` anywhere v3 can reach is automatically covered — no test-case
// enumeration needed, and no manual porting needed as long as v3.1 keeps
// composing (calling) the same rule-checking functions.
// -----------------------------------------------------------------------------

const ALLOWLIST = new Map([
  ['catalog_resolution_conflict', 'D5: v3.1 withholds the ambiguous/unsupported item\'s product mutation into withheld_mutations instead of rejecting the whole proposal.'],
  ['catalog_resolution_action_forbidden', 'D5: the state-mutation branch is replaced by withholding (see withheld_mutations); v3.1 has no quote-level single catalog_resolution to gate the primary_request branch against.'],
]);

const readSource = () => fs.readFileSync(RUNTIME_PATH, 'utf8');

// Maps every top-level `const name = (...) => {...}` / `function name(...) {}`
// binding to its function AST node, so a call to `name` elsewhere in the file
// can be resolved back to a body to walk.
const collectTopLevelFunctions = (ast) => {
  const functions = new Map();
  for (const statement of ast.body) {
    if (statement.type === 'FunctionDeclaration' && statement.id) {
      functions.set(statement.id.name, statement);
      continue;
    }
    if (statement.type !== 'VariableDeclaration') continue;
    for (const declarator of statement.declarations) {
      if (declarator.id?.type !== 'Identifier' || !declarator.init) continue;
      if (['ArrowFunctionExpression', 'FunctionExpression'].includes(declarator.init.type)) {
        functions.set(declarator.id.name, declarator.init);
      }
    }
  }
  return functions;
};

// Generic recursive AST walk with no dependency on acorn-walk: any object
// with a string `.type` is a node: visit its own properties, then recurse.
// Arrays are walked element-by-element. This is intentionally unaware of
// AST shape beyond that, so it never needs updating when the file's syntax
// grows (new expression types, etc.).
const walk = (node, visitor) => {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    for (const item of node) walk(item, visitor);
    return;
  }
  if (typeof node.type === 'string') visitor(node);
  for (const key of Object.keys(node)) {
    if (key === 'type') continue;
    walk(node[key], visitor);
  }
};

// Every `validationError('code', ...)` call reachable from `functionNode`,
// resolving calls to other known top-level functions transitively.
const collectErrorCodes = (functionNode, functions, visited = new Set()) => {
  const codes = new Set();
  const toVisitFunctionNames = new Set();
  walk(functionNode.body, (node) => {
    if (node.type !== 'CallExpression' || node.callee.type !== 'Identifier') return;
    if (node.callee.name === 'validationError') {
      const firstArg = node.arguments[0];
      if (firstArg?.type === 'Literal' && typeof firstArg.value === 'string') {
        codes.add(firstArg.value);
      }
      return;
    }
    if (functions.has(node.callee.name) && !visited.has(node.callee.name)) {
      toVisitFunctionNames.add(node.callee.name);
    }
  });
  for (const name of toVisitFunctionNames) {
    visited.add(name);
    for (const code of collectErrorCodes(functions.get(name), functions, visited)) codes.add(code);
  }
  return codes;
};

const codeSetsFor = (source) => {
  const ast = parse(source, { ecmaVersion: 2022, sourceType: 'script' });
  const functions = collectTopLevelFunctions(ast);
  const v3Node = functions.get('validateV3AiProposalV3');
  const v31Node = functions.get('validateV3AiProposalV31');
  if (!v3Node || !v31Node) {
    throw new Error('validateV3AiProposalV3/V31 not found as top-level bindings — static extraction assumptions broke');
  }
  return {
    v3Codes: collectErrorCodes(v3Node, functions),
    v31Codes: collectErrorCodes(v31Node, functions),
  };
};

describe('static error-code coverage: every v3 code is reachable from v3.1 or allowlisted (design.md D11)', () => {
  test('V3 codes are a subset of V31 codes plus the closed D5 carve-out allowlist', () => {
    const { v3Codes, v31Codes } = codeSetsFor(readSource());
    expect(v3Codes.size).toBeGreaterThan(10);
    const missing = [...v3Codes].filter((code) => !v31Codes.has(code) && !ALLOWLIST.has(code));
    expect(missing).toEqual([]);
  });

  test('every allowlist entry actually differs (a stale entry would hide a real regression)', () => {
    const { v3Codes, v31Codes } = codeSetsFor(readSource());
    for (const code of ALLOWLIST.keys()) {
      expect(v3Codes.has(code)).toBe(true);
      expect(v31Codes.has(code)).toBe(false);
    }
  });

  test('every allowlist entry carries a non-empty one-line reason', () => {
    for (const reason of ALLOWLIST.values()) {
      expect(typeof reason).toBe('string');
      expect(reason.length).toBeGreaterThan(10);
      expect(reason).not.toContain('\n');
    }
  });

  // Proves the coverage assertion is not vacuous: a v3 rule with a code v3.1
  // never emits and never allowlists must fail this test.
  test('a brand-new v3-only code (not allowlisted) fails the coverage assertion', () => {
    const source = readSource();
    const injected = source.replace(
      "const validateV3AiProposalV3 = (policy, proposal) => {\n  const errors = [];",
      "const validateV3AiProposalV3 = (policy, proposal) => {\n  const errors = [];\n  errors.push(validationError('dummy_new_v3_rule', 'x'));",
    );
    expect(injected).not.toBe(source);
    const { v3Codes, v31Codes } = codeSetsFor(injected);
    expect(v3Codes.has('dummy_new_v3_rule')).toBe(true);
    const missing = [...v3Codes].filter((code) => !v31Codes.has(code) && !ALLOWLIST.has(code));
    expect(missing).toContain('dummy_new_v3_rule');
  });
});
