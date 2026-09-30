-- =====================================================================
-- Reflect Co — Media Portal auth + tracking
--
-- Two tables + two RPCs + a trigger keep portal users completely
-- isolated from the CRM.
--
--   portal_authorized_emails — allow-list of {email, account_id}. A
--     portal login checks this table; a match returns the account
--     context, no match returns nothing and the client shows the
--     "not authorized" screen. Rows are seeded automatically from
--     each account's primary email via a trigger; admins can add
--     extra rows from the CRM.
--
--   portal_downloads — one row per download (path, when, which
--     account). Visible to admin in the CRM.
--
--   portal_resolve_context() — RPC the portal client calls right
--     after sign-in to find its account_id. Runs as SECURITY DEFINER
--     so it can read the allow-list without granting portal users
--     select on the table directly.
--
--   portal_log_download() — RPC the portal client calls when a
--     download starts. Inserts a portal_downloads row.
--
-- Every existing CRM table's RLS policy uses is_admin() OR
-- rep_id-based checks — neither is true for portal users, so their
-- sessions are blocked from accounts, orders, forecasts, notes,
-- reminders, contacts, everything. This migration adds NO new grants
-- to those tables; portal isolation comes for free.
--
-- Idempotent — safe to re-run.
-- =====================================================================

-- ---------------------------------------------------------------------
-- portal_authorized_emails
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.portal_authorized_emails (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  account_id UUID NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'admin', -- 'primary' (auto) or 'admin' (manual add)
  added_by UUID REFERENCES auth.users(id),
  added_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  disabled BOOLEAN NOT NULL DEFAULT FALSE,
  CHECK (source IN ('primary', 'admin'))
);

-- Case-insensitive uniqueness per account
CREATE UNIQUE INDEX IF NOT EXISTS portal_authorized_emails_uidx
  ON public.portal_authorized_emails (account_id, LOWER(email));

-- Fast lookup by email
CREATE INDEX IF NOT EXISTS portal_authorized_emails_email_idx
  ON public.portal_authorized_emails (LOWER(email))
  WHERE disabled = FALSE;

ALTER TABLE public.portal_authorized_emails ENABLE ROW LEVEL SECURITY;

-- Admin can see and manage everything
DO $$ BEGIN
  CREATE POLICY "portal_auth_emails admin all"
    ON public.portal_authorized_emails
    FOR ALL TO authenticated
    USING (public.is_admin())
    WITH CHECK (public.is_admin());
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Reps can see rows for their own accounts (so they can tell a customer
-- who's currently authorized)
DO $$ BEGIN
  CREATE POLICY "portal_auth_emails rep read"
    ON public.portal_authorized_emails
    FOR SELECT TO authenticated
    USING (
      EXISTS (
        SELECT 1 FROM public.accounts a
        WHERE a.id = portal_authorized_emails.account_id
          AND a.rep_id = (SELECT rep_id FROM public.profiles WHERE id = auth.uid())
      )
    );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Portal users get NO direct select — they go through portal_resolve_context()

-- ---------------------------------------------------------------------
-- Auto-seed: any time an account is created or its email changes, sync
-- the 'primary' row in portal_authorized_emails.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.sync_portal_primary_email()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- Clear any old 'primary' row that no longer matches
  DELETE FROM public.portal_authorized_emails
    WHERE account_id = NEW.id
      AND source = 'primary'
      AND (NEW.email IS NULL OR LOWER(email) <> LOWER(NEW.email));

  -- Insert the current primary (idempotent via the unique index)
  IF NEW.email IS NOT NULL AND NEW.email <> '' THEN
    INSERT INTO public.portal_authorized_emails (account_id, email, source, added_at)
      VALUES (NEW.id, NEW.email, 'primary', NOW())
      ON CONFLICT (account_id, LOWER(email)) DO UPDATE SET
        source = CASE
          WHEN portal_authorized_emails.source = 'admin' THEN 'admin'
          ELSE 'primary'
        END,
        disabled = FALSE;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_sync_portal_primary_email ON public.accounts;
CREATE TRIGGER trg_sync_portal_primary_email
  AFTER INSERT OR UPDATE OF email ON public.accounts
  FOR EACH ROW
  EXECUTE FUNCTION public.sync_portal_primary_email();

-- Backfill existing accounts
INSERT INTO public.portal_authorized_emails (account_id, email, source, added_at)
  SELECT a.id, a.email, 'primary', NOW()
  FROM public.accounts a
  WHERE a.email IS NOT NULL AND a.email <> ''
  ON CONFLICT (account_id, LOWER(email)) DO NOTHING;

-- ---------------------------------------------------------------------
-- portal_downloads
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.portal_downloads (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  account_id UUID NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  asset_path TEXT NOT NULL,
  user_email TEXT,
  downloaded_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS portal_downloads_account_idx
  ON public.portal_downloads (account_id, downloaded_at DESC);

CREATE INDEX IF NOT EXISTS portal_downloads_asset_idx
  ON public.portal_downloads (asset_path);

ALTER TABLE public.portal_downloads ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  CREATE POLICY "portal_downloads admin read"
    ON public.portal_downloads
    FOR SELECT TO authenticated
    USING (public.is_admin());
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
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
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Writes go through portal_log_download() as SECURITY DEFINER

-- ---------------------------------------------------------------------
-- portal_resolve_context — client calls this right after magic-link
-- sign-in to find its account. Returns {account_id, business_name}
-- or empty. Runs as SECURITY DEFINER so we can look up the caller's
-- email against the allow-list without granting SELECT on the table.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.portal_resolve_context()
RETURNS TABLE (account_id UUID, business_name TEXT)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_email TEXT;
BEGIN
  -- Read the caller's email from auth.users. If the profile isn't a
  -- portal user (i.e. they ARE a rep/admin), still return their
  -- account context if their email matches — this lets a rep test
  -- the portal with their own address.
  SELECT LOWER(email) INTO v_email FROM auth.users WHERE id = auth.uid();
  IF v_email IS NULL THEN RETURN; END IF;

  RETURN QUERY
    SELECT a.id, a.business_name
    FROM public.portal_authorized_emails p
    JOIN public.accounts a ON a.id = p.account_id
    WHERE LOWER(p.email) = v_email
      AND p.disabled = FALSE
    LIMIT 1;
END;
$$;

REVOKE ALL ON FUNCTION public.portal_resolve_context() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.portal_resolve_context() TO authenticated;

-- ---------------------------------------------------------------------
-- portal_log_download — client calls this when a download starts.
-- Looks up the caller's account from the allow-list and inserts a row.
-- SECURITY DEFINER so it can insert without the caller having direct
-- INSERT on portal_downloads.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.portal_log_download(p_asset_path TEXT)
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
  IF v_email IS NULL THEN
    RAISE EXCEPTION 'not authenticated';
  END IF;

  SELECT p.account_id INTO v_account_id
    FROM public.portal_authorized_emails p
    WHERE LOWER(p.email) = v_email
      AND p.disabled = FALSE
    LIMIT 1;
  IF v_account_id IS NULL THEN
    RAISE EXCEPTION 'not authorized';
  END IF;

  INSERT INTO public.portal_downloads (account_id, asset_path, user_email)
    VALUES (v_account_id, p_asset_path, v_email);
END;
$$;

REVOKE ALL ON FUNCTION public.portal_log_download(TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.portal_log_download(TEXT) TO authenticated;

-- =====================================================================
-- Verification queries (run manually after migration):
--   SELECT COUNT(*) FROM portal_authorized_emails WHERE source = 'primary';
--   -- should equal the count of accounts with a non-empty email
--
--   SELECT * FROM portal_resolve_context();
--   -- when run as an admin whose auth.email matches an account.email,
--   -- returns that account row; otherwise empty
-- =====================================================================
