/* Service worker auto-update — same pattern the CRM uses. Moved out
   of index.html so the CSP can drop script-src 'unsafe-inline'. Every
   deploy lands on the next page load; no manual DevTools resets. */
if ('serviceWorker' in navigator) {
  window.addEventListener('load', async () => {
    try {
      const reg = await navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' });
      reg.update().catch(() => {});
      reg.addEventListener('updatefound', () => {
        const sw = reg.installing;
        if (!sw) return;
        sw.addEventListener('statechange', () => {
          if (sw.state === 'installed' && navigator.serviceWorker.controller) {
            try { sw.postMessage({ type: 'SKIP_WAITING' }); } catch (_) {}
          }
        });
      });
      let reloading = false;
      navigator.serviceWorker.addEventListener('controllerchange', () => {
        if (reloading) return;
        reloading = true;
        window.location.reload();
      });
    } catch (err) { console.warn('SW register failed', err); }
  });
}
