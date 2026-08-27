# Cierre de Etapa P0 — Congelar Baseline y Proteger Estado Actual

**Fecha:** 2026-06-30
**Responsable:** Juan Pablo (Hormiglass) + Agente Hermes
**Estado:** ✅ COMPLETADO

---

## Resumen

Se ejecutó y validó el plan P0 completo: **backup completo nuevo creado despues del sync de workflows, verificado (restore no destructivo OK), healthchecks de todos los servicios pasan, workflows sincronizados, y pruebas locales de AI y regresión conversacional exitosas**.

El baseline queda **congelado y protegido**. No se avanzará a cambios funcionales hasta confirmar que este estado es recuperable (ya verificado).

---

## 1. Backup Completo Nuevo

### Comando ejecutado
```bash
sh scripts/ops/backup-local.sh
```

### Resultado
```
Creando backup en: /home/agentesai/Automatizacion-WhatsApp/backups/20260630-145829
Backup listo:
total 16M
-rw-r--r-- 1 agentesai agentesai 237K Jun 30 14:58 crm_whatsapp_app.dump
-rw-r--r-- 1 agentesai agentesai  15M Jun 30 14:58 crm_whatsapp_n8n.dump
-rw------- 1 agentesai agentesai  179 Jun 30 14:58 manifest.txt
-rw-r--r-- 1 root      root      217K Jun 30 14:58 n8n_data.tar.gz
```

### Verificación de Restore (No Destructivo)
```bash
sh scripts/ops/verify-backup-local.sh backups/20260630-145829
```

### Resultado
```
Verificando backup: backups/20260630-145829
Bases temporales de verificacion:
  crm_whatsapp_app_restore_check_20260630145930
  crm_whatsapp_n8n_restore_check_20260630145930
Restore check OK
app_tables=22
app_leads=24
n8n_tables=52
n8n_workflows=10
n8n_volume_tar=readable
```

**✅ Backup post-sync validado y restaurable.** El directorio de referencia autorizado es: `backups/20260630-145829/`

---

## 2. Healthchecks de Servicios

### `docker compose --env-file .env ps`
```
NAME                                      IMAGE                              COMMAND                  SERVICE         CREATED       STATUS                 PORTS
crm-whatsapp-automatizado-evolution-api   evoapicloud/evolution-api:v2.3.7   "/bin/bash -c '. ./D…"   evolution-api   10 days ago   Up 10 days             0.0.0.0:8080->8080/tcp
crm-whatsapp-automatizado-n8n             docker.n8n.io/n8nio/n8n:1.123.29   "tini -- /docker-ent…"   n8n             10 days ago   Up 22 minutes          0.0.0.0:5678->5678/tcp
crm-whatsapp-automatizado-postgres        postgres:16.13-alpine              "docker-entrypoint.s…"   postgres        10 days ago   Up 10 days (healthy)   0.0.0.0:5433->5432/tcp
crm-whatsapp-automatizado-redis           redis:7.4-alpine                   "redis-server --appen…"   redis           10 days ago   Up 10 days (healthy)   6379/tcp
```
**✅ Los 4 servicios: Running/Healthy**

### `curl -fsS http://127.0.0.1:5678/healthz`
```json
{"status":"ok"}
```
**✅ n8n responde healthcheck**

### `curl -fsS http://127.0.0.1:8080/`
```json
{"status":200,"message":"Welcome to the Evolution API, it is working!","version":"2.3.7","clientName":"evolution_exchange","manager":"http://127.0.0.1:8080/manager","documentation":"https://doc.evolution-api.com","whatsappWebVersion":"2.3000.1042401057"}
```
**✅ Evolution API responde**

### `sh scripts/dev/evolution-doctor.sh`
```
Evolution Doctor
================
Base URL              : http://localhost:8080
Version API (runtime) : 2.3.7
Imagen configurada    : evoapicloud/evolution-api:v2.3.7
Instancias totales    : 1
Instancia default     : wahormiglass (existe: si)

Instancias:
- wahormiglass: integration=WHATSAPP-BAILEYS, status=open

Chequeos:
- OK: EVOLUTION_API_IMAGE no usa latest.
- OK: runtime en rama 2.3.x o superior.
- OK: la instancia default existe.
```
**✅ Instancia WhatsApp `wahormiglass` en estado `open` (conectada, número 56972328559)**

---

## 3. Sincronización de Workflows n8n

### Preflight
```bash
sh scripts/dev/sync-n8n-workflows.sh --preflight
```
**Resultado:** `Preflight local OK`

### Sincronización Real
```bash
sh scripts/dev/sync-n8n-workflows.sh
```
**Resultado:**
```
Preflight local OK
Importando workflows (base)... Successfully imported 9 workflows.
Importando workflows (links resueltos)... Successfully imported 9 workflows.
Verificacion remota OK
Workflow de entrada activado: WA - Inbound Entry
Workflows sincronizados con CLI oficial de n8n
```
**✅ 9 workflows importados, enlaces resueltos, `WA - Inbound Entry` activo, `OPS - Error Handler` configurado como error handler**

---

## 4. Pruebas Locales de AI y Regresión Conversacional

### Test AI Assistant Local (Contrato + Fallback)
```bash
sh scripts/ops/test-ai-assistant-local.sh
```
**Resultado:** `AI assistant local contract OK: 7 escenarios simulados + fallback de configuracion`
**✅ Contrato JSON válido, fallback por configuración faltante funcionando**

### Test Conversation Regression Local
```bash
sh scripts/ops/test-conversation-regression-local.sh
```
**Resultado:** `Conversation regression local smoke OK: 18 casos validados`
**✅ 18 casos de regresión conversacional pasan (saludos, datos, confirmaciones, objeciones, reinicios, continuidad 24h, etc.)**

---

## 5. Estado de Datos Clave (Confirmación Post-Backup)

| Entidad | Registros | Notas |
|---------|-----------|-------|
| `leads` | 24 | Con `qualification_context` poblado |
| `conversations` | 42 | Con `pending_question_key` y `qualification_context` |
| `catalog_items` | 28 | Catálogo Hormiglass público completo |
| `price_rules` | 28 | Reglas de precio públicas (fixed/range/requires_human) |
| `commercial_conditions` | 8 | Activas |
| `faq_entries` | 12 | Activas |
| `objection_playbooks` | 5 | Activas |
| `appointment_slots` | 0 | **Agenda deshabilitada** (sin cupos reales) |
| `sellers_total` | 5 | Total de registros en `sellers` |
| `sellers_notifiable` | 4 | Activos con `clickup_user_id` para round-robin + notificación |
| `assignment_rotations` | 2 | Rotación funcionando |

Nota operativa: `Juan Pablo (Pruebas)` sigue dentro de los vendedores notificables y queda como riesgo abierto para P1 antes de producción.

---

## 6. Workflows n8n Versionados (9 no archivados)

Estado observado: `workflows_total=10`, `workflows_not_archived=9`, `workflows_active=1`.
El workflow archivado adicional es `My workflow`; no forma parte del baseline operativo.

1. `WA - Inbound Entry` (ID: 6TgrfXCUUixpJOWh) — **ACTIVO** ✅
2. `WA - Conversation Orchestrator` (ID: zEs4qs4XmAziAeHY)
3. `WA - Outbound Messages` (ID: Ilb6wl7noSgtFzKv)
4. `AI - Lead Qualification Assistant` (ID: xkCWU5wQO4jPqnfW)
5. `CRM - Lead Creation And Assignment` (ID: ZtmqC1nulHQUUIpD)
6. `CRM - ClickUp Sync Lead` (ID: D3bltCnDffERnrwH)
7. `CRM - Seller Notification Dispatch` (ID: qgWNv7JX61Apd0yW)
8. `OPS - Error Handler` (ID: xCQoXr0IJ5oRHg3n) — **Error Handler configurado**
9. `TEST - ClickUp Sync Smoke` (ID: nIB2MnEyKsJ8WebT)

---

## 7. Configuración AI (Hormi Atención)

- **Proveedor:** Google (endpoint OpenAI-compatible)
- **Modelo canónico:** `gemini-3.1-flash-lite`
- **Endpoint:** `https://generativelanguage.googleapis.com/v1beta/openai/chat/completions`
- **Memoria:** `qualification_context` (JSONB) + `pending_question_key`
- **Guardrails:** Validados en n8n (no inventa precios, stock, agenda, descuentos)
- **Handoff:** Solo tras crear y asignar lead (confirmado en E2E Vitacura)
- **Auditoría:** `advisor_decisions` registra decisiones aceptadas/rechazadas/fallback/error

---

## 8. Próximos Pasos (Etapa 1+)

Con el baseline congelado y protegido, el siguiente foco según `docs/guia-produccion.md`:

1. **Etapa 1** — Congelar baseline funcional (tags de imágenes, nombres finales, procedimiento sync/rollback documentado)
2. **Etapa 2** — Preparar infraestructura de staging (host, DNS, proxy, HTTPS, secretos separados)
3. **Etapa 3** — Endurecer datos, seguridad y recuperación (rotar secretos, backup automático, restore real probado)
4. **Etapa 4** — Validación funcional ampliada (matriz E2E completa: B2B, reclamos, garantía, pagos)
5. **Etapa 5** — Activar AI en staging con secretos separados
6. **Etapa 6** — Preparar operación diaria (monitoreo, alertas, runbooks, responsable)
7. **Etapa 7** — Corte a producción controlado

---

## 9. Criterios de Salida P0 — TODOS CUMPLIDOS ✅

- [x] Backup completo nuevo post-sync creado en `backups/20260630-145829/`
- [x] Backup verificado con restore no destructivo (`Restore check OK`)
- [x] `app_tables=22`, `app_leads=24`, `n8n_tables=52`, `n8n_workflows=10`, `n8n_volume_tar=readable`
- [x] `docker compose --env-file .env ps` → 4 servicios running/healthy
- [x] `curl http://127.0.0.1:5678/healthz` → `{"status":"ok"}`
- [x] `curl http://127.0.0.1:8080/` → Evolution API 2.3.7 respondiendo
- [x] `sh scripts/dev/evolution-doctor.sh` → Instancia `wahormiglass` estado `open`
- [x] `sh scripts/dev/sync-n8n-workflows.sh --preflight` → `Preflight local OK`
- [x] `sh scripts/dev/sync-n8n-workflows.sh` → `Verificacion remota OK`, `Workflow de entrada activado`
- [x] `sh scripts/ops/test-ai-assistant-local.sh` → 7 escenarios + fallback OK
- [x] `sh scripts/ops/test-conversation-regression-local.sh` → 18 casos OK
- [x] Documentado en `docs/estado-actual-2026-06-30.md`

---

## 10. Decisión

**El baseline queda OFICIALMENTE CONGELADO Y PROTEGIDO.**

- El backup `backups/20260630-145829/` es el punto de restauración autorizado.
- No se aplicarán cambios funcionales, migraciones de esquema, ni actualizaciones de workflows sin antes confirmar que este baseline es recuperable (ya verificado).
- Cualquier trabajo posterior partirá de este estado documentado.

---

**Firma / Registro:** Juan Pablo — 2026-06-30 — Baseline P0 congelado y validado.
