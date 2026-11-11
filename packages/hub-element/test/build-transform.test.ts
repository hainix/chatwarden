import { readdirSync, readFileSync } from 'node:fs';
import { join, sep } from 'node:path';
import { describe, expect, it } from 'vitest';
// @ts-expect-error plain ESM build helper with JSDoc types; the package tsconfig does not cover build/
import { elementCss, injectShadowDocument, hubCssPath } from '../build/transform.mjs';

// What the build does to hub-react on the way in: its stylesheet keeps its token defaults under private names, so that any --cw-*
// value the page sets on the element or above it is what the hub reads, and its sources get the element's `document`. Both must
// fail loudly when hub-react changes shape, not quietly ship a hub that ignores the page's theme.

const hubCss = readFileSync(hubCssPath as string, 'utf8');
const css = elementCss(hubCss) as string;

describe('elementCss', () => {
  const hostBlocks = (text: string): string => [...text.matchAll(/:host\s*\{([^}]*)\}/g)].map((m) => m[1] as string).join('\n');
  const names = (text: string): string[] => [...text.matchAll(/^\s*(--cw-[\w-]+):/gm)].map((m) => m[1] as string);
  const tokens = names(/:where\(\.cw-hub\)\s*\{([^}]*)\}/.exec(hubCss)?.[1] ?? '');

  it('moves the token block (and the no-light-dark() fallback) from .cw-hub to :host', () => {
    expect(hubCss).toContain(':where(.cw-hub) {');
    expect(css).not.toContain(':where(.cw-hub)');
    expect(tokens.length).toBeGreaterThan(30);
    expect([...css.matchAll(/:host\s*\{[^}]*--cwd-bg:/g)]).toHaveLength(2);
  });

  it('keeps the defaults under private names (--cwd-*), so a --cw-* value set on the element or anywhere above it is what the hub reads', () => {
    const host = hostBlocks(css);
    for (const token of tokens) {
      const defaulted = `--cwd-${token.slice('--cw-'.length)}`;
      expect(host, defaulted).toContain(`${defaulted}:`);
      // The public name is never declared by the stylesheet: a declaration on the host would beat what the page set above it.
      expect(host, token).not.toMatch(new RegExp(`^\\s*${token}:`, 'm'));
    }
    expect(host).toMatch(/--cwd-bg:\s*light-dark\(/);
    expect(host).toMatch(/--cwd-bg:\s*#f4f5f8/);
  });

  it('reads every token as var(--cw-x, var(--cwd-x)): the page value if there is one, the default if not', () => {
    expect(hubCss).toMatch(/var\(--cw-bg\)/);
    expect(css).not.toMatch(/var\(--cw-[a-z0-9-]+\)/);
    expect(css).toContain('background: var(--cw-bg, var(--cwd-bg));');
    const uses = (css.match(/var\(--cw-[a-z0-9-]+, var\(--cwd-[a-z0-9-]+\)\)/g) ?? []).length;
    expect(uses).toBe((hubCss.match(/var\(--cw-[a-z0-9-]+\)/g) ?? []).length);
    expect(uses).toBeGreaterThan(800);
  });

  it('every default a read refers to exists, and every token read is a known one', () => {
    const host = hostBlocks(css);
    for (const m of css.matchAll(/var\((--cw-[a-z0-9-]+), var\((--cwd-[a-z0-9-]+)\)\)/g)) {
      expect(tokens, m[1]).toContain(m[1]);
      expect(host, m[2]).toContain(`${m[2]}:`);
    }
  });

  it('keeps every other rule of hub-react as it was, apart from the token reads', () => {
    expect(css).toContain('.cw-hub {\n  position: relative;');
    const plain = (text: string): string => text.slice(text.indexOf('/* ---- Base')).replace(/var\((--cw-[a-z0-9-]+), var\(--cwd-[a-z0-9-]+\)\)/g, 'var($1)');
    expect(plain(css)).toBe(plain(hubCss));
  });

  it('adds the host rules: a block, hidden when hidden', () => {
    expect(css).toMatch(/:host\s*\{\s*display:\s*block;?\s*\}/);
    expect(css).toMatch(/:host\(\[hidden\]\)\s*\{\s*display:\s*none;?\s*\}/);
  });

  it('refuses a stylesheet whose token block it cannot find, or that has almost no tokens', () => {
    expect(() => elementCss('.cw-hub { color: red }')).toThrow(/token block/);
    expect(() => elementCss(':where(.cw-hub) {\n  --cw-a: 1;\n}\n.x { color: var(--cw-a); }')).toThrow(/tokens/);
  });
});

describe('injectShadowDocument', () => {
  const hubSrc = join(process.cwd(), 'packages', 'hub-react', 'src');
  const hubFile = join(hubSrc, 'Dialog.tsx');

  it('gives a hub-react source that reads the page the element\'s document', () => {
    const out = injectShadowDocument('const x = document.activeElement;\n', hubFile) as string;
    expect(out).toMatch(/^import \{ cwDocument as document \} from ".*shadowDocument\.ts";\n/);
    expect(out).toContain('const x = document.activeElement;');
  });

  it('leaves a hub-react source that never reads the page alone', () => {
    expect(injectShadowDocument('export const a = 1;\n', hubFile)).toBeNull();
  });

  it('leaves everything outside hub-react alone (react-dom has its own business with document)', () => {
    expect(injectShadowDocument('const d = document.createElement("div");\n', '/repo/node_modules/react-dom/cjs/react-dom-client.production.js')).toBeNull();
    expect(injectShadowDocument('const d = document.body;\n', '/repo/packages/hub-element/src/element.ts')).toBeNull();
  });

  it('works for the windows path of a hub-react file too', () => {
    const out = injectShadowDocument('document.getElementById("x");\n', 'C:\\dev\\chatwarden\\packages\\hub-react\\src\\case\\DecisionBar.tsx');
    expect(out).not.toBeNull();
  });

  it('does not inject twice', () => {
    const once = injectShadowDocument('document.activeElement;\n', hubFile) as string;
    expect(injectShadowDocument(once, hubFile)).toBeNull();
  });

  it('every hub-react source file that reads the page gets it, and none still reads the real one (the real tree)', () => {
    // The real sources: each `document.` use is in a file the transform rewrites.
    const dir = `${hubSrc.split(sep).join('/')}/`;
    const files: string[] = [];
    const walk = (d: string): void => {
      for (const entry of readdirSync(d, { withFileTypes: true })) {
        const p = `${d}${entry.name}`;
        if (entry.isDirectory()) walk(`${p}/`);
        else if (/\.tsx?$/.test(entry.name)) files.push(p);
      }
    };
    walk(dir);
    expect(files.length).toBeGreaterThan(50);
    const using = files.filter((f) => /(?<![\w$.])document\./.test(readFileSync(f, 'utf8')));
    expect(using.length).toBeGreaterThan(3);
    for (const f of using) expect(injectShadowDocument(readFileSync(f, 'utf8'), f), f).not.toBeNull();
  });
});
