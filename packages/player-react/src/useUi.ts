import { useMemo } from 'react';
import { createT, en } from './i18n.js';
import type { PlayerUiProps, Ui } from './ui.js';

/** The words, locale, clock and zone a component draws with: the props, with English and the player's own clock where they were left out. */
export function useUi({ t, locale = 'en', now, timeZone }: PlayerUiProps): Ui {
  const words = useMemo(() => t ?? createT(en, locale), [t, locale]);
  return { t: words, locale, now: now ?? Date.now, timeZone };
}
