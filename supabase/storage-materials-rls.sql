-- =====================================================================
-- Storage RLS for the shared 'materials' bucket (2026-10-27 snapshot)
--
-- Documents the policies currently live in Supabase so a from-scratch
-- rebuild of this project doesn't ship without them. The admin
-- boundary for upload / move / delete depends ENTIRELY on these
-- policies — the client-side isAdmin() check in the portal and CRM
-- is a UX gate, not a security boundary. If these policies are
-- missing, any signed-in authenticated user can hit
-- sb.storage.from('materials').remove([path]) directly via DevTools.
--
-- Idempotent: safe to re-run.
-- =====================================================================

/* READ: any authenticated user. Required for signed-URL generation
   (both the CRM Materials grid and the customer-facing portal). */
DROP POLICY IF EXISTS "materials read auth" ON storage.objects;
CREATE POLICY "materials read auth"
  ON storage.objects FOR SELECT
  TO authenticated
  USING (bucket_id = 'materials');

/* READ via short link — if a 7-day signed download link was issued
   via the short_links table, that path can be read even outside the
   auth check. Used by the CRM's materials.copyLink / email flows. */
DROP POLICY IF EXISTS "materials_read_via_short_link" ON storage.objects;
CREATE POLICY "materials_read_via_short_link"
  ON storage.objects FOR SELECT
  USING (
    bucket_id = 'materials'
    AND EXISTS (SELECT 1 FROM public.short_links sl WHERE sl.storage_path = objects.name)
  );

/* INSERT / UPDATE / DELETE: admin only. Enforces that reps and
   customers can never upload, move, or delete files even if they
   bypass the client gate. */
DROP POLICY IF EXISTS "materials write admin" ON storage.objects;
CREATE POLICY "materials write admin"
  ON storage.objects FOR INSERT
  TO authenticated
  WITH CHECK (bucket_id = 'materials' AND public.is_admin());

DROP POLICY IF EXISTS "materials update admin" ON storage.objects;
CREATE POLICY "materials update admin"
  ON storage.objects FOR UPDATE
  TO authenticated
  USING (bucket_id = 'materials' AND public.is_admin());

DROP POLICY IF EXISTS "materials delete admin" ON storage.objects;
CREATE POLICY "materials delete admin"
  ON storage.objects FOR DELETE
  TO authenticated
  USING (bucket_id = 'materials' AND public.is_admin());

DO $$ BEGIN
  RAISE NOTICE 'materials bucket storage policies verified / applied.';
END $$;
