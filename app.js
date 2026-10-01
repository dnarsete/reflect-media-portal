/* ============================================================================
   Reflect Co — Media Portal (v2)

   Design principles:
     - Portal access is 100% opt-in. No auto-sync. Every allow-list row
       is an explicit admin decision made in the CRM.
     - Portal users have NO admin role and NO rep_id, so every CRM
       table's existing RLS blocks them by default — no new grants
       needed. Only their own account's downloads are visible to them.
     - Staff emails (admin/rep) are hard-blocked at the DB level from
       ever landing in the allow-list, from any code path.
     - Every asset button uses data-attribute event delegation, not
       inline onclick — filename special chars can never break or
       inject.
   ============================================================================ */

const CFG = window.REFLECT_PORTAL_CONFIG;
const sb = window.supabase.createClient(CFG.SUPABASE_URL, CFG.SUPABASE_KEY, {
  auth: { persistSession: true, autoRefreshToken: true }
});

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c =>
  ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;','\'':'&#39;'}[c]));

const view = {
  show(id) {
    document.querySelectorAll('.view').forEach(v => v.classList.add('hide'));
    const el = document.getElementById(id);
    if (el) el.classList.remove('hide');
  }
};

const toast = {
  signin(msg, kind = 'ok') {
    const el = document.getElementById('signin-msg');
    if (!el) return;
    el.textContent = msg;
    el.className = 'signin-msg ' + kind;
    el.classList.remove('hide');
  }
};

/* ================= AUTH ================= */
const portalAuth = {
  _accountCtx: null,

  async sendMagicLink() {
    const emailEl = document.getElementById('signin-email');
    const submitBtn = document.getElementById('signin-submit');
    const email = emailEl.value.trim().toLowerCase();
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      toast.signin('Please enter a valid email address.', 'err');
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
      toast.signin('Check your inbox — the sign-in link will arrive in a few seconds. It works for 60 minutes.', 'ok');
    } catch (e) {
      toast.signin(e.message || 'Something went wrong. Try again in a moment.', 'err');
    } finally {
      submitBtn.disabled = false;
      submitBtn.textContent = 'Send sign-in link';
    }
  },

  async signOut() {
    try { await sb.auth.signOut(); } catch (_) {}
    location.href = '/';
  },

  /* Look up which account this signed-in email is authorized for.
     Uses portal_current_account() RPC — runs SECURITY DEFINER against
     the allow-list. Returns null if the email isn't on any account's list. */
  async whichAccount() {
    const r = await sb.rpc('portal_current_account');
    if (r.error) {
      console.warn('[portal] whichAccount failed:', r.error);
      return null;
    }
    return r.data && r.data.length ? r.data[0] : null;
  },

  async _enterSignedIn() {
    const ctx = await portalAuth.whichAccount();
    if (!ctx || !ctx.account_id) {
      view.show('view-denied');
      return;
    }
    portalAuth._accountCtx = ctx;
    document.getElementById('header-account').classList.remove('hide');
    document.getElementById('header-account-name').textContent = ctx.business_name || '';
    view.show('view-browse');
    await portalBrowse.load();
  },

  async boot() {
    const params = new URLSearchParams(location.hash.slice(1));
    const hasAuthPayload = params.has('access_token') || params.has('error');

    if (hasAuthPayload) {
      /* Magic-link redirect. Wait for supabase-js to finalize the
         session via onAuthStateChange rather than a hardcoded timeout. */
      view.show('view-callback');
      await new Promise((resolve) => {
        const { data: sub } = sb.auth.onAuthStateChange((event) => {
          if (event === 'SIGNED_IN' || event === 'INITIAL_SESSION') {
            try { sub.subscription.unsubscribe(); } catch (_) {}
            resolve();
          }
        });
        setTimeout(() => { try { sub.subscription.unsubscribe(); } catch (_) {} resolve(); }, 4000);
      });
      history.replaceState(null, '', location.pathname);
    }

    const { data } = await sb.auth.getSession();
    if (!data?.session) {
      view.show('view-signin');
      return;
    }
    await portalAuth._enterSignedIn();
  }
};

/* ================= BROWSE ================= */
const portalBrowse = {
  _files: [],
  _actionsBound: false,
  _escHandler: null,

  _bindActions() {
    if (portalBrowse._actionsBound) return;
    portalBrowse._actionsBound = true;
    document.getElementById('browse-list').addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-action]');
      if (!btn) return;
      const { action, path, name, category } = btn.dataset;
      if (action === 'preview') portalBrowse.openPreview(path, name, category);
      else if (action === 'download') portalBrowse.download(path, name);
    });
  },

  async load() {
    const wrap = document.getElementById('browse-list');
    wrap.innerHTML = '<div class="muted">Loading…</div>';
    portalBrowse._bindActions();
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
      portalBrowse._files = results.flat();

      const catSel = document.getElementById('browse-category');
      if (catSel.options.length <= 1) {
        CFG.PORTAL_CATEGORIES.forEach(c => {
          const opt = document.createElement('option');
          opt.value = c;
          opt.textContent = c;
          catSel.appendChild(opt);
        });
      }

      portalBrowse.render();
    } catch (e) {
      wrap.innerHTML = `<div class="muted">Could not load media: ${esc(e.message || e)}</div>`;
    }
  },

  render() {
    const wrap = document.getElementById('browse-list');
    const q = (document.getElementById('browse-search').value || '').trim().toLowerCase();
    const catF = document.getElementById('browse-category').value || '';
    const filtered = portalBrowse._files.filter(f => {
      if (catF && f.category !== catF) return false;
      if (!q) return true;
      return (f.name + ' ' + f.category).toLowerCase().includes(q);
    });

    if (!filtered.length) {
      wrap.innerHTML = `<div class="muted">${portalBrowse._files.length === 0 ? 'No media yet — check back soon.' : 'No matches.'}</div>`;
      return;
    }

    const groups = {};
    filtered.forEach(f => { (groups[f.category] = groups[f.category] || []).push(f); });

    wrap.innerHTML = Object.keys(groups).sort().map(cat => `
      <h2 class="category-h">${esc(cat)}</h2>
      ${groups[cat].map(f => portalBrowse._cardHTML(f)).join('')}
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
        <button class="ghost" data-action="preview" data-path="${esc(f.path)}" data-name="${esc(f.name)}" data-category="${esc(f.category)}">Preview</button>
        <button class="primary" data-action="download" data-path="${esc(f.path)}" data-name="${esc(f.name)}">Download</button>
      </div>
    </div>`;
  },

  openPreview(path, name, category) {
    const ext = (name.split('.').pop() || '').toLowerCase();
    const isVideo = ['mp4', 'mov', 'webm', 'm4v'].includes(ext);
    const isImage = ['png', 'jpg', 'jpeg', 'gif', 'webp'].includes(ext);
    const url = sb.storage.from(CFG.MATERIALS_BUCKET).getPublicUrl(path).data.publicUrl;
    const content = document.getElementById('preview-content');

    let media;
    if (isImage) media = `<img src="${esc(url)}" alt="${esc(name)}"/>`;
    else if (isVideo) media = `<video src="${esc(url)}" controls autoplay playsinline></video>`;
    else media = `<div class="preview-fallback"><div class="placeholder">📎</div><p class="muted">Preview isn't available for this file type. Use Download to save it.</p></div>`;

    content.innerHTML = `${media}
      <div class="preview-meta">
        <div class="preview-name">${esc(name)}</div>
        ${esc(category)}
      </div>`;

    document.getElementById('preview-download').onclick = () => portalBrowse.download(path, name);
    document.getElementById('preview-modal').classList.remove('hide');
    document.body.style.overflow = 'hidden';

    portalBrowse._escHandler = (e) => { if (e.key === 'Escape') portalBrowse.closePreview(); };
    document.addEventListener('keydown', portalBrowse._escHandler);
  },

  closePreview(e) {
    if (e && e.target && e.target.id !== 'preview-modal' && e.target.tagName !== 'BUTTON') return;
    document.getElementById('preview-modal').classList.add('hide');
    const vid = document.querySelector('#preview-content video');
    if (vid) { try { vid.pause(); } catch (_) {} }
    document.getElementById('preview-content').innerHTML = '';
    document.body.style.overflow = '';
    if (portalBrowse._escHandler) {
      document.removeEventListener('keydown', portalBrowse._escHandler);
      portalBrowse._escHandler = null;
    }
  },

  async download(path, filename) {
    try {
      /* Log first — a failed log is better than an unlogged download. */
      try { await sb.rpc('portal_record_download', { p_asset_path: path }); }
      catch (e) { console.warn('[portal] download log failed:', e); }

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

/* Boot */
portalAuth.boot();
