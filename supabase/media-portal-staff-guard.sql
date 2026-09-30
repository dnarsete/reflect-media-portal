-- =====================================================================
-- Media Portal — staff-email guard
--
-- Root-cause fix for the "dan@thereflectco.com ended up as a portal
-- primary for Skin Bar Medspa" incident. The old trigger backfilled
-- every accounts.email into portal_authorized_emails as source='primary'.
-- If a staff email (admin or rep) was ever entered as an account's
-- primary email — by typo, testing, historical data — that staff
-- member automatically got portal access to that customer's account.
--
-- This migration:
--   1. Adds is_staff_email(TEXT) helper — TRUE if the email exists in
--      profiles with role IN ('admin','rep') AND disabled = FALSE
--   2. Rewrites sync_portal_primary_email() to SKIP staff emails
--   3. Purges every existing allow-list row where the email matches a
--      current staff email (regardless of source, admin or primary)
--   4. Prints a verify report
--
-- Idempotent — safe to re-run.
-- =====================================================================

-- ---------------------------------------------------------------------
-- Helper: is this email a current staff member?
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
-- Rewrite the auto-sync trigger to skip staff emails
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.sync_portal_primary_email()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- Always clear stale primary rows that no longer match this account's email.
  DELETE FROM public.portal_authorized_emails
    WHERE account_id = NEW.id
      AND source = 'primary'
      AND (NEW.email IS NULL OR LOWER(email) <> LOWER(NEW.email));

  -- Insert the current primary — BUT ONLY if the email isn't a staff account.
  -- Staff emails have their own CRM login; they never need to be added as
  -- a customer-side portal user, and doing so grants unintended access.
  IF NEW.email IS NOT NULL
     AND NEW.email <> ''
     AND NOT public.is_staff_email(NEW.email) THEN
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

-- Also guard the manual admin-add path via a BEFORE INSERT trigger.
-- Even if an admin types a staff email into the CRM's "Authorize email"
-- box, this rejects the row rather than granting access.
CREATE OR REPLACE FUNCTION public.reject_staff_portal_email()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.email IS NOT NULL AND public.is_staff_email(NEW.email) THEN
    RAISE EXCEPTION 'Cannot authorize a staff email (%) as a portal user. Staff sign in through the CRM, not media.thereflectco.com.', NEW.email;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_reject_staff_portal_email ON public.portal_authorized_emails;
CREATE TRIGGER trg_reject_staff_portal_email
  BEFORE INSERT OR UPDATE OF email ON public.portal_authorized_emails
  FOR EACH ROW
  EXECUTE FUNCTION public.reject_staff_portal_email();

-- ---------------------------------------------------------------------
-- Clean up historical accidents.
-- Remove every allow-list row whose email is currently a staff email,
-- regardless of source ('primary' or 'admin'). Any dan@thereflectco.com
-- or rep-email row on any account is gone.
-- ---------------------------------------------------------------------
DELETE FROM public.portal_authorized_emails p
WHERE public.is_staff_email(p.email);

-- ---------------------------------------------------------------------
-- Verify — three counts. All should be safe.
--   1. Total staff-emails currently on the allow list — MUST BE 0
--   2. Rows on Skin Bar Medspa's allow list — should be dawn@ only
--   3. Accounts whose email is a staff email — flag for cleanup
-- ---------------------------------------------------------------------
DO $$
DECLARE
  n_bad INT;
  n_skinbar INT;
  n_staff_as_accountemail INT;
BEGIN
  SELECT COUNT(*) INTO n_bad
    FROM public.portal_authorized_emails p
    WHERE public.is_staff_email(p.email);

  SELECT COUNT(*) INTO n_skinbar
    FROM public.portal_authorized_emails p
    JOIN public.accounts a ON a.id = p.account_id
    WHERE a.business_name = 'Skin Bar Medspa';

  SELECT COUNT(*) INTO n_staff_as_accountemail
    FROM public.accounts
    WHERE email IS NOT NULL AND public.is_staff_email(email);

  RAISE NOTICE '───────────────────────────────────────────';
  RAISE NOTICE 'Staff emails on portal allow list: %  (must be 0)', n_bad;
  RAISE NOTICE 'Skin Bar Medspa allow-list rows:   %', n_skinbar;
  RAISE NOTICE 'Accounts whose EMAIL is a staff email (data-entry mistakes to fix in CRM): %', n_staff_as_accountemail;
  RAISE NOTICE '───────────────────────────────────────────';
END $$;

-- List the accounts that still have a staff email in their email field —
-- these are data-entry mistakes that need the CRM's Account edit to fix.
SELECT a.id AS account_id, a.account_number, a.business_name, a.email
FROM public.accounts a
WHERE a.email IS NOT NULL AND public.is_staff_email(a.email)
ORDER BY a.account_number;
