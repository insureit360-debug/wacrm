-- ============================================================
-- 063_filter_contacts_by_tags_dated.sql — tag filter + date range
--
-- Same as filter_contacts_by_tags (025) plus an optional "added between"
-- range on contacts.created_at: p_from inclusive, p_to EXCLUSIVE (pass
-- the start of the day AFTER the last day wanted).
--
-- Additive: a NEW function. The original is untouched, so nothing that
-- already calls it can break. SECURITY INVOKER (same as 025): RLS still
-- scopes results to the caller's account.
-- Idempotent — safe to run multiple times.
-- ============================================================

CREATE OR REPLACE FUNCTION public.filter_contacts_by_tags_dated(
  p_tag_ids UUID[],
  p_search TEXT DEFAULT NULL,
  p_from TIMESTAMPTZ DEFAULT NULL,
  p_to TIMESTAMPTZ DEFAULT NULL,
  p_limit INT DEFAULT 25,
  p_offset INT DEFAULT 0
)
RETURNS TABLE (contact contacts, total_count BIGINT)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
  WITH matched AS (
    SELECT DISTINCT c.id, c.created_at
    FROM contacts c
    JOIN contact_tags ct ON ct.contact_id = c.id
    WHERE ct.tag_id = ANY(p_tag_ids)
      AND (p_from IS NULL OR c.created_at >= p_from)
      AND (p_to IS NULL OR c.created_at < p_to)
      AND (
        p_search IS NULL
        OR c.name ILIKE '%' || p_search || '%'
        OR c.phone ILIKE '%' || p_search || '%'
        OR c.email ILIKE '%' || p_search || '%'
      )
  ),
  page AS (
    SELECT id, count(*) OVER() AS total_count
    FROM matched
    ORDER BY created_at DESC, id
    LIMIT p_limit OFFSET p_offset
  )
  SELECT c AS contact, page.total_count
  FROM page
  JOIN contacts c ON c.id = page.id
  ORDER BY c.created_at DESC, c.id;
$$;

ALTER FUNCTION public.filter_contacts_by_tags_dated(UUID[], TEXT, TIMESTAMPTZ, TIMESTAMPTZ, INT, INT) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.filter_contacts_by_tags_dated(UUID[], TEXT, TIMESTAMPTZ, TIMESTAMPTZ, INT, INT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.filter_contacts_by_tags_dated(UUID[], TEXT, TIMESTAMPTZ, TIMESTAMPTZ, INT, INT) TO authenticated;
