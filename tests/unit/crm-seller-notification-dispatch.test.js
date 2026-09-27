// D9 (design.md): "The seller notification renders `leads.requirement`
// verbatim." `Build Seller Notification` (crm-seller-notification-dispatch.json)
// already embeds `row.requirement` (the leads.requirement column) as-is into
// one line of the notification text — it never re-derives or reformats it.
// Since `leads.requirement` itself already carries one `• {product} —
// {quantity}[, {measurements}]` line per item for a multi-item quote
// (build-v3-lead-effect.js, D9), the notification inherits the itemization
// for free. This node is intentionally not extracted to a fixture (it has no
// other test coverage need beyond this confirmation), so this test evaluates
// its real jsCode straight from the deployed workflow JSON — the same
// technique v3-brand-voice.test.js uses to catch drift in an inline node.
import fs from 'node:fs';
import { describe, expect, test } from 'vitest';

const runEmbeddedNode = (nodeName, row, env = {}) => {
  const workflow = JSON.parse(
    fs.readFileSync('n8n/workflows/crm-seller-notification-dispatch.json', 'utf8'),
  );
  const node = workflow.nodes.find((candidate) => candidate.name === nodeName);
  return new Function('items', '$env', node.parameters.jsCode)([{ json: row }], env)[0].json;
};

const baseRow = (overrides = {}) => ({
  lead_id: 77,
  seller_id: 3,
  seller_name: 'Vendedor Uno',
  whatsapp_name: 'Cliente Prueba',
  phone_number: '+56911112222',
  clickup_task_id: 'ct-1',
  clickup_task_url: 'https://app.clickup.com/t/ct-1',
  clickup_user_id: '55',
  operation_key: 'seller-notification:lead:77:seller:3',
  notification_operation_status: 'processing',
  should_dispatch_notification: true,
  ...overrides,
});

describe('Build Seller Notification — renders leads.requirement verbatim (D9)', () => {
  test('shows one line per item when the lead requirement is already itemized', () => {
    const requirement = '• Cierro de Hormigón — 5 m2, 3 metros de altura\n• Alambre de Púas — 200 ml\nUso: Cierre perimetral';
    const output = runEmbeddedNode('Build Seller Notification', baseRow({
      service: 'despacho', city: 'Lo Prado', requirement,
    }), { CLICKUP_API_TOKEN: 'token-1' });

    const commentText = output.notification_payload.comment_text;
    // The label prefixes only the first line ("Requerimiento: "); every other
    // item keeps its own bare "• " bullet line, one per item, verbatim.
    expect(commentText).toContain('Requerimiento: • Cierro de Hormigón — 5 m2, 3 metros de altura');
    expect(commentText).toContain('• Alambre de Púas — 200 ml');
    expect(commentText).toContain('Uso: Cierre perimetral');
    expect(commentText.split('\n').filter((line) => line.includes('•'))).toHaveLength(2);
  });

  test('shows the plain single-item requirement unchanged', () => {
    const output = runEmbeddedNode('Build Seller Notification', baseRow({
      service: 'despacho', city: 'Santiago', requirement: 'hormigon H25 20 m3',
    }), { CLICKUP_API_TOKEN: 'token-1' });

    expect(output.notification_payload.comment_text).toContain('Requerimiento: hormigon H25 20 m3');
  });
});
