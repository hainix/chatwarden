import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { CaseCard } from '../src/pieces/CaseCard.js';
import { CaseList } from '../src/pieces/CaseList.js';
import { CaseWorkbench } from '../src/pieces/CaseWorkbench.js';
import { RecentActions } from '../src/pieces/RecentActions.js';
import { hubWorld } from './world.js';
import { renderPieces } from './pieces-kit.js';
import { rulesCss } from './css.js';

// A piece placed in somebody else's page. jsdom has no layout, so this checks what the stylesheet says and the structure the
// pieces render; the pixels are checked in a real browser (see the report's screenshots).

const css = rulesCss();

/** The declarations of the first rule whose selector list contains `selector` exactly. */
function rule(selector: string): string {
  for (const m of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selectors = (m[1] as string).split(',').map((s) => s.trim());
    if (selectors.includes(selector)) return m[2] as string;
  }
  return '';
}

describe('the embedded root', () => {
  it('does not fill the viewport or clip: the page it sits in decides its height', () => {
    const body = rule('.cw-hub--embed');
    expect(body).toMatch(/height:\s*auto/);
    expect(body).toMatch(/overflow:\s*visible/);
    expect(body).toMatch(/background:\s*transparent/);
  });

  it('the shell root still fills the viewport', () => {
    expect(rule('.cw-hub')).toMatch(/height:\s*var\(--cw-hub-height\)/);
  });
});

describe('a piece', () => {
  it('has padding of its own, and is the container the stylesheet\'s container queries measure', () => {
    const body = rule('.cw-hub .cw-piece');
    expect(body).toMatch(/padding:/);
    expect(body).toMatch(/container-type:\s*inline-size/);
    expect(body).toMatch(/container-name:\s*cwmain/);
  });

  it('relies on no grid area of the shell', () => {
    expect(css).not.toMatch(/grid-area/);
    for (const m of css.matchAll(/([^{}]*\.cw-piece[^{}]*)\{([^{}]*)\}/g)) {
      expect(m[2], m[1]).not.toMatch(/grid-(area|column|row)\s*:/);
    }
  });

  it('a case pane in a piece is as tall as its content, not the shell column it was made for', () => {
    expect(rule('.cw-hub .cw-piece .cw-casepane')).toMatch(/height:\s*auto/);
  });

  it('the queue in a piece is a box of its own, with a height it scrolls inside', () => {
    const body = rule('.cw-hub .cw-piece .cw-queue');
    expect(body).toMatch(/border:/);
    expect(body).toMatch(/max-height:/);
  });

  it('the workbench lays the case and its panel side by side when it is wide and stacks them when it is narrow', () => {
    expect(rule('.cw-hub .cw-wb')).toMatch(/display:\s*grid/);
    expect(css).toMatch(/@container cwmain \(min-width:[^)]+\)\s*\{[^@]*\.cw-wb\b/);
  });
});

describe('what each piece renders', () => {
  it('every piece root is a .cw-piece outside any shell body, and holds no shell class', async () => {
    const w = await hubWorld({ role: 'senior' });
    const f = await w.file({ target: 'Alpha' });
    const { container } = renderPieces(
      w,
      <>
        <CaseList />
        <CaseCard reportId={f.id} />
        <CaseWorkbench reportId={f.id} />
        <RecentActions />
      </>,
    );
    await screen.findByRole('complementary', { name: 'About this case' });
    const roots = [...container.querySelectorAll('.cw-piece')];
    expect(roots.map((r) => (r as HTMLElement).dataset.cwPiece)).toEqual(['CaseList', 'CaseCard', 'CaseWorkbench', 'RecentActions']);
    for (const root of roots) {
      expect(root.closest('.cw-body')).toBeNull();
      expect(root.parentElement).toBe(container.querySelector('.cw-hub--embed'));
    }
  });

  it('the workbench is the case beside its panel, in one box', async () => {
    const w = await hubWorld();
    const f = await w.file({ target: 'Alpha' });
    const { container } = renderPieces(w, <CaseWorkbench reportId={f.id} />);
    await screen.findByRole('complementary', { name: 'About this case' });
    const wb = container.querySelector('.cw-wb') as HTMLElement;
    expect([...wb.children].map((c) => c.className.split(' ')[0])).toEqual(['cw-casepane', 'cw-ctx']);
  });
});
