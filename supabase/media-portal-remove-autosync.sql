-- =====================================================================
-- Media Portal — remove auto-sync from account.email
--
-- Original design was wrong: any time a customer's account.email was
-- set or changed, the trigger auto-added it to portal_authorized_emails
-- as source='primary'. That's not opt-in — it silently grants portal
-- access based on data that lives in the CRM for INVOICING, not for
-- portal access.
--
-- New design: portal access is 100% opt-in. Every allow-list row is
-- entered explicitly through the CRM's "Media portal access" section
-- (admin only). No trigger, no backfill from any other field.
--
-- This migration:
--   1. Drops sync_portal_primary_email() and its trigger
--   2. Deletes every row where source = 'primary' (they were all
--      auto-created; nothing was manually chosen)
--   3. Keeps the staff-email guard trigger from the previous migration
--      as a belt-and-suspenders check on manual adds
--   4. Prints a report
--
-- Idempotent — safe to re-run.
-- =====================================================================

DROP TRIGGER IF EXISTS trg_sync_portal_primary_email ON public.accounts;
DROP FUNCTION IF EXISTS public.sync_portal_primary_email();

-- Every 'primary' row was auto-created. None of them were an admin
-- decision, so they all go.
DELETE FROM public.portal_authorized_emails WHERE source = 'primary';

DO $$
DECLARE
  n_remaining INT;
  n_accounts INT;
BEGIN
  SELECT COUNT(*) INTO n_remaining FROM public.portal_authorized_emails;
  SELECT COUNT(DISTINCT account_id) INTO n_accounts FROM public.portal_authorized_emails;
  RAISE NOTICE '───────────────────────────────────────────';
  RAISE NOTICE 'Auto-sync trigger removed.';
  RAISE NOTICE 'Every allow-list row now = someone Dan or a rep explicitly added.';
  RAISE NOTICE 'Rows remaining: %  (spread across % accounts)', n_remaining, n_accounts;
  RAISE NOTICE '───────────────────────────────────────────';
END $$;

SELECT p.email, a.business_name, p.source, p.disabled, p.added_at
FROM public.portal_authorized_emails p
JOIN public.accounts a ON a.id = p.account_id
ORDER BY p.added_at DESC;
