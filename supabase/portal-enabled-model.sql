-- =====================================================================
-- Portal access redesign — single bit per account, read-through to
-- the account's primary email + its Additional contacts.
--
-- Replaces the portal_access allow-list approach. Rationale per Dan:
--   "In order for an account to gain access to the media portal, they
--    must be added by admin. But, if a rep or admin want to include
--    another contact for the media portal all they will need to do is
--    add that contact under accounts."
--
-- Model:
--   1. accounts.portal_enabled BOOLEAN — admin flips this ON to grant
--      the whole account access, OFF to revoke it.
--   2. portal_current_account() looks up the signed-in email against
--      accounts.email AND account_contacts.email, filtered by
--      portal_enabled = TRUE.
--   3. No per-email rows to manage. Adding/removing a contact in the
--      account's Additional contacts section automatically grants or
--      removes portal access for that email on the next sign-in.
--
-- Migration preserves current state: every account that has an active
-- (non-revoked) row in the old portal_access table gets flipped to
-- portal_enabled = TRUE.
--
-- Idempotent — safe to re-run.
-- =====================================================================

-- 1. Add the toggle
ALTER TABLE public.accounts
  ADD COLUMN IF NOT EXISTS portal_enabled BOOLEAN NOT NULL DEFAULT FALSE;

CREATE INDEX IF NOT EXISTS accounts_portal_enabled_idx
  ON public.accounts (portal_enabled)
  WHERE portal_enabled = TRUE;

-- 2. Migrate state from the old portal_access table (if it exists and
--    has rows). Any account with at least one active email becomes
--    portal_enabled = TRUE.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables
             WHERE table_schema = 'public' AND table_name = 'portal_access') THEN
    UPDATE public.accounts a
    SET portal_enabled = TRUE
    WHERE EXISTS (
      SELECT 1 FROM public.portal_access p
      WHERE p.account_id = a.id AND p.disabled = FALSE
    )
    AND a.portal_enabled = FALSE;
    RAISE NOTICE 'Flipped portal_enabled=TRUE for accounts with active portal_access rows.';
  END IF;
END $$;

-- 3. Rewrite portal_current_account to read through to accounts.email
--    and account_contacts.email, gated by portal_enabled.
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

  -- Customer: match by account primary email OR any additional contact
  -- email, filtered by portal_enabled = TRUE.
  RETURN QUERY
    SELECT a.id, a.business_name
    FROM public.accounts a
    WHERE a.portal_enabled = TRUE
      AND (
        LOWER(a.email) = v_email
        OR EXISTS (
          SELECT 1 FROM public.account_contacts c
          WHERE c.account_id = a.id
            AND c.deleted_at IS NULL
            AND LOWER(c.email) = v_email
        )
      )
    LIMIT 1;
  IF FOUND THEN RETURN; END IF;

  -- Staff fallback — unchanged.
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

-- 4. Same read-through for download logging.
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

  -- Customer: find the enabled account this email belongs to.
  SELECT a.id INTO v_account_id
    FROM public.accounts a
    WHERE a.portal_enabled = TRUE
      AND (
        LOWER(a.email) = v_email
        OR EXISTS (
          SELECT 1 FROM public.account_contacts c
          WHERE c.account_id = a.id
            AND c.deleted_at IS NULL
            AND LOWER(c.email) = v_email
        )
      )
    LIMIT 1;

  IF v_account_id IS NOT NULL THEN
    INSERT INTO public.portal_downloads (account_id, asset_path, user_email)
      VALUES (v_account_id, p_asset_path, v_email);
    RETURN;
  END IF;

  -- Staff fallback — log with NULL account_id.
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

-- 5. Report
DO $$
DECLARE n_enabled INT; n_total INT;
BEGIN
  SELECT COUNT(*) INTO n_enabled FROM public.accounts WHERE portal_enabled = TRUE;
  SELECT COUNT(*) INTO n_total   FROM public.accounts;
  RAISE NOTICE '───────────────────────────────────────────';
  RAISE NOTICE 'Portal access redesign installed.';
  RAISE NOTICE 'Accounts with portal_enabled=TRUE: % of %', n_enabled, n_total;
  RAISE NOTICE 'From now on: toggle portal_enabled on an account; its primary email + every additional contact gets access automatically.';
  RAISE NOTICE 'portal_access table is unused but kept for audit history. You can DROP it later if you want.';
  RAISE NOTICE '───────────────────────────────────────────';
END $$;
