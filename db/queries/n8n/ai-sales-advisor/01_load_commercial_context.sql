-- Inputs esperados:
-- :message_text
-- :service (nullable)
-- :city (nullable)
-- :catalog_limit
-- :faq_limit
-- :slot_limit

WITH params AS (
  SELECT
    LOWER(COALESCE(:message_text, '')) AS message_text,
    LOWER(NULLIF(COALESCE(:service, ''), '')) AS service,
    LOWER(NULLIF(COALESCE(:city, ''), '')) AS city,
    COALESCE(:catalog_limit, 8)::INTEGER AS catalog_limit,
    COALESCE(:faq_limit, 8)::INTEGER AS faq_limit,
    COALESCE(:slot_limit, 6)::INTEGER AS slot_limit
),
matched_catalog AS (
  SELECT
    ci.id,
    ci.sku,
    ci.name,
    ci.item_type,
    cc.name AS category_name,
    ci.short_description,
    ci.long_description,
    ci.service_keywords,
    ci.applicable_cities,
    ci.restrictions,
    ci.metadata,
    (
      CASE
        WHEN p.service IS NOT NULL AND LOWER(ci.name) LIKE '%' || p.service || '%' THEN 30
        ELSE 0
      END
      + CASE
        WHEN p.service IS NOT NULL AND EXISTS (
          SELECT 1
          FROM unnest(ci.service_keywords) AS kw
          WHERE LOWER(kw) LIKE '%' || p.service || '%'
             OR p.service LIKE '%' || LOWER(kw) || '%'
        ) THEN 25
        ELSE 0
      END
      + CASE
        WHEN p.message_text <> '' AND LOWER(ci.name) <> ''
          AND p.message_text LIKE '%' || LOWER(ci.name) || '%'
        THEN 20
        ELSE 0
      END
      + CASE
        WHEN p.city IS NOT NULL AND (
          cardinality(ci.applicable_cities) = 0
          OR EXISTS (
            SELECT 1
            FROM unnest(ci.applicable_cities) AS city_name
            WHERE LOWER(city_name) = p.city
          )
        ) THEN 10
        ELSE 0
      END
    ) AS priority_score
  FROM catalog_items ci
  LEFT JOIN catalog_categories cc ON cc.id = ci.category_id
  CROSS JOIN params p
  WHERE ci.deleted_at IS NULL
    AND ci.is_active = TRUE
    AND (
      p.message_text <> ''
      OR p.service IS NOT NULL
      OR p.city IS NOT NULL
    )
  ORDER BY priority_score DESC, ci.name ASC
  LIMIT (SELECT catalog_limit FROM params)
),
active_price_rules AS (
  SELECT
    pr.catalog_item_id,
    jsonb_agg(
      jsonb_build_object(
        'code', pr.code,
        'price_type', pr.price_type,
        'currency', pr.currency,
        'amount', pr.amount,
        'amount_min', pr.amount_min,
        'amount_max', pr.amount_max,
        'unit', pr.unit,
        'formula', pr.formula,
        'conditions', pr.conditions,
        'is_reference', pr.is_reference,
        'effective_from', pr.effective_from,
        'effective_to', pr.effective_to
      )
      ORDER BY pr.effective_from DESC NULLS LAST, pr.id DESC
    ) AS rules
  FROM price_rules pr
  WHERE pr.deleted_at IS NULL
    AND pr.is_active = TRUE
    AND (pr.effective_from IS NULL OR pr.effective_from <= CURRENT_DATE)
    AND (pr.effective_to IS NULL OR pr.effective_to >= CURRENT_DATE)
  GROUP BY pr.catalog_item_id
),
commercial_context AS (
  SELECT
    COALESCE(
      jsonb_agg(
        jsonb_build_object(
          'id', mc.id,
          'sku', mc.sku,
          'name', mc.name,
          'item_type', mc.item_type,
          'category_name', mc.category_name,
          'short_description', mc.short_description,
          'long_description', mc.long_description,
          'service_keywords', mc.service_keywords,
          'applicable_cities', mc.applicable_cities,
          'restrictions', mc.restrictions,
          'metadata', mc.metadata,
          'priority_score', mc.priority_score,
          'price_rules', COALESCE(apr.rules, '[]'::JSONB)
        )
        ORDER BY mc.priority_score DESC, mc.name ASC
      ),
      '[]'::JSONB
    ) AS catalog_items
  FROM matched_catalog mc
  LEFT JOIN active_price_rules apr ON apr.catalog_item_id = mc.id
),
conditions_context AS (
  SELECT
    COALESCE(
      jsonb_agg(
        jsonb_build_object(
          'code', cc.code,
          'title', cc.title,
          'condition_type', cc.condition_type,
          'body', cc.body,
          'applies_to', cc.applies_to,
          'effective_from', cc.effective_from,
          'effective_to', cc.effective_to
        )
        ORDER BY cc.condition_type ASC, cc.title ASC
      ),
      '[]'::JSONB
    ) AS conditions
  FROM commercial_conditions cc
  WHERE cc.deleted_at IS NULL
    AND cc.is_active = TRUE
    AND (cc.effective_from IS NULL OR cc.effective_from <= CURRENT_DATE)
    AND (cc.effective_to IS NULL OR cc.effective_to >= CURRENT_DATE)
),
faq_context AS (
  SELECT
    COALESCE(
      jsonb_agg(
        jsonb_build_object(
          'question', q.question,
          'answer', q.answer,
          'tags', q.tags,
          'applies_to', q.applies_to,
          'priority', q.priority
        )
        ORDER BY q.priority DESC, q.id DESC
      ),
      '[]'::JSONB
    ) AS faqs
  FROM (
    SELECT fe.*
    FROM faq_entries fe
    CROSS JOIN params p
    WHERE fe.deleted_at IS NULL
      AND fe.is_active = TRUE
      AND (
        p.message_text = ''
        OR LOWER(fe.question) LIKE '%' || p.message_text || '%'
        OR EXISTS (
          SELECT 1
          FROM unnest(fe.tags) AS tag
          WHERE p.message_text LIKE '%' || LOWER(tag) || '%'
        )
      )
    ORDER BY fe.priority DESC, fe.id DESC
    LIMIT (SELECT faq_limit FROM params)
  ) q
),
objection_context AS (
  SELECT
    COALESCE(
      jsonb_agg(
        jsonb_build_object(
          'objection_type', op.objection_type,
          'customer_signal', op.customer_signal,
          'recommended_response', op.recommended_response,
          'escalation_rule', op.escalation_rule,
          'priority', op.priority
        )
        ORDER BY op.priority DESC, op.id DESC
      ),
      '[]'::JSONB
    ) AS objections
  FROM objection_playbooks op
  WHERE op.deleted_at IS NULL
    AND op.is_active = TRUE
),
agenda_context AS (
  SELECT
    COALESCE(
      jsonb_agg(
        jsonb_build_object(
          'id', s.id,
          'slot_type', s.slot_type,
          'starts_at', s.starts_at,
          'ends_at', s.ends_at,
          'timezone', s.timezone,
          'city', s.city,
          'capacity', s.capacity,
          'booked_count', s.booked_count,
          'status', s.status
        )
        ORDER BY s.starts_at ASC
      ),
      '[]'::JSONB
    ) AS available_slots
  FROM (
    SELECT aps.*
    FROM appointment_slots aps
    CROSS JOIN params p
    WHERE aps.deleted_at IS NULL
      AND aps.status = 'available'
      AND aps.starts_at > NOW()
      AND aps.booked_count < aps.capacity
      AND (p.city IS NULL OR aps.city IS NULL OR LOWER(aps.city) = p.city)
    ORDER BY aps.starts_at ASC
    LIMIT (SELECT slot_limit FROM params)
  ) s
)
SELECT jsonb_build_object(
  'catalog_items', commercial_context.catalog_items,
  'conditions', conditions_context.conditions,
  'faqs', faq_context.faqs,
  'objections', objection_context.objections,
  'available_slots', agenda_context.available_slots
) AS commercial_context
FROM commercial_context
CROSS JOIN conditions_context
CROSS JOIN faq_context
CROSS JOIN objection_context
CROSS JOIN agenda_context;
