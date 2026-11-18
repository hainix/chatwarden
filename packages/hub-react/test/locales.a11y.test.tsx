import { screen, waitFor } from '@testing-library/react';
import axe from 'axe-core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { es } from '../src/locales/es.js';
import { pt } from '../src/locales/pt.js';
import { renderHub } from './render.js';
import { hubWorld } from './world.js';
import type { HubWorld } from './world.js';

// The queue, a case and Settings in Spanish and Portuguese, in a 360 px column, light and dark: the words come from the catalogue (the
// provider loads it) and axe finds nothing. jsdom paints no colours, so `color-contrast` is off here; the stylesheet's contrast is computed from its
// tokens by the static tests, and the words add none.
const RULES = { 'color-contrast': { enabled: false } } as const;
async function violations(container: HTMLElement): Promise<string[]> {
  const result = await axe.run(container, { rules: RULES, resultTypes: ['violations'] });
  return result.violations.map((v) => `${v.impact ?? 'unknown'}: ${v.id} (${v.nodes.length}) ${v.nodes.map((n) => n.target.join(' ')).join('; ')}`);
}

const LANGS = { es: es as Record<string, string>, pt: pt as Record<string, string> };

async function crowd(w: HubWorld): Promise<string> {
  for (let i = 0; i < 4; i += 1) await w.file({ target: 'Mallory', reporter: `A${i}`, category: i % 2 === 0 ? 'harassment' : 'hate' });
  const filed = await w.file({ target: 'Zed', reporter: 'Z1', category: 'spam' });
  return (filed as unknown as { reportId?: string; id?: string }).reportId ?? (filed as unknown as { id: string }).id;
}

describe.each(['es', 'pt'] as const)('axe in %s at 360 px', (locale) => {
  // jsdom has no layout; the page is made 360 px wide (the width media queries and the script read) so the narrow render is what is checked.
  const width = window.innerWidth;
  beforeEach(() => {
    window.innerWidth = 360;
    document.body.style.width = '360px';
  });
  afterEach(() => {
    window.innerWidth = width;
    document.body.style.width = '';
  });
  const words = LANGS[locale];

  describe.each(['light', 'dark'] as const)('%s theme', (theme) => {
    it('the queue', async () => {
      const w = await hubWorld({ role: 'owner' });
      await crowd(w);
      const { container } = renderHub(w, { path: '/reports', theme, locale });
      await screen.findByRole('heading', { name: words['hub.reports.title'] as string });
      await waitFor(() => expect(container.querySelector('[aria-busy="true"]')).toBeNull());
      expect(container.querySelector('.cw-hub')).toHaveAttribute('data-cw-theme', theme);
      expect(screen.queryByRole('heading', { name: 'Reports' })).toBeNull();
      expect(await violations(container)).toEqual([]);
    });

    it('a case', async () => {
      const w = await hubWorld({ role: 'owner' });
      const id = await crowd(w);
      const { container } = renderHub(w, { path: `/reports/${id}`, theme, locale });
      await screen.findByRole('region', { name: words['hub.decide.title'] as string });
      expect(screen.queryByRole('region', { name: 'Decision' })).toBeNull();
      expect(await violations(container)).toEqual([]);
    });

    it('Settings', async () => {
      const w = await hubWorld({ role: 'owner' });
      const { container } = renderHub(w, { path: '/settings', theme, locale });
      await screen.findByRole('navigation', { name: words['hub.settings.sections'] as string });
      expect(screen.queryByRole('navigation', { name: 'Settings sections' })).toBeNull();
      expect(await violations(container)).toEqual([]);
    });
  });
});
