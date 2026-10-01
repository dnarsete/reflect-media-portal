-- Removes the staff-email block on portal_access. The original guard
-- was overcautious — the owner (Dan) and other admins should be able
-- to sign in to their own portal to see what customers see, test
-- uploads, verify access, etc. The real safeguard against the
-- original Skin Bar Medspa incident was dropping the auto-sync
-- trigger (done in v2), which is still gone. Admins now have to
-- explicitly add any email, including their own.

DROP TRIGGER IF EXISTS trg_reject_staff_portal_email ON public.portal_access;
DROP FUNCTION IF EXISTS public.reject_staff_portal_email();

-- is_staff_email helper stays — not harmful, might be useful later.
