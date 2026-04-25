SELECT 'CREATE DATABASE crm_whatsapp_app'
WHERE NOT EXISTS (
  SELECT 1
  FROM pg_database
  WHERE datname = 'crm_whatsapp_app'
)\gexec

SELECT 'CREATE DATABASE evolution_api'
WHERE NOT EXISTS (
  SELECT 1
  FROM pg_database
  WHERE datname = 'evolution_api'
)\gexec
