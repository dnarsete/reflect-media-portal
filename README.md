# Reflect Co — Media Portal (v2)

Customer-facing static site at **media.thereflectco.com**. Signed-in accounts
browse and download Social Media and Video assets Dan uploads from the
CRM's Materials tab.

## Files

| File | Purpose |
|---|---|
| `index.html` | Sign-in / callback / browse / access-denied views |
| `styles.css` | Design + light/dark theme |
| `app.js` | Auth flow, browse UI, download tracking |
| `config.js` | Supabase URL/key, category folders, site URL |
| `sw.js` | Service worker with skip-waiting auto-update |
| `manifest.json` | PWA manifest |
| `CNAME` | Custom domain for GitHub Pages |
| `icon.png` / `icon-192.png` / `icon-512.png` | App icons |
| `supabase/media-portal.sql` | Complete DB schema (tables + RPCs + guard) |

## Design principles

1. **100% opt-in.** No auto-sync from any customer field. Every allow-list
   row is an explicit admin decision made in the CRM's "Media portal
   access" panel.
2. **Staff-email hard block.** `is_staff_email()` + a BEFORE INSERT
   trigger refuse any staff email from every code path — CRM, SQL,
   RPCs, everything.
3. **RLS-only isolation.** Portal users have no admin role and no
   rep_id, so every existing CRM table's RLS blocks them.
4. **No XSS surface.** Buttons use `data-*` attributes + event
   delegation, never inline `onclick` with interpolated strings.

## Deployment

Already deployed. If starting fresh:

1. **SQL** — Supabase → SQL Editor → paste `supabase/media-portal.sql` → Run
2. **Push repo** — `git push origin main`
3. **Enable Pages** — Settings → Pages → Deploy from branch `main` / root
4. **Set custom domain** — Pages → Custom domain: `media.thereflectco.com`
5. **DNS** — CNAME `media` → `dnarsete.github.io`
6. **Supabase redirect** — Auth → URL Configuration → add
   `https://media.thereflectco.com/**`

## Admin controls

CRM → open any existing account → **🎬 Media portal access** section.
Add / revoke / delete authorized emails.
