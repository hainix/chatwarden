// @vitest-environment node
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import type { Browser, Page } from 'playwright';
import { afterAll, describe, expect, it } from 'vitest';
import { FALLBACK_BEFORE, TOKENS_BEFORE } from './tokens-before.js';

// The theme contract, the same one hub-react adopted at Task 7j. A page themes the components by setting a public `--cw-*` token on
// ANY element above them (body, a wrapper) or on the player's own root. That only works if the stylesheet never declares a public
// name on `.cw-player` (a declaration on an element beats the value inherited from above), so the defaults sit under private
// `--cwd-*` names and every read is `var(--cw-x, var(--cwd-x))`: the page's value if there is one, the default if not.
//
// The first half checks the stylesheet's text (jsdom does not compute custom properties through the cascade). The second half
// computes it in Chromium, through Playwright; it skips when no Chromium is installed (`npx playwright install chromium`), unless
// CW_REQUIRE_BROWSER=1.

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
const tokenBlock = all.find((b) => b.selector === ':where(.cw-player)' && b.inside === '');
const fallbackBlock = all.find((b) => b.selector === ':where(.cw-player)' && b.inside.startsWith('@supports not'));

/** Read with no default of its own on purpose: the font is the game's own, so `--cw-font` has no private default. */
const OPTIONAL = ['--cw-font'];

describe('the parser reads this stylesheet', () => {
  it('finds the rules, the token block and the fallback block', () => {
    expect(all.length).toBeGreaterThan(50);
    expect(tokenBlock).toBeDefined();
    expect(fallbackBlock).toBeDefined();
  });

  it('sees a declaration and the at-rule around it (control)', () => {
    const sample = blocks(':where(.cw-player) { --cw-x: 1px; --cwd-y: 2px; } @media (min-width: 1px) { .cw-player .a { color: red; } }');
    expect(sample.map((b) => b.selector)).toEqual([':where(.cw-player)', '.cw-player .a']);
    expect(sample[1]?.inside).toBe('@media (min-width: 1px)');
    expect(declarations(sample[0] as Block).map(([n]) => n)).toEqual(['--cw-x', '--cwd-y']);
  });
});

describe('no public --cw-* name is declared by the stylesheet', () => {
  it('not on .cw-player, not under :where(), not in any rule at all', () => {
    const declared = all.flatMap((b) => declarations(b).filter(([n]) => /^--cw-/.test(n)).map(([n]) => `${b.selector} { ${n} }`));
    expect(declared).toEqual([]);
  });

  it('no rule that names .cw-player declares any custom property but a private default, and only the :where() ones do that', () => {
    const bad = all
      .filter((b) => b.selector.includes('.cw-player') && b.selector !== ':where(.cw-player)')
      .flatMap((b) => declarations(b).filter(([n]) => n.startsWith('--')).map(([n]) => `${b.selector} { ${n} }`));
    expect(bad).toEqual([]);
  });

  it('the data-cw-theme rules set the colour scheme and nothing else', () => {
    const themed = all.filter((b) => b.selector.includes('data-cw-theme'));
    expect(themed.length).toBe(2);
    for (const b of themed) expect(declarations(b).map(([n]) => n)).toEqual(['color-scheme']);
  });
});

describe('every default is private, and under :where(.cw-player)', () => {
  it('has the same tokens as before, each declared once', () => {
    const names = privateDecls.filter((d) => d.block === tokenBlock).map((d) => publicName(d.name));
    expect(new Set(names).size).toBe(names.length);
    expect(names.sort()).toEqual(Object.keys(TOKENS_BEFORE).sort());
  });

  it('declares them only in the token block and the light fallback, both at zero specificity', () => {
    expect(privateDecls.length).toBeGreaterThan(0);
    for (const d of privateDecls) expect(d.block.selector, d.name).toBe(':where(.cw-player)');
    expect(privateDecls.every((d) => d.block === tokenBlock || d.block === fallbackBlock)).toBe(true);
  });

  it('leaves the font unset: there is no private font default either', () => {
    expect(privateDecls.map((d) => d.name)).not.toContain('--cwd-font');
    expect(bare).toMatch(/font-family:\s*var\(--cw-font, inherit\);/);
  });
});

describe('every read is var(--cw-x, var(--cwd-x))', () => {
  const publicReads = [...bare.matchAll(/var\((--cw-[a-z0-9-]+)/g)];
  const privateReads = [...bare.matchAll(/var\((--cwd-[a-z0-9-]+)/g)];
  const guarded = publicReads.filter((m) => !OPTIONAL.includes(m[1] as string));

  it('has many reads, so the test is not vacuous', () => {
    expect(publicReads.length).toBeGreaterThan(100);
    expect(privateReads.length).toBe(guarded.length);
  });

  it('each public read falls back to the private default of the same name', () => {
    const wrong: string[] = [];
    for (const m of guarded) {
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

  it('every token that is read has a default (bar the font), and every default is read', () => {
    const read = new Set(publicReads.map((m) => m[1] as string));
    const defaults = new Set(privateDecls.filter((d) => d.block === tokenBlock).map((d) => publicName(d.name)));
    expect([...read].filter((r) => !defaults.has(r) && !OPTIONAL.includes(r))).toEqual([]);
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
    expect(colours.length).toBe(13);
    expect(Object.keys(TOKENS_BEFORE).length).toBe(28);
    expect(after.size).toBe(28);
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
    expect(forced.find((b) => b.selector.includes("'dark'"))?.selector).toContain("[data-cw-theme='dark'] .cw-player");
    expect(forced.find((b) => b.selector.includes("'light'"))?.selector).toContain(".cw-player[data-cw-theme='light']");
  });
});

// ---- Computed, in a real browser --------------------------------------------------------------------------------------------

const rgb = (hex: string): string => {
  const n = Number.parseInt(hex.slice(1), 16);
  return `rgb(${n >> 16}, ${(n >> 8) & 255}, ${n & 255})`;
};
const LIGHT = { bg: rgb('#ffffff'), ink: rgb('#151b27'), accent: rgb('#2950d3') };
const DARK = { bg: rgb('#151c28'), ink: rgb('#e8ebf1'), accent: rgb('#7d9bff') };

// Top-level await: whether there is a Chromium has to be known while the tests are collected, so a missing one shows up as skipped tests.
let browser: Browser | null = null;
try {
  browser = await chromium.launch();
} catch (error) {
  if (process.env.CW_REQUIRE_BROWSER === '1') throw error;
  console.warn(`player token computation skipped: Chromium could not start (${String(error).split('\n')[0]}). Run "npx playwright install chromium".`);
}
afterAll(async () => {
  await browser?.close();
});

/** A test that needs the browser: skipped, and reported as skipped, when there is none. */
const itb = browser === null ? it.skip : it;

interface Look {
  /** The root's background and text colour. */
  bg: string;
  ink: string;
  /** The primary button's fill and corner radius. */
  fill: string;
  radius: string;
  font: string;
  /** What the root itself carries for a public token (it must declare none, so this is empty). */
  ownSurface: string;
}

/**
 * The stylesheet in a bare page. `host` is CSS for the page itself, placed BEFORE the stylesheet (the hardest order for the page:
 * it still has to win). `ancestor` are the attributes of the wrapper around the player; `root` those of the player root.
 */
async function open(scheme: 'light' | 'dark', host = '', ancestor = '', root = ''): Promise<Page> {
  const context = await (browser as Browser).newContext({ colorScheme: scheme });
  const p = await context.newPage();
  await p.setContent(
    `<!doctype html><html><head><style>${host}</style><style>${css}</style></head><body><div id="wrap" ${ancestor}><div id="root" class="cw-player" ${root}><button class="cw-btn cw-btn--primary" id="go">Go</button></div></div></body></html>`,
  );
  return p;
}

const look = (p: Page): Promise<Look> =>
  p.evaluate(() => {
    const rootEl = document.getElementById('root') as HTMLElement;
    const go = document.getElementById('go') as HTMLElement;
    return {
      bg: getComputedStyle(rootEl).backgroundColor,
      ink: getComputedStyle(rootEl).color,
      fill: getComputedStyle(go).backgroundColor,
      radius: getComputedStyle(go).borderTopLeftRadius,
      font: getComputedStyle(rootEl).fontFamily,
      ownSurface: getComputedStyle(rootEl).getPropertyValue('--cw-surface'),
    };
  });

describe('computed in Chromium: with nothing set, the player looks as it did', () => {
  itb.each([
    ['light', LIGHT],
    ['dark', DARK],
  ] as const)('%s: the base, the ink, the accent, the radius', async (scheme, want) => {
    const p = await open(scheme);
    const seen = await look(p);
    expect(seen.bg).toBe(want.bg);
    expect(seen.ink).toBe(want.ink);
    expect(seen.fill).toBe(want.accent);
    expect(seen.radius).toBe('6px');
    await p.context().close();
  });

  itb('the root declares no public token: --cw-surface is empty on it', async () => {
    const p = await open('light');
    expect((await look(p)).ownSurface).toBe('');
    await p.context().close();
  });

  itb.each(['light', 'dark'] as const)('every token resolves to the value it had before (%s)', async (scheme) => {
    const p = await open(scheme);
    const entries = Object.entries(TOKENS_BEFORE);
    const seen = await p.evaluate((list) => {
      const root = document.getElementById('root') as HTMLElement;
      const probe = document.createElement('i');
      root.append(probe);
      const out: Record<string, string> = {};
      for (const [name, before] of list) {
        const read = `var(${name}, var(--cwd-${name.slice(5)}))`;
        if (before.startsWith('light-dark(')) {
          probe.style.color = 'transparent';
          probe.style.color = read;
          out[name] = getComputedStyle(probe).color;
        } else {
          probe.style.setProperty('--probe', read);
          out[name] = getComputedStyle(probe).getPropertyValue('--probe').trim();
        }
      }
      return out;
    }, entries);
    for (const [name, before] of entries) {
      const want = before.startsWith('light-dark(') ? rgb(resolve(before, scheme)) : before;
      expect(seen[name], `${name} (${scheme})`).toBe(want);
    }
    await p.context().close();
  });
});

describe('computed in Chromium: a value set on any ancestor wins', () => {
  itb('on the wrapper around the player', async () => {
    const p = await open('light', '#wrap { --cw-surface: rgb(1, 2, 3); --cw-accent: rgb(4, 5, 6); --cw-radius-s: 2px }');
    const seen = await look(p);
    expect(seen.bg).toBe('rgb(1, 2, 3)');
    expect(seen.fill).toBe('rgb(4, 5, 6)');
    expect(seen.radius).toBe('2px');
    expect(seen.ink).toBe(LIGHT.ink);
    await p.context().close();
  });

  itb('on body, and on :root', async () => {
    const onBody = await open('light', 'body { --cw-surface: rgb(7, 8, 9) }');
    expect((await look(onBody)).bg).toBe('rgb(7, 8, 9)');
    await onBody.context().close();
    const onRoot = await open('dark', ':root { --cw-surface: rgb(9, 8, 7) }');
    const seen = await look(onRoot);
    expect(seen.bg).toBe('rgb(9, 8, 7)');
    expect(seen.ink).toBe(DARK.ink);
    await onRoot.context().close();
  });

  itb('through a chain, the nearest ancestor first', async () => {
    const p = await open('light', 'body { --cw-surface: rgb(1, 1, 1) } #wrap { --cw-surface: rgb(2, 2, 2) }');
    expect((await look(p)).bg).toBe('rgb(2, 2, 2)');
    await p.context().close();
  });

  itb('on the player root itself (a rule of your own, in a sheet that loads before this one)', async () => {
    const p = await open('light', '.cw-player { --cw-surface: rgb(10, 20, 30) }');
    expect((await look(p)).bg).toBe('rgb(10, 20, 30)');
    await p.context().close();
  });

  itb('on the className you pass', async () => {
    const p = await open('light', '.acme { --cw-accent: rgb(11, 12, 13); --cw-radius-s: 1px }');
    await p.evaluate(() => document.getElementById('root')?.classList.add('acme'));
    const seen = await look(p);
    expect(seen.fill).toBe('rgb(11, 12, 13)');
    expect(seen.radius).toBe('1px');
    await p.context().close();
  });

  itb('a token left alone keeps its default when its neighbour is set (control)', async () => {
    const p = await open('light', '#wrap { --cw-accent: rgb(4, 5, 6) }');
    const seen = await look(p);
    expect(seen.bg).toBe(LIGHT.bg);
    expect(seen.fill).toBe('rgb(4, 5, 6)');
    await p.context().close();
  });

  itb('--cw-font on an ancestor is used; unset, the game font is inherited', async () => {
    const set = await open('light', '#wrap { --cw-font: Georgia, serif }');
    expect((await look(set)).font).toContain('Georgia');
    await set.context().close();
    const unset = await open('light', '#wrap { font-family: Verdana, sans-serif }');
    expect((await look(unset)).font).toContain('Verdana');
    await unset.context().close();
  });
});

describe('computed in Chromium: forced themes work, on the player and on any ancestor', () => {
  itb.each([
    ['dark', 'light', DARK],
    ['light', 'dark', LIGHT],
  ] as const)('%s forced on an ancestor beats a %s visitor', async (forced, visitor, want) => {
    const p = await open(visitor, '', `data-cw-theme="${forced}"`);
    const seen = await look(p);
    expect(seen.bg).toBe(want.bg);
    expect(seen.ink).toBe(want.ink);
    expect(seen.fill).toBe(want.accent);
    await p.context().close();
  });

  itb.each([
    ['dark', 'light', DARK],
    ['light', 'dark', LIGHT],
  ] as const)('%s forced on the player root (the theme prop) beats a %s visitor', async (forced, visitor, want) => {
    const p = await open(visitor, '', '', `data-cw-theme="${forced}"`);
    const seen = await look(p);
    expect(seen.bg).toBe(want.bg);
    expect(seen.ink).toBe(want.ink);
    await p.context().close();
  });

  itb("a value set above and a forced theme together: the page's colour, in the forced scheme's other colours", async () => {
    const p = await open('light', 'body { --cw-surface: rgb(1, 2, 3) }', 'data-cw-theme="dark"');
    const seen = await look(p);
    expect(seen.bg).toBe('rgb(1, 2, 3)');
    expect(seen.ink).toBe(DARK.ink);
    await p.context().close();
  });

  itb('a light-dark() value set above follows the forced scheme', async () => {
    const host = 'body { --cw-surface: light-dark(rgb(250, 240, 230), rgb(20, 30, 40)) }';
    const dark = await open('light', host, 'data-cw-theme="dark"');
    expect((await look(dark)).bg).toBe('rgb(20, 30, 40)');
    await dark.context().close();
    const light = await open('dark', host, 'data-cw-theme="light"');
    expect((await look(light)).bg).toBe('rgb(250, 240, 230)');
    await light.context().close();
  });

  itb('with nothing forced, the visitor decides (control)', async () => {
    const dark = await open('dark');
    expect((await look(dark)).bg).toBe(DARK.bg);
    await dark.context().close();
    const light = await open('light');
    expect((await look(light)).bg).toBe(LIGHT.bg);
    await light.context().close();
  });
});

describe('the README says how to theme from above', () => {
  const readme = readFileSync(fileURLToPath(new URL('../README.md', import.meta.url)), 'utf8').replace(/\s+/g, ' ');

  it('tells a page it can set a token on any ancestor, and that the defaults are private', () => {
    expect(readme).toContain('Set a token on any element above the components');
    expect(readme).toContain('`--cwd-*`');
    expect(readme).toContain('var(--cw-x, var(--cwd-x))');
  });

  it('no longer says a value set higher up is shadowed, or that the tokens go on the component root and not an ancestor', () => {
    expect(readme).not.toMatch(/shadowed/i);
    expect(readme).not.toMatch(/not on an ancestor/i);
    expect(readme).not.toMatch(/declared on `\.cw-player` itself/);
  });
});
