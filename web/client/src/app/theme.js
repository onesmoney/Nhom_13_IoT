export const THEME_KEY = 'nhom13.theme';

export function readTheme(host = window) {
  try {
    const saved = host.localStorage.getItem(THEME_KEY);
    if (saved === 'light' || saved === 'dark') return saved;
  } catch { /* Fall back to the system preference. */ }
  try { return host.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'; } catch { return 'light'; }
}

export function applyTheme(theme, host = window) {
  host.document.documentElement.dataset.theme = theme;
  host.document.documentElement.classList.toggle('dark', theme === 'dark');
  host.document.documentElement.style.colorScheme = theme;
}

export function saveTheme(theme, storage) {
  try { (storage ?? window.localStorage).setItem(THEME_KEY, theme); } catch { /* Theme still works. */ }
}
