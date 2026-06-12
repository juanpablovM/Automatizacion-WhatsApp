# Fase 2 Completada - Integración de los 7 Puntos

**Fecha:** 2026-06-12  
**Estado:** ✅ COMPLETADO  
**Commit:** `041f823` en branch `feat/afinar-hormi-atencion`  
**Sync n8n:** ✅ Realizada + reinicio de contenedor  
**Tests:** ✅ AI assistant contract (8 escenarios) + Conversation regression (18 casos)

---

## Resumen de Cambios Aplicados

### AG1: Catálogo Hormiglass
- **Qué:** Se agregó el catálogo completo de productos y servicios de Hormiglass al system prompt de la AI
- **Archivo:** `n8n/workflows/ai-lead-qualification-assistant.json` → nodo `Build AI Request`
- **Impacto:** La AI ahora conoce todos los productos (Adocésped, Adocreto, baldosas, pastelones, cierres, soleras, etc.) y servicios (venta, instalación, movimiento de tierra, transporte)
- **Cobertura:** Región Metropolitana completa

### AG2: Confirmación Ambigua
- **Qué:** Detección de respuestas que PARECEN confirmación pero tienen condiciones ("sí, pero...", "ok, aunque...", "depende...")
- **Archivos:** 
  - `ai-lead-qualification-assistant.json` → `Build AI Request` (instrucción en system prompt)
  - `wa-conversation-orchestrator.json` → `Apply AI Assistance` (validación post-procesado)
- **Comportamiento:** Cuando se detecta ambigüedad, la AI devuelve `intent: "correction"` / `"provide_info"` y `confirmation_status: "requested"` en lugar de `"confirmed"`
- **Ejemplos cubiertos:**
  - "Sí, pero en Valparaíso" → NO es confirmación, es corrección de ciudad
  - "Ok, aunque quiero que sea color gris" → NO es confirmación, agrega requisito
  - "Si es que me llaman mañana" → NO es confirmación, pone condición temporal
  - "Sí, depende del precio" → NO es confirmación, condiciona

### AG3: Consistencia reply_text vs next_question
- **Qué:** Fix para que el reply_text de la AI no desincronice el flujo cuando hay campos faltantes
- **Archivo:** `wa-conversation-orchestrator.json` → `Apply AI Assistance`
- **Solución:** Solo usar `ai_autonomous_reply` cuando `shouldCreateLead=true` (handoff) o `missing='confirm'` (confirmación)
- **Antes:** La AI podía decir "Entendido, gracias" pero el flujo esperaba que el usuario complete un campo
- **Ahora:** En data collection, se usa `nextQuestion(missing)` que siempre pregunta por el campo faltante

### AG4: Eliminar lead_quality
- **Qué:** Se eliminó el campo `lead_quality` (enum: none/low/medium/high) porque no se usaba downstream
- **Archivos:** `ai-lead-qualification-assistant.json` → nodos `Build AI Request` y `Normalize AI Result`
- **Impacto:** 
  - Ahorro de ~85 tokens por request (~3-4% del total)
  - Schema más limpio y simple
  - Menos ruido en el contrato de la AI

### AG5: Corrección Precisa
- **Qué:** `maybeApply` ahora SOLO acepta campos que el usuario mencionó explícitamente en su corrección
- **Archivos:**
  - `ai-lead-qualification-assistant.json` → `Build AI Request` (nuevo campo `explicitly_mentioned_fields` en schema + instrucción en prompt)
  - `wa-conversation-orchestrator.json` → `Apply AI Assistance` (heurística `userMentionedField` + modificación de `maybeApply`)
- **Problema resuelto:** Antes, si el usuario decía "No, es en Valparaíso", la AI podía devolver `service=Vidrios` y se aplicaba aunque el usuario nunca lo mencionó
- **Solución:** 
  - La AI devuelve `explicitly_mentioned_fields: ["city"]` cuando el usuario solo menciona ciudad
  - El orquestador valida con heurística de keywords como fallback de seguridad
  - `maybeApply` solo acepta campos que están en `explicitly_mentioned_fields` O que la heurística detecta
- **Ejemplos:**
  - "No, en Valparaíso" → SOLO `city` se aplica
  - "Corrijo: quiero baldosas en Santiago" → `service` y `city` se aplican
  - "Mejor dicho, necesito 50m2" → SOLO `requirement` se aplica

### AG6: Temperatura y Timeout
- **Qué:** Ajustes de configuración para mayor determinismo y tolerancia a latencia
- **Cambios:**
  - Temperatura: `0.2` → `0.05` (más determinista para extracción estructurada)
  - Timeout: `8000ms` → `15000ms` (tolera modelos lentos o picos de latencia)
- **Archivos:**
  - `ai-lead-qualification-assistant.json` → `Build AI Request` (default en código)
  - `.env.example` (variables de entorno)
  - `docs/ai-api-directa-configuracion.md` (documentación)

---

## Archivos Modificados

| Archivo | Cambios |
|---------|---------|
| `n8n/workflows/ai-lead-qualification-assistant.json` | AG1 (catálogo), AG2 (confirmación ambigua), AG4 (eliminar lead_quality), AG5 (explicitly_mentioned_fields), AG6 (temperatura) |
| `n8n/workflows/wa-conversation-orchestrator.json` | AG2 (validación post-proceso), AG3 (consistencia reply), AG5 (corrección precisa) |
| `.env.example` | AG6 (temperatura 0.05, timeout 15000) |
| `docs/ai-api-directa-configuracion.md` | AG6 (documentación actualizada) |

---

## Backups

Backups de los workflows originales creados en:
- `n8n/workflows/backup/ai-lead-qualification-assistant.json.20260612_121208.bak`
- `n8n/workflows/backup/wa-conversation-orchestrator.json.20260612_121208.bak`

---

## Próximos Pasos Sugeridos

1. **Monitoreo en producción:** Observar comportamientos de confirmación ambigua y correcciones precisas en conversaciones reales
2. **Ajuste de heurísticas:** Si la heurística `userMentionedField` falla con ciertos sinónimos, agregar keywords al patrón
3. **Métricas:** Medir reducción en tokens (AG4) y mejora en precisión de extracción (AG5)
4. **Documentación:** Actualizar `docs/flujo-leads.md` con los nuevos comportamientos si es necesario

---

## Reportes de Fase 1

Todos los reportes de investigación están en `.hermes/plans/reports/`:
- `FASE1-AG1-catalogo.md`
- `FASE1-AG2-confirmacion-ambigua.md`
- `FASE1-AG3-consistencia-reply.md`
- `FASE1-AG4-lead-quality.md`
- `FASE1-AG5-correccion-precisa.md`
- `FASE1-AG6-ajustes-menores.md`

---

**Estado final:** ✅ LISTO PARA PRODUCCIÓN