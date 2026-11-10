// The small delights (konami code, hero glow, level meter) and the polish fixes that jsdom can see.
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { GoldWarden } from '../src/components/GoldWarden';
import { KONAMI } from '../src/lib/konami';
import { AiLevels } from '../src/sections/AiLevels';
import { Hero } from '../src/sections/Hero';
import { OpenSource } from '../src/sections/OpenSource';
import { INSTALL_KIT } from '../src/content';

function stubMatchMedia(opts: { reduced?: boolean; finePointer?: boolean } = {}) {
  window.matchMedia = ((q: string) => ({
    matches: /reduced-motion/.test(q) ? !!opts.reduced : /hover|pointer: fine/.test(q) ? (opts.finePointer ?? true) : false,
    media: q,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
  })) as unknown as typeof window.matchMedia;
}

const press = (key: string, target: Window | Element = window) => fireEvent.keyDown(target, { key });
const type = (keys: readonly string[]) => keys.forEach((k) => press(k));

beforeEach(() => {
  delete document.documentElement.dataset.gold;
  stubMatchMedia();
});
afterEach(cleanup);

describe('konami code', () => {
  it('is the classic sequence', () => {
    expect(KONAMI).toEqual(['ArrowUp', 'ArrowUp', 'ArrowDown', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'ArrowLeft', 'ArrowRight', 'b', 'a']);
  });
  it('turns the warden gold and says so in a polite live region', () => {
    render(<GoldWarden />);
    expect(document.documentElement.dataset.gold).toBeUndefined();
    act(() => type(KONAMI));
    expect(document.documentElement.dataset.gold).toBe('true');
    const status = screen.getByRole('status');
    expect(status.getAttribute('aria-live')).toBe('polite');
    expect(status.textContent).toMatch(/gold/i);
  });
  it('is case-insensitive for B and A', () => {
    render(<GoldWarden />);
    act(() => type([...KONAMI.slice(0, 8), 'B', 'A']));
    expect(document.documentElement.dataset.gold).toBe('true');
  });
  it('does nothing for a partial sequence', () => {
    render(<GoldWarden />);
    act(() => type(KONAMI.slice(0, 9)));
    expect(document.documentElement.dataset.gold).toBeUndefined();
  });
  it('a wrong key resets the sequence, but a fresh start after it still works', () => {
    render(<GoldWarden />);
    act(() => type([...KONAMI.slice(0, 5), 'x']));
    act(() => type(KONAMI.slice(5)));
    expect(document.documentElement.dataset.gold).toBeUndefined();
    act(() => type(KONAMI));
    expect(document.documentElement.dataset.gold).toBe('true');
  });
  it('a restart in the middle ("up up up down ...") still matches from the second up', () => {
    render(<GoldWarden />);
    act(() => type(['ArrowUp', ...KONAMI]));
    expect(document.documentElement.dataset.gold).toBe('true');
  });
  it('is ignored while typing in a field, so the chat box and the report form never trigger it', () => {
    render(
      <>
        <GoldWarden />
        <input aria-label="chat" />
      </>,
    );
    const input = screen.getByLabelText('chat');
    act(() => KONAMI.forEach((k) => press(k, input)));
    expect(document.documentElement.dataset.gold).toBeUndefined();
  });
  it('ignores keys with a modifier held (browser shortcuts)', () => {
    render(<GoldWarden />);
    act(() => KONAMI.forEach((k) => fireEvent.keyDown(window, { key: k, ctrlKey: true })));
    expect(document.documentElement.dataset.gold).toBeUndefined();
  });
  it('entering it again turns the warden back (it toggles, so it is never stuck)', () => {
    render(<GoldWarden />);
    act(() => type(KONAMI));
    act(() => type(KONAMI));
    expect(document.documentElement.dataset.gold).toBeUndefined();
    expect(screen.getByRole('status').textContent).toMatch(/teal|back/i);
  });
  it('removes its key listener on unmount', () => {
    const { unmount } = render(<GoldWarden />);
    unmount();
    act(() => type(KONAMI));
    expect(document.documentElement.dataset.gold).toBeUndefined();
  });
});

describe('hero', () => {
  it('keeps the exact headline text, set as two balanced sentences', () => {
    render(<Hero />);
    const h1 = screen.getByRole('heading', { level: 1 });
    expect(h1.textContent).toBe('Your game has chat. Give it a warden.');
    expect(h1.querySelectorAll('.h1-line')).toHaveLength(2);
  });
  it('shows the install command with its text intact and no break inside a package name', () => {
    render(<Hero />);
    const code = document.querySelector('.cmd code') as HTMLElement;
    expect(code.textContent).toBe(INSTALL_KIT);
    const parts = [...code.querySelectorAll('.nw')].map((e) => e.textContent);
    expect(parts.join(' ')).toBe(INSTALL_KIT);
    expect(parts.some((p) => p?.includes('@chatwarden/store-sqlite'))).toBe(true);
  });
  it('moves a glow with the pointer on a fine pointer', () => {
    render(<Hero />);
    const hero = document.getElementById('hero') as HTMLElement;
    hero.getBoundingClientRect = () => ({ left: 100, top: 50, width: 800, height: 400, right: 900, bottom: 450, x: 100, y: 50, toJSON() {} });
    fireEvent.pointerMove(hero, { clientX: 500, clientY: 250, pointerType: 'mouse' });
    expect(hero.style.getPropertyValue('--mx')).toBe('50%');
    expect(hero.style.getPropertyValue('--my')).toBe('50%');
  });
  it('does not track the pointer under reduced motion', () => {
    stubMatchMedia({ reduced: true });
    render(<Hero />);
    const hero = document.getElementById('hero') as HTMLElement;
    fireEvent.pointerMove(hero, { clientX: 500, clientY: 250, pointerType: 'mouse' });
    expect(hero.style.getPropertyValue('--mx')).toBe('');
  });
  it('does not track touch pointers', () => {
    render(<Hero />);
    const hero = document.getElementById('hero') as HTMLElement;
    fireEvent.pointerMove(hero, { clientX: 500, clientY: 250, pointerType: 'touch' });
    expect(hero.style.getPropertyValue('--mx')).toBe('');
  });
});

describe('AI level meter', () => {
  it('states plainly that only level 0 exists, with no invented numbers', () => {
    render(<AiLevels />);
    const meter = screen.getByTestId('level-meter');
    expect(meter.textContent).toMatch(/level 0 is live/i);
    expect(meter.textContent).toMatch(/shipped: 0 of 4/i);
    expect(meter.textContent).toMatch(/levels 1 to 4/i);
    expect(meter.textContent).toMatch(/coming/i);
  });
  it('shows four pips, one per AI level 1 to 4, all unlit (matching "0 of 4"), hidden from assistive tech', () => {
    render(<AiLevels />);
    const meter = screen.getByTestId('level-meter');
    expect(meter.querySelectorAll('.pip')).toHaveLength(4);
    expect(meter.querySelectorAll('.pip.is-live')).toHaveLength(0);
    expect(meter.querySelector('.pips')?.getAttribute('aria-hidden')).toBe('true');
  });
  it('still lists every level, with 1 to 4 marked coming soon', () => {
    render(<AiLevels />);
    expect(document.querySelectorAll('.level .pill-soon')).toHaveLength(4);
    expect(document.querySelectorAll('.level .pill-live')).toHaveLength(1);
  });
});

describe('open-source badges', () => {
  it('use their own class names, so the demo stylesheet (which styles .badge as a count chip) cannot restyle them', () => {
    render(<OpenSource />);
    const list = screen.getByRole('list');
    for (const li of within(list).getAllByRole('listitem')) {
      expect(li.className).toContain('open-badge');
      expect(li.classList.contains('badge')).toBe(false);
    }
  });
});
