/* ============================================================================
   Reflect Co — Media Portal
   Customer-facing static site. Auth via Supabase magic-link. Access is gated
   by a portal_authorized_emails allow-list that admins manage from the CRM.
   Portal users have NO admin role and NO rep_id, so every CRM table's RLS
   policy blocks them by default. Only their own account's downloads and
   authorized-emails rows are readable.
   ============================================================================ */

const CFG = window.REFLECT_PORTAL_CONFIG;
const sb = window.supabase.createClient(CFG.SUPABASE_URL, CFG.SUPABASE_KEY, {
  auth: { persistSession: true, autoRefreshToken: true }
});

const ui = {
  show(viewId) {
    document.querySelectorAll('.view').forEach(v => v.classList.add('hide'));
    const el = document.getElementById(viewId);
    if (el) el.classList.remove('hide');
  },
  toast(msg, kind = 'ok') {
    const el = document.getElementById('signin-msg');
    if (!el) return;
    el.textContent = msg;
    el.className = 'signin-msg ' + kind;
    el.classList.remove('hide');
  }
};

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c =>
  ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;','\'':'&#39;'}[c]));

const auth = {
  _accountCtx: null,

  async sendMagicLink() {
    const emailEl = document.getElementById('signin-email');
    const submitBtn = document.getElementById('signin-submit');
    const email = emailEl.value.trim().toLowerCase();
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      ui.toast('Please enter a valid email address.', 'err');
      return;
    }
    submitBtn.disabled = true;
    submitBtn.textContent = 'Sending…';
    try {
      const { error } = await sb.auth.signInWithOtp({
        email,
        options: {
          emailRedirectTo: CFG.SITE_URL + '/',
          shouldCreateUser: true
        }
      });
      if (error) throw error;
      ui.toast('Check your inbox — the sign-in link will arrive in a few seconds. It works for 60 minutes.', 'ok');
    } catch (e) {
      ui.toast(e.message || 'Something went wrong. Try again in a moment.', 'err');
    } finally {
      submitBtn.disabled = false;
      submitBtn.textContent = 'Send sign-in link';
    }
  },

  async signOut() {
    try { await sb.auth.signOut(); } catch (_) {}
    location.href = '/';
  },

  /* After sign-in, look up whether this email is on the authorized list
     and which account it maps to. If not, show the denied screen. */
  async resolveContext() {
    const { data: userData } = await sb.auth.getUser();
    const user = userData?.user;
    if (!user) return null;

    const r = await sb.rpc('portal_resolve_context');
    if (r.error) {
      console.warn('[portal] resolve_context failed:', r.error);
      return null;
    }
    return r.data && r.data.length ? r.data[0] : null;
  },

  async boot() {
    const params = new URLSearchParams(location.hash.slice(1));
    const hasAuthPayload = params.has('access_token') || params.has('error');
    if (hasAuthPayload) {
      ui.show('view-callback');
      /* supabase-js parses the hash automatically on load; wait one tick. */
      await new Promise(r => setTimeout(r, 100));
      history.replaceState(null, '', location.pathname);
    }

    const { data } = await sb.auth.getSession();
    if (!data?.session) {
      ui.show('view-signin');
      return;
    }

    const ctx = await auth.resolveContext();
    if (!ctx || !ctx.account_id) {
      ui.show('view-denied');
      return;
    }

    auth._accountCtx = ctx;
    document.getElementById('header-account').classList.remove('hide');
    document.getElementById('header-account-name').textContent = ctx.business_name || '';
    ui.show('view-browse');
    await portal.load();
  }
};

const portal = {
  _files: [],

  async load() {
    const wrap = document.getElementById('browse-list');
    wrap.innerHTML = '<div class="muted">Loading…</div>';
    try {
      const results = await Promise.all(
        CFG.PORTAL_CATEGORIES.map(async (cat) => {
          const { data, error } = await sb.storage
            .from(CFG.MATERIALS_BUCKET)
            .list(cat, { limit: 500, sortBy: { column: 'name', order: 'asc' } });
          if (error) return [];
          return (data || [])
            .filter(f => f.name && f.name !== '.emptyFolderPlaceholder')
            .map(f => ({ ...f, category: cat, path: `${cat}/${f.name}` }));
        })
      );
      portal._files = results.flat();

      /* Populate category filter */
      const catSel = document.getElementById('browse-category');
      if (catSel.options.length <= 1) {
        CFG.PORTAL_CATEGORIES.forEach(c => {
          const opt = document.createElement('option');
          opt.value = c;
          opt.textContent = c;
          catSel.appendChild(opt);
        });
      }

      portal.render();
    } catch (e) {
      wrap.innerHTML = `<div class="muted">Could not load media library: ${esc(e.message || e)}</div>`;
    }
  },

  render() {
    const wrap = document.getElementById('browse-list');
    const q = (document.getElementById('browse-search').value || '').trim().toLowerCase();
    const catF = document.getElementById('browse-category').value || '';
    const filtered = portal._files.filter(f => {
      if (catF && f.category !== catF) return false;
      if (!q) return true;
      return (f.name + ' ' + f.category).toLowerCase().includes(q);
    });

    if (!filtered.length) {
      wrap.innerHTML = `<div class="muted">${portal._files.length === 0 ? 'No media available yet — check back soon.' : 'No matches for that search.'}</div>`;
      return;
    }

    const groups = {};
    filtered.forEach(f => { (groups[f.category] = groups[f.category] || []).push(f); });

    wrap.innerHTML = Object.keys(groups).sort().map(cat => `
      <h2 class="category-h">${esc(cat)}</h2>
      ${groups[cat].map(f => portal._cardHTML(f)).join('')}
    `).join('');
  },

  _cardHTML(f) {
    const ext = (f.name.split('.').pop() || '').toLowerCase();
    const isVideo = ['mp4', 'mov', 'webm', 'm4v'].includes(ext);
    const isImage = ['png', 'jpg', 'jpeg', 'gif', 'webp'].includes(ext);
    const url = sb.storage.from(CFG.MATERIALS_BUCKET).getPublicUrl(f.path).data.publicUrl;
    const kb = f.metadata?.size
      ? (f.metadata.size < 1024 * 1024
        ? (f.metadata.size / 1024).toFixed(0) + ' KB'
        : (f.metadata.size / 1024 / 1024).toFixed(1) + ' MB')
      : '';

    let thumb;
    if (isImage) {
      thumb = `<img src="${esc(url)}" alt="${esc(f.name)}" loading="lazy"/>`;
    } else if (isVideo) {
      thumb = `<video src="${esc(url)}#t=0.5" muted preload="metadata"></video><div class="asset-play">▶</div>`;
    } else {
      thumb = `<div class="placeholder">📎</div>`;
    }

    return `<div class="asset-card">
      <div class="asset-thumb">${thumb}</div>
      <div class="asset-meta">
        <span class="asset-name">${esc(f.name)}</span>
        <span class="asset-sub">${esc(f.category)}${kb ? ' · ' + esc(kb) : ''}</span>
      </div>
      <div class="asset-actions">
        ${isVideo ? `<button class="ghost" onclick="portal.preview('${esc(f.path)}')">Preview</button>` : ''}
        <button class="primary" onclick="portal.download('${esc(f.path)}', '${esc(f.name)}')">Download</button>
      </div>
    </div>`;
  },

  preview(path) {
    const url = sb.storage.from(CFG.MATERIALS_BUCKET).getPublicUrl(path).data.publicUrl;
    window.open(url, '_blank', 'noopener');
  },

  async download(path, filename) {
    try {
      /* Log the download BEFORE the fetch — a failed log shouldn't block the
         download, but a completed download without a log is worse than a
         completed download with a duplicate log. */
      try {
        await sb.rpc('portal_log_download', { p_asset_path: path });
      } catch (e) {
        console.warn('[portal] download log failed:', e);
      }
      const url = sb.storage.from(CFG.MATERIALS_BUCKET).getPublicUrl(path).data.publicUrl;
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      a.rel = 'noopener';
      document.body.appendChild(a);
      a.click();
      a.remove();
    } catch (e) {
      alert('Download failed: ' + (e.message || e));
    }
  }
};

/* ---------- Boot ---------- */
auth.boot();
