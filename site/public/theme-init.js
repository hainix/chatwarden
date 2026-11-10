// Runs before first paint so a stored light/dark choice never flashes the wrong theme.
// It is a file (not an inline script) so the Content-Security-Policy can forbid inline scripts.
try {
  var t = localStorage.getItem('cw-theme');
  if (t === 'light' || t === 'dark') document.documentElement.dataset.theme = t;
} catch {
  // Storage is blocked (private mode): the page follows the system theme.
}
