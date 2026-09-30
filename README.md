# Reflect Co — Media Portal

Customer-facing static site at **media.thereflectco.com**. Signed-in accounts
can browse and download the same Social Media and Video assets Dan and the
reps upload from the CRM's Materials tab.

## What it is

- **Static SPA** hosted on GitHub Pages (same setup as the CRM)
- **Shares the CRM's Supabase project** — one materials bucket, no duplicate
  uploads
- **Isolated from CRM data by RLS** — portal users have no admin role and
  no rep_id, so every CRM table's existing policy blocks them
- **Magic-link auth** — accounts enter their email, get a sign-in link,
  click, they're in

## Files

| File | What it does |
|------|--------------|
| `index.html` | Single-page shell with sign-in / callback / browse / denied views |
| `styles.css` | Design tokens + layout (light + dark mode) |
| `app.js` | Auth flow, browse UI, download tracking |
| `config.js` | Supabase URL/key + list of category folders |
| `sw.js` | Service worker with auto-update |
| `manifest.json` | PWA manifest for install-to-home-screen |
| `CNAME` | Tells GitHub Pages the custom domain |
| `supabase/media-portal.sql` | Two tables + two RPCs + a trigger — see below |

## Deployment checklist

Follow in order the first time. Each step is a UI action; no CLI required.

### 1. Run the SQL migration
Supabase Dashboard → SQL Editor → paste `supabase/media-portal.sql` → Run.

Creates the allow-list, the download log, and the two RPCs. Backfills
existing accounts' primary emails.

### 2. Create the GitHub repo
GitHub → New repository → name it `reflect-media-portal` (or whatever)
→ Public → Create.

Push this folder to it.

### 3. Enable GitHub Pages
Repo → Settings → Pages → Source: **Deploy from a branch** → Branch: **main**
→ Folder: **/ (root)** → Save.

### 4. Set the custom domain
Repo → Settings → Pages → Custom domain: **media.thereflectco.com** → Save.
GitHub will show "Improperly configured" until DNS points at it.

### 5. Add the DNS record
At the DNS registrar for **thereflectco.com** (Cloudflare, GoDaddy, etc.):
- **Type:** CNAME
- **Host:** media
- **Value:** `<your-github-username>.github.io`
- **TTL:** default (~5 min)

After the record propagates (usually 1–5 min), GitHub's HTTPS auto-provision
kicks in.

### 6. Whitelist the redirect URL in Supabase
Supabase Dashboard → Authentication → URL Configuration →
**Site URL:** `https://media.thereflectco.com`
**Redirect URLs (add):** `https://media.thereflectco.com/**`

Without this, magic links land at your CRM's URL instead.

### 7. Test end-to-end
1. Visit **https://media.thereflectco.com**
2. Enter an email that's on file for a test account
3. Check inbox, click the link
4. You should land in the Media Portal browse view
5. Download an asset
6. In the CRM's admin section, check `portal_downloads` for the row

## Admin controls (CRM side — future phase)

The CRM will gain a "Media Portal" tab under the account edit view where
you can:
- See all authorized emails for the account (primary + admin-added)
- Add extra emails (e.g. the account's marketing manager)
- Revoke access without deleting the row
- See recent portal downloads

Until that lands, add authorized emails directly via SQL:

```sql
INSERT INTO portal_authorized_emails (account_id, email, source, added_by)
  VALUES ('<account-uuid>', 'contact@customer.com', 'admin', auth.uid());
```

## Security notes

- The materials bucket is public — anyone with a file's exact URL can
  download it. The portal is a discovery layer + audit trail, not a
  hard access wall. Fine for marketing assets meant to spread; not fine
  for anything confidential.
- If a customer's email is compromised, the attacker gets access to
  that ONE account's asset list and download history. No path to
  reach any other account, rep, order, or personal data — RLS blocks it.
- Portal magic-link tokens expire in 60 minutes (Supabase default).
  Sessions last as long as the browser holds the refresh token
  (default 7 days).
