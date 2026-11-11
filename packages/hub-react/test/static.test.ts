// @vitest-environment node
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { en } from '../src/i18n.js';
import { UNDO_MS } from '../src/toasts.js';

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
/** The public name of a private default: `--cwd-bg` is what `--cw-bg` falls back to. */
const pub = (privateName: string): string => `--cw-${privateName.slice('--cwd-'.length)}`;

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
  const fbStart = css.indexOf('/* ---- Fallback');
  const fbEnd = css.indexOf('/* ---- End of fallback');
  const fallback = css.slice(fbStart, fbEnd);
  // Everything after the tokens, without the fallback block (which holds plain colours on purpose).
  const rest = fbStart === -1 ? css.slice(end) : css.slice(end, fbStart) + css.slice(fbEnd);
  const defined = [...tokenBlock.matchAll(/^\s*(--cwd-[a-z0-9-]+):/gm)].map((m) => pub(m[1] as string));
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
    const colours = [...tokenBlock.matchAll(/^\s*(--cwd-[a-z0-9-]+):\s*(.+);$/gm)].filter(([, , v]) => /#[0-9a-f]{3,8}\b/i.test(v as string));
    expect(colours.length).toBe(COLOUR_TOKENS.length);
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

  it('has a light fallback for browsers without light-dark(), holding every colour token at its light value', () => {
    expect(fbStart).toBeGreaterThan(end);
    expect(fbEnd).toBeGreaterThan(fbStart);
    expect(fallback).toMatch(/@supports not \(color: light-dark\(#000, #fff\)\)/);
    expect(fallback).toMatch(/:where\(\.cw-hub\)\s*\{/);
    const colours = [...tokenBlock.matchAll(/^\s*(--cwd-[a-z0-9-]+):\s*light-dark\((#[0-9a-f]{6}), #[0-9a-f]{6}\);$/gim)];
    expect(colours.length).toBe(COLOUR_TOKENS.length);
    for (const [, name, light] of colours) expect(fallback, name).toContain(`${name}: ${light};`);
    const inFallback = [...fallback.matchAll(/^\s*(--cwd-[a-z0-9-]+):/gm)].map((m) => pub(m[1] as string));
    expect(inFallback.sort()).toEqual(colours.map((c) => pub(c[1] as string)).sort());
  });

  it('draws the focus ring inside the status filter and the rail, where their boxes clip an outside ring', () => {
    const stripped = css.replace(/\/\*[\s\S]*?\*\//g, '');
    const rule = /\.cw-hub \.cw-seg button:focus-visible,\s*\.cw-hub \.cw-rail a:focus-visible\s*\{([^}]*)\}/.exec(stripped);
    expect(rule, 'a focus-visible rule for both').not.toBeNull();
    expect(rule?.[1]).toMatch(/outline-offset:\s*-\d+px/);
    // The segment box clips; the rule above is what keeps the ring visible.
    expect(stripped).toMatch(/\.cw-hub \.cw-seg\s*\{[^}]*overflow:\s*hidden/);
  });

  it('lets the rail wrap onto more lines on a phone instead of scrolling sideways with sections out of sight', () => {
    const stripped = css.replace(/\/\*[\s\S]*?\*\//g, '');
    const phone = /@media \(max-width: 51\.1875rem\)\s*\{([\s\S]*?)\n\}\n/.exec(stripped)?.[1] ?? '';
    const rail = /\.cw-hub \.cw-rail ul\s*\{([^}]*)\}/.exec(phone)?.[1] ?? '';
    expect(rail).toMatch(/flex-wrap:\s*wrap/);
    expect(rail).not.toMatch(/overflow/);
  });

  it('keeps the token defaults at zero specificity so an adopter rule always wins', () => {
    expect(tokenBlock).toMatch(/:where\(\.cw-hub\)\s*\{/);
  });

  // v2 sized the sheet for the shell, the windows, the toasts and the team view: 52 KB raw, 10 KB gzipped. The case pane (the
  // transcript, the decision bar, the context pane, the phone sheet) takes it to 64 KB raw, 12 KB gzipped. The last five screens
  // (Terms, Blocked, Rule gaps, Audit, Guide: tables with column floors, the add and edit form and its dry-run list, the gap and
  // rule lists, the ladder and the guide's document typography) take it to 76 KB raw, 14 KB gzipped (the size test). They reuse the
  // table, scroll box, form, panel, tag and mask classes; what is new is only what none of those could draw.
  // The embedded pieces (the provider's root, the piece box, the queue and the workbench outside the shell) took it to 76.7 KB; it is
  // now 84 KB raw, 15 KB gzipped: raised at 7d for the Steps and ladder settings screen (owner-approved feature, 2026-11-10).
  // 7j: 112 KB raw, 18 KB gzipped (the size test). Every one of the 960 token reads now carries its private default,
  // `var(--cw-x, var(--cwd-x))`, which is what lets a page theme the hub from any element above it (owner-approved, 2026-11-10): +20 KB
  // of repeated text raw, about +1 KB gzipped. Gzip is the contract; the raw cap only keeps the file from growing without a look.
  it('is under 112 KB raw (the size test holds it to 18 KB gzipped)', () => {
    expect(Buffer.byteLength(css)).toBeLessThan(112 * 1024);
  });
});

// ---- Design v2: colour only where it means something ------------------------------------------------------------------

/** The colour tokens, exactly. Adding or dropping one is a design decision: change this list, the README table and the test below together. */
const COLOUR_TOKENS = [
  '--cw-bg',
  '--cw-surface',
  '--cw-surface-sunken',
  '--cw-border',
  '--cw-border-strong',
  '--cw-ink',
  '--cw-ink-muted',
  '--cw-ink-faint',
  '--cw-accent',
  '--cw-accent-ink',
  '--cw-accent-soft',
  '--cw-red',
  '--cw-red-soft',
  '--cw-yellow',
  '--cw-yellow-soft',
  '--cw-yellow-ink',
  '--cw-live',
  '--cw-shadow-ink',
];

describe('design v2: the palette', () => {
  const css = read(join(src, 'styles.css'));
  const block = css.slice(css.indexOf('/* ---- Tokens'), css.indexOf('/* ---- End of tokens'));
  const pairs = [...block.matchAll(/^\s*(--cwd-[a-z0-9-]+):\s*light-dark\((#[0-9a-f]{6}), (#[0-9a-f]{6})\);$/gim)].map((m) => [m[0], pub(m[1] as string), m[2], m[3]] as const);
  const theme = (which: 'light' | 'dark'): Record<string, string> =>
    Object.fromEntries(pairs.map((m) => [m[1] as string, (which === 'light' ? m[2] : m[3]) as string]));

  it('has exactly the documented colour tokens: a neutral base, one accent, red, yellow, the live dot and the shadow ink', () => {
    expect(pairs.map((m) => m[1]).sort()).toEqual([...COLOUR_TOKENS].sort());
  });

  it('has no per-category, per-speaker or per-person colour token', () => {
    for (const name of pairs.map((m) => m[1] as string)) expect(name, name).not.toMatch(/categor|speaker|person|player|avatar|harass|hate|spam|cheat|disrupt|green|blue|teal|purple|orange|pink/);
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
    ['--cw-ink', ['--cw-bg', '--cw-surface', '--cw-surface-sunken', '--cw-accent-soft', '--cw-red-soft', '--cw-yellow-soft']],
    ['--cw-ink-muted', ['--cw-bg', '--cw-surface', '--cw-surface-sunken', '--cw-accent-soft', '--cw-red-soft', '--cw-yellow-soft']],
    ['--cw-ink-faint', ['--cw-bg', '--cw-surface', '--cw-surface-sunken', '--cw-accent-soft', '--cw-red-soft']],
    ['--cw-accent', ['--cw-bg', '--cw-surface', '--cw-surface-sunken', '--cw-accent-soft']],
    ['--cw-accent-ink', ['--cw-accent']],
    ['--cw-red', ['--cw-bg', '--cw-surface', '--cw-surface-sunken', '--cw-red-soft', '--cw-accent-soft']],
    ['--cw-yellow-ink', ['--cw-yellow-soft']],
    // Inverted text: the toast and the new-cases pill (surface on ink), and the initial in an avatar (surface on faint ink).
    ['--cw-surface', ['--cw-ink', '--cw-ink-faint']],
  ];
  // Lines and shapes that identify a control must stand out from what is behind them (WCAG 1.4.11, 3:1).
  const SHAPES: Array<[string, string[]]> = [
    ['--cw-border-strong', ['--cw-bg', '--cw-surface', '--cw-surface-sunken']],
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
  const stripped = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const body = stripped.slice(stripped.indexOf('End of fallback') === -1 ? 0 : 0);
  const rulesUsing = (token: string): string[] => {
    const out: string[] = [];
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
    for (const m of body.matchAll(/([^{}@;]+)\{([^{}]*)\}/g)) {
      if (new RegExp(`var\\(${token}\\b`).test(m[2] as string)) out.push(...split(m[1] as string));
    }
    return out.filter((s) => !/^(from|to|\d+%)$/.test(s));
  };

  const ALLOWED: Record<string, RegExp[]> = {
    // Green: the live dot, nothing else.
    '--cw-live': [/^\.cw-hub \.cw-live-dot$/],
    // Yellow: a warning (a warning tag or notice, the connection banner) and the yellow side of a referee card.
    '--cw-yellow': [/cw-tag--warn$/, /cw-card--(warning|restriction)$/, /cw-notice--warn$/, /cw-banner$/],
    '--cw-yellow-soft': [/cw-tag--warn$/, /cw-notice--warn$/, /cw-banner$/],
    '--cw-yellow-ink': [/cw-tag--warn$/, /cw-notice--warn$/, /cw-banner$/],
    // Red: overdue, the reported line, a ban, a failure.
    '--cw-red': [
      /cw-tag--bad$/,
      /cw-card--(restriction|ban)$/,
      /cw-notice--bad$/,
      /cw-error$/,
      /cw-case\[data-wait='overdue'\]( \.cw-case-wait)?$/,
      /cw-stat\[data-wait='overdue'\] \.cw-stat-value$/,
      /cw-qrow\[data-wait='stale'\]( \.cw-qrow-age)?$/,
      /cw-line\[data-reported='true'\]$/,
      /cw-btn--danger$/,
      /\[aria-invalid='true'\]$/,
      /cw-field-error$/,
      /cw-problems$/,
      /cw-toast\[data-tone='bad'\]$/,
    ],
    '--cw-red-soft': [/cw-tag--bad$/, /cw-notice--bad$/, /cw-error$/, /cw-line\[data-reported='true'\]$/, /cw-problems$/],
  };
  it.each(Object.entries(ALLOWED))('%s is used only where it means something', (token, allowed) => {
    const used = rulesUsing(token);
    expect(used.length).toBeGreaterThan(0);
    expect(used.filter((sel) => !allowed.some((re) => re.test(sel)))).toEqual([]);
  });

  it('the accent is only you, a next action, a selection or a focus', () => {
    const allowed = [
      /cw-mark-(shield|tick)$/,
      /cw-skip$/,
      /:focus(-visible)?$/,
      /:focus-visible$/,
      /cw-avatar--you$/,
      /cw-tag--accent$/,
      /cw-btn--primary(:hover)?$/,
      /cw-link(btn)?$/,
      /cw-take( .cw-kbd)?$/,
      /cw-case\[data-selected='true'\]$/,
      /cw-case\[data-claim='you'\] \.cw-case-claim$/,
      /cw-case-state\[data-claim='you'\]$/,
      /cw-member-you$/,
      /cw-suggest$/,
      /cw-radio:has\(input:checked\)$/,
      // The Reporting settings' flow choices: the chosen one is a selection, like a verdict.
      /cw-flowopt:has\(input:checked\)$/,
      /cw-result$/,
      // The case pane: your claim (a soft blue band), the open tab, your decision waiting for its Undo, the focus ring on a verdict,
      // and the key caps on the primary button (white-ish on the accent).
      /cw-claim\[data-claim='you'\]( strong)?$/,
      /cw-tabs button\[aria-selected='true'\]$/,
      /cw-queued$/,
      /cw-radio input:focus-visible \+ label$/,
      /cw-btn--primary \.cw-kbd$/,
      /cw-cmdk-item\[aria-selected='true'\]$/,
      /cw-cmdk-field:has\(input:focus-visible\)$/,
      /cw-toast-bar$/,
      /input\[type='checkbox'\],?$/,
      /input\[type='radio'\]$/,
    ];
    for (const token of ['--cw-accent', '--cw-accent-soft', '--cw-accent-ink']) {
      const bad = rulesUsing(token).filter((sel) => !allowed.some((re) => re.test(sel)));
      expect(bad, token).toEqual([]);
    }
  });

  it('colours no category, speaker or person: those rules use neutral tokens only', () => {
    const SIGNAL = /var\(--cw-(accent|accent-soft|accent-ink|red|red-soft|yellow|yellow-soft|yellow-ink|live)\b/;
    for (const cls of ['cw-cat', 'cw-pid', 'cw-line-who', 'cw-person-name', 'cw-case-name', 'cw-qrow-name', 'cw-avatar']) {
      for (const m of body.matchAll(new RegExp(`\\.cw-hub \\.${cls}\\s*\\{([^}]*)\\}`, 'g'))) {
        expect(m[1], cls).not.toMatch(SIGNAL);
      }
    }
  });
});

describe('design v2: the optional font', () => {
  const fontCss = readFileSync(join(pkg, 'font.css'), 'utf8');
  const manifest = JSON.parse(readFileSync(join(pkg, 'package.json'), 'utf8')) as {
    exports: Record<string, unknown>;
    sideEffects: string[];
    files: string[];
    devDependencies: Record<string, string>;
  };

  it('is a self-hosted latin subset: one relative woff2 that ships in the package, and nothing from elsewhere', () => {
    const urls = [...fontCss.matchAll(/url\(\s*['"]?([^'")]+)['"]?\s*\)/g)].map((m) => m[1] as string);
    expect(urls).toEqual(['./fonts/instrument-sans-latin-wght-normal.woff2']);
    const file = join(pkg, 'fonts', 'instrument-sans-latin-wght-normal.woff2');
    expect(statSync(file).size).toBeGreaterThan(10_000);
    expect(statSync(file).size).toBeLessThan(40_000);
    expect(readdirSync(join(pkg, 'fonts')).sort()).toEqual(['OFL.txt', 'instrument-sans-latin-wght-normal.woff2']);
    expect(fontCss).toMatch(/font-family:\s*'Instrument Sans'/);
    expect(fontCss).toMatch(/font-display:\s*swap/);
    expect(fontCss).toMatch(/font-weight:\s*400 700/);
    // Latin only: no Cyrillic, Greek, Vietnamese or latin-ext ranges.
    expect(fontCss).not.toMatch(/U\+0400|U\+0370|U\+1EA0|U\+0100-/);
  });

  it('ships the SIL Open Font Licence text', () => {
    const licence = readFileSync(join(pkg, 'fonts', 'OFL.txt'), 'utf8');
    expect(licence).toMatch(/SIL OPEN FONT LICENSE Version 1\.1/);
    expect(licence).toMatch(/Instrument Sans Project Authors/);
  });

  it('is exported as ./font.css, listed in sideEffects and files, and the font is a devDependency only', () => {
    expect(manifest.exports['./font.css']).toBe('./font.css');
    expect(manifest.exports['./styles.css']).toBe('./src/styles.css');
    expect(manifest.sideEffects).toEqual(['./src/styles.css', './font.css']);
    for (const f of ['font.css', 'fonts', 'src']) expect(manifest.files).toContain(f);
    expect(manifest.devDependencies['@fontsource-variable/instrument-sans']).toBeDefined();
  });

  it('the stylesheet names Instrument Sans first and falls back to the system UI font, so it applies once font.css is loaded', () => {
    const css = read(join(src, 'styles.css'));
    const stack = /--cwd-font:\s*([^;]+);/.exec(css)?.[1] ?? '';
    expect(stack.startsWith("'Instrument Sans', ")).toBe(true);
    expect(stack).toMatch(/system-ui/);
  });
});

describe('nothing is loaded from a third party', () => {
  const URL_RE = /(?:https?:)?\/\/[a-z0-9.-]+\.[a-z]{2,}/i;
  const strip = (text: string): string => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

  it.each(files.filter((f) => /\.(tsx?|css)$/.test(f)).map((f) => [rel(f), f] as const))('%s names no remote address in code', (_name, file) => {
    // Comments may link to docs; code and CSS may not reach out.
    expect(strip(read(file))).not.toMatch(URL_RE);
  });

  it('font.css names no remote address, and neither does the stylesheet use url()', () => {
    expect(strip(readFileSync(join(pkg, 'font.css'), 'utf8'))).not.toMatch(URL_RE);
    expect(read(join(src, 'styles.css'))).not.toMatch(/url\(/);
  });

  it('the scan sees a remote address when there is one (control)', () => {
    expect(URL_RE.test('@import url(https://fonts.googleapis.com/css2?family=Instrument+Sans)')).toBe(true);
    expect(URL_RE.test("src: url('//cdn.example.com/a.woff2')")).toBe(true);
    expect(URL_RE.test("src: url('./fonts/a.woff2')")).toBe(false);
  });
});

describe('the Undo window is 5 seconds in the stylesheet and in the code', () => {
  it('the progress bar runs for UNDO_MS', () => {
    const css = read(join(src, 'styles.css'));
    const seconds = Number(/\.cw-toast-bar\s*\{[^}]*animation:\s*cw-undo\s+([\d.]+)s/.exec(css)?.[1]);
    expect(seconds * 1000).toBe(UNDO_MS);
    expect(UNDO_MS).toBe(5000);
  });
});

describe('the README documents the token contract', () => {
  const readme = readFileSync(join(pkg, 'README.md'), 'utf8');
  const css = read(join(src, 'styles.css'));
  const block = css.slice(css.indexOf('/* ---- Tokens'), css.indexOf('/* ---- End of tokens'));
  const defined = [...block.matchAll(/^\s*(--cwd-[a-z0-9-]+):/gm)].map((m) => pub(m[1] as string));
  const theming = readme.slice(readme.indexOf('\n## Theming\n'), readme.indexOf('\n## Security notes\n'));

  it('lists every token under Theming, and no token the stylesheet lacks', () => {
    expect(theming.length).toBeGreaterThan(500);
    const documented = [...theming.matchAll(/^\| `(--cw-[a-z0-9-]+)` \|/gm)].map((m) => m[1] as string);
    expect(documented.sort()).toEqual([...defined].sort());
  });

  it('says the ref is in the address, so onNavigate paths must not go to analytics', () => {
    const flat = readme.replace(/\s+/g, ' ');
    expect(flat).toMatch(/full person ref is in the (link|address)/i);
    expect(flat).toMatch(/onNavigate[^.]*analytics|analytics[^.]*onNavigate/i);
  });

  it('says React 18.3 is declared but the tests run on React 19', () => {
    const flat = readme.replace(/\s+/g, ' ');
    expect(flat).toMatch(/18\.3/);
    expect(flat).toMatch(/tested (only )?(on|against|with) React 19/i);
  });

  it('describes the light fallback', () => {
    expect(theming.replace(/\s+/g, ' ')).toMatch(/older browsers[^.]*light/i);
  });

  it('states each colour token default as written in the stylesheet', () => {
    for (const m of block.matchAll(/^\s*(--cwd-[a-z0-9-]+):\s*light-dark\((#[0-9a-f]+), (#[0-9a-f]+)\);$/gim)) {
      expect(theming, m[1]).toContain(`| \`${pub(m[1] as string)}\` | \`${m[2]}\`, \`${m[3]}\` |`);
    }
  });
});

describe('fix round 1: hygiene', () => {
  const css = read(join(src, 'styles.css')).replace(/\/\*[\s\S]*?\*\//g, '');

  it('no opacity below 1 dims text: contrast is computed from the tokens, and opacity would bypass it', () => {
    const rules = [...css.matchAll(/([^{}@;]+)\{([^{}]*)\}/g)].filter((m) => /(^|[\s;])opacity:\s*0?\.\d+/.test(m[2] as string));
    // The only dimmed things: a disabled control, and the small hint on the take-next button (white on accent, 0.9).
    const allowed = [/cw-btn:disabled/, /cw-btn\[aria-disabled='true'\]/, /cw-take small/];
    expect(rules.map((m) => (m[1] as string).trim()).filter((sel) => !allowed.some((re) => re.test(sel)))).toEqual([]);
  });

  it('the tones are the palette: no unstyled "ok"', () => {
    expect(read(join(src, 'ui.tsx'))).toMatch(/export type Tone = 'warn' \| 'bad' \| 'idle' \| 'accent';/);
  });

  it('every catalog key is used by the source (no dead words)', () => {
    const text = appCode.map(read).join('\n');
    const literals = new Set([...text.matchAll(/'(hub\.[A-Za-z0-9_.]+)'/g)].map((m) => m[1] as string));
    const prefixes = [...text.matchAll(/`(hub\.[A-Za-z0-9_.]*\.)\$\{/g)].map((m) => m[1] as string);
    const bases = [...new Set(Object.keys(en).map((k) => k.replace(/\.(zero|one|two|few|many|other)$/, '')))];
    const dead = bases.filter((k) => !literals.has(k) && !prefixes.some((p) => k.startsWith(p)));
    expect(dead).toEqual([]);
  });
});

describe('the page is reached only through dom.ts', () => {
  // `document` is the page, which is the wrong place to look when the hub is drawn inside a shadow root: `document.activeElement` is
  // the host, `document.getElementById` finds nothing, and a key listener on the page hears every hub on it. Everything that looks a
  // node up or reads focus goes through `dom.ts`, from the node it has, and the one page-wide key listener lives there too.
  // `headless/env.ts` is the page-hide and visibility source: those really are the page's, so it may say `document`.
  const MAY_SAY_DOCUMENT = new Set(['src/dom.ts', 'src/headless/env.ts']);
  const MAY_LISTEN_FOR_KEYS = new Set(['src/dom.ts']);
  // Members only dom.ts may use (`.document` and `['document']` are banned everywhere else; `ownerDocument` is a different name).
  const ROOT_ONLY = new Set(['activeElement', 'getElementById']);
  const KEY_EVENTS = new Set(['keydown', 'keyup', 'keypress']);

  /** Every way the source reaches the page or listens for keys on it, as short descriptions. `text` is the source of one file. */
  function uses(text: string, options: { document?: boolean; keys?: boolean } = {}): string[] {
    const source = ts.createSourceFile('x.tsx', text, ts.ScriptTarget.ES2023, true, ts.ScriptKind.TSX);
    const found: string[] = [];
    const where = (n: ts.Node): string => `line ${source.getLineAndCharacterOfPosition(n.getStart()).line + 1}: ${n.parent.getText().split('\n')[0]?.slice(0, 80)}`;
    const memberName = (n: ts.Node): string | undefined => {
      if (ts.isPropertyAccessExpression(n)) return n.name.text;
      if (ts.isElementAccessExpression(n) && (ts.isStringLiteral(n.argumentExpression) || ts.isNoSubstitutionTemplateLiteral(n.argumentExpression))) return n.argumentExpression.text;
      return undefined;
    };
    const keyLiteral = (n: ts.Node | undefined): boolean => n !== undefined && (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) && KEY_EVENTS.has(n.text);
    const visit = (node: ts.Node): void => {
      if (options.document !== true) {
        // The global `document` as a bare name: `document`, `typeof document`, `const d = document`, `f(document)`.
        if (ts.isIdentifier(node) && node.text === 'document') {
          const p = node.parent;
          const isMemberName = ts.isPropertyAccessExpression(p) && p.name === node;
          const isDeclared = (ts.isVariableDeclaration(p) || ts.isParameter(p) || ts.isPropertySignature(p) || ts.isPropertyAssignment(p) || ts.isBindingElement(p)) && p.name === node;
          if (!isMemberName && !isDeclared) found.push(`document ${where(node)}`);
        }
        // `x.document`, `x['document']`, however x was reached: window, globalThis, self, top, parent, an alias, a cast.
        const name = memberName(node);
        if (name === 'document') found.push(`.document ${where(node)}`);
        if (name !== undefined && ROOT_ONLY.has(name)) found.push(`.${name} ${where(node)}`);
        // `const { activeElement } = root`, `const { document } = window`, `({ getElementById: g } = root)`.
        if (ts.isBindingElement(node)) {
          const key = node.propertyName ?? node.name;
          const text = ts.isIdentifier(key) || ts.isStringLiteral(key) ? key.text : '';
          if (text === 'document' || ROOT_ONLY.has(text)) found.push(`destructured ${text} ${where(node)}`);
        }
      }
      if (options.keys !== true && ts.isCallExpression(node)) {
        const callee = node.expression;
        const method = ts.isPropertyAccessExpression(callee) ? callee.name.text : ts.isIdentifier(callee) ? callee.text : '';
        const listens = method === 'addEventListener' || method === 'removeEventListener' || method === 'onPage';
        const first = listens ? node.arguments[0] : undefined;
        if (keyLiteral(first)) found.push(`key listener ${where(node)}`);
        // An event name the checker cannot read (a variable, a template with parts) on the page-wide helper is as bad.
        if (method === 'onPage' && first !== undefined && !ts.isStringLiteral(first) && !ts.isNoSubstitutionTemplateLiteral(first)) found.push(`onPage with a computed event ${where(node)}`);
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
    return found;
  }

  it('no source file but dom.ts and headless/env.ts uses `document`, `.document`, `.activeElement` or `.getElementById`; only dom.ts listens for keys on the page', () => {
    const bad = code.flatMap((f) => uses(read(f), { document: MAY_SAY_DOCUMENT.has(rel(f)), keys: MAY_LISTEN_FOR_KEYS.has(rel(f)) }).map((u) => `${rel(f)} ${u}`));
    expect(bad).toEqual([]);
  });

  it('the allow-lists are exactly those files, and each really does use what it is allowed', () => {
    expect([...MAY_SAY_DOCUMENT].sort()).toEqual(['src/dom.ts', 'src/headless/env.ts']);
    expect([...MAY_LISTEN_FOR_KEYS]).toEqual(['src/dom.ts']);
    for (const f of MAY_SAY_DOCUMENT) expect(uses(read(join(pkg, f))).length, f).toBeGreaterThan(0);
    expect(uses(read(join(pkg, 'src/dom.ts')), { document: true }).filter((u) => u.startsWith('key listener')).length).toBeGreaterThan(0);
  });

  // The checker, run through the real `uses()`: each of these must be caught, and each of the legal ones must not.
  const CAUGHT: Array<[string, string]> = [
    ['the bare name', 'const x = document.body;'],
    ['typeof', "if (typeof document !== 'undefined') f();"],
    ['an alias of the name', 'const d = document; d.body;'],
    ['window.document', 'window.document.body;'],
    ['globalThis.document', 'globalThis.document;'],
    ['self.document', 'self.document;'],
    ['an aliased window', 'const w = window; w.document.body;'],
    ['a cast window', '(window as Window).document;'],
    ['element access on window', "window['document'];"],
    ['element access on globalThis', "globalThis['document'].body;"],
    ['a template literal key', 'window[`document`];'],
    ['top.document', 'top.document;'],
    ['parent.document', 'parent.document;'],
    ['a document passed along', 'run(document);'],
    ['activeElement on anything', 'root.activeElement;'],
    ['getElementById on anything', "root.getElementById('x');"],
    ['getElementById by element access', "root['getElementById']('x');"],
    ['a destructured activeElement', 'const { activeElement } = root;'],
    ['a renamed destructured getElementById', 'const { getElementById: byId } = root;'],
    ['a destructured document', 'const { document: d } = window;'],
    ['a destructured document in a parameter', 'function f({ document }: Window) { return document; }'],
    ['a keydown listener on the window', "window.addEventListener('keydown', f);"],
    ['a keyup listener on an alias of the window', "const w = window; w.addEventListener('keyup', f);"],
    ['a keypress listener removed', "globalThis.removeEventListener('keypress', f);"],
    ['a keydown listener on any element', "el.addEventListener('keydown', f);"],
    ['a keydown listener through onPage', "onPage('keydown', f);"],
    ['a template-literal key event', 'onPage(`keyup`, f);'],
    ['onPage with an event it cannot read', 'onPage(kind, f);'],
  ];
  it.each(CAUGHT)('the checker catches %s', (_name, text) => {
    expect(uses(text).length, text).toBeGreaterThan(0);
  });

  const LEGAL: Array<[string, string]> = [
    ['ownerDocument', 'el.ownerDocument.body;'],
    ['a field called documents', 'doc.documents.moderatorGuide;'],
    ['a type with a documents member', 'type T = { documents: { a: string } };'],
    ['a pagehide listener on the window', "window.addEventListener('pagehide', f);"],
    ['onPage with a pointer event', "onPage('pointerdown', f);"],
    ['a click listener', "el.addEventListener('click', f);"],
    ['React key props', 'const x = <div onKeyDown={f} />;'],
    ['getRootNode', 'node.getRootNode();'],
    ['a word in a string', "const s = 'document.activeElement';"],
  ];
  it.each(LEGAL)('the checker allows %s', (_name, text) => {
    expect(uses(text), text).toEqual([]);
  });

  it('the allow options let dom.ts and env.ts through, and nothing else', () => {
    expect(uses('document.activeElement; window.addEventListener("keydown", f);', { document: true })).toHaveLength(1);
    expect(uses('document.activeElement; window.addEventListener("keydown", f);', { document: true, keys: true })).toEqual([]);
    expect(uses('document.body; window.addEventListener("keydown", f);', { keys: true })).toHaveLength(1);
  });
});
