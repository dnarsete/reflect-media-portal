/* Same Supabase project the CRM uses. Materials storage bucket is
   shared. Portal auth sessions are per-origin, so signing into the
   portal never touches the CRM session on dnarsete.github.io. */
window.REFLECT_PORTAL_CONFIG = {
  SUPABASE_URL: 'https://clzpkjssxvmgvgloxehk.supabase.co',
  SUPABASE_KEY: 'sb_publishable_AVb4KY5cTUdtMbltuiRPUg_YOdfNVvi',
  MATERIALS_BUCKET: 'materials',
  PORTAL_CATEGORIES: ['Social Media', 'Videos'],
  SITE_URL: 'https://media.thereflectco.com'
};
