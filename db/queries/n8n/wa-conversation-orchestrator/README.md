# WA Conversation Orchestrator — Queries

Este directorio documenta los queries SQL embebidos en el workflow
`wa-conversation-orchestrator.json` de n8n.

## Relación con el workflow

Los queries en este directorio son la **fuente de referencia documentada**.
El workflow n8n embebe los mismos queries con parámetros posicionales
(`$1`, `$2`, ...) en lugar de named params.

**Regla**: Si modificás un query SQL en el workflow, actualizá el archivo
documentado correspondiente ACÁ. Y viceversa.

## Archivos

| Archivo | Nodo en workflow | Propósito |
|---------|------------------|-----------|
| `01_load_active_context.sql` | Load Conversation State | Carga conversación activa, lead anterior, mensajes recientes |
| `02_create_conversation.sql` | — | Creación inicial de conversación |
| `03_insert_incoming_message.sql` | — | Inserción de mensaje entrante |
| `04_upsert_attachment_metadata.sql` | — | Metadata de adjuntos |
| `05_update_conversation_state.sql` | Persist Conversation State | UPDATE/INSERT de conversación, mensaje, auditoría |
| `06_insert_conversation_audit.sql` | — | Inserción de evento de auditoría |

## qualification_context

Estructura del campo `qualification_context` (JSONB) en `conversations`:

```json
{
  "name": "string | null",
  "product": "string | null",
  "commune": "string | null",
  "quantity": "string | null",
  "measurements": "string | null",
  "use_case": "string | null",
  "modality": "string | null",
  "urgency": "string | null",
  "desired_date": "string | null",
  "photos": "boolean | null",
  "terrain": "string | null",
  "truck_access": "boolean | null",
  "debris_removal": "boolean | null",
  "customer_type": "string | null",
  "company": "string | null",
  "company_rut": "string | null",
  "contact_name": "string | null",
  "contact_role": "string | null",
  "email": "string | null",
  "purchase_order": "boolean | null",
  "invoice_required": "boolean | null",
  "address": "string | null",
  "access_restrictions": "string | null",
  "reception_contact": "string | null",
  "sale_number": "string | null",
  "purchase_date": "string | null",
  "issue_description": "string | null",
  "payment_amount": "string | null",
  "payment_method": "string | null",
  "quote_number": "string | null"
}
```

## pending_question_key

Indica qué pregunta está esperando respuesta. Puede ser cualquier key de
`qualification_context` (name, product, commune, quantity, etc.) o
`final_confirmation`. Cuando es `null`, no hay pregunta pendiente.
