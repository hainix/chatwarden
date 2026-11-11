// @vitest-environment node
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { FALLBACK_BEFORE, TOKENS_BEFORE } from './tokens-before.js';

// The theme contract. A page themes the hub by setting a public `--cw-*` token on ANY element above it (body, a wrapper, the
// <chatwarden-hub> host) or on the hub's own root. That only works if the stylesheet never declares a public name on `.cw-hub`
// (a declaration on an element beats the value inherited from above), so the defaults sit under private `--cwd-*` names and every
// read is `var(--cw-x, var(--cwd-x))`: the page's value if there is one, the default if not. jsdom does not compute custom
// properties through the cascade, so this checks the stylesheet's text; the browser smoke in hub-element computes it in Chromium.

const css = readFileSync(fileURLToPath(new URL('../src/styles.css', import.meta.url)), 'utf8');
const bare = css.replace(/\/\*[\s\S]*?\*\//g, '');

interface Block {
  selector: string;
  body: string;
  /** The text of the at-rule it sits in, if any. */
  inside: string;
}

/** Every declaration block with its selector, however deep in @media or @supports. */
function blocks(source: string): Block[] {
  const out: Block[] = [];
  const stack: string[] = [];
  let head = '';
  let body = '';
  let depthOfBody = -1;
  for (const ch of source) {
    if (ch === '{') {
      if (depthOfBody >= 0) {
        // A nested block inside a declaration block (CSS nesting): not used by this stylesheet.
        body += ch;
        depthOfBody += 1;
        continue;
      }
      const selector = head.trim();
      stack.push(selector);
      head = '';
      if (!/^@(media|supports|container|layer)\b/.test(selector)) depthOfBody = 0;
    } else if (ch === '}') {
      if (depthOfBody > 0) {
        body += ch;
        depthOfBody -= 1;
      } else if (depthOfBody === 0) {
        const selector = stack.pop() as string;
        out.push({ selector, body, inside: stack.filter((s) => s.startsWith('@')).join(' ') });
        body = '';
        depthOfBody = -1;
      } else {
        stack.pop();
        head = '';
      }
    } else if (depthOfBody >= 0) body += ch;
    else head += ch;
  }
  return out;
}

const all = blocks(bare);
const declarations = (b: Block): Array<[string, string]> =>
  b.body
    .split(';')
    .map((d) => d.trim())
    .filter((d) => d.length > 0)
    .map((d): [string, string] => {
      const at = d.indexOf(':');
      return [d.slice(0, at).trim(), d.slice(at + 1).trim()];
    });

const privateDecls = all.flatMap((b) => declarations(b).filter(([n]) => n.startsWith('--cwd-')).map(([n, v]) => ({ name: n, value: v, block: b })));
const publicName = (privateName: string): string => `--cw-${privateName.slice('--cwd-'.length)}`;
const tokenBlock = all.find((b) => b.selector === ':where(.cw-hub)' && b.inside === '');
const fallbackBlock = all.find((b) => b.selector === ':where(.cw-hub)' && b.inside.startsWith('@supports not'));

describe('the parser reads this stylesheet', () => {
  it('finds the rules, the token block and the fallback block', () => {
    expect(all.length).toBeGreaterThan(400);
    expect(tokenBlock).toBeDefined();
    expect(fallbackBlock).toBeDefined();
  });
});

describe('no public --cw-* name is declared by the stylesheet', () => {
  it('not on .cw-hub, not under :where(), not in any rule at all', () => {
    const declared = all.flatMap((b) => declarations(b).filter(([n]) => /^--cw-/.test(n)).map(([n]) => `${b.selector} { ${n} }`));
    expect(declared).toEqual([]);
  });

  it('no rule that names .cw-hub declares any custom property but a private default, and only the :where() ones do that', () => {
    const bad = all
      .filter((b) => b.selector.includes('.cw-hub') && b.selector !== ':where(.cw-hub)')
      .flatMap((b) => declarations(b).filter(([n]) => n.startsWith('--')).map(([n]) => `${b.selector} { ${n} }`));
    expect(bad).toEqual([]);
  });

  it('the data-cw-theme rules set the colour scheme and nothing else', () => {
    const themed = all.filter((b) => b.selector.includes('data-cw-theme'));
    expect(themed.length).toBe(2);
    for (const b of themed) expect(declarations(b).map(([n]) => n)).toEqual(['color-scheme']);
  });
});

describe('every default is private, and under :where(.cw-hub)', () => {
  it('has the same forty-odd tokens as before, each declared once', () => {
    const names = privateDecls.filter((d) => d.block === tokenBlock).map((d) => publicName(d.name));
    expect(new Set(names).size).toBe(names.length);
    expect(names.sort()).toEqual(Object.keys(TOKENS_BEFORE).sort());
  });

  it('declares them only in the token block and the light fallback, both at zero specificity', () => {
    for (const d of privateDecls) expect(d.block.selector, d.name).toBe(':where(.cw-hub)');
    expect(privateDecls.every((d) => d.block === tokenBlock || d.block === fallbackBlock)).toBe(true);
  });
});

describe('every read is var(--cw-x, var(--cwd-x))', () => {
  const publicReads = [...bare.matchAll(/var\((--cw-[a-z0-9-]+)/g)];
  const privateReads = [...bare.matchAll(/var\((--cwd-[a-z0-9-]+)/g)];

  it('has many reads, so the test is not vacuous', () => {
    expect(publicReads.length).toBeGreaterThan(900);
    expect(privateReads.length).toBe(publicReads.length);
  });

  it('each public read falls back to the private default of the same name', () => {
    const wrong: string[] = [];
    for (const m of publicReads) {
      const name = m[1] as string;
      const at = m.index as number;
      const expected = `var(${name}, var(--cwd-${name.slice('--cw-'.length)}))`;
      if (bare.slice(at, at + expected.length) !== expected) wrong.push(bare.slice(at, at + 60).split('\n')[0] as string);
    }
    expect(wrong).toEqual([]);
  });

  it('a private default is read nowhere else', () => {
    const lone = privateReads.filter((m) => !new RegExp(`var\\(--cw-${(m[1] as string).slice('--cwd-'.length)}, $`).test(bare.slice(Math.max(0, (m.index as number) - 60), m.index)));
    expect(lone.map((m) => m[1])).toEqual([]);
  });

  it('every token that is read has a default, and every default is read', () => {
    const read = new Set(publicReads.map((m) => m[1] as string));
    const defaults = new Set(privateDecls.filter((d) => d.block === tokenBlock).map((d) => publicName(d.name)));
    expect([...read].filter((r) => !defaults.has(r))).toEqual([]);
    expect([...defaults].filter((d) => !read.has(d))).toEqual([]);
  });
});

/** `light-dark(a, b)` becomes the arm for the scheme; any other value is the same in both. */
function resolve(value: string, scheme: 'light' | 'dark'): string {
  const m = /^light-dark\(\s*(.+?)\s*,\s*(#[0-9a-f]{6})\s*\)$/i.exec(value);
  return m === null ? value : (scheme === 'light' ? (m[1] as string) : (m[2] as string));
}

describe('with nothing overridden, every token resolves to what it did before, light and dark', () => {
  const after = new Map(privateDecls.filter((d) => d.block === tokenBlock).map((d) => [publicName(d.name), d.value]));
  const colours = Object.entries(TOKENS_BEFORE).filter(([, v]) => v.startsWith('light-dark('));

  it('covers every colour and every other token', () => {
    expect(colours.length).toBe(18);
    expect(Object.keys(TOKENS_BEFORE).length).toBe(44);
    expect(after.size).toBe(44);
  });

  it.each(['light', 'dark'] as const)('the %s value of every token is unchanged', (scheme) => {
    for (const [name, before] of Object.entries(TOKENS_BEFORE)) {
      expect(resolve(after.get(name) ?? '<missing>', scheme), `${name} (${scheme})`).toBe(resolve(before, scheme));
    }
  });

  it('the declared text is the same too (so a future edit to one scheme is seen as an edit)', () => {
    for (const [name, before] of Object.entries(TOKENS_BEFORE)) expect(after.get(name), name).toBe(before);
  });

  it('the light fallback for a browser without light-dark() holds the same values', () => {
    const fallback = new Map(privateDecls.filter((d) => d.block === fallbackBlock).map((d) => [publicName(d.name), d.value]));
    expect(Object.fromEntries(fallback)).toEqual(FALLBACK_BEFORE);
    for (const [name, v] of Object.entries(FALLBACK_BEFORE)) expect(v, name).toBe(resolve(TOKENS_BEFORE[name] as string, 'light'));
  });

  it('the colour-scheme rules are as before: both by default, one when forced', () => {
    expect(declarations(tokenBlock as Block).find(([n]) => n === 'color-scheme')?.[1]).toBe('light dark');
    const forced = all.filter((b) => b.selector.includes('data-cw-theme'));
    expect(forced.map((b) => declarations(b)[0]?.[1]).sort()).toEqual(['dark', 'light']);
    expect(forced.find((b) => b.selector.includes("'dark'"))?.selector).toContain("[data-cw-theme='dark'] .cw-hub");
    expect(forced.find((b) => b.selector.includes("'light'"))?.selector).toContain(".cw-hub[data-cw-theme='light']");
  });
});

describe('the README says how to theme from above, and which keys the hub hears', () => {
  const readme = readFileSync(fileURLToPath(new URL('../README.md', import.meta.url)), 'utf8').replace(/\s+/g, ' ');

  it('tells a page it can set a token on any ancestor, and that the defaults are private', () => {
    expect(readme).toContain('Set a token on any element above the hub');
    expect(readme).toContain('`--cwd-*`');
    expect(readme).toContain('var(--cw-x, var(--cwd-x))');
  });

  it('says a hub answers keys only while focus is inside it, and that two hubs do not share them', () => {
    expect(readme).toContain('answers a key only while keyboard focus is inside it');
    expect(readme).toContain('Two hubs on one page each answer only their own keys');
  });
});
