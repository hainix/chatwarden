// @vitest-environment node
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { en } from '../src/i18n.js';

// Rules that bind every component of the package, checked on the source itself: no words outside the catalog, no inline
// styles, no injected HTML, no import of another Chatwarden UI package, and a stylesheet whose tokens are a complete,
// documented contract that stays small, neutral and themable.

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

  it('there are components to scan', () => {
    expect(code.filter((f) => f.endsWith('.tsx')).length).toBeGreaterThanOrEqual(6);
  });

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
    for (const f of appCode) for (const m of read(f).matchAll(/\bt\(\s*'(player\.[A-Za-z0-9_.]+)'/g)) used.push([rel(f), m[1] as string]);
    expect(used.length).toBeGreaterThan(15);
    expect(used.filter(([, k]) => !keys.has(k))).toEqual([]);
  });

  it('every key in a label table is in the catalog', () => {
    const keys = new Set(Object.keys(en).map((k) => k.replace(/\.(zero|one|two|few|many|other)$/, '')));
    const used: Array<[string, string]> = [];
    for (const f of appCode) for (const m of read(f).matchAll(/'(player\.[A-Za-z0-9_.]+)'/g)) used.push([rel(f), m[1] as string]);
    expect(used.filter(([, k]) => !keys.has(k))).toEqual([]);
  });

  it('every catalog key is used by the source (no dead words)', () => {
    const text = appCode.map(read).join('\n');
    const literalsUsed = new Set([...text.matchAll(/'(player\.[A-Za-z0-9_.]+)'/g)].map((m) => m[1] as string));
    const prefixes = [...text.matchAll(/`(player\.[A-Za-z0-9_.]*\.)\$\{/g)].map((m) => m[1] as string);
    const bases = [...new Set(Object.keys(en).map((k) => k.replace(/\.(zero|one|two|few|many|other)$/, '')))];
    const dead = bases.filter((k) => !literalsUsed.has(k) && !prefixes.some((p) => k.startsWith(p)));
    expect(dead).toEqual([]);
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
    expect(read(join(src, 'styles.css'))).not.toMatch(/@import|url\(/);
  });

  it('no source file imports a stylesheet (the CSS is a separate file the adopter loads)', () => {
    for (const f of code) expect(read(f), rel(f)).not.toMatch(/import\s+['"][^'"]*\.css['"]/);
  });
});

describe('imports', () => {
  const importsOf = (file: string): Array<{ spec: string; typeOnly: boolean }> => {
    const source = ts.createSourceFile(file, read(file), ts.ScriptTarget.ES2023, true, file.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
    const out: Array<{ spec: string; typeOnly: boolean }> = [];
    source.forEachChild((n) => {
      if (ts.isImportDeclaration(n) && ts.isStringLiteral(n.moduleSpecifier)) out.push({ spec: n.moduleSpecifier.text, typeOnly: n.importClause?.isTypeOnly === true });
      if (ts.isExportDeclaration(n) && n.moduleSpecifier !== undefined && ts.isStringLiteral(n.moduleSpecifier)) out.push({ spec: n.moduleSpecifier.text, typeOnly: n.isTypeOnly });
    });
    return out;
  };

  it('never depends on hub-react: the transport type is copied, and a test keeps the two the same', () => {
    for (const f of code) for (const i of importsOf(f)) expect(i.spec, rel(f)).not.toMatch(/hub-react|packages\/hub|\.\.\/\.\.\//);
  });

  it('imports the kit as types only: no run-time import of core or http, so the bundle needs no kit code', () => {
    for (const f of code) for (const i of importsOf(f).filter((x) => x.spec.startsWith('@chatwarden/'))) expect(i.typeOnly, `${rel(f)} imports ${i.spec}`).toBe(true);
  });

  it('imports nothing but React, the kit types and its own files', () => {
    for (const f of code) for (const i of importsOf(f)) expect(i.spec, rel(f)).toMatch(/^(\.\/|\.\.\/|react$|react\/jsx-runtime$|@chatwarden\/core$)/);
  });
});

describe('the stylesheet is a complete token contract', () => {
  const css = read(join(src, 'styles.css'));
  const start = css.indexOf('/* ---- Tokens');
  const end = css.indexOf('/* ---- End of tokens');
  const tokenBlock = css.slice(start, end);
  const fbStart = css.indexOf('/* ---- Fallback');
  const fbEnd = css.indexOf('/* ---- End of fallback');
  const fallback = css.slice(fbStart, fbEnd);
  // Everything after the tokens, without the fallback block (which holds plain colours on purpose).
  const rest = fbStart === -1 ? css.slice(end) : css.slice(end, fbStart) + css.slice(fbEnd);
  const defined = [...tokenBlock.matchAll(/^\s*(--cw-[a-z0-9-]+):/gm)].map((m) => m[1] as string);
  const used = [...new Set([...rest.matchAll(/var\((--cw-[a-z0-9-]+)/g)].map((m) => m[1] as string))];

  it('has a token block with a good number of tokens, each defined once', () => {
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    expect(defined.length).toBeGreaterThan(25);
    expect(defined.length).toBeLessThan(45);
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
    expect(colours.length).toBe(COLOUR_TOKENS.length);
    for (const [, name, value] of colours) expect(value, name).toMatch(/^light-dark\(#[0-9a-f]{6}, #[0-9a-f]{6}\)$/i);
  });

  it('writes no colour outside the token block: every colour in a rule is a variable', () => {
    expect(rest.replace(/\/\*[\s\S]*?\*\//g, '')).not.toMatch(/#[0-9a-f]{3,8}\b|\brgba?\(|\bhsla?\(|\boklch\(/i);
  });

  it('scopes every rule under .cw-player', () => {
    const stripped = css.replace(/\/\*[\s\S]*?\*\//g, '');
    const selectors = [...stripped.matchAll(/(^|[{};])\s*([^{}@;\s][^{}]*)\{/g)].map((m) => (m[2] as string).trim()).filter((s) => !/^(from|to|\d+%)$/.test(s));
    expect(selectors.length).toBeGreaterThan(40);
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
    expect(selectors.flatMap(split).filter((x) => !x.includes('.cw-player'))).toEqual([]);
  });

  it('answers prefers-color-scheme by color-scheme, honours data-cw-theme, reduced motion and forced colours', () => {
    expect(css).toMatch(/color-scheme:\s*light dark/);
    expect(css).toMatch(/\[data-cw-theme='light'\]/);
    expect(css).toMatch(/\[data-cw-theme='dark'\]/);
    expect(css).toMatch(/prefers-reduced-motion/);
    expect(css).toMatch(/forced-colors/);
    expect(css).toMatch(/:focus-visible/);
  });

  it('has a light fallback for browsers without light-dark(), holding every colour token at its light value', () => {
    expect(fbStart).toBeGreaterThan(end);
    expect(fbEnd).toBeGreaterThan(fbStart);
    expect(fallback).toMatch(/@supports not \(color: light-dark\(#000, #fff\)\)/);
    expect(fallback).toMatch(/:where\(\.cw-player\)\s*\{/);
    const colours = [...tokenBlock.matchAll(/^\s*(--cw-[a-z0-9-]+):\s*light-dark\((#[0-9a-f]{6}), #[0-9a-f]{6}\);$/gim)];
    expect(colours.length).toBe(COLOUR_TOKENS.length);
    for (const [, name, light] of colours) expect(fallback, name).toContain(`${name}: ${light};`);
    const inFallback = [...fallback.matchAll(/^\s*(--cw-[a-z0-9-]+):/gm)].map((m) => m[1]);
    expect(inFallback.sort()).toEqual(colours.map((c) => c[1]).sort());
  });

  it('keeps the token defaults at zero specificity so an adopter rule always wins', () => {
    expect(tokenBlock).toMatch(/:where\(\.cw-player\)\s*\{/);
  });

  it('takes the font from the game by default (inherit), so the components look like they belong', () => {
    expect(/--cw-font:\s*([^;]+);/.exec(css)?.[1]).toBe('inherit');
  });

  it('is small: under 14 KB raw (the size test holds it to 6 KB gzipped)', () => {
    expect(Buffer.byteLength(css)).toBeLessThan(14 * 1024);
  });
});

// ---- Colour only where it means something --------------------------------------------------------------------------------

/** The colour tokens, exactly. Adding or dropping one is a design decision: change this list, the README table and the test below together. */
const COLOUR_TOKENS = [
  '--cw-surface',
  '--cw-surface-sunken',
  '--cw-border',
  '--cw-border-strong',
  '--cw-ink',
  '--cw-ink-muted',
  '--cw-accent',
  '--cw-accent-ink',
  '--cw-accent-soft',
  '--cw-red',
  '--cw-red-soft',
  '--cw-yellow',
  '--cw-shadow-ink',
];

describe('the palette', () => {
  const css = read(join(src, 'styles.css'));
  const block = css.slice(css.indexOf('/* ---- Tokens'), css.indexOf('/* ---- End of tokens'));
  const pairs = [...block.matchAll(/^\s*(--cw-[a-z0-9-]+):\s*light-dark\((#[0-9a-f]{6}), (#[0-9a-f]{6})\);$/gim)];
  const theme = (which: 'light' | 'dark'): Record<string, string> =>
    Object.fromEntries(pairs.map((m) => [m[1] as string, (which === 'light' ? m[2] : m[3]) as string]));

  it('has exactly the documented colour tokens: a neutral base, one accent, red and yellow, and the shadow ink', () => {
    expect(pairs.map((m) => m[1]).sort()).toEqual([...COLOUR_TOKENS].sort());
  });

  it('has no per-category, per-player or per-kind colour token, and no green, blue or other hue name', () => {
    for (const name of pairs.map((m) => m[1] as string)) expect(name, name).not.toMatch(/categor|speaker|person|player|avatar|harass|hate|spam|cheat|disrupt|green|blue|teal|purple|orange|pink|live|warn|ban/);
  });

  // WCAG 2.x relative luminance and contrast ratio, from the token values themselves.
  const channel = (c: number): number => {
    const v = c / 255;
    return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  const luminance = (hex: string): number => {
    const n = Number.parseInt(hex.slice(1), 16);
    return 0.2126 * channel(n >> 16) + 0.7152 * channel((n >> 8) & 255) + 0.0722 * channel(n & 255);
  };
  const ratio = (a: string, b: string): number => {
    const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
    return (hi + 0.05) / (lo + 0.05);
  };

  // Every text token on every surface it is drawn on. 4.5 is WCAG AA for body text.
  const TEXT: Array<[string, string[]]> = [
    ['--cw-ink', ['--cw-surface', '--cw-surface-sunken', '--cw-accent-soft', '--cw-red-soft']],
    ['--cw-ink-muted', ['--cw-surface', '--cw-surface-sunken', '--cw-accent-soft', '--cw-red-soft']],
    ['--cw-accent', ['--cw-surface', '--cw-surface-sunken', '--cw-accent-soft']],
    ['--cw-accent-ink', ['--cw-accent']],
    ['--cw-red', ['--cw-surface', '--cw-surface-sunken', '--cw-red-soft']],
  ];
  // Lines and shapes that identify a control must stand out from what is behind them (WCAG 1.4.11, 3:1).
  const SHAPES: Array<[string, string[]]> = [
    ['--cw-border-strong', ['--cw-surface', '--cw-surface-sunken']],
    ['--cw-accent', ['--cw-surface']],
    ['--cw-red', ['--cw-surface']],
  ];

  describe.each(['light', 'dark'] as const)('contrast, %s theme', (which) => {
    const t = theme(which);
    it.each(TEXT.flatMap(([fg, bgs]) => bgs.map((bg) => [fg, bg] as const)))('text %s on %s is at least 4.5:1 (AA)', (fg, bg) => {
      expect(ratio(t[fg] as string, t[bg] as string)).toBeGreaterThanOrEqual(4.5);
    });
    it.each(SHAPES.flatMap(([fg, bgs]) => bgs.map((bg) => [fg, bg] as const)))('line %s against %s is at least 3:1', (fg, bg) => {
      expect(ratio(t[fg] as string, t[bg] as string)).toBeGreaterThanOrEqual(3);
    });
  });

  it('the contrast maths is right (control)', () => {
    expect(ratio('#000000', '#ffffff')).toBeCloseTo(21, 5);
    expect(ratio('#777777', '#ffffff')).toBeCloseTo(4.48, 2);
    expect(ratio('#ffffff', '#ffffff')).toBe(1);
  });

  // Where each signal colour may appear. A rule outside its list is a colour that does not carry meaning.
  const body = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const rulesUsing = (token: string): string[] => {
    const out: string[] = [];
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
    for (const m of body.matchAll(/([^{}@;]+)\{([^{}]*)\}/g)) {
      if (new RegExp(`var\\(${token}\\b`).test(m[2] as string)) out.push(...split(m[1] as string));
    }
    return out.filter((s) => !/^(from|to|\d+%)$/.test(s));
  };

  const ALLOWED: Record<string, RegExp[]> = {
    // Yellow: the yellow side of a referee card, and nothing else.
    '--cw-yellow': [/cw-card--(warning|restriction)$/],
    // Red: the red side of a referee card, and a failure (an error, an invalid field).
    '--cw-red': [/cw-card--(restriction|ban)$/, /cw-error$/, /cw-field-error$/, /\[aria-invalid='true'\]$/],
    '--cw-red-soft': [/cw-error$/, /cw-field-error$/],
  };
  it.each(Object.entries(ALLOWED))('%s is used only where it means something', (token, allowed) => {
    const used = rulesUsing(token);
    expect(used.length).toBeGreaterThan(0);
    expect(used.filter((sel) => !allowed.some((re) => re.test(sel)))).toEqual([]);
  });

  it('the accent is only a next action, a link, a choice or a focus', () => {
    const allowed = [/:focus-visible$/, /cw-btn--primary(:hover)?$/, /cw-link$/, /cw-linkbtn$/, /cw-choice:has\(input:checked\)$/, /input\[type='radio'\]$/];
    for (const token of ['--cw-accent', '--cw-accent-soft', '--cw-accent-ink']) {
      const bad = rulesUsing(token).filter((sel) => !allowed.some((re) => re.test(sel)));
      expect(bad, token).toEqual([]);
    }
  });

  it('colours no kind of notice but through the referee card: the kind itself is a word, not a colour', () => {
    const SIGNAL = /var\(--cw-(accent|accent-soft|accent-ink|red|red-soft|yellow)\b/;
    for (const cls of ['cw-kind', 'cw-title', 'cw-facts', 'cw-line-text', 'cw-line-day', 'cw-rule']) {
      for (const m of body.matchAll(new RegExp(`\\.cw-player \\.${cls}\\b[^{]*\\{([^}]*)\\}`, 'g'))) expect(m[1], cls).not.toMatch(SIGNAL);
    }
  });

  it('draws the referee card as the hub does: yellow, half yellow and half red, red, and a dashed outline for a note', () => {
    const rule = (cls: string): string => new RegExp(`\\.cw-player \\.cw-card--${cls}\\s*\\{([^}]*)\\}`).exec(body)?.[1] ?? '';
    expect(rule('warning')).toMatch(/background:\s*var\(--cw-yellow\)/);
    expect(rule('restriction')).toMatch(/linear-gradient\(135deg,\s*var\(--cw-yellow\) 50%,\s*var\(--cw-red\) 50%\)/);
    expect(rule('ban')).toMatch(/background:\s*var\(--cw-red\)/);
    expect(rule('note')).toMatch(/dashed/);
  });

  it('the referee card has the same geometry as the hub card (a sanction looks the same to staff and player)', () => {
    const hub = readFileSync(join(pkg, '..', 'hub-react', 'src', 'styles.css'), 'utf8');
    const geometry = (sheet: string, root: string): string[] => {
      const m = new RegExp(`\\.${root} \\.cw-card\\s*\\{([^}]*)\\}`).exec(sheet)?.[1] ?? '';
      return m
        .split(';')
        .map((d) => d.trim())
        .filter((d) => /^(width|height|border-radius|transform):/.test(d))
        .sort();
    };
    expect(geometry(hub, 'cw-hub').length).toBe(4);
    expect(geometry(body, 'cw-player')).toEqual(geometry(hub, 'cw-hub'));
    for (const cls of ['warning', 'restriction', 'ban']) {
      const of = (sheet: string, root: string): string => new RegExp(`\\.${root} \\.cw-card--${cls}\\s*\\{([^}]*)\\}`).exec(sheet)?.[1]?.replace(/\s+/g, ' ').trim() ?? '';
      expect(of(body, 'cw-player'), cls).toBe(of(hub, 'cw-hub'));
    }
  });

  it('the colour values of the shared palette are the hub values (one look)', () => {
    const hub = readFileSync(join(pkg, '..', 'hub-react', 'src', 'styles.css'), 'utf8');
    const hubPairs = Object.fromEntries([...hub.matchAll(/^\s*(--cw-[a-z0-9-]+):\s*(light-dark\(#[0-9a-f]{6}, #[0-9a-f]{6}\));$/gim)].map((m) => [m[1], m[2]]));
    for (const m of pairs) expect(`${m[1]}: light-dark(${m[2]}, ${m[3]})`, String(m[1])).toBe(`${m[1]}: ${hubPairs[m[1] as string] as string}`);
  });
});

describe('hygiene', () => {
  const css = read(join(src, 'styles.css')).replace(/\/\*[\s\S]*?\*\//g, '');

  it('no opacity below 1 dims text: contrast is computed from the tokens, and opacity would bypass it', () => {
    const rules = [...css.matchAll(/([^{}@;]+)\{([^{}]*)\}/g)].filter((m) => /(^|[\s;])opacity:\s*0?\.\d+/.test(m[2] as string));
    const allowed = [/cw-btn\[aria-disabled='true'\]/];
    expect(rules.map((m) => (m[1] as string).trim()).filter((sel) => !allowed.some((re) => re.test(sel)))).toEqual([]);
  });

  it('the busy button is dimmed by its aria state, never by :disabled (it keeps focus)', () => {
    expect(css).not.toMatch(/\.cw-btn:disabled/);
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

  it('names the three inputs a game sets to make it look like its own: base, accent and radius', () => {
    const flat = theming.replace(/\s+/g, ' ');
    expect(flat).toMatch(/three/i);
    for (const token of ['--cw-surface', '--cw-accent', '--cw-radius']) expect(flat).toContain(token);
  });

  it('says React 18.3 is declared but the tests run on React 19', () => {
    const flat = readme.replace(/\s+/g, ' ');
    expect(flat).toMatch(/18\.3/);
    expect(flat).toMatch(/tested (only )?(on|against|with) React 19/i);
  });

  it('describes the light fallback', () => {
    expect(theming.replace(/\s+/g, ' ')).toMatch(/older browsers[^.]*light/i);
  });
});

describe('the manifest', () => {
  const manifest = JSON.parse(readFileSync(join(pkg, 'package.json'), 'utf8')) as {
    exports: Record<string, unknown>;
    sideEffects: string[];
    files: string[];
    peerDependencies: Record<string, string>;
    dependencies?: Record<string, string>;
    devDependencies: Record<string, string>;
  };

  it('exports ./styles.css, lists only it under sideEffects, and ships src', () => {
    expect(manifest.exports['./styles.css']).toBe('./src/styles.css');
    expect(manifest.sideEffects).toEqual(['./src/styles.css']);
    expect(manifest.files).toEqual(['dist/src', 'src', 'README.md', 'LICENSE']);
  });

  it('peers on React, React DOM and core only (not http, not hub-react); bundles none of them', () => {
    expect(Object.keys(manifest.peerDependencies).sort()).toEqual(['@chatwarden/core', 'react', 'react-dom']);
    expect(manifest.peerDependencies.react).toBe('^18.3.0 || ^19.0.0');
    expect(manifest.peerDependencies['react-dom']).toBe('^18.3.0 || ^19.0.0');
    expect(manifest.dependencies).toBeUndefined();
  });

  it('dev-depends on hub-react only for the transport type test', () => {
    expect(manifest.devDependencies['@chatwarden/hub-react']).toBeDefined();
  });
});

describe('nothing is loaded from a third party', () => {
  const URL_RE = /(?:https?:)?\/\/[a-z0-9.-]+\.[a-z]{2,}/i;
  const strip = (text: string): string => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

  it.each(files.filter((f) => /\.(tsx?|css)$/.test(f)).map((f) => [rel(f), f] as const))('%s names no remote address in code', (_name, file) => {
    expect(strip(read(file))).not.toMatch(URL_RE);
  });

  it('the scan sees a remote address when there is one (control)', () => {
    expect(URL_RE.test('@import url(https://fonts.googleapis.com/css2?family=Instrument+Sans)')).toBe(true);
    expect(URL_RE.test("src: url('//cdn.example.com/a.woff2')")).toBe(true);
    expect(URL_RE.test("src: url('./fonts/a.woff2')")).toBe(false);
  });
});

describe('player-facing copy', () => {
  const entries = Object.entries(en) as Array<[string, string]>;

  it('is plain: no marketing words, no em dash, no exclamation mark, no legalese', () => {
    for (const [key, text] of entries) {
      expect(text, key).not.toMatch(/[—!]/);
      expect(text, key).not.toMatch(/\b(seamless|powerful|robust|blazing)\b/i);
      expect(text, key).not.toMatch(/\b(hereby|pursuant|violat(e|ed|ion)s?|offen[sc]es?|infractions?|misconduct|prohibited|sanctioned|terms of service)\b/i);
    }
  });

  it('does not shame: no "you must", "you failed" or "your behaviour"', () => {
    for (const [key, text] of entries) expect(text, key).not.toMatch(/\byou (must|failed|should be ashamed)\b|\byour (behaviou?r|bad)\b|\bwarned you\b/i);
  });

  it('is sentence case: a sentence starts with a capital and a title has no Title Case Words', () => {
    for (const [key, text] of entries) {
      if (/^player\.(notice|record|rules|report)\.title|\.title\./.test(key)) expect(text, key).not.toMatch(/^[A-Z][a-z]+( [A-Z][a-z]+){2,}$/);
    }
  });

  it('holds no real slur or blocked word: only the synthetic terms may ever appear in an example', () => {
    const SYNTHETIC = ['zorbak', 'vlemmo', 'quissel', 'drakkuun', 'fenrisk', 'tarvo', 'snerp', 'glarn'];
    expect(SYNTHETIC.length).toBe(8);
    // The catalog needs no example word at all.
    for (const [key, text] of entries) for (const w of SYNTHETIC) expect(text.toLowerCase(), key).not.toContain(w);
  });
});
