/* Clickjacking defense — moved out of index.html so the CSP can drop
   script-src 'unsafe-inline'. Loaded synchronously before any other
   script so a framing attacker's content never paints. */
(function () {
  if (window.top !== window.self) {
    try { document.documentElement.style.display = 'none'; } catch (_) {}
    try { window.top.location = window.self.location.href; } catch (_) {}
  }
})();
