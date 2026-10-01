-- =====================================================================
-- Media Portal — allow staff (admin + rep) to sign in
--
-- Reps need portal access to show their customers the library during
-- sales calls, grab assets to attach to emails, etc. They sign in with
-- their regular rep email; no allow-list entry needed.
--
-- Changes:
--   1. portal_current_account() returns a synthetic context for staff
--      (admin or rep) when their email isn't on an allow-list. Account
--      row is NULL; business_name shows their role so the header reads
--      "Admin view" or "Rep view" instead of a customer name.
--   2. portal_downloads.account_id becomes nullable so staff downloads
--      can be logged without being tied to a customer account.
--   3. portal_record_download() handles both — logs with NULL
--      account_id for staff downloads so admin reports can tell staff
--      activity apart from customer activity.
--
-- Idempotent — safe to re-run.
-- =====================================================================

ALTER TABLE public.portal_downloads
  ALTER COLUMN account_id DROP NOT NULL;

-- ---------------------------------------------------------------------
-- Resolve the signed-in user to EITHER an allow-list customer context
-- OR a synthetic staff context. Customer rows have a real account_id;
-- staff rows have NULL + a role label.
-- ---------------------------------------------------------------------
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

  -- Customer: on an allow-list → return their account
  RETURN QUERY
    SELECT a.id, a.business_name
    FROM public.portal_access p
    JOIN public.accounts a ON a.id = p.account_id
    WHERE LOWER(p.email) = v_email
      AND p.disabled = FALSE
    LIMIT 1;
  IF FOUND THEN RETURN; END IF;

  -- Not on allow-list → check if they're staff (admin or rep)
  SELECT role, name INTO v_role, v_name
    FROM public.profiles
    WHERE LOWER(email) = v_email
      AND role IN ('admin', 'rep')
      AND COALESCE(disabled, FALSE) = FALSE
    LIMIT 1;
  IF v_role IS NOT NULL THEN
    RETURN QUERY SELECT
      NULL::UUID AS account_id,
      ('Staff · ' || COALESCE(v_name, v_role)) AS business_name;
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.portal_current_account() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.portal_current_account() TO authenticated;

-- ---------------------------------------------------------------------
-- Log a download. Staff downloads log with NULL account_id so admin
-- reports can tell staff activity apart from customer activity.
-- ---------------------------------------------------------------------
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

  -- Try customer context first
  SELECT p.account_id INTO v_account_id
    FROM public.portal_access p
    WHERE LOWER(p.email) = v_email
      AND p.disabled = FALSE
    LIMIT 1;

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

-- Report
DO $$ BEGIN
  RAISE NOTICE '───────────────────────────────────────────';
  RAISE NOTICE 'Media portal: staff (admin + rep) can now sign in.';
  RAISE NOTICE 'portal_current_account() returns staff context when email is in profiles.';
  RAISE NOTICE 'portal_record_download() logs staff downloads with NULL account_id.';
  RAISE NOTICE '───────────────────────────────────────────';
END $$;
