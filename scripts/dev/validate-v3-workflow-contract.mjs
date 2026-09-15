#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const requiredNodes = [
  'Resolve Conversation Contract Route', 'V3 Control Only?', 'Route V3 Early?', 'Fix V3 Route',
  'Compile V3 Turn Policy', 'Use V3 Contract?', 'Validate And Authorize V3',
  'V3 Proposal Valid?', 'Build V3 Repair', 'Persist V3 Turn Authority',
  'Prepare V3 Execution', 'Prepare V3 Effects', 'V3 Has Pending Effect?',
  'Execute V3 Lead Effect', 'Persist V3 Handoff Effect', 'Normalize V3 Effect Receipt',
  'Commit V3 State And Outbox', 'Commit V3 Contingency', 'Prepare V3 Saga Result',
  'Persist V3 Dispatch?', 'Persist V3 Durable Dispatch', 'Return Conversation Output',
];
const requiredEdges = [
  ['Load Conversation State', 0, 'Resolve Conversation Contract Route'],
  ['Resolve Conversation Contract Route', 0, 'Evaluate Conversation Step'],
  ['Evaluate Conversation Step', 0, 'V3 Control Only?'],
  ['V3 Control Only?', 0, 'Apply AI Assistance'],
  ['V3 Control Only?', 1, 'Route V3 Early?'],
  ['Route V3 Early?', 0, 'Fix V3 Route'],
  ['Compile V3 Turn Policy', 0, 'Execute AI Lead Qualification'],
  ['Merge AI Assistance', 0, 'Use V3 Contract?'],
  ['Use V3 Contract?', 0, 'Validate And Authorize V3'],
  ['Validate And Authorize V3', 0, 'V3 Proposal Valid?'],
  ['V3 Proposal Valid?', 0, 'Persist V3 Turn Authority'],
  ['V3 Proposal Valid?', 1, 'Build V3 Repair'],
  ['V3 Has Pending Effect?', 1, 'Commit V3 State And Outbox'],
  ['V3 Effect Is Create Lead?', 1, 'Persist V3 Handoff Effect'],
  ['Persist V3 Handoff Effect', 0, 'Normalize V3 Effect Receipt'],
  ['Prepare V3 Saga Result', 0, 'Prepare Conversation Output'],
  ['Prepare Conversation Output', 0, 'Persist V3 Dispatch?'],
  ['Persist V3 Dispatch?', 0, 'Persist V3 Durable Dispatch'],
  ['Persist V3 Durable Dispatch', 0, 'Return Conversation Output'],
  ['Persist V3 Dispatch?', 1, 'Return Conversation Output'],
];

export function validateV3WorkflowContract(workflowDirectory) {
  const workflows = fs.readdirSync(workflowDirectory)
    .filter((file) => file.endsWith('.json'))
    .map((file) => JSON.parse(fs.readFileSync(path.join(workflowDirectory, file), 'utf8')));
  const workflow = workflows.find((entry) => entry.name === 'WA - Conversation Orchestrator');
  if (!workflow) throw new Error('v3 default requires WA - Conversation Orchestrator');
  const names = new Set(workflow.nodes.map((node) => node.name));
  for (const name of requiredNodes) {
    if (!names.has(name)) throw new Error(`v3 default requires node: ${name}`);
  }
  for (const [from, branch, to] of requiredEdges) {
    if (!workflow.connections?.[from]?.main?.[branch]?.some((edge) => edge.node === to)) {
      throw new Error(`v3 default requires connection: ${from}[${branch}] -> ${to}`);
    }
  }
  // Presence is insufficient: disconnected executors or commits silently remove
  // capabilities while still passing workflow-name and manifest parity checks.
  const reachable = new Set();
  const pending = ['Workflow Input'];
  while (pending.length) {
    const name = pending.pop();
    if (reachable.has(name)) continue;
    reachable.add(name);
    for (const branches of Object.values(workflow.connections?.[name] || {})) {
      for (const branch of branches) for (const edge of branch || []) pending.push(edge.node);
    }
  }
  for (const name of requiredNodes) {
    if (!reachable.has(name)) throw new Error(`v3 default requires reachable node: ${name}`);
  }
  const prepareEffectNode = workflow.nodes.find((node) => node.name === 'Prepare V3 Effect');
  const canonicalPrepareEffectSql = fs.readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)),
    '../../db/queries/n8n/wa-conversation-orchestrator/11_prepare_v3_effect.sql'), 'utf8');
  if (prepareEffectNode.type !== 'n8n-nodes-base.postgres'
      || prepareEffectNode.parameters?.query !== canonicalPrepareEffectSql
      || !canonicalPrepareEffectSql.includes('command.decision_id')) {
    throw new Error('v3 default requires canonical flat normal-handoff decision binding SQL');
  }
  const persistHandoffNode = workflow.nodes.find((node) => node.name === 'Persist V3 Handoff Effect');
  if (persistHandoffNode.parameters?.additionalFields?.queryParams
        !== 'operation_key,decision_id,effect_payload_digest,claim_token'
      || persistHandoffNode.alwaysOutputData !== true) {
    throw new Error('v3 default requires visible exact normal-handoff binding failures');
  }
  const durableNode = workflow.nodes.find((node) => node.name === 'Persist V3 Durable Dispatch');
  const canonicalDurableSql = fs.readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)),
    '../../db/queries/n8n/wa-conversation-orchestrator/18_persist_v3_durable_dispatch.sql'), 'utf8');
  if (durableNode.type !== 'n8n-nodes-base.postgres' || durableNode.parameters?.query !== canonicalDurableSql) {
    throw new Error('v3 default requires canonical durable dispatch claim/decision/outbox binding SQL');
  }
  const dispatcher = workflows.find((entry) => entry.name === 'WA - Inbound Downstream Dispatcher');
  for (const name of ['V3 Delivery Result?', 'Record V3 Delivery Receipt']) {
    if (!dispatcher?.nodes?.some((node) => node.name === name)) {
      throw new Error(`v3 default requires downstream node: ${name}`);
    }
  }
  const outboundCompletion = dispatcher.nodes.find((node) => node.name === 'Outbound Lane Complete');
  const completionSource = outboundCompletion?.parameters?.jsCode || '';
  for (const binding of ["$('Normalize Durable Dispatch').first().json", 'inbound_event_id: dispatchContext.inbound_event_id', 'processing_token: dispatchContext.processing_token']) {
    if (!completionSource.includes(binding)) {
      throw new Error('v3 default requires restored outbound inbox event/claim token context');
    }
  }
  if (!dispatcher.connections?.['V3 Delivery Result?']?.main?.[0]?.some((edge) => edge.node === 'Record V3 Delivery Receipt')) {
    throw new Error('v3 default requires connected downstream delivery receipt');
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    validateV3WorkflowContract(process.argv[2]);
    console.log('v3 default workflow contract OK');
  } catch (error) {
    console.error(`ERROR: ${error.message}; refusing workflows that remove the project default v3 pipeline`);
    process.exitCode = 1;
  }
}
