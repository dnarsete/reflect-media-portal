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

  /* Enter the signed-in flow: resolve which account this user belongs
     to and either show the browse view or the "not authorized" screen. */
  async _enterSignedIn() {
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
  },

  async boot() {
    const params = new URLSearchParams(location.hash.slice(1));
    const hasAuthPayload = params.has('access_token') || params.has('error');

    if (hasAuthPayload) {
      /* Magic-link redirect. Show the "signing you in" splash while
         supabase-js parses the hash and finalizes the session. Waiting
         for the SIGNED_IN event is bulletproof — no hardcoded timeout
         to guess right on every device. */
      ui.show('view-callback');
      await new Promise((resolve) => {
        const { data: sub } = sb.auth.onAuthStateChange((event, session) => {
          if (event === 'SIGNED_IN' || event === 'INITIAL_SESSION') {
            try { sub.subscription.unsubscribe(); } catch (_) {}
            resolve(session);
          }
        });
        /* Safety net: if the hash was invalid and no event fires within
           4 s, fall through so we don't hang on "Signing you in…". */
        setTimeout(() => { try { sub.subscription.unsubscribe(); } catch (_) {} resolve(null); }, 4000);
      });
      history.replaceState(null, '', location.pathname);
    }

    const { data } = await sb.auth.getSession();
    if (!data?.session) {
      ui.show('view-signin');
      return;
    }

    await auth._enterSignedIn();
  }
};

const portal = {
  _files: [],

  _bindAssetActions() {
    /* Attach the delegated click handler exactly once. Reads the
       action + path + name + category from the target button's
       data-attributes and dispatches. Immune to filename special
       characters. */
    if (portal._actionsBound) return;
    portal._actionsBound = true;
    document.getElementById('browse-list').addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-action]');
      if (!btn) return;
      const action = btn.dataset.action;
      const path = btn.dataset.path;
      const name = btn.dataset.name;
      const category = btn.dataset.category;
      if (action === 'preview') portal.preview(path, name, category);
      else if (action === 'download') portal.download(path, name);
    });
  },

  async load() {
    const wrap = document.getElementById('browse-list');
    wrap.innerHTML = '<div class="muted">Loading…</div>';
    portal._bindAssetActions();
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

    /* Buttons store their asset ref in data-* attributes. Handler is
       attached ONCE via delegation in portal.load() so filename special
       characters (apostrophes, quotes, backslashes) can't break the
       button or inject anything into an inline onclick. */
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

  /* Open the preview modal for an asset. Images render as <img>, videos
     as a playable <video controls>, other file types fall back to an
     icon + note prompting the download button. */
  preview(path, name, category) {
    const ext = (name.split('.').pop() || '').toLowerCase();
    const isVideo = ['mp4', 'mov', 'webm', 'm4v'].includes(ext);
    const isImage = ['png', 'jpg', 'jpeg', 'gif', 'webp'].includes(ext);
    const url = sb.storage.from(CFG.MATERIALS_BUCKET).getPublicUrl(path).data.publicUrl;
    const content = document.getElementById('preview-content');

    let media;
    if (isImage) {
      media = `<img src="${esc(url)}" alt="${esc(name)}"/>`;
    } else if (isVideo) {
      media = `<video src="${esc(url)}" controls autoplay playsinline></video>`;
    } else {
      media = `<div class="preview-fallback">
        <div class="placeholder">📎</div>
        <p class="muted">Preview isn't available for this file type. Use Download to save it.</p>
      </div>`;
    }
    content.innerHTML = `${media}
      <div class="preview-meta">
        <div class="preview-name">${esc(name)}</div>
        ${esc(category)}
      </div>`;

    const dlBtn = document.getElementById('preview-download');
    dlBtn.onclick = () => portal.download(path, name);

    const modal = document.getElementById('preview-modal');
    modal.classList.remove('hide');
    document.body.style.overflow = 'hidden';

    /* Close on Escape */
    portal._escHandler = (e) => { if (e.key === 'Escape') portal.closePreview(); };
    document.addEventListener('keydown', portal._escHandler);
  },

  closePreview(e) {
    /* Only close on backdrop clicks or the close button — not on clicks
       inside the modal body (those are stopped in the onclick attribute). */
    if (e && e.target && e.target.id !== 'preview-modal' && e.target.tagName !== 'BUTTON') return;
    const modal = document.getElementById('preview-modal');
    modal.classList.add('hide');
    /* Stop any playing video so audio doesn't linger */
    const vid = document.querySelector('#preview-content video');
    if (vid) { try { vid.pause(); } catch (_) {} }
    document.getElementById('preview-content').innerHTML = '';
    document.body.style.overflow = '';
    if (portal._escHandler) {
      document.removeEventListener('keydown', portal._escHandler);
      portal._escHandler = null;
    }
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
