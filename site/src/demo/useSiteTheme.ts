import { useEffect, useState } from 'react';
import { currentTheme } from '../lib/theme';
import type { Theme } from '../lib/theme';

/** The page's theme, now: the visitor's choice on `<html data-theme>`, else the system's. It follows the theme toggle live. */
export function readSiteTheme(): Theme {
  if (typeof document === 'undefined') return 'dark';
  const set = document.documentElement.dataset.theme;
  return set === 'light' || set === 'dark' ? set : currentTheme();
}

/**
 * The theme the hub and the player components are drawn in, so they match the page. They take `theme` as a prop (`light` or
 * `dark`), so the page tells them: it changes when the toggle flips `data-theme` or, with no choice made, when the system does.
 */
export function useSiteTheme(): Theme {
  const [theme, setTheme] = useState<Theme>(readSiteTheme);
  useEffect(() => {
    const on = () => setTheme(readSiteTheme());
    on();
    const observer = new MutationObserver(on);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    let query: MediaQueryList | null = null;
    try {
      query = typeof window.matchMedia === 'function' ? window.matchMedia('(prefers-color-scheme: light)') : null;
      query?.addEventListener?.('change', on);
    } catch {
      query = null;
    }
    return () => {
      observer.disconnect();
      query?.removeEventListener?.('change', on);
    };
  }, []);
  return theme;
}
