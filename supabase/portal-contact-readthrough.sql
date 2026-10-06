-- =====================================================================
-- Portal sign-in: read through to account_contacts
--
-- Per Dan: once an account is on the portal (has any portal_access row),
-- every current contact on that account should be able to sign in —
-- no snapshot, no backfill, always current.
--
-- Changes:
--   portal_current_account() — if the signed-in email doesn't match a
--     portal_access row, it ALSO checks account_contacts.email on any
--     account that already has a portal_access row. Same gate (account
--     must be on the portal) so general accounts aren't exposed.
--
--   portal_record_download() — same read-through so downloads work for
--     contact-based access, logged against the correct account.
--
-- Non-destructive: schema unchanged, portal_access table unchanged,
-- admin UI unchanged. Only RPC behavior broadens.
-- =====================================================================

CREATE OR REPLACE FUNCTION public.portal_current_account()
RETURNS TABLE (account_id UUID, business_name TEXT)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_email TEXT;
  v_role TEXT;
  v_name TEXT;
BEGIN
  SELECT LOWER(email) INTO v_email FROM auth.users WHERE id = auth.uid();
  IF v_email IS NULL THEN RETURN; END IF;

  -- 1. Direct allow-list match (portal_access)
  RETURN QUERY
    SELECT a.id, a.business_name
    FROM public.portal_access p
    JOIN public.accounts a ON a.id = p.account_id
    WHERE LOWER(p.email) = v_email
      AND p.disabled = FALSE
    LIMIT 1;
  IF FOUND THEN RETURN; END IF;

  -- 2. Contact-based match. The account must already have at least
  --    one portal_access row (meaning admin added it to the portal).
  --    Non-portal accounts' contacts are blocked by that EXISTS gate.
  RETURN QUERY
    SELECT a.id, a.business_name
    FROM public.account_contacts c
    JOIN public.accounts a ON a.id = c.account_id
    WHERE LOWER(c.email) = v_email
      AND c.deleted_at IS NULL
      AND EXISTS (
        SELECT 1 FROM public.portal_access p
        WHERE p.account_id = a.id AND p.disabled = FALSE
      )
    LIMIT 1;
  IF FOUND THEN RETURN; END IF;

  -- 3. Staff fallback — unchanged
  SELECT role, name INTO v_role, v_name
    FROM public.profiles
    WHERE LOWER(email) = v_email
      AND role IN ('admin', 'rep')
      AND COALESCE(disabled, FALSE) = FALSE
    LIMIT 1;
  IF v_role IS NOT NULL THEN
    RETURN QUERY SELECT NULL::UUID, ('Staff · ' || COALESCE(v_name, v_role));
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.portal_current_account() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.portal_current_account() TO authenticated;

-- Same read-through for download logging.
CREATE OR REPLACE FUNCTION public.portal_record_download(p_asset_path TEXT)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_email TEXT;
  v_account_id UUID;
  v_is_staff BOOLEAN;
BEGIN
  IF p_asset_path IS NULL OR LENGTH(p_asset_path) = 0 THEN
    RAISE EXCEPTION 'asset_path required';
  END IF;

  SELECT LOWER(email) INTO v_email FROM auth.users WHERE id = auth.uid();
  IF v_email IS NULL THEN RAISE EXCEPTION 'not authenticated'; END IF;

  -- Direct allow-list first
  SELECT p.account_id INTO v_account_id
    FROM public.portal_access p
    WHERE LOWER(p.email) = v_email
      AND p.disabled = FALSE
    LIMIT 1;

  -- Then contact-based (same gate: account must be on the portal)
  IF v_account_id IS NULL THEN
    SELECT a.id INTO v_account_id
      FROM public.account_contacts c
      JOIN public.accounts a ON a.id = c.account_id
      WHERE LOWER(c.email) = v_email
        AND c.deleted_at IS NULL
        AND EXISTS (
          SELECT 1 FROM public.portal_access p
          WHERE p.account_id = a.id AND p.disabled = FALSE
        )
      LIMIT 1;
  END IF;

  IF v_account_id IS NOT NULL THEN
    INSERT INTO public.portal_downloads (account_id, asset_path, user_email)
      VALUES (v_account_id, p_asset_path, v_email);
    RETURN;
  END IF;

  -- Staff fallback
  SELECT TRUE INTO v_is_staff
    FROM public.profiles
    WHERE LOWER(email) = v_email
      AND role IN ('admin', 'rep')
      AND COALESCE(disabled, FALSE) = FALSE
    LIMIT 1;
  IF v_is_staff THEN
    INSERT INTO public.portal_downloads (account_id, asset_path, user_email)
      VALUES (NULL, p_asset_path, v_email);
    RETURN;
  END IF;

  RAISE EXCEPTION 'not authorized';
END;
$$;

REVOKE ALL ON FUNCTION public.portal_record_download(TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.portal_record_download(TEXT) TO authenticated;

DO $$ BEGIN
  RAISE NOTICE '───────────────────────────────────────────';
  RAISE NOTICE 'portal_current_account + portal_record_download now read through to account_contacts.';
  RAISE NOTICE 'Rachael-style contacts on portal-enabled accounts can sign in without a portal_access row.';
  RAISE NOTICE '───────────────────────────────────────────';
END $$;
