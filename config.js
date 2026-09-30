/* Shared with the CRM (dnarsete.github.io/reflect-co-crm) — same Supabase
   project, same materials storage bucket, isolated auth session by origin.
   Portal users are locked out of every CRM table by existing RLS policies
   (they have no admin role, no rep_id assignment). */
window.REFLECT_PORTAL_CONFIG = {
  SUPABASE_URL: 'https://clzpkjssxvmgvgloxehk.supabase.co',
  SUPABASE_KEY: 'sb_publishable_AVb4KY5cTUdtMbltuiRPUg_YOdfNVvi',
  MATERIALS_BUCKET: 'materials',
  PORTAL_CATEGORIES: ['Social Media', 'Videos'],
  SITE_URL: 'https://media.thereflectco.com'
};
