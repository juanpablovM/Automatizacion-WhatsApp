import fs from 'node:fs';
import { createRequire } from 'node:module';
import { describe, expect, test } from 'vitest';

const require = createRequire(import.meta.url);
const { CHILE_COMMUNE_NAMES, resolveChileanCommune, isServiceAreaCommune, SERVICE_AREA } = require('../fixtures/workflow-nodes/shared/chile-communes.js');

// Task 3c.33 (L2, live 2026-09-30 conversation 392: "Chiloe" was accepted as
// the commune). The official list is public SUBDERE data (CUT codes).
describe('official Chilean communes', () => {
  test('lists the 346 comunas once each', () => {
    expect(CHILE_COMMUNE_NAMES).toHaveLength(346);
    expect(new Set(CHILE_COMMUNE_NAMES).size).toBe(346);
    expect(CHILE_COMMUNE_NAMES).toEqual(expect.arrayContaining(['Puente Alto', 'Ñuñoa', 'Castro', 'Chillán Viejo', 'Til Til', 'Isla de Pascua']));
  });

  test.each([
    ['puente alto', 'Puente Alto'],
    ['PUENTE ALTO', 'Puente Alto'],
    ['Nunoa', 'Ñuñoa'],
    ['Viña del Mar', 'Viña del Mar'],
    ['comuna de Maipú', 'Maipú'],
    ['Tiltil', 'Til Til'],
    ['Llaillay', 'Llay-Llay'],
    ['Puente Alto, Santiago', 'Puente Alto'],
    ['Chicureo', 'Colina'],
    ['La Dehesa', 'Lo Barnechea'],
  ])('%s resolves to %s', (text, expected) => {
    expect(resolveChileanCommune(text)).toBe(expected);
  });

  test.each(['Chiloé', 'Chiloe', 'Región Metropolitana', 'Calle Falsa 123', '', 'Patagonia'])('%s is not a commune', (text) => {
    expect(resolveChileanCommune(text)).toBeNull();
  });
});

// Task 3c.34 (owner rule 2026-10-09): deliveries and installations only in the
// Región Metropolitana (CUT region 13) plus Viña del Mar (05109), Valparaíso
// (05101), Concepción (08101) and Rancagua (06101).
describe('service area', () => {
  test('is derived from CUT codes: region 13 plus four single comunas', () => {
    expect(SERVICE_AREA).toEqual({ region_codes: ['13'], commune_codes: ['05109', '05101', '08101', '06101'] });
    const inArea = CHILE_COMMUNE_NAMES.filter((name) => isServiceAreaCommune(name));
    expect(inArea).toHaveLength(56);
    expect(inArea).toEqual(expect.arrayContaining(['Santiago', 'Maipú', 'Puente Alto', 'Colina', 'San Bernardo', 'Melipilla', 'Peñaflor', 'Viña del Mar', 'Valparaíso', 'Concepción', 'Rancagua']));
  });

  test.each(['Maipú', 'puente alto', 'Chicureo', 'La Dehesa', 'Til Til', 'Viña del Mar', 'Reñaca', 'Viña', 'Valparaiso', 'Concepcion', 'Rancagua'])('%s is inside', (text) => {
    expect(isServiceAreaCommune(text)).toBe(true);
  });

  test.each(['Concón', 'Quilpué', 'Talcahuano', 'Machalí', 'Talca', 'Castro', 'Temuco', 'San Antonio'])('%s is outside', (text) => {
    expect(isServiceAreaCommune(text)).toBe(false);
  });

  test.each(['Chiloé', 'Región Metropolitana', '', null])('%s is not a comuna, so it is unknown', (text) => {
    expect(isServiceAreaCommune(text)).toBeNull();
  });
});

describe('every deployed node that validates communes carries the official list', () => {
  test.each([
    ['n8n/workflows/wa-conversation-orchestrator.json', 'Compile V3 Turn Policy'],
    ['n8n/workflows/wa-conversation-orchestrator.json', 'Validate And Authorize V3'],
    ['n8n/workflows/wa-conversation-orchestrator.json', 'Evaluate Conversation Step'],
    ['n8n/workflows/ai-prd-shadow-evaluator.json', 'Prepare Shadow Evaluation'],
    ['n8n/workflows/ai-prd-shadow-evaluator.json', 'Record Shadow Evaluation'],
  ])('%s :: %s', (workflowPath, nodeName) => {
    const workflow = JSON.parse(fs.readFileSync(workflowPath, 'utf8'));
    const source = workflow.nodes.find((node) => node.name === nodeName).parameters.jsCode;
    expect(source).toContain('const { CHILE_COMMUNE_NAMES, resolveChileanCommune, isServiceAreaCommune } = (() => {');
  });
});
