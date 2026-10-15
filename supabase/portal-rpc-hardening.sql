-- =====================================================================
-- Portal RPC hardening — closes the 8 findings from the 2026-10-15 review
--
-- Replaces three functions and adds one index:
--   • portal_current_account()  — staff first, stable ordering, empty-email guard
--   • portal_record_download()  — reuses current_account for a single source of truth
--   • handle_new_user()         — short-circuits for contact-based portal users too
--   • idx_account_contacts_lower_email — kills the seq-scan on every sign-in
--
-- Each findings number below maps to the review item it closes.
--
-- Idempotent: all CREATE OR REPLACE / CREATE INDEX IF NOT EXISTS.
-- Non-destructive: no schema changes, no data migration.
-- =====================================================================


-- ---------------------------------------------------------------------
-- Index: speed up every readthrough lookup.
-- Fix #6 — before this, every portal sign-in and every download
-- triggered a sequential scan of account_contacts.
-- ---------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_account_contacts_lower_email
  ON public.account_contacts (LOWER(email))
  WHERE deleted_at IS NULL AND email <> '';


-- ---------------------------------------------------------------------
-- portal_current_account()
--
-- Order of resolution (changed):
--   1. STAFF FIRST  (fix #2, #5)      — admin/rep is always staff context
--                                       even if their email also appears
--                                       in account_contacts.
--   2. Direct portal_access match     — unchanged
--   3. Contact-readthrough            — stable ORDER BY (fix #3), empty-
--                                       email guard (fix #7).
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
  IF v_email IS NULL OR v_email = '' THEN RETURN; END IF;

  -- 1. Staff fallback FIRST. Must beat the contact-readthrough so an
  --    admin/rep listed as an account contact (admin added themselves
  --    while testing; rep added their gmail as an "office contact")
  --    still gets staff context and their downloads log with
  --    account_id = NULL as the audit expects.
  SELECT role, name INTO v_role, v_name
    FROM public.profiles
    WHERE LOWER(email) = v_email
      AND role IN ('admin', 'rep')
      AND COALESCE(disabled, FALSE) = FALSE
    LIMIT 1;
  IF v_role IS NOT NULL THEN
    RETURN QUERY SELECT NULL::UUID, ('Staff · ' || COALESCE(v_name, v_role));
    RETURN;
  END IF;

  -- 2. Direct portal_access match (unchanged).
  RETURN QUERY
    SELECT a.id, a.business_name
    FROM public.portal_access p
    JOIN public.accounts a ON a.id = p.account_id
    WHERE LOWER(p.email) = v_email
      AND p.disabled = FALSE
    LIMIT 1;
  IF FOUND THEN RETURN; END IF;

  -- 3. Contact-readthrough. Stable ORDER BY so a contact listed on
  --    multiple portal-enabled accounts always resolves to the same
  --    one between sign-ins (fix #3). Empty-email guard (fix #7).
  RETURN QUERY
    SELECT a.id, a.business_name
    FROM public.account_contacts c
    JOIN public.accounts a ON a.id = c.account_id
    WHERE LOWER(c.email) = v_email
      AND c.email <> ''
      AND c.deleted_at IS NULL
      AND EXISTS (
        SELECT 1 FROM public.portal_access p
        WHERE p.account_id = a.id AND p.disabled = FALSE
      )
    ORDER BY a.business_name, a.id
    LIMIT 1;
END;
$$;

REVOKE ALL ON FUNCTION public.portal_current_account() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.portal_current_account() TO authenticated;


-- ---------------------------------------------------------------------
-- portal_record_download(p_asset_path TEXT)
--
-- Delegates the resolution to portal_current_account() so there's ONE
-- source of truth per session.
--
-- Fixes:
--   #4 — the download could previously log against a DIFFERENT account
--        than the one the user was browsing, because record_download
--        ran its own LIMIT 1 lookup.
--   #5 — staff who were also contacts previously had their downloads
--        logged with a customer account_id; now they get NULL again.
--   #8 — one resolver instead of two copies.
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
  v_business_name TEXT;
BEGIN
  IF p_asset_path IS NULL OR LENGTH(p_asset_path) = 0 THEN
    RAISE EXCEPTION 'asset_path required';
  END IF;

  SELECT LOWER(email) INTO v_email FROM auth.users WHERE id = auth.uid();
  IF v_email IS NULL OR v_email = '' THEN RAISE EXCEPTION 'not authenticated'; END IF;

  -- Reuse the browse-context resolver so the account logged on the
  -- download row is always the one the user is currently viewing.
  -- NULL account_id means staff — intentional, matches the audit's
  -- "customer vs staff" split.
  SELECT ca.account_id, ca.business_name
    INTO v_account_id, v_business_name
    FROM public.portal_current_account() ca
    LIMIT 1;

  -- Staff: v_business_name starts with 'Staff · ' and account_id is NULL.
  -- Non-staff with no account resolved: both NULL — not authorized.
  IF v_business_name IS NULL AND v_account_id IS NULL THEN
    RAISE EXCEPTION 'not authorized';
  END IF;

  INSERT INTO public.portal_downloads (account_id, asset_path, user_email)
    VALUES (v_account_id, p_asset_path, v_email);
END;
$$;

REVOKE ALL ON FUNCTION public.portal_record_download(TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.portal_record_download(TEXT) TO authenticated;


-- ---------------------------------------------------------------------
-- handle_new_user()
--
-- Adds the second short-circuit the review flagged (fix #1).
-- Before: a brand-new contact-based portal user (listed on
-- account_contacts of a portal-enabled account, NOT on portal_access)
-- fell through to the rep-profile INSERT and either hit the
-- "Database error saving new user" or ended up with a bogus role='rep'
-- profile row.
-- After: the trigger short-circuits for them the same way it does for
-- direct portal_access rows.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  inv RECORD;
  md JSONB;
  assigned_rep_id TEXT;
  assigned_role TEXT;
  assigned_commission NUMERIC;
  assigned_territory TEXT[];
  assigned_name TEXT;
  assigned_disabled BOOLEAN;
  was_invited BOOLEAN;
BEGIN
  -- 1. Direct portal_access match — unchanged.
  IF EXISTS (
    SELECT 1 FROM public.portal_access
    WHERE LOWER(email) = LOWER(NEW.email)
  ) THEN
    RETURN NEW;
  END IF;

  -- 2. NEW: contact-based portal user. Same empty-email + soft-delete
  --    guards as portal_current_account's readthrough so the two agree
  --    on who's a portal user.
  IF NEW.email IS NOT NULL AND NEW.email <> '' THEN
    IF EXISTS (
      SELECT 1 FROM public.account_contacts c
      JOIN public.portal_access p
        ON p.account_id = c.account_id AND p.disabled = FALSE
      WHERE LOWER(c.email) = LOWER(NEW.email)
        AND c.email <> ''
        AND c.deleted_at IS NULL
    ) THEN
      RETURN NEW;
    END IF;
  END IF;

  -- 3. Reps/admins — unchanged.
  md := COALESCE(NEW.raw_user_meta_data, '{}'::JSONB);
  SELECT * INTO inv FROM public.pending_invites WHERE email = NEW.email;
  was_invited := FOUND;

  IF inv.rep_id IS NOT NULL AND inv.rep_id <> '' THEN
    assigned_rep_id := inv.rep_id;
  ELSE
    assigned_rep_id := 'R-' || LPAD((public.next_counter('rep') + 1)::TEXT, 3, '0');
  END IF;

  assigned_disabled   := NOT was_invited;
  assigned_role       := COALESCE(inv.role, 'rep');
  assigned_commission := COALESCE(inv.commission, 20);
  assigned_territory  := COALESCE(inv.territory, '{}'::TEXT[]);
  assigned_name       := COALESCE(inv.name, md->>'name', SPLIT_PART(NEW.email, '@', 1));

  INSERT INTO public.profiles (
    id, email, name, role, rep_id, commission, territory,
    cell, company, street, city, state, zip, disabled
  ) VALUES (
    NEW.id, NEW.email, assigned_name, assigned_role, assigned_rep_id,
    assigned_commission, assigned_territory,
    md->>'cell', md->>'company', md->>'street', md->>'city', md->>'state', md->>'zip',
    assigned_disabled
  )
  ON CONFLICT (id) DO NOTHING;

  DELETE FROM public.pending_invites WHERE email = NEW.email;
  RETURN NEW;
END $$;


DO $$ BEGIN
  RAISE NOTICE '───────────────────────────────────────────';
  RAISE NOTICE 'Portal RPC hardening applied.';
  RAISE NOTICE '  • portal_current_account: staff FIRST, stable ordering, empty-email guard';
  RAISE NOTICE '  • portal_record_download: reuses current_account';
  RAISE NOTICE '  • handle_new_user: short-circuits contact-based portal users';
  RAISE NOTICE '  • idx_account_contacts_lower_email created';
  RAISE NOTICE '───────────────────────────────────────────';
END $$;
