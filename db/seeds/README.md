# Seeds

Esta carpeta almacenara datos iniciales versionados.

Seeds implementados actualmente:

- `001_lead_statuses.sql`
- `002_conversation_statuses.sql`
- `003_sellers.example.sql`
- `004_whatsapp_numbers.example.sql`

Estos archivos deben ejecutarse despues de las migraciones de esquema.

Este repositorio es publico, por lo que no debe versionar vendedores, numeros,
IDs de WhatsApp Business, JIDs, tokens ni ningun dato operativo real.

Los ejemplos `003` y `004` son plantillas sin datos sensibles. Para operar un
ambiente real, crear seeds privados fuera de Git, por ejemplo en
`.local/private-seeds/` o `db/seeds/private/`.

Reglas:

- No commitear archivos `*_real.sql`.
- No commitear datos de vendedores reales ni numeros de WhatsApp reales.
- No copiar datos operativos a demos publicas ni documentacion externa.
- Si un dato operativo estuvo publicado, tratarlo como expuesto y rotarlo cuando
  corresponda.
- Mantener vendedores incompletos como inactivos hasta completar sus datos
  operativos requeridos.
