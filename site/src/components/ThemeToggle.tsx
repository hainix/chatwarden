import { useState } from 'react';
import { applyTheme, currentTheme, storeTheme, type Theme } from '../lib/theme';
import { MoonIcon, SunIcon } from './Icons';

export function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>(() => currentTheme());

  function toggle() {
    const next: Theme = theme === 'dark' ? 'light' : 'dark';
    setTheme(next);
    applyTheme(next);
    storeTheme(next);
  }

  return (
    <button
      type="button"
      className="icon-btn"
      onClick={toggle}
      aria-label={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
    >
      {theme === 'dark' ? <SunIcon /> : <MoonIcon />}
    </button>
  );
}
