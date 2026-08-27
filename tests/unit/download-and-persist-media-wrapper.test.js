import fs from 'node:fs';
import { createRequire } from 'node:module';
import { describe, expect, test } from 'vitest';

const fixturePath = 'tests/fixtures/workflow-nodes/ops-media-download-scheduler/download-and-persist-media.js';
const nodeRequire = createRequire(import.meta.url);

// This wrapper is async (it awaits httpRequest through n8n's injected
// `helpers` global) and returns a Promise of the n8n item array, unlike the
// other synchronous Code node wrappers in this repo. n8n's Code node sandbox
// also injects a `require` for allowed built-ins (crypto/fs/path here).
const runAsyncCodeNode = (source, items, env = {}, helpers = {}) =>
  new Function('items', '$env', 'helpers', 'require', source)(items, env, helpers, nodeRequire);

describe('Download and Persist Media — real n8n Code node wrapper', () => {
  test('the wrapper awaits the promise and returns the n8n item contract without ever touching the network when config is missing', async () => {
    const source = fs.readFileSync(fixturePath, 'utf8');
    const httpRequest = () => {
      throw new Error('httpRequest must not be called when Evolution config is missing');
    };

    const output = await runAsyncCodeNode(
      source,
      [{ json: { conversation_id: 1, instance_name: 'default' } }],
      {}, // no EVOLUTION_API_BASE_URL / EVOLUTION_API_KEY configured
      { httpRequest },
    );

    expect(output).toHaveLength(1);
    expect(output[0].json.media_outcome).toBe('deferred');
    expect(output[0].json.media_error).toBe('media_configuration_missing');
  });
});
