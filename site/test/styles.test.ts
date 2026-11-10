// Guards on the stylesheet itself: things that are easy to break silently and not visible in a jsdom render.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const css = readFileSync(join(__dirname, '..', 'src', 'styles.css'), 'utf8');

/** The bodies of every rule whose selector is exactly `selector` (comma lists are not split). */
function bodies(selector: string): string[] {
  const out: string[] = [];
  const re = new RegExp(`(?:^|[{}]|\\*\\/)\\s*${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{([^}]*)\\}`, 'g');
  for (const m of css.matchAll(re)) out.push(m[1] as string);
  return out;
}
const decls = (body: string) =>
  body
    .split(';')
    .map((d) => d.trim().replace(/\s+/g, ' '))
    .filter(Boolean)
    .sort();

describe('light theme tokens', () => {
  it('the toggled theme and the first-visit (prefers-color-scheme) theme define identical tokens', () => {
    const toggled = bodies(":root[data-theme='light']");
    const system = bodies(':root:not([data-theme])');
    expect(toggled).toHaveLength(1);
    expect(system).toHaveLength(1);
    expect(decls(system[0] as string)).toEqual(decls(toggled[0] as string));
  });
  it('explains why the block is written twice', () => {
    expect(css).toMatch(/written twice on purpose/i);
  });
});

describe('the refused line', () => {
  it('is struck through in its base style, so it still is under reduced motion', () => {
    const base = bodies('.msg-refused .said').join(';');
    expect(base).toMatch(/text-decoration(-line)?:\s*line-through/);
  });
  it('animates from the unstruck state instead of to the struck one', () => {
    const m = css.match(/@keyframes strike\s*\{([\s\S]*?)\n\}/);
    expect(m).toBeTruthy();
    const frames = m?.[1] ?? '';
    expect(frames).toMatch(/from\s*\{/);
    expect(frames).not.toMatch(/\bto\s*\{/);
  });
});

describe('reduced motion', () => {
  it('switches every animation and transition off', () => {
    const m = css.match(/@media \(prefers-reduced-motion: reduce\)\s*\{([\s\S]*)\}\s*$/);
    expect(m).toBeTruthy();
    expect(m?.[1]).toMatch(/animation:\s*none\s*!important/);
    expect(m?.[1]).toMatch(/transition:\s*none\s*!important/);
  });
});

describe('gold on dark surfaces', () => {
  const demoCss = readFileSync(join(__dirname, '..', 'src', 'demo', 'demo.css'), 'utf8');
  it('--gold-bright is the same gold in both themes (the light --gold is a dark text gold)', () => {
    expect(css).toMatch(/--gold-bright:\s*#ffc83d/);
    for (const sel of [":root[data-theme='light']", ':root:not([data-theme])']) {
      expect(bodies(sel).join(';'), sel).not.toMatch(/--gold-bright/);
    }
  });
  it('fills under dark ink (step numbers, avatars) use the bright gold, so they stay yellow in the light theme', () => {
    expect(bodies('.step-num').join(';')).toMatch(/background:\s*var\(--gold-bright\)/);
    expect(bodies('.avatar-b').join(';')).toMatch(/background:\s*var\(--gold-bright\)/);
  });
  it('the demo (all dark screens) never uses the theme-dependent --gold', () => {
    expect(demoCss).not.toMatch(/var\(--gold\)/);
  });
});

describe('the open-source badges and the demo count chip', () => {
  const demoCss = readFileSync(join(__dirname, '..', 'src', 'demo', 'demo.css'), 'utf8');
  it('the demo owns a bare .badge (a magenta count chip), so the site sheet must not define one', () => {
    expect(demoCss).toMatch(/^\.badge\s*\{/m);
    expect(bodies('.badge')).toEqual([]);
    expect(bodies('.open-badge').join(';')).toMatch(/border-radius:\s*999px/);
  });
});
