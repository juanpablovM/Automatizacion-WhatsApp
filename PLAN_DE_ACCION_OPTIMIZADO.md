# Plan de Acción Optimizado: CRM WhatsApp Automatizado
**Versión:** 1.2 (Pragmática para n8n + AI controlada)
**Objetivo:** Llevar el sistema a producción con máxima confiabilidad, seguridad y el mínimo de complejidad innecesaria, incorporando AI como capa asistida de comprensión conversacional sin que gobierne el CRM.

---

## Principio Rector

La AI complementa el flujo actual, pero no reemplaza las reglas del sistema.

- **AI recomienda:** intención, calidad del lead, datos extraídos, respuesta sugerida y resumen.
- **n8n decide:** siguiente paso del workflow, validaciones, errores y llamadas externas.
- **PostgreSQL gobierna el estado:** conversaciones, leads, auditoría, asignación y deduplicación.
- **ClickUp recibe leads confirmados:** no tareas creadas directamente por AI.

---

## Sprint 0: Validación Real del Flujo (Prioridad inmediata)
*Enfoque: Confirmar que el sistema funciona con WhatsApp real antes de optimizar o agregar AI.*

### 0.1 Conectar Evolution API
- **Acción:** Solicitar QR de la instancia `principal`, escanearlo y verificar que quede en estado conectado.
- **Por qué:** Sin canal WhatsApp real abierto, cualquier mejora posterior se valida solo parcialmente.

### 0.2 Cargar Datos Reales Mínimos
- **Acción:** Cargar vendedores reales en PostgreSQL, números de WhatsApp reales y `clickup_user_id` si se usará asignación en ClickUp.
- **Por qué:** El round robin y la notificación interna solo pueden validarse con datos operativos reales.

### 0.3 Prueba End-to-End Real
- **Acción:** Enviar una conversación real desde WhatsApp y verificar: entrada por Evolution API, procesamiento en n8n, persistencia en DB, creación de lead, tarea en ClickUp y notificación al vendedor.
- **Por qué:** Esta prueba define qué debe corregirse antes de endurecer producción.

---

## Sprint 1: Seguridad y Estabilidad Base
*Enfoque: Proteger datos y asegurar recuperación operativa antes de agregar inteligencia conversacional.*

### 1.1 Seguridad de Webhooks (Crítico)
- **Acción:** Implementar validación del webhook en `WA - Inbound Entry`.
- **Criterio:** Usar HMAC si Evolution API lo soporta de forma simple; si no, usar un secreto/token compartido robusto para n8n.
- **Por qué:** Evita que terceros inyecten mensajes falsos fingiendo ser Evolution API.

### 1.2 Auditoría de Secretos y Credenciales
- **Acción:** Revisar API keys, tokens y contraseñas. Mantener secretos en variables de entorno o Credentials nativas de n8n, nunca hardcodeados en workflows.
- **Por qué:** Evita fugas si se exportan workflows o se comparte el repositorio.

### 1.3 Estrategia de Backup y Restore
- **Acción:** Crear script o procedimiento para `pg_dump`, backup del volumen de n8n y prueba documentada de restauración.
- **Por qué:** La base de datos y los workflows son activos críticos del CRM.

### 1.4 Error Workflow Operativo
- **Acción:** Validar que `OPS - Error Handler` esté conectado como error workflow y probar al menos un fallo controlado.
- **Por qué:** El proyecto ya tiene handler de errores; el foco ahora es comprobarlo en operación real.

---

## Sprint 2: AI Controlada para Calificación Conversacional
*Enfoque: Mejorar comprensión, extracción y respuesta sin delegar decisiones críticas a un agente autónomo.*

### 2.1 Sub-workflow `AI - Lead Qualification Assistant`
- **Acción:** Diseñar e implementar un sub-workflow llamado `AI - Lead Qualification Assistant`.
- **Responsabilidad:** Analizar el mensaje y contexto conversacional para proponer datos estructurados, respuesta sugerida y resumen para ClickUp.
- **Por qué:** Mantiene la AI encapsulada, testeable y fácil de activar/desactivar.

### 2.2 Entrada del Sub-workflow AI
- **Acción:** Enviar a AI solo el contexto necesario:
  - mensaje actual
  - estado conversacional actual
  - últimos mensajes relevantes
  - datos ya detectados: `service`, `city`, `requirement`
  - lead previo si existe
- **Por qué:** Reduce costo, ruido y riesgo de decisiones inconsistentes.

### 2.3 Salida Estructurada Validable
- **Acción:** Exigir una salida JSON estructurada con:
  - `intent`
  - `lead_quality`
  - `service`
  - `city`
  - `requirement`
  - `missing_fields`
  - `should_create_lead`
  - `needs_confirmation`
  - `confidence`
  - `reply_text`
  - `clickup_summary`
- **Por qué:** n8n puede validar campos y decidir con reglas explícitas.

### 2.4 Reglas de Control
- **Acción:** Documentar e implementar guardrails:
  - AI no escribe directamente en PostgreSQL
  - AI no crea tareas en ClickUp
  - AI no asigna vendedores
  - si falta información o la confianza es baja, se pregunta o pide aclaración
  - la creación de lead sigue requiriendo `servicio + ciudad + requerimiento + confirmación`
- **Por qué:** Evita que una respuesta probabilística controle el CRM.

### 2.5 Uso Inicial Recomendado
- **Acción:** Activar AI primero para extracción, clasificación y redacción controlada.
- **Por qué:** Es el punto de mayor valor con menor riesgo. Un agente autónomo completo queda descartado para la primera versión.

---

## Sprint 3: Resiliencia, Testing y Observabilidad
*Enfoque: Que el sistema sea confiable ante fallos externos y fácil de diagnosticar.*

### 3.1 Retry con Backoff Exponencial y Jitter
- **Acción:** Configurar reintentos inteligentes en ClickUp API, Evolution API saliente y notificación al vendedor.
- **Por qué:** Las APIs externas pueden fallar temporalmente o aplicar rate limiting.

### 3.2 Smoke Test End-to-End
- **Acción:** Crear o ampliar un workflow de prueba que simule entrada, conversación, creación de lead y sincronización con ClickUp.
- **Por qué:** Es más útil que tests unitarios aislados para esta arquitectura basada en n8n.

### 3.3 Observabilidad Simple
- **Acción:** Crear consultas SQL o vista operativa para:
  - mensajes procesados hoy
  - leads creados hoy
  - leads asignados por vendedor
  - errores de las últimas 24 horas
- **Por qué:** Permite saber qué está pasando sin revisar manualmente ejecuciones de n8n.

### 3.4 Logging y Correlation ID
- **Acción:** Generar un identificador trazable entre workflows, mensajes, lead, auditoría y ClickUp.
- **Por qué:** Permite seguir una conversación completa cuando algo falla.

### 3.5 Connection Pooling (Postgres)
- **Acción:** Revisar parámetros de conexión de n8n y evaluar pooling si aparecen señales de saturación.
- **Por qué:** No debe ser una optimización prematura, pero sí quedar listo como ajuste operativo.

---

## Sprint 4: Optimización Avanzada (Opcional/A futuro)
*Enfoque: Escalar solo cuando el uso real lo justifique.*

### 4.1 Redis como Buffer de Negocio
- **Acción:** Evaluar Redis para colas o buffer de tareas críticas.
- **Por qué:** Solo tiene sentido si aparecen picos de tráfico o latencia operativa.

### 4.2 n8n en Modo Queue (Workers)
- **Acción:** Migrar n8n a workers con Redis si una sola instancia no alcanza.
- **Por qué:** Solo necesario con carga sostenida o necesidad clara de concurrencia.

### 4.3 Data Retention
- **Acción:** Crear política de retención para auditoría y logs históricos.
- **Por qué:** Mantiene la base liviana sin borrar información útil antes de tiempo.

### 4.4 Dashboard Completo
- **Acción:** Evaluar Grafana u otra herramienta solo después de validar consultas operativas simples.
- **Por qué:** Evita sobreingeniería antes de tener métricas reales de uso.

---

## Indicadores Clave de Éxito (KPIs)
1. **Flujo real:** 1 conversación real completa desde WhatsApp hasta ClickUp y notificación.
2. **Seguridad:** 100% de webhooks protegidos antes de exposición pública.
3. **Integridad:** 0 leads confirmados perdidos por fallos de red o reintentos agotados sin auditoría.
4. **AI controlada:** 100% de salidas AI validadas por esquema y reglas antes de modificar estado.
5. **Operación:** MTTR menor a 10 minutos para fallos comunes documentados.

---

## Regla de Orden

1. Primero hacerlo funcionar con WhatsApp real.
2. Después protegerlo y asegurar recuperación.
3. Después incorporar AI como capa controlada.
4. Después hacerlo resistente y observable.
5. Finalmente escalarlo si el volumen real lo exige.
