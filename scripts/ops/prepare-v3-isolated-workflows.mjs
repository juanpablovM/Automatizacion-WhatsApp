#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const replacements = [
  ['https://api.clickup.com', 'http://mock-clickup:8083'],
  ['https://app.clickup.com', 'http://mock-clickup:8083'],
  ['https://generativelanguage.googleapis.com/v1beta/openai', 'http://mock-ai:8081'],
  ['https://generativelanguage.googleapis.com', 'http://mock-ai:8081'],
  ['https://api.openai.com/v1', 'http://mock-ai:8081'],
];
const allowedOrigins = new Set(['http://mock-clickup:8083', 'http://mock-ai:8081', 'http://mock-evolution:8080']);
const visit = (value) => {
  if (Array.isArray(value)) return value.map(visit);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, visit(item)]));
  if (typeof value !== 'string') return value;
  let rewritten = value;
  for (const [from, to] of replacements) rewritten = rewritten.replaceAll(from, to);
  for (const match of rewritten.matchAll(/https?:\/\/[A-Za-z0-9._:-]+/g)) {
    if (!allowedOrigins.has(match[0])) throw new Error(`isolated v3 import refuses external embedded URL: ${match[0]}`);
  }
  return rewritten;
};

// Production sources remain unchanged. Redirect computed Code-node URLs as
// well as HTTP-node parameters, then reject unknown destinations before import.
export function prepareIsolatedV3Workflow(workflow) {
  return { ...workflow, nodes: workflow.nodes.map((node) => ({ ...node, parameters: visit(node.parameters || {}) })) };
}

export function prepareIsolatedV3Directory(directory) {
  for (const name of fs.readdirSync(directory).filter((file) => file.endsWith('.json'))) {
    const file = path.join(directory, name);
    const workflow = prepareIsolatedV3Workflow(JSON.parse(fs.readFileSync(file, 'utf8')));
    fs.writeFileSync(file, JSON.stringify(workflow, null, 2) + '\n');
  }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  prepareIsolatedV3Directory(process.argv[2]);
  console.log('Isolated v3 embedded provider URL guard OK');
}
