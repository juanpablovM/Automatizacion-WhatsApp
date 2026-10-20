import fs from 'node:fs';
import { describe, expect, test } from 'vitest';

// -----------------------------------------------------------------------------
// Task 3c.29: how an authorized send_technical_sheet effect reaches WhatsApp.
//   1. The saga runs it like any blocking effect: `V3 Effect Is Technical
//      Sheet?` routes it to `Persist V3 Technical Sheet Effect` (SQL 19), which
//      reserves one document message in the outbox, and `Normalize V3 Effect
//      Receipt` turns that row into a receipt.
//   2. After the turn reply is delivered, the dispatcher loads the reserved
//      documents of that decision (SQL 02) and sends each one through
//      `WA - Outbound Messages`, which posts it to Evolution's
//      /message/sendMedia with the PDF bytes `Mark Outbound Sending` read.
// -----------------------------------------------------------------------------

const readWorkflow = (name) => JSON.parse(fs.readFileSync(`n8n/workflows/${name}.json`, 'utf8'));
const nodeOf = (workflow, name) => workflow.nodes.find((node) => node.name === name);
const targets = (workflow, name, output = 0) => (workflow.connections[name]?.main?.[output] || []).map((edge) => edge.node);
const fixture = (relative) => fs.readFileSync(`tests/fixtures/workflow-nodes/${relative}`, 'utf8');
const sql = (relative) => fs.readFileSync(`db/queries/n8n/${relative}`, 'utf8');
const runCode = (source, row, extra = {}) => new Function('items', '$env', ...Object.keys(extra), source)(
  [{ json: row }], { EVOLUTION_API_BASE_URL: 'http://evolution.test', EVOLUTION_API_KEY: 'test-key' }, ...Object.values(extra),
);

describe('the saga executes send_technical_sheet through its own executor', () => {
  const workflow = readWorkflow('wa-conversation-orchestrator');

  test('create_lead keeps its branch; a technical sheet is routed before the handoff executor', () => {
    expect(targets(workflow, 'V3 Effect Is Create Lead?', 0)).toEqual(['Build V3 Lead Effect']);
    expect(targets(workflow, 'V3 Effect Is Create Lead?', 1)).toEqual(['V3 Effect Is Technical Sheet?']);
    expect(targets(workflow, 'V3 Effect Is Technical Sheet?', 0)).toEqual(['Persist V3 Technical Sheet Effect']);
    expect(targets(workflow, 'V3 Effect Is Technical Sheet?', 1)).toEqual(['Persist V3 Handoff Effect']);
    expect(targets(workflow, 'Persist V3 Technical Sheet Effect')).toEqual(['Normalize V3 Effect Receipt']);
    const condition = nodeOf(workflow, 'V3 Effect Is Technical Sheet?').parameters.conditions.conditions[0].leftValue;
    expect(condition).toBe("={{ $json.v3_effect_command?.type === 'send_technical_sheet' }}");
  });

  test('the executor embeds SQL 19 byte-for-byte, binds like the handoff executor and always reaches the normalizer', () => {
    const node = nodeOf(workflow, 'Persist V3 Technical Sheet Effect');
    expect(node.parameters.query).toBe(sql('wa-conversation-orchestrator/19_persist_v3_technical_sheet_effect.sql'));
    expect(node.parameters.additionalFields.queryParams).toBe('operation_key,decision_id,effect_payload_digest,claim_token');
    expect(node.alwaysOutputData).toBe(true);
    expect(node.credentials).toEqual(nodeOf(workflow, 'Persist V3 Handoff Effect').credentials);
  });

  test('the claim and receipt SQL accept the new effect only from a v3.1 decision', () => {
    expect(sql('wa-conversation-orchestrator/11_prepare_v3_effect.sql')).toContain("effect.value->>'type' = 'send_technical_sheet'");
    expect(sql('wa-conversation-orchestrator/12_record_v3_effect_result.sql')).toContain("target.operation_type = 'send_technical_sheet'");
  });
});

describe('Normalize V3 Effect Receipt for a technical sheet', () => {
  const normalize = (row) => runCode(fixture('wa-conversation-orchestrator/normalize-v3-effect-receipt.js'), row)[0].json;
  const receipt = {
    version: 'v3_effect_receipt/v1', operation_key: 'sheet-op-1', payload_digest: 'sheet-digest',
    effect_type: 'send_technical_sheet', status: 'succeeded', document_message_id: 77,
    delivery_key: 'v3-technical-sheet:sheet-op-1', technical_sheet_file_id: 5, sha256: 'a'.repeat(64),
  };

  test('a reserved document becomes a succeeded receipt', () => {
    const output = normalize({
      operation_key: 'sheet-op-1', operation_type: 'send_technical_sheet', payload_digest: 'sheet-digest',
      claim_token: 'claim-1', document_message_id: 77, error: null, v3_effect_receipt: receipt,
    });
    expect(output.v3_effect_outcome).toBe('succeeded');
    expect(output.v3_effect_receipt).toEqual(receipt);
    expect(output.v3_effect_external_id).toBe('77');
  });

  test('an unavailable sheet becomes a failed receipt', () => {
    const output = normalize({
      operation_key: 'sheet-op-1', operation_type: 'send_technical_sheet', payload_digest: 'sheet-digest',
      claim_token: 'claim-1', document_message_id: null, error: 'technical_sheet_unavailable', v3_effect_receipt: null,
    });
    expect(output.v3_effect_outcome).toBe('failed');
    expect(output.v3_effect_receipt).toMatchObject({ effect_type: 'send_technical_sheet', status: 'failed', error: 'technical_sheet_unavailable' });
  });

  test('a row without its document message fails visibly', () => {
    expect(() => normalize({ operation_type: 'send_technical_sheet', operation_key: 'x', v3_effect_receipt: {} }))
      .toThrow('technical_sheet_receipt_missing_document_message');
  });
});

describe('WA - Outbound Messages sends a reserved document', () => {
  const workflow = readWorkflow('wa-outbound-messages');

  test('Build Outbound Payload claims the reserved document by its delivery key, without text', () => {
    const [output] = runCode(fixture('wa-outbound-messages/build-outbound-payload.js'), {
      conversation_id: 44, phone_number: '56900000000', instance_name: 'demo-instance',
      message_type: 'document', response_kind: 'technical_sheet', delivery_key: 'v3-technical-sheet:op-1',
    });
    expect(output.json).toMatchObject({
      message_type: 'document',
      text_body: null,
      idempotency_key: 'v3-technical-sheet:op-1',
      outbound_url: 'http://evolution.test/message/sendMedia/demo-instance',
      raw_payload_json: '{}',
    });
  });

  test('a document without its reserved delivery key is refused', () => {
    expect(() => runCode(fixture('wa-outbound-messages/build-outbound-payload.js'), {
      conversation_id: 44, phone_number: '56900000000', instance_name: 'demo-instance', message_type: 'document',
    })).toThrow(/delivery_key/);
  });

  test('text sends are unchanged', () => {
    const [output] = runCode(fixture('wa-outbound-messages/build-outbound-payload.js'), {
      conversation_id: 44, phone_number: '56900000000', instance_name: 'demo-instance', response_text: 'Hola', delivery_key: 'k',
    });
    expect(output.json).toMatchObject({
      message_type: 'text', text_body: 'Hola',
      outbound_url: 'http://evolution.test/message/sendText/demo-instance',
      outbound_body: { number: '56900000000', text: 'Hola', delay: 0, linkPreview: false },
    });
  });

  test('Mark Outbound Sending embeds SQL 05, which builds the sendMedia body from the exact active file', () => {
    const query = nodeOf(workflow, 'Mark Outbound Sending').parameters.query;
    expect(query).toBe(sql('wa-outbound-messages/05_authorize_outbound_send.sql'));
    expect(query).toContain("file.id::TEXT = t.raw_payload#>>'{technical_sheet,file_id}'");
    expect(query).toContain("file.sha256 = t.raw_payload#>>'{technical_sheet,sha256}'");
    expect(query).toContain('file.active');
    expect(query).toContain("'technical_sheet_unavailable'");
    expect(query).toContain("translate(encode(file.content, 'base64'), E'\\n', '')");
  });

  test('Send Evolution Message posts a document to sendMedia and never keeps the bytes in its output', async () => {
    const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
    const calls = [];
    const helpers = {
      httpRequest: async (request) => {
        calls.push(request);
        return { statusCode: 201, body: { key: { id: 'wamid-doc' } }, headers: {} };
      },
    };
    const body = { number: '56900000000', mediatype: 'document', mimetype: 'application/pdf', fileName: 'ficha-demo.pdf', media: 'JVBERi0xLjQK' };
    const output = await new AsyncFunction('items', 'helpers', '$env', fixture('wa-outbound-messages/send-evolution-message.js'))(
      [{ json: { should_send: true, already_sent: false, message_type: 'document', instance_name: 'demo-instance', outbound_body: body } }],
      helpers,
      { EVOLUTION_API_BASE_URL: 'http://evolution.test', EVOLUTION_API_KEY: 'test-key' },
    );
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('http://evolution.test/message/sendMedia/demo-instance');
    expect(calls[0].body).toEqual(body);
    expect(output[0].json.statusCode).toBe(201);
    expect(output[0].json.body.key.id).toBe('wamid-doc');
    expect(JSON.stringify(output[0].json)).not.toContain('JVBERi0xLjQK');
  });

  test('a failed document send of a v3.1 effect is quarantined for reconciliation', () => {
    const [output] = new Function('items', fixture('wa-outbound-messages/normalize-delivery-result.js'))([{ json: {
      id: 902, statusCode: 400, body: { message: 'bad media' },
      raw_payload: { version: 'validated_conversation_decision/v3.1', mediatype: 'document' },
    } }]);
    expect(output.json).toMatchObject({ delivery_status: 'failed', reconciliation_required: true });
  });
});

describe('the dispatcher sends the documents after the delivered reply', () => {
  const workflow = readWorkflow('wa-inbound-downstream-dispatcher');

  test('the technical-sheet lane sits between the reply receipt and the outbound completion', () => {
    expect(targets(workflow, 'Record V3 Delivery Receipt')).toEqual(['Load V3 Technical Sheet Deliveries']);
    expect(targets(workflow, 'Load V3 Technical Sheet Deliveries')).toEqual(['V3 Technical Sheet Deliveries?']);
    expect(targets(workflow, 'V3 Technical Sheet Deliveries?', 0)).toEqual(['Execute Technical Sheet Outbound']);
    expect(targets(workflow, 'V3 Technical Sheet Deliveries?', 1)).toEqual(['Technical Sheet Lane Complete']);
    expect(targets(workflow, 'Execute Technical Sheet Outbound')).toEqual(['Technical Sheet Lane Complete']);
    expect(targets(workflow, 'Technical Sheet Lane Complete')).toEqual(['Outbound Lane Complete']);
  });

  test('the load embeds SQL 02 and always emits an item', () => {
    const node = nodeOf(workflow, 'Load V3 Technical Sheet Deliveries');
    expect(node.parameters.query).toBe(sql('wa-inbound-downstream-dispatcher/02_load_v3_technical_sheet_deliveries.sql'));
    expect(node.parameters.options.queryReplacement).toBe('={{ [$json.decision_id] }}');
    expect(node.alwaysOutputData).toBe(true);
    expect(node.parameters.query).toContain("execution.state = 'delivered'");
  });

  test('documents go through WA - Outbound Messages one by one, and a failure never blocks the turn', () => {
    const node = nodeOf(workflow, 'Execute Technical Sheet Outbound');
    expect(node.parameters.workflowId).toEqual(nodeOf(workflow, 'Execute Outbound Response').parameters.workflowId);
    expect(node.parameters.mode).toBe('each');
    expect(node.parameters.options).toEqual({ waitForSubWorkflow: true });
    expect(node.onError).toBe('continueRegularOutput');
    const condition = nodeOf(workflow, 'V3 Technical Sheet Deliveries?').parameters.conditions.conditions[0].leftValue;
    expect(condition).toBe('={{ Boolean($json.document_message_id && $json.delivery_key) }}');
  });

  test('Technical Sheet Lane Complete restores the single reply receipt and summarizes the documents', () => {
    const source = fixture('wa-inbound-downstream-dispatcher/technical-sheet-lane-complete.js');
    expect(nodeOf(workflow, 'Technical Sheet Lane Complete').parameters.jsCode).toBe(source);
    const receipt = { decision_id: 'd-1', state: 'delivered', delivery_key: 'reply-key' };
    const $ = (name) => ({ first: () => ({ json: name === 'Record V3 Delivery Receipt' ? receipt : {} }) });
    const output = new Function('items', '$', source)([
      { json: { delivery_key: 'v3-technical-sheet:a', delivery_status: 'sent' } },
      { json: { error: { message: 'boom' } } },
    ], $);
    expect(output).toHaveLength(1);
    expect(output[0].json).toEqual({
      ...receipt,
      technical_sheet_deliveries: [
        { delivery_key: 'v3-technical-sheet:a', delivery_status: 'sent', error: null },
        { delivery_key: null, delivery_status: null, error: 'boom' },
      ],
    });
    const none = new Function('items', '$', source)([{ json: {} }], $);
    expect(none).toEqual([{ json: { ...receipt, technical_sheet_deliveries: [] } }]);
  });

  test('the mock Evolution of the test stack answers sendMedia', () => {
    expect(fs.readFileSync('docker-compose.test.yml', 'utf8')).toContain("request.url.startsWith('/message/sendMedia/')");
  });
});
