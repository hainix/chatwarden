// @vitest-environment node
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { en } from '../src/i18n.js';

// Rules that bind every screen of the hub, checked on the source itself: no words outside the catalog, no inline styles, no
// injected HTML, and a stylesheet whose tokens are a complete, documented contract.

const pkg = fileURLToPath(new URL('..', import.meta.url));
const src = join(pkg, 'src');

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((d) => (d.isDirectory() ? walk(join(dir, d.name)) : [join(dir, d.name)]));
}
const files = walk(src);
const code = files.filter((f) => /\.tsx?$/.test(f));
// The catalog itself and its comments name keys on purpose.
const appCode = code.filter((f) => !f.endsWith('i18n.ts'));
const read = (f: string): string => readFileSync(f, 'utf8');
const rel = (f: string): string => f.slice(pkg.length).replaceAll('\\', '/');

describe('no words outside the catalog', () => {
  // Attributes whose string value a person reads or hears.
  const TEXT_ATTRS = new Set(['aria-label', 'aria-description', 'aria-placeholder', 'aria-roledescription', 'title', 'placeholder', 'alt', 'label']);

  function literals(file: string): string[] {
    const source = ts.createSourceFile(file, read(file), ts.ScriptTarget.ES2023, true, file.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
    const found: string[] = [];
    const visit = (node: ts.Node): void => {
      if (ts.isJsxText(node) && /[A-Za-z]{2,}/.test(node.text)) found.push(`text "${node.text.trim()}"`);
      if (ts.isJsxAttribute(node) && TEXT_ATTRS.has(node.name.getText()) && node.initializer !== undefined && ts.isStringLiteral(node.initializer)) {
        found.push(`${node.name.getText()}="${node.initializer.text}"`);
      }
      if (ts.isJsxExpression(node) && node.expression !== undefined && (ts.isStringLiteral(node.expression) || ts.isNoSubstitutionTemplateLiteral(node.expression))) {
        if (/[A-Za-z]{2,}/.test(node.expression.text)) found.push(`expression "${node.expression.text}"`);
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
    return found;
  }

  it.each(code.filter((f) => f.endsWith('.tsx')).map((f) => [rel(f), f] as const))('%s has no JSX text or text attribute of its own', (_name, file) => {
    expect(literals(file)).toEqual([]);
  });

  it('the scan sees what it should (control)', () => {
    const probe = join(pkg, 'test', '__probe__.tsx');
    const sample = "export const A = () => <p title=\"Hello there\">Some words {'more words'}</p>;";
    const source = ts.createSourceFile(probe, sample, ts.ScriptTarget.ES2023, true, ts.ScriptKind.TSX);
    const found: string[] = [];
    const visit = (node: ts.Node): void => {
      if (ts.isJsxText(node) && /[A-Za-z]{2,}/.test(node.text)) found.push('text');
      if (ts.isJsxAttribute(node) && node.name.getText() === 'title') found.push('title');
      if (ts.isJsxExpression(node) && node.expression !== undefined && ts.isStringLiteral(node.expression)) found.push('expression');
      ts.forEachChild(node, visit);
    };
    visit(source);
    expect(found.sort()).toEqual(['expression', 'text', 'title']);
  });

  it('every t("...") key written out in the source is in the English catalog', () => {
    const keys = new Set(Object.keys(en).map((k) => k.replace(/\.(zero|one|two|few|many|other)$/, '')));
    const used: Array<[string, string]> = [];
    for (const f of appCode) for (const m of read(f).matchAll(/\bt\(\s*'(hub\.[A-Za-z0-9_.]+)'/g)) used.push([rel(f), m[1] as string]);
    expect(used.length).toBeGreaterThan(40);
    const unknown = used.filter(([, k]) => !keys.has(k));
    expect(unknown).toEqual([]);
  });

  it('every key in a label table (nav, labels, screens) is in the catalog', () => {
    const keys = new Set(Object.keys(en).map((k) => k.replace(/\.(zero|one|two|few|many|other)$/, '')));
    const used: Array<[string, string]> = [];
    for (const f of appCode) for (const m of read(f).matchAll(/'(hub\.[A-Za-z0-9_.]+)'/g)) used.push([rel(f), m[1] as string]);
    const unknown = used.filter(([, k]) => !keys.has(k));
    expect(unknown).toEqual([]);
  });
});

describe('nothing is injected and nothing is styled inline', () => {
  const FORBIDDEN: Array<[RegExp, string]> = [
    [/dangerouslySetInnerHTML/, 'dangerouslySetInnerHTML'],
    [/\.innerHTML\b|\.outerHTML\b|insertAdjacentHTML|document\.write/, 'raw HTML insertion'],
    [/createElement\(\s*['"]style['"]/, 'a created <style>'],
    [/<style[\s>]/, 'a <style> element'],
    [/\bstyle\s*=\s*\{/, 'an inline style prop'],
    [/\beval\s*\(|new Function\s*\(/, 'eval'],
    [/\bsetAttribute\(\s*['"]style['"]/, 'a style attribute'],
    [/\.style\.[a-zA-Z]+\s*=/, 'a style assignment'],
    [/adoptedStyleSheets|insertRule|CSSStyleSheet/, 'a run-time stylesheet'],
  ];
  it.each(code.map((f) => [rel(f), f] as const))('%s', (_name, file) => {
    const text = read(file);
    for (const [re, what] of FORBIDDEN) expect(re.test(text), what).toBe(false);
  });

  it('the stylesheet imports nothing and loads nothing from elsewhere', () => {
    const css = read(join(src, 'styles.css'));
    expect(css).not.toMatch(/@import|url\(/);
  });

  it('no source file imports a stylesheet (the CSS is a separate file the adopter loads)', () => {
    for (const f of code) expect(read(f), rel(f)).not.toMatch(/import\s+['"][^'"]*\.css['"]/);
  });
});

describe('the stylesheet is a complete token contract', () => {
  const css = read(join(src, 'styles.css'));
  const start = css.indexOf('/* ---- Tokens');
  const end = css.indexOf('/* ---- End of tokens');
  const tokenBlock = css.slice(start, end);
  const rest = css.slice(end);
  const defined = [...tokenBlock.matchAll(/^\s*(--cw-[a-z0-9-]+):/gm)].map((m) => m[1] as string);
  const used = [...new Set([...rest.matchAll(/var\((--cw-[a-z0-9-]+)/g)].map((m) => m[1] as string))];

  it('has a token block with a good number of tokens, each defined once', () => {
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    expect(defined.length).toBeGreaterThan(40);
    expect(new Set(defined).size).toBe(defined.length);
  });

  it('every var(--cw-*) a rule uses is defined', () => {
    expect(used.filter((u) => !defined.includes(u))).toEqual([]);
  });

  it('every token is used by a rule, so the list stays the true size of the contract', () => {
    expect(defined.filter((d) => !used.includes(d))).toEqual([]);
  });

  it('gives every colour a light and a dark value', () => {
    const colours = [...tokenBlock.matchAll(/^\s*(--cw-[a-z0-9-]+):\s*(.+);$/gm)].filter(([, , v]) => /#[0-9a-f]{3,8}\b/i.test(v as string));
    expect(colours.length).toBeGreaterThan(20);
    for (const [, name, value] of colours) expect(value, name).toMatch(/^light-dark\(#[0-9a-f]{6}, #[0-9a-f]{6}\)$/i);
  });

  it('writes no colour outside the token block: every colour in a rule is a variable', () => {
    expect(rest.replace(/\/\*[\s\S]*?\*\//g, '')).not.toMatch(/#[0-9a-f]{3,8}\b|\brgba?\(|\bhsla?\(|\boklch\(/i);
  });

  it('scopes every rule under .cw-hub', () => {
    const stripped = css.replace(/\/\*[\s\S]*?\*\//g, '');
    const selectors = [...stripped.matchAll(/(^|[{};])\s*([^{}@;\s][^{}]*)\{/g)].map((m) => (m[2] as string).trim()).filter((s) => !/^(from|to|\d+%)$/.test(s));
    expect(selectors.length).toBeGreaterThan(80);
    // Split a selector list on the commas that are not inside :is( ) or :where( ).
    const split = (list: string): string[] => {
      const parts: string[] = [];
      let depth = 0;
      let current = '';
      for (const ch of list) {
        if (ch === '(') depth += 1;
        if (ch === ')') depth -= 1;
        if (ch === ',' && depth === 0) {
          parts.push(current.trim());
          current = '';
        } else current += ch;
      }
      return [...parts, current.trim()];
    };
    const loose = selectors.flatMap(split).filter((x) => !x.includes('.cw-hub'));
    expect(loose).toEqual([]);
  });

  it('answers prefers-color-scheme by color-scheme, honours data-cw-theme, reduced motion and forced colours', () => {
    expect(css).toMatch(/color-scheme:\s*light dark/);
    expect(css).toMatch(/\[data-cw-theme='light'\]/);
    expect(css).toMatch(/\[data-cw-theme='dark'\]/);
    expect(css).toMatch(/prefers-reduced-motion/);
    expect(css).toMatch(/forced-colors/);
    expect(css).toMatch(/:focus-visible/);
  });

  it('keeps the token defaults at zero specificity so an adopter rule always wins', () => {
    expect(tokenBlock).toMatch(/:where\(\.cw-hub\)\s*\{/);
  });

  it('is under 24 KB raw (the size test holds it to 6 KB gzipped)', () => {
    expect(Buffer.byteLength(css)).toBeLessThan(24 * 1024);
  });
});

describe('the README documents the token contract', () => {
  const readme = readFileSync(join(pkg, 'README.md'), 'utf8');
  const css = read(join(src, 'styles.css'));
  const block = css.slice(css.indexOf('/* ---- Tokens'), css.indexOf('/* ---- End of tokens'));
  const defined = [...block.matchAll(/^\s*(--cw-[a-z0-9-]+):/gm)].map((m) => m[1] as string);
  const theming = readme.slice(readme.indexOf('\n## Theming\n'), readme.indexOf('\n## Security notes\n'));

  it('lists every token under Theming, and no token the stylesheet lacks', () => {
    expect(theming.length).toBeGreaterThan(500);
    const documented = [...theming.matchAll(/^\| `(--cw-[a-z0-9-]+)` \|/gm)].map((m) => m[1] as string);
    expect(documented.sort()).toEqual([...defined].sort());
  });

  it('states each colour token default as written in the stylesheet', () => {
    for (const m of block.matchAll(/^\s*(--cw-[a-z0-9-]+):\s*light-dark\((#[0-9a-f]+), (#[0-9a-f]+)\);$/gim)) {
      expect(theming, m[1]).toContain(`| \`${m[1]}\` | \`${m[2]}\`, \`${m[3]}\` |`);
    }
  });
});
