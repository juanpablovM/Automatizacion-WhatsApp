import fs from 'node:fs';
import { describe, expect, test } from 'vitest';

const fixturePath = 'tests/fixtures/workflow-nodes/wa-inbound-downstream-dispatcher/ensure-media-attachment.js';

const runCodeNode = (source, items, env = {}) => new Function('items', '$env', source)(items, env);

describe('Ensure Media Attachment — real n8n Code node wrapper', () => {
  test('accepts an in-policy image and marks it pending for download', () => {
    const source = fs.readFileSync(fixturePath, 'utf8');
    const output = runCodeNode(source, [
      {
        json: {
          conversation_id: 10,
          attachment_type: 'image',
          file_size: 1024,
          external_message_id: 'msg-1',
          raw_payload_json: '{}',
        },
      },
    ]);

    expect(output).toHaveLength(1);
    expect(output[0].json.media_write).toBe(true);
    expect(output[0].json.media_scope.download_state).toBe('pending');
  });

  test('rejects an oversized declared file using the env-configured limit', () => {
    const source = fs.readFileSync(fixturePath, 'utf8');
    const output = runCodeNode(source, [
      {
        json: {
          conversation_id: 10,
          attachment_type: 'image',
          file_size: 2048,
          raw_payload_json: '{}',
        },
      },
    ], { MEDIA_MAX_BYTES_IMAGE: '1000' });

    expect(output[0].json.media_scope.download_state).toBe('rejected');
    expect(output[0].json.media_scope.rejected_reason).toBe('oversized_declared');
  });

  test('skips the write when there is no media attachment at all', () => {
    const source = fs.readFileSync(fixturePath, 'utf8');
    const output = runCodeNode(source, [{ json: { conversation_id: 10 } }]);

    expect(output[0].json.media_skipped).toBe(true);
    expect(output[0].json.media_write).toBe(false);
  });
});
