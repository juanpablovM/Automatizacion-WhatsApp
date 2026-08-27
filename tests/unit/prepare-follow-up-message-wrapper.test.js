import fs from 'node:fs';
import { describe, expect, test } from 'vitest';

const fixturePath = 'tests/fixtures/workflow-nodes/ops-followup-scheduler/prepare-follow-up-message.js';

const runCodeNode = (source, items, env = {}) => new Function('items', '$env', source)(items, env);

describe('Prepare Follow-Up Message — real n8n Code node wrapper', () => {
  test('fills the day-3 cotizacion_lead template and allows sending inside the window', () => {
    const source = fs.readFileSync(fixturePath, 'utf8');
    const output = runCodeNode(source, [
      {
        json: {
          id: 42,
          motivo: 'cotizacion_lead',
          step_dia: 3,
          claimed_at: '2026-08-21T15:00:00.000Z',
          lead_name: 'Juan',
          // Fixed 00:00-23:59 window to keep the assertion timezone-independent.
          follow_up_window_start: '00:00',
          follow_up_window_end: '23:59',
        },
      },
    ]);

    expect(output).toHaveLength(1);
    expect(output[0].json.follow_up_text).toContain('aun no tuvimos novedades tuyas');
    expect(output[0].json.follow_up_text).not.toContain('{{nombre}}');
    expect(output[0].json.follow_up_will_send).toBe(true);
    expect(output[0].json.response_kind).toBe('follow_up_day_3');
    expect(output[0].json.message_id).toBe('follow-up:42');
  });

  test('blocks sending when the claimed time falls outside the configured window', () => {
    const source = fs.readFileSync(fixturePath, 'utf8');
    const output = runCodeNode(source, [
      {
        json: {
          id: 43,
          motivo: 'cotizacion_lead',
          step_dia: 0,
          claimed_at: '2026-08-21T15:00:00.000Z',
          follow_up_window_start: '00:00',
          follow_up_window_end: '00:01',
        },
      },
    ]);

    expect(output[0].json.follow_up_window_ok).toBe(false);
    expect(output[0].json.follow_up_will_send).toBe(false);
  });
});
