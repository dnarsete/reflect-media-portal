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

  /* Check whether the signed-in user is an admin (role='admin' in
     profiles). Used to show the upload button in the header. */
  async isAdmin() {
    try {
      const { data: userData } = await sb.auth.getUser();
      const uid = userData?.user?.id;
      if (!uid) return false;
      const r = await sb.from('profiles').select('role').eq('id', uid).maybeSingle();
      return r.data?.role === 'admin';
    } catch (_) { return false; }
  },

  async _enterSignedIn() {
    const ctx = await portalAuth.whichAccount();
    /* Customer: ctx.account_id is a real UUID. Staff (admin/rep):
       ctx.account_id is NULL but business_name is 'Staff · {name}'.
       Both are valid signed-in states; only an empty ctx (email on
       no list and not a staff user) hits the denied screen. */
    if (!ctx) {
      view.show('view-denied');
      return;
    }
    portalAuth._accountCtx = ctx;
    document.getElementById('header-account').classList.remove('hide');
    document.getElementById('header-account-name').textContent = ctx.business_name || '';

    /* Admin gets the upload button + delete button on each file.
       Checked silently; non-admins see no indication these controls
       could exist. */
    portalBrowse._isAdmin = await portalAuth.isAdmin();
    if (portalBrowse._isAdmin) {
      document.getElementById('upload-btn').classList.remove('hide');
    }

    view.show('view-browse');
    await portalBrowse.load();
  },

  async boot() {
    const params = new URLSearchParams(location.hash.slice(1));
    const hasAuthPayload = params.has('access_token') || params.has('error');

    if (hasAuthPayload) {
      view.show('view-callback');
      /* supabase-js often finalizes the session synchronously from the
         URL fragment before our listener attaches, in which case
         onAuthStateChange NEVER emits SIGNED_IN and we used to sit on
         the loading screen for a full 4 s. Poll getSession briefly
         first — if the session is already there, skip the wait. */
      let gotSession = false;
      for (let i = 0; i < 20 && !gotSession; i++) {
        const { data } = await sb.auth.getSession();
        if (data?.session) { gotSession = true; break; }
        await new Promise(r => setTimeout(r, 50));
      }
      if (!gotSession) {
        /* Fall back to the listener for the slow-path, with the same
           4 s cap so we never hang forever. */
        await new Promise((resolve) => {
          const { data: sub } = sb.auth.onAuthStateChange((event) => {
            if (event === 'SIGNED_IN' || event === 'INITIAL_SESSION') {
              try { sub.subscription.unsubscribe(); } catch (_) {}
              resolve();
            }
          });
          setTimeout(() => { try { sub.subscription.unsubscribe(); } catch (_) {} resolve(); }, 4000);
        });
      }
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
      else if (action === 'delete') portalBrowse.deleteFile(path, name);
      else if (action === 'viewOffice') portalBrowse.viewOffice(path, name);
    });
    /* Move-to dropdown routed through delegation too so inline onchange
       isn't the only path — survives a future CSP tightening that drops
       'unsafe-inline' and makes attribute handlers inert. */
    document.getElementById('browse-list').addEventListener('change', (e) => {
      const sel = e.target.closest('select.move-select');
      if (!sel) return;
      const val = sel.value;
      if (val && val !== '__move') {
        const { path, name } = sel.dataset;
        /* Reset the dropdown FIRST so a re-render that happens inside
           moveFile can't race the reset into firing change again. */
        sel.value = '__move';
        portalBrowse.moveFile(path, name, val);
      }
    });
    /* Search input debounce — rebuilding the full grid (with Office
       iframes) on every keystroke used to fire tens-to-hundreds of
       Microsoft viewer loads per short query. 150 ms feels responsive
       and collapses the storm. */
    const search = document.getElementById('browse-search');
    if (search) {
      search.oninput = () => {
        clearTimeout(portalBrowse._searchT);
        portalBrowse._searchT = setTimeout(() => portalBrowse.render(), 150);
      };
    }
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

      /* Batch-sign every file once at load time so thumbnails render
         synchronously inside _cardHTML. 24-hour TTL (was 1h) so a day-
         long portal session doesn't go blank mid-day — reps keeping
         the portal open during a prospecting day used to see every
         thumbnail silently 403 at the 60-minute mark. Click-time
         actions still re-sign fresh so even if the batch URL expires
         the download/preview buttons work. The materials bucket is
         private, so there is no permanent public URL — signed URLs
         are the only way in. */
      if (portalBrowse._files.length) {
        try {
          const paths = portalBrowse._files.map(f => f.path);
          const { data: signed, error } = await sb.storage
            .from(CFG.MATERIALS_BUCKET)
            .createSignedUrls(paths, 86400);
          if (!error && Array.isArray(signed)) {
            const byPath = Object.create(null);
            signed.forEach(s => { if (s && s.path) byPath[s.path] = s.signedUrl; });
            portalBrowse._files.forEach(f => { f._signedUrl = byPath[f.path] || ''; });
          }
        } catch (e) {
          console.warn('[portal] batch sign failed:', e);
        }
      }

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

    /* Preserve the config order (Training → Instructions → Social
       Media → Videos) instead of sorting alphabetically. Any folder
       that somehow isn't in PORTAL_CATEGORIES falls to the end. */
    const orderedCats = CFG.PORTAL_CATEGORIES.filter(c => groups[c])
      .concat(Object.keys(groups).filter(c => !CFG.PORTAL_CATEGORIES.includes(c)));
    wrap.innerHTML = orderedCats.map(cat => `
      <h2 class="category-h">${esc(cat)}</h2>
      ${groups[cat].map(f => portalBrowse._cardHTML(f)).join('')}
    `).join('');
  },

  _cardHTML(f) {
    const ext = (f.name.split('.').pop() || '').toLowerCase();
    const isVideo = ['mp4', 'mov', 'webm', 'm4v'].includes(ext);
    const isImage = ['png', 'jpg', 'jpeg', 'gif', 'webp'].includes(ext);
    const isOffice = ['pptx', 'ppt', 'docx', 'doc', 'xlsx', 'xls'].includes(ext);
    /* _signedUrl was populated by load() via batch createSignedUrls.
       If sign-time failed for some reason the thumb falls back to a
       placeholder — click-time actions re-sign fresh so the file is
       still viewable/downloadable. */
    const url = f._signedUrl || '';
    const kb = f.metadata?.size
      ? (f.metadata.size < 1024 * 1024
        ? (f.metadata.size / 1024).toFixed(0) + ' KB'
        : (f.metadata.size / 1024 / 1024).toFixed(1) + ' MB')
      : '';

    let thumb;
    if (isImage) {
      thumb = url ? `<img src="${esc(url)}" alt="${esc(f.name)}" loading="lazy"/>` : `<div class="placeholder">🖼</div>`;
    } else if (isVideo) {
      thumb = url ? `<video src="${esc(url)}#t=0.5" muted preload="metadata"></video><div class="asset-play">▶</div>` : `<div class="placeholder">🎬</div>`;
    } else if (isOffice) {
      /* Office thumbnails render as a plain icon instead of embedding
         Microsoft's Office Online Viewer iframe. The viewer loaded its
         own "Save" button inside the iframe that fires an
         oauth.officeapps.live.com OAuth popup on click, and 10+ office
         files in the grid used to spawn 10+ concurrent cross-origin
         viewer loads at page open. Preview and Download buttons on the
         card still work via the signed URL — Microsoft is out of the
         thumbnail path. Same change as the CRM Materials grid. */
      thumb = `<div class="placeholder">📄</div>`;
    } else {
      thumb = `<div class="placeholder">📎</div>`;
    }

    const adminDeleteBtn = portalBrowse._isAdmin
      ? `<button class="danger" data-action="delete" data-path="${esc(f.path)}" data-name="${esc(f.name)}" title="Delete (admin only)" aria-label="Delete">🗑</button>`
      : '';

    const adminMoveSelect = portalBrowse._isAdmin
      ? `<select class="move-select" data-path="${esc(f.path)}" data-name="${esc(f.name)}" title="Move to another category (admin only)">
          <option value="__move">↔ Move to…</option>
          ${CFG.PORTAL_CATEGORIES.filter(c => c !== f.category).map(c => `<option value="${esc(c)}">→ ${esc(c)}</option>`).join('')}
        </select>`
      : '';

    /* Office files: preview-only (opens in a new tab via Office Online
       Viewer). No Download button — Dan wants training/proprietary
       Office content viewable but not distributable. */
    const previewBtn = isOffice
      ? `<button class="ghost" data-action="viewOffice" data-path="${esc(f.path)}" data-name="${esc(f.name)}">View in new window</button>`
      : `<button class="ghost" data-action="preview" data-path="${esc(f.path)}" data-name="${esc(f.name)}" data-category="${esc(f.category)}">Preview</button>`;
    const downloadBtn = isOffice
      ? ''
      : `<button class="primary" data-action="download" data-path="${esc(f.path)}" data-name="${esc(f.name)}">Download</button>`;

    return `<div class="asset-card">
      <div class="asset-thumb">${thumb}</div>
      <div class="asset-meta">
        <span class="asset-name">${esc(f.name)}</span>
        <span class="asset-sub">${esc(f.category)}${kb ? ' · ' + esc(kb) : ''}${isOffice ? ' · view only' : ''}</span>
      </div>
      <div class="asset-actions">
        ${previewBtn}
        ${downloadBtn}
        ${adminMoveSelect}
        ${adminDeleteBtn}
      </div>
    </div>`;
  },

  async openPreview(path, name, category) {
    const ext = (name.split('.').pop() || '').toLowerCase();
    const isVideo = ['mp4', 'mov', 'webm', 'm4v'].includes(ext);
    const isImage = ['png', 'jpg', 'jpeg', 'gif', 'webp'].includes(ext);
    const isPdf = ext === 'pdf';
    /* Fresh signed URL at click time — 1-hour TTL covers any realistic
       preview session and we don't rely on the possibly-stale URL
       cached on the file row. */
    const sr = await sb.storage.from(CFG.MATERIALS_BUCKET).createSignedUrl(path, 3600);
    if (sr.error || !sr.data?.signedUrl) {
      alert('Could not open preview: ' + (sr.error?.message || 'no url'));
      return;
    }
    const url = sr.data.signedUrl;
    const content = document.getElementById('preview-content');

    let media;
    if (isImage) media = `<img src="${esc(url)}" alt="${esc(name)}"/>`;
    else if (isVideo) media = `<video src="${esc(url)}" controls autoplay playsinline></video>`;
    else if (isPdf) media = `<iframe src="${esc(url)}" style="width:100%;height:80vh;border:0;background:#fff" title="${esc(name)}"></iframe>`;
    else media = `<div class="preview-fallback"><div class="placeholder">📎</div><p class="muted">Preview isn't available for this file type. Use Download to save it.</p></div>`;

    content.innerHTML = `${media}
      <div class="preview-meta">
        <div class="preview-name">${esc(name)}</div>
        ${esc(category)}
      </div>`;

    document.getElementById('preview-download').onclick = () => portalBrowse.download(path, name);
    document.getElementById('preview-modal').classList.remove('hide');
    document.body.style.overflow = 'hidden';

    /* Detach any previous handler before attaching a new one so a
       double-open (keyboard shortcut, future auto-advance) doesn't
       leak orphaned Esc listeners that fire on every future key. */
    if (portalBrowse._escHandler) {
      document.removeEventListener('keydown', portalBrowse._escHandler);
    }
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

  /* Move a file to a different category folder. Admin only.
     Supabase storage API has a direct move() method.
     Re-checks admin against the server (not just the local _isAdmin
     flag) so a browser-console flip of _isAdmin doesn't bypass the
     client gate before Supabase RLS gets to see the request. */
  async moveFile(path, name, newCategory) {
    if (!(await portalAuth.isAdmin())) return;
    if (!newCategory || newCategory === '__move') return;
    const newPath = `${newCategory}/${name}`;
    if (newPath === path) return;
    try {
      const r = await sb.storage.from(CFG.MATERIALS_BUCKET).move(path, newPath);
      if (r.error) throw r.error;
      await portalBrowse.load();
    } catch (e) {
      const msg = String(e?.message || e || '');
      /* Specific message for the "destination name taken" case so the
         admin knows what to do instead of just "Move failed: ...". */
      if (/already exists|duplicate/i.test(msg)) {
        alert(`Can't move "${name}" to ${newCategory} — a file with the same name is already there.\n\nRename or delete the one in ${newCategory} first, then try again.`);
      } else {
        alert('Move failed: ' + msg);
      }
    }
  },

  /* Open an Office file in a new tab via Microsoft's viewer. No
     download, no save-to-disk — the file is viewable but not
     distributable from the portal. Fresh signed URL at click time,
     1-hour TTL. After the window closes (or 1 hour, whichever is
     sooner) the url is dead; DevTools users can no longer share it. */
  async viewOffice(path) {
    const sr = await sb.storage.from(CFG.MATERIALS_BUCKET).createSignedUrl(path, 3600);
    if (sr.error || !sr.data?.signedUrl) {
      alert('Could not open file: ' + (sr.error?.message || 'no url'));
      return;
    }
    const officeUrl = `https://view.officeapps.live.com/op/view.aspx?src=${encodeURIComponent(sr.data.signedUrl)}`;
    window.open(officeUrl, '_blank', 'noopener,noreferrer');
  },

  async deleteFile(path, name) {
    /* Re-check admin against the server so a browser-console flip of
       _isAdmin doesn't let a non-admin reach storage.remove. */
    if (!(await portalAuth.isAdmin())) return;
    if (!confirm(`Permanently delete "${name}" from the media portal?\n\nThis removes the file from Supabase storage. There is no undo.`)) return;
    try {
      const r = await sb.storage.from(CFG.MATERIALS_BUCKET).remove([path]);
      if (r.error) throw r.error;
      await portalBrowse.load();
    } catch (e) {
      alert('Delete failed: ' + (e.message || e));
    }
  },

  async download(path, filename) {
    try {
      /* Sign URL FIRST — if it fails, we abort before logging a false
         download. Signed URL with { download: filename } makes Supabase
         reply with Content-Disposition: attachment; filename=... so the
         browser saves the file instead of opening inline. 1-hour TTL
         is more than enough for a single download. */
      const sr = await sb.storage.from(CFG.MATERIALS_BUCKET)
        .createSignedUrl(path, 3600, { download: filename });
      if (sr.error || !sr.data?.signedUrl) {
        throw sr.error || new Error('No signed URL');
      }

      /* Then log, then click. A failed log is still better than an
         unlogged download (per the original design), so a thrown log
         doesn't block the click. The only remaining false-positive is
         if the browser crashes between click() and the download
         completing — unavoidable without a server-side proxy. */
      try { await sb.rpc('portal_record_download', { p_asset_path: path }); }
      catch (e) { console.warn('[portal] download log failed:', e); }

      const a = document.createElement('a');
      a.href = sr.data.signedUrl;
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

/* ================= UPLOAD (admin only) ================= */
const portalUpload = {
  open() {
    const sel = document.getElementById('upload-category');
    if (sel.options.length <= 1) {
      CFG.PORTAL_CATEGORIES.forEach(c => {
        const opt = document.createElement('option');
        opt.value = c;
        opt.textContent = c;
        sel.appendChild(opt);
      });
    }
    document.getElementById('upload-files').value = '';
    document.getElementById('upload-status').innerHTML = '';
    document.getElementById('upload-submit').disabled = false;
    document.getElementById('upload-modal').classList.remove('hide');
    document.body.style.overflow = 'hidden';
  },

  close(e) {
    if (e && e.target && e.target.id !== 'upload-modal' && e.target.tagName !== 'BUTTON') return;
    document.getElementById('upload-modal').classList.add('hide');
    document.body.style.overflow = '';
  },

  async submit() {
    const category = document.getElementById('upload-category').value;
    const filesInput = document.getElementById('upload-files');
    const files = Array.from(filesInput.files || []);
    const status = document.getElementById('upload-status');
    const submit = document.getElementById('upload-submit');
    if (!category) { status.innerHTML = '<div class="signin-msg err">Pick a category first.</div>'; return; }
    if (!files.length) { status.innerHTML = '<div class="signin-msg err">Pick at least one file.</div>'; return; }

    /* Server-verified admin re-check so a browser-console
       portalBrowse._isAdmin=true can't open the modal and start a
       storage.upload that only the bucket's RLS would reject. */
    if (!(await portalAuth.isAdmin())) {
      status.innerHTML = '<div class="signin-msg err">Upload is admin-only.</div>';
      return;
    }

    /* Client-side upload guards — Supabase hard-fails anything over its
       bucket limit (typically 50 MB per file for free, 5 GB on paid)
       with a vague error that leaves half-finished uploads on screen.
       Reject obviously oversized or batch-heavy picks here with a
       clear message. Numbers are conservative; adjust in config.js if
       you need larger uploads. */
    const MAX_FILES = 25;
    const MAX_BYTES_PER_FILE = 500 * 1024 * 1024; // 500 MB
    if (files.length > MAX_FILES) {
      status.innerHTML = `<div class="signin-msg err">Too many files (${files.length}). Upload up to ${MAX_FILES} at a time.</div>`;
      return;
    }
    const tooBig = files.filter(f => f.size > MAX_BYTES_PER_FILE);
    if (tooBig.length) {
      status.innerHTML = `<div class="signin-msg err">${tooBig.length} file${tooBig.length===1?' is':'s are'} larger than 500 MB and can't be uploaded here:<br/>${tooBig.map(f => esc(f.name)).join('<br/>')}</div>`;
      return;
    }

    submit.disabled = true;
    status.innerHTML = `<div class="muted">Uploading 0 of ${files.length}…</div>`;

    let done = 0, failed = 0;
    const failedNames = [];
    for (const f of files) {
      const safeName = f.name.replace(/[/\\]/g, '_');
      const path = `${category}/${safeName}`;
      try {
        const r = await sb.storage.from(CFG.MATERIALS_BUCKET).upload(path, f, {
          cacheControl: '3600',
          upsert: true,
          contentType: f.type || undefined
        });
        if (r.error) throw r.error;
        done++;
      } catch (e) {
        failed++;
        failedNames.push(`${f.name} — ${e.message || e}`);
      }
      status.innerHTML = `<div class="muted">Uploaded ${done} of ${files.length}${failed ? ` · ${failed} failed` : ''}…</div>`;
    }

    if (failed === 0) {
      status.innerHTML = `<div class="signin-msg ok">${done} file${done===1?'':'s'} uploaded. They're live on the portal now.</div>`;
      await portalBrowse.load();
      setTimeout(() => portalUpload.close(), 1500);
    } else {
      status.innerHTML = `<div class="signin-msg err">Uploaded ${done} of ${files.length}. ${failed} failed:<br/>${failedNames.map(esc).join('<br/>')}</div>`;
      await portalBrowse.load();
    }
    submit.disabled = false;
  }
};

/* ================= DOM wiring =================
   Every event listener bound here instead of inline onclick/onchange
   attributes in index.html, so the CSP can forbid script-src
   'unsafe-inline' — any future stored XSS can't execute inline. The
   handlers themselves are unchanged. */
function bindDomHandlers() {
  const on = (id, event, fn) => {
    const el = document.getElementById(id);
    if (el) el.addEventListener(event, fn);
  };

  on('upload-btn',          'click',  () => portalUpload.open());
  on('signout-btn',         'click',  () => portalAuth.signOut());
  on('denied-signout-btn',  'click',  () => portalAuth.signOut());

  on('signin-form',         'submit', (e) => { e.preventDefault(); portalAuth.sendMagicLink(); });
  on('upload-form',         'submit', (e) => { e.preventDefault(); portalUpload.submit(); });

  on('browse-category',     'change', () => portalBrowse.render());
  /* browse-search debounce + oninput is attached in portalBrowse._bindActions
     at load-time; nothing to do here. */

  /* Upload modal — backdrop click closes, body click stops propagation. */
  on('upload-modal',        'click',  (e) => portalUpload.close(e));
  on('upload-modal-close',  'click',  () => portalUpload.close());

  /* Preview modal — same pattern. */
  on('preview-modal',       'click',  (e) => portalBrowse.closePreview(e));
  on('preview-close-x',     'click',  () => portalBrowse.closePreview());
  on('preview-close-btn',   'click',  () => portalBrowse.closePreview());

  /* Any element with data-stop-prop (the two modal-bodies) stops its
     own clicks from reaching the backdrop. */
  document.querySelectorAll('[data-stop-prop]').forEach(el => {
    el.addEventListener('click', (e) => e.stopPropagation());
  });
}

/* Boot */
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => { bindDomHandlers(); portalAuth.boot(); });
} else {
  bindDomHandlers();
  portalAuth.boot();
}
