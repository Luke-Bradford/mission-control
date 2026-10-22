// Runs before first paint (a blocking classic script, since the CSP forbids inline scripts) so a
// remembered light/dark choice never flashes the other theme. Key: THEME_KEY in src/storage.ts
// (re-exported by src/theme.ts).
try {
  const t = localStorage.getItem("mc-theme");
  if (t === "light" || t === "dark") document.documentElement.dataset.theme = t;
} catch {}
