-- =====================================================================
-- Reflect Co — Media Portal database (v2, clean rebuild)
--
-- This file replaces every earlier portal migration. It:
--   1. Drops the old schema in full (portal_authorized_emails,
--      portal_downloads, related functions and triggers)
--   2. Installs the v2 schema
--
-- Design (v2):
--   * portal_access — allow-list of {account_id, email}. NO source
--     column, NO auto-sync trigger. Every row is an explicit admin
--     decision made in the CRM's "Media portal access" panel.
--   * portal_downloads — one row per download, for the admin's audit
--     view in the CRM.
--   * portal_current_account() — the ONE RPC the portal client calls
--     to find its account context. Runs SECURITY DEFINER so portal
--     users don't need direct SELECT on the allow-list.
--   * portal_record_download(path) — the ONE RPC the portal client
--     calls when a download starts.
--   * is_staff_email(email) — returns TRUE if the email exists in
--     profiles with role IN ('admin','rep'). Used by the guard
--     trigger to block staff emails at the DB level.
--   * BEFORE INSERT/UPDATE trigger on portal_access refuses any row
--     whose email is a staff email. From every code path — the CRM
--     UI, raw SQL, my future queries, anything.
--
-- Isolation:
--   Portal users have no admin role, no rep_id. Every existing CRM
--   table's RLS policy blocks them. This migration adds NO grants to
--   any CRM table.
--
-- Idempotent — safe to re-run.
-- =====================================================================

-- ---------------------------------------------------------------------
-- Step 1: Drop v1 schema (if present)
-- ---------------------------------------------------------------------
DROP TRIGGER IF EXISTS trg_sync_portal_primary_email ON public.accounts;
DROP TRIGGER IF EXISTS trg_reject_staff_portal_email ON public.portal_authorized_emails;

DROP FUNCTION IF EXISTS public.sync_portal_primary_email() CASCADE;
DROP FUNCTION IF EXISTS public.reject_staff_portal_email() CASCADE;
DROP FUNCTION IF EXISTS public.portal_resolve_context() CASCADE;
DROP FUNCTION IF EXISTS public.portal_log_download(TEXT) CASCADE;
DROP FUNCTION IF EXISTS public.is_staff_email(TEXT) CASCADE;

DROP TABLE IF EXISTS public.portal_authorized_emails CASCADE;
DROP TABLE IF EXISTS public.portal_downloads CASCADE;

-- ---------------------------------------------------------------------
-- Step 2: Helpers
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.is_staff_email(p_email TEXT)
RETURNS BOOLEAN
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
STABLE
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.profiles
    WHERE LOWER(email) = LOWER(p_email)
      AND role IN ('admin', 'rep')
      AND COALESCE(disabled, FALSE) = FALSE
  );
$$;

REVOKE ALL ON FUNCTION public.is_staff_email(TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.is_staff_email(TEXT) TO authenticated;

-- ---------------------------------------------------------------------
-- Step 3: portal_access — the allow-list
-- ---------------------------------------------------------------------
CREATE TABLE public.portal_access (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  account_id UUID NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  added_by UUID REFERENCES auth.users(id),
  added_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  disabled BOOLEAN NOT NULL DEFAULT FALSE
);

CREATE UNIQUE INDEX portal_access_uidx
  ON public.portal_access (account_id, LOWER(email));

CREATE INDEX portal_access_email_idx
  ON public.portal_access (LOWER(email))
  WHERE disabled = FALSE;

ALTER TABLE public.portal_access ENABLE ROW LEVEL SECURITY;

-- Admin sees and manages everything
CREATE POLICY "portal_access admin all"
  ON public.portal_access
  FOR ALL TO authenticated
  USING (public.is_admin())
  WITH CHECK (public.is_admin());

-- Reps read rows for their own accounts (so they can see who's on the list)
CREATE POLICY "portal_access rep read"
  ON public.portal_access
  FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.accounts a
      WHERE a.id = portal_access.account_id
        AND a.rep_id = (SELECT rep_id FROM public.profiles WHERE id = auth.uid())
    )
  );

-- Portal users get nothing directly — they read via portal_current_account()

-- ---------------------------------------------------------------------
-- Step 4: Staff-email guard trigger
-- Blocks any INSERT/UPDATE whose email belongs to a staff user.
-- Fires from every code path — CRM UI, raw SQL, RPCs, anything.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.reject_staff_portal_email()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.email IS NOT NULL AND public.is_staff_email(NEW.email) THEN
    RAISE EXCEPTION 'Cannot authorize a staff email (%) for portal access. Staff sign in through the CRM, not the media portal.', NEW.email;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_reject_staff_portal_email
  BEFORE INSERT OR UPDATE OF email ON public.portal_access
  FOR EACH ROW
  EXECUTE FUNCTION public.reject_staff_portal_email();

-- ---------------------------------------------------------------------
-- Step 5: portal_downloads — audit log
-- ---------------------------------------------------------------------
CREATE TABLE public.portal_downloads (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  account_id UUID NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  asset_path TEXT NOT NULL,
  user_email TEXT,
  downloaded_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX portal_downloads_account_idx
  ON public.portal_downloads (account_id, downloaded_at DESC);

CREATE INDEX portal_downloads_asset_idx
  ON public.portal_downloads (asset_path);

ALTER TABLE public.portal_downloads ENABLE ROW LEVEL SECURITY;

CREATE POLICY "portal_downloads admin read"
  ON public.portal_downloads
  FOR SELECT TO authenticated
  USING (public.is_admin());

CREATE POLICY "portal_downloads rep read"
  ON public.portal_downloads
  FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.accounts a
      WHERE a.id = portal_downloads.account_id
        AND a.rep_id = (SELECT rep_id FROM public.profiles WHERE id = auth.uid())
    )
  );

-- Writes come through portal_record_download() as SECURITY DEFINER

-- ---------------------------------------------------------------------
-- Step 6: RPCs
-- ---------------------------------------------------------------------

-- Returns {account_id, business_name} for the signed-in email, or empty
-- if the email isn't on any account's allow-list. Called by the portal
-- client right after magic-link sign-in.
CREATE OR REPLACE FUNCTION public.portal_current_account()
RETURNS TABLE (account_id UUID, business_name TEXT)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_email TEXT;
BEGIN
  SELECT LOWER(email) INTO v_email FROM auth.users WHERE id = auth.uid();
  IF v_email IS NULL THEN RETURN; END IF;

  RETURN QUERY
    SELECT a.id, a.business_name
    FROM public.portal_access p
    JOIN public.accounts a ON a.id = p.account_id
    WHERE LOWER(p.email) = v_email
      AND p.disabled = FALSE
    LIMIT 1;
END;
$$;

REVOKE ALL ON FUNCTION public.portal_current_account() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.portal_current_account() TO authenticated;

-- Records a download for the signed-in email's account. Called by the
-- portal client every time Download is clicked.
CREATE OR REPLACE FUNCTION public.portal_record_download(p_asset_path TEXT)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_email TEXT;
  v_account_id UUID;
BEGIN
  IF p_asset_path IS NULL OR LENGTH(p_asset_path) = 0 THEN
    RAISE EXCEPTION 'asset_path required';
  END IF;

  SELECT LOWER(email) INTO v_email FROM auth.users WHERE id = auth.uid();
  IF v_email IS NULL THEN RAISE EXCEPTION 'not authenticated'; END IF;

  SELECT p.account_id INTO v_account_id
    FROM public.portal_access p
    WHERE LOWER(p.email) = v_email
      AND p.disabled = FALSE
    LIMIT 1;
  IF v_account_id IS NULL THEN RAISE EXCEPTION 'not authorized'; END IF;

  INSERT INTO public.portal_downloads (account_id, asset_path, user_email)
    VALUES (v_account_id, p_asset_path, v_email);
END;
$$;

REVOKE ALL ON FUNCTION public.portal_record_download(TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.portal_record_download(TEXT) TO authenticated;

-- ---------------------------------------------------------------------
-- Step 7: Verify
-- ---------------------------------------------------------------------
DO $$
DECLARE
  n_access INT;
  n_downloads INT;
BEGIN
  SELECT COUNT(*) INTO n_access FROM public.portal_access;
  SELECT COUNT(*) INTO n_downloads FROM public.portal_downloads;
  RAISE NOTICE '───────────────────────────────────────────';
  RAISE NOTICE 'Media Portal v2 installed.';
  RAISE NOTICE 'portal_access rows:    %  (should be 0)', n_access;
  RAISE NOTICE 'portal_downloads rows: %  (should be 0)', n_downloads;
  RAISE NOTICE 'Every future row = an explicit admin decision in the CRM.';
  RAISE NOTICE 'Staff emails are hard-blocked at the DB level.';
  RAISE NOTICE '───────────────────────────────────────────';
END $$;
