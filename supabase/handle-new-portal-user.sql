-- =====================================================================
-- handle_new_user: skip portal users (they're customers, not reps)
--
-- Before this fix, any brand-new sign-in through Supabase Auth fired
-- handle_new_user() and tried to create a 'rep' profiles row for them
-- (with auto-assigned rep_id, role='rep', disabled=TRUE). For portal
-- users this is wrong on two counts: they're customers not staff, and
-- the insert sometimes failed, bubbling up to the client as
-- "Database error saving new user".
--
-- Fix: if the new auth user's email is on portal_access, short-circuit
-- the trigger — no profiles row created, portal sign-in just works.
-- Reps and admins still get their profile row as before via the invite
-- flow.
--
-- Idempotent — safe to re-run.
-- =====================================================================

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
  -- Portal users (customers on media.thereflectco.com) get NO profiles
  -- row. They authenticate via Supabase Auth and are resolved to an
  -- account context by portal_current_account(). Skipping the whole
  -- trigger body avoids the rep_id assignment, role defaulting, and
  -- any downstream constraint failure.
  IF EXISTS (
    SELECT 1 FROM public.portal_access
    WHERE LOWER(email) = LOWER(NEW.email)
  ) THEN
    RETURN NEW;
  END IF;

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
  RAISE NOTICE 'handle_new_user() patched.';
  RAISE NOTICE 'Portal users no longer get a profiles row on first sign-in.';
  RAISE NOTICE 'Rep/admin invite flow unchanged.';
  RAISE NOTICE '───────────────────────────────────────────';
END $$;
