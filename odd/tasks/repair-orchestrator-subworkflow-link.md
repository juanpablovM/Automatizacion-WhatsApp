# Repair orchestrator subworkflow link
Status: completed. Production inbound processing was restored after the deployed orchestrator lost its resolved lead-effect subworkflow target.
Scope: repair and verify the orchestrator path; the separate CRM endpoint HTTP 502 incident remains out of scope for this work unit. Forecast: under 100 authored lines. Delivery strategy: ask-on-risk.

## Specs
1. **S1** — The user chose: “Salud actual y eventos fallidos”.
2. **S2** — After the health audit found the production backlog, the user chose: “Reparar el orquestador ahora”.

## Tasks
- [x] **T1** — S2 — Parent route — Snapshot the runtime, restore the resolved `Execute V3 Lead Effect` target through the supported manifest-aware path, and preserve unrelated workflow state. Risk: item 5 (production workflow deployment). Commit: pending.
- [x] **T2** — S1-S2 — Independent verification route — Confirm the live target ID, workflow health, queue drainage, and absence of new orchestration failures; report the separate CRM HTTP 502 condition without changing it. Risk: item 5 (production verification after deployment). Commit: pending.

## Verification
- Read back the deployed `Execute V3 Lead Effect.workflowId` and compare it with the sole runtime ID of `CRM - Lead Creation And Assignment`.
- Confirm `WA - Inbound Recovery` and required entry workflows retain their prior active state.
- Confirm processing/received queue counts decrease and no new `WA - Conversation Orchestrator` errors appear after the repair.
- Run the repository remote workflow verifier and focused workflow-link tests where available.

## Log
- **L1** — User: “vayamos por partes”.
- **L2** — User selected: “Salud actual y eventos fallidos”.
- **L3** — Audit evidence: `Execute V3 Lead Effect.workflowId` is empty in production; 7 inbound events are stuck in `processing/orchestrating`, 22 are queued, and Recovery/Orchestrator executions repeatedly fail. The CRM dispatcher is active and configured but receives HTTP 502 from the CRM endpoint; that separate incident is not part of this repair.
- **L4** — User selected: “Reparar el orquestador ahora”.
- **L5** — First targeted repair attempt made no production change: sourcing the deployment helper from a background shell made it derive `PROJECT_ROOT=/`, so it failed before pausing workflows with `couldn't find env file: /.env`. The corrected invocation sets the script path as shell `$0`; a read-only probe confirmed `PROJECT_ROOT=/home/agentesai/Automatizacion-WhatsApp` and resolved the live orchestrator ID.
- **L6** — Targeted repair succeeded from snapshot `/tmp/automatizacion-whatsapp-orchestrator-repair-20261123-154333`: imported one manifest-resolved orchestrator, remote verification passed, `Execute V3 Lead Effect.workflowId=ZtmqC1nulHQUUIpD`, Entry and Recovery remained active, and the orchestrator remained callable/inactive as designed.
- **L7** — Queue observation reached zero backlog older than two minutes. Independent high-risk verification passed S1 and S2: zero current received/processing rows, 33 successful orchestrator executions, 97 successful Recovery executions, and no Recovery/Orchestrator errors after `2026-11-23 15:46:00-03`. One `own_message_conversation_not_found` failure was confirmed unrelated to the repaired link. Separate unresolved condition: five CRM outbox events remain pending with HTTP 502 from the CRM endpoint.
