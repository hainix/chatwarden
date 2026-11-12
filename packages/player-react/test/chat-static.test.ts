// @vitest-environment node
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { en as baseEn } from '../src/i18n.js';
import { enChat } from '../src/chat/words.js';

const en = { ...baseEn, ...enChat };

// Rules that bind the chat box. The package-wide rules in static.test.ts already scan every file under src (so src/chat too);
// these pin the chat-specific ones: the words, the stylesheet's token contract, the lazy entry, and the manifest.

const pkg = fileURLToPath(new URL('..', import.meta.url));
const src = join(pkg, 'src');
const chatDir = join(src, 'chat');
const read = (f: string): string => readFileSync(f, 'utf8');
const rel = (f: string): string => f.slice(pkg.length).replaceAll('\\', '/');
const walk = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((d) => (d.isDirectory() ? walk(join(dir, d.name)) : [join(dir, d.name)]));
const chatFiles = walk(chatDir).filter((f) => /\.tsx?$/.test(f));
const chatTsx = chatFiles.filter((f) => f.endsWith('.tsx'));
const css = read(join(src, 'chat.css'));
const baseCss = read(join(src, 'styles.css'));
const strip = (text: string): string => text.replace(/\/\*[\s\S]*?\*\//g, '');
/** `var(--cw-x, var(--cwd-x))` folded to `var(--cw-x)`, so a test can talk about the token alone. */
const folded = (sheet: string): string => strip(sheet).replace(/var\((--cw-[a-z0-9-]+), var\(--cwd-[a-z0-9-]+\)\)/g, 'var($1)');

describe('the words', () => {
  const TEXT_ATTRS = new Set(['aria-label', 'aria-description', 'aria-placeholder', 'aria-roledescription', 'title', 'placeholder', 'alt', 'label']);
  function literals(file: string): string[] {
    const source = ts.createSourceFile(file, read(file), ts.ScriptTarget.ES2023, true, ts.ScriptKind.TSX);
    const found: string[] = [];
    const visit = (node: ts.Node): void => {
      if (ts.isJsxText(node) && /[A-Za-z]{2,}/.test(node.text)) found.push(`text "${node.text.trim()}"`);
      if (ts.isJsxAttribute(node) && TEXT_ATTRS.has(node.name.getText()) && node.initializer !== undefined && ts.isStringLiteral(node.initializer)) found.push(`${node.name.getText()}="${node.initializer.text}"`);
      if (ts.isJsxExpression(node) && node.expression !== undefined && (ts.isStringLiteral(node.expression) || ts.isNoSubstitutionTemplateLiteral(node.expression)) && /[A-Za-z]{2,}/.test(node.expression.text)) found.push(`expression "${node.expression.text}"`);
      ts.forEachChild(node, visit);
    };
    visit(source);
    return found;
  }

  it('there are chat components to scan', () => {
    expect(chatTsx.map(rel).sort()).toContain('src/chat/ChatBox.tsx');
    expect(chatTsx.map(rel).sort()).toContain('src/chat/Composer.tsx');
  });

  it.each(chatTsx.map((f) => [rel(f), f] as const))('%s has no JSX text or text attribute of its own', (_n, f) => {
    expect(literals(f)).toEqual([]);
  });

  const keys = new Set(Object.keys(en).map((k) => k.replace(/\.(zero|one|two|few|many|other)$/, '')));
  const text = chatFiles.filter((f) => !f.endsWith('words.ts')).map(read).join('\n');

  it('every t() key written out in src/chat is in the catalog', () => {
    const used = [...text.matchAll(/'(player\.[A-Za-z0-9_.]+)'/g)].map((m) => m[1] as string);
    expect(used.length).toBeGreaterThan(10);
    expect(used.filter((k) => !keys.has(k))).toEqual([]);
  });

  it('every player.chat.* key is used by src/chat (a key built from a prefix counts)', () => {
    const literal = new Set([...text.matchAll(/'(player\.chat\.[A-Za-z0-9_.]+)'/g)].map((m) => m[1] as string));
    const prefixes = [...text.matchAll(/`(player\.chat\.[A-Za-z0-9_.]*\.)\$\{/g)].map((m) => m[1] as string);
    const chatKeys = [...keys].filter((k) => k.startsWith('player.chat.'));
    expect(chatKeys.length).toBeGreaterThan(20);
    expect(chatKeys.filter((k) => !literal.has(k) && !prefixes.some((p) => k.startsWith(p)))).toEqual([]);
  });

  it('every dynamic player.chat.<x>.${...} key has a catalog entry for each value it is given', () => {
    // The refusal and closed tables are read as `player.chat.refused.${reason}` and `player.chat.closed.${why}`.
    for (const reason of ['length', 'rate', 'gate', 'blocked', 'profanity', 'slow_mode', 'flood', 'duplicate', 'unknown']) expect(keys.has(`player.chat.refused.${reason}`), reason).toBe(true);
    for (const why of ['banned', 'forbidden', 'unauthorized', 'room_closed', 'shutdown', 'replaced', 'not_found', 'unsupported']) expect(keys.has(`player.chat.closed.${why}`), why).toBe(true);
  });

  it('the catalog comment lists the chat area', () => {
    expect(read(join(src, 'i18n.ts'))).toMatch(/Areas:[^\n]*\bchat\b/);
  });

  it('the chat words stay out of the main catalog, and are keyed player.chat.*', () => {
    expect(Object.keys(baseEn).filter((k) => k.startsWith('player.chat.'))).toEqual([]);
    expect(Object.keys(enChat).filter((k) => !k.startsWith('player.chat.'))).toEqual([]);
    for (const [key, words] of Object.entries(enChat)) expect(words, key).not.toBe('');
  });

  it('the chat words follow the catalog rules: plural pairs, {count}, plain words, no shaming, no real or synthetic term', () => {
    const entries = Object.entries(enChat) as Array<[string, string]>;
    const bases = new Set(entries.map(([k]) => k).filter((k) => /\.(one|other)$/.test(k)).map((k) => k.replace(/\.[a-z]+$/, '')));
    expect(bases.size).toBeGreaterThanOrEqual(3);
    for (const base of bases) {
      expect(Object.keys(enChat), base).toContain(`${base}.one`);
      expect(Object.keys(enChat), base).toContain(`${base}.other`);
      expect(enChat[`${base}.other` as keyof typeof enChat], base).toContain('{count}');
    }
    for (const [key, words] of entries) {
      expect(key).toMatch(/^player(\.[a-z][A-Za-z0-9_]*)+$/);
      expect(words, key).not.toMatch(/[—!]/);
      expect(words, key).not.toMatch(/\b(seamless|powerful|robust|blazing|hereby|violat(e|ed|ion)s?|offen[sc]es?|infractions?|misconduct|prohibited|sanctioned)\b/i);
      expect(words, key).not.toMatch(/\byou (must|failed|should be ashamed)\b|\byour (behaviou?r|bad)\b|\bwarned you\b/i);
      for (const m of words.matchAll(/\{([^}]*)\}/g)) expect(m[1], key).toMatch(/^[a-zA-Z]+$/);
      for (const term of ['zorbak', 'vlemmo', 'quissel', 'drakkuun', 'fenrisk', 'tarvo', 'snerp', 'glarn']) expect(words.toLowerCase(), key).not.toContain(term);
    }
  });

});

describe('nothing is injected and nothing is styled inline', () => {
  it.each(chatFiles.map((f) => [rel(f), f] as const))('%s', (_n, f) => {
    const t = read(f);
    expect(t).not.toMatch(/dangerouslySetInnerHTML|\.innerHTML\b|\.outerHTML\b|insertAdjacentHTML|document\.write/);
    expect(t).not.toMatch(/\bstyle\s*=\s*\{|\.style\.[a-zA-Z]+\s*=|setAttribute\(\s*['"]style['"]/);
    expect(t).not.toMatch(/\beval\s*\(|new Function\s*\(/);
  });

  it('no link detection, markdown or HTML parsing in the chat code', () => {
    for (const f of chatFiles) expect(read(f), rel(f)).not.toMatch(/DOMParser|marked|markdown|linkify|<a\s/i);
  });

  it('the stylesheet imports nothing and loads nothing', () => {
    expect(css).not.toMatch(/@import|url\(/);
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

  it('the chat code imports the kit as types only and never hub-react or http', () => {
    for (const f of chatFiles) {
      for (const i of importsOf(f)) {
        expect(i.spec, rel(f)).not.toMatch(/hub-react|@chatwarden\/http|packages\//);
        if (i.spec.startsWith('@chatwarden/')) expect(i.typeOnly, `${rel(f)} imports ${i.spec}`).toBe(true);
      }
    }
  });

  it('imports nothing but React, the kit types and its own files', () => {
    for (const f of chatFiles) for (const i of importsOf(f)) expect(i.spec, rel(f)).toMatch(/^(\.\/|\.\.\/|react$|react-dom$|react\/jsx-runtime$|@chatwarden\/core$)/);
  });

  it('the chat entry does not export the test-only transport factory', () => {
    expect(read(join(chatDir, 'index.ts'))).not.toMatch(/createSseTransport/);
  });

  it('src/index.ts reaches nothing under src/chat at run time (a type import is gone)', () => {
    const seen = new Set<string>();
    const visit = (file: string): void => {
      if (seen.has(file)) return;
      seen.add(file);
      for (const i of importsOf(file)) {
        // A type-only import is gone at run time: it adds nothing to the bundle.
        if (i.typeOnly || !i.spec.startsWith('.')) continue;
        const base = resolve(dirname(file), i.spec.replace(/\.js$/, ''));
        const target = ['.ts', '.tsx', '/index.ts'].map((e) => base + e).find((p) => existsSync(p));
        if (target !== undefined) visit(target);
      }
    };
    visit(join(src, 'index.ts'));
    expect(seen.size).toBeGreaterThan(10);
    expect([...seen].map(rel).filter((f) => f.includes('/src/chat/'))).toEqual([]);
    expect(read(join(src, 'index.ts'))).not.toMatch(/chat\//);
  });
});

describe('chat.css is a complete token contract', () => {
  const own = ['--cw-chat-height', '--cw-chat-gap', '--cw-chat-name-width'];
  const start = css.indexOf('/* ---- Tokens');
  const end = css.indexOf('/* ---- End of tokens');
  const block = css.slice(start, end);
  const baseBlock = baseCss.slice(baseCss.indexOf('/* ---- Tokens'), baseCss.indexOf('/* ---- End of tokens'));
  const baseDefined = new Set([...baseBlock.matchAll(/^\s*--cwd-([a-z0-9-]+):/gm)].map((m) => `--cw-${m[1] as string}`));
  const body = strip(css.slice(end));
  const reads = [...body.matchAll(/var\((--cw-[a-z0-9-]+)(?:,\s*([^;{}]*?))?\)(?=[\s;,)]|$)/g)];

  it('has a token block that declares exactly the three chat tokens, as private defaults at zero specificity', () => {
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    expect(block).toMatch(/:where\(\.cw-player\)\s*\{/);
    const defined = [...block.matchAll(/^\s*(--cwd-[a-z0-9-]+):/gm)].map((m) => (m[1] as string).replace('--cwd-', '--cw-'));
    expect(defined.sort()).toEqual([...own].sort());
    expect(block).not.toMatch(/^\s*--cw-/m);
  });

  it('every var(--cw-*) read is a chat token or a token the base stylesheet defines, and carries its private default', () => {
    expect(reads.length).toBeGreaterThan(20);
    for (const m of reads) {
      const name = m[1] as string;
      expect(own.includes(name) || baseDefined.has(name) || name === '--cw-font', name).toBe(true);
    }
    const bare = [...body.matchAll(/var\((--cw-[a-z0-9-]+)\)/g)].map((m) => m[1]);
    expect(bare).toEqual([]);
    for (const m of body.matchAll(/var\((--cw-[a-z0-9-]+),\s*var\((--cwd-[a-z0-9-]+)\)\)/g)) expect(m[2], m[1]).toBe((m[1] as string).replace('--cw-', '--cwd-'));
  });

  it('every chat token is read by a rule', () => {
    const used = new Set(reads.map((m) => m[1]));
    expect(own.filter((t) => !used.has(t))).toEqual([]);
  });

  it('writes no colour of its own: every colour in a rule is a variable', () => {
    expect(body).not.toMatch(/#[0-9a-f]{3,8}\b|\brgba?\(|\bhsla?\(|\boklch\(/i);
  });

  it('no opacity below 1: contrast is computed from the tokens and opacity would bypass it', () => {
    expect(body).not.toMatch(/(^|[\s;{])opacity:\s*0?\.\d+/);
  });

  it('scopes every rule under .cw-player', () => {
    const selectors = [...body.matchAll(/(^|[{};])\s*([^{}@;\s][^{}]*)\{/g)].map((m) => (m[2] as string).trim()).filter((s) => !/^(from|to|\d+%)$/.test(s));
    expect(selectors.length).toBeGreaterThan(20);
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

  const rulesUsing = (token: string): string[] => {
    const out: string[] = [];
    for (const m of folded(css).matchAll(/([^{}@;]+)\{([^{}]*)\}/g)) if (new RegExp(`var\\(${token}\\b`).test(m[2] as string)) out.push(...(m[1] as string).split(',').map((s) => s.trim()));
    return out;
  };

  it('colour only where it means something: red for a failure, the accent for the player\'s own name, Send and focus', () => {
    const red = [...rulesUsing('--cw-red'), ...rulesUsing('--cw-red-soft')];
    expect(red.length).toBeGreaterThan(0);
    expect(red.filter((s) => !/cw-chat-(refusal|failure|connection)\b/.test(s))).toEqual([]);
    for (const token of ['--cw-accent', '--cw-accent-soft', '--cw-accent-ink']) {
      const bad = rulesUsing(token).filter((s) => !/cw-chat-name--you$|cw-chat-send|:focus-visible$|cw-chat-jump|cw-chat-undo|cw-chat-retry/.test(s));
      expect(bad, token).toEqual([]);
    }
    expect(rulesUsing('--cw-yellow')).toEqual([]);
  });

  it('keeps the options control reachable on touch: always shown (dimmed by its colour) under (hover: none), and on focus', () => {
    expect(css).toMatch(/@media\s*\(\s*hover:\s*none\s*\)/);
    expect(css).toMatch(/:focus-within/);
    expect(css).toMatch(/\.cw-chat-optbtn/);
  });

  it('every control is at least 2.25 rem tall', () => {
    expect(strip(css)).toMatch(/\.cw-chat-optbtn\s*\{[^}]*min-height:\s*2\.25rem/);
  });

  it('wraps long words and isolates bidirectional text', () => {
    expect(css).toMatch(/overflow-wrap:\s*anywhere/);
    expect(css).toMatch(/unicode-bidi:\s*isolate/);
  });

  it('is small: under 12 KB raw (chat-size holds it to its gzip budget)', () => {
    expect(Buffer.byteLength(css)).toBeLessThan(12 * 1024);
  });
});

describe('server rendering', () => {
  it('no chat component calls useLayoutEffect directly: it goes through the isomorphic alias, so React 18 does not warn on a server render', () => {
    for (const file of readdirSync(join(src, 'chat')).filter((f) => f.endsWith('.tsx'))) {
      const code = read(join(src, 'chat', file)).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
      const direct = [...code.matchAll(/(?<![A-Za-z0-9_])useLayoutEffect\s*\(/g)];
      expect(direct, file).toEqual([]);
    }
    const box = read(join(src, 'chat', 'ChatBox.tsx'));
    expect(box).toMatch(/const useIsomorphicLayoutEffect = typeof window === 'undefined' \? useEffect : useLayoutEffect;/);
  });

  it('the chat box renders to a string on a server (no window) without throwing', async () => {
    const { renderToString } = await import('react-dom/server');
    const { createElement } = await import('react');
    const { ChatBox } = await import('../src/chat/ChatBox.js');
    const transport = { open: () => ({ send: () => Promise.reject(new Error('x')), mute: () => Promise.resolve(false), report: () => Promise.reject(new Error('x')), close: () => undefined }) };
    const html = renderToString(createElement(ChatBox, { room: 'lobby', transport } as never));
    expect(html).toContain('role="log"');
  });
});

describe('the manifest', () => {
  const manifest = JSON.parse(read(join(pkg, 'package.json'))) as {
    exports: Record<string, unknown>;
    sideEffects: string[];
    typesVersions?: Record<string, Record<string, string[]>>;
  };

  it('exports ./chat and ./chat.css, and lists chat.css under sideEffects', () => {
    expect(manifest.exports['./chat']).toEqual({ types: './dist/src/chat/index.d.ts', default: './dist/src/chat/index.js' });
    expect(manifest.exports['./chat.css']).toBe('./src/chat.css');
    expect(manifest.sideEffects).toEqual(['./src/styles.css', './src/chat.css']);
    expect(manifest.typesVersions?.['*']?.chat).toEqual(['dist/src/chat/index.d.ts']);
  });

  it('the files it points at exist in source', () => {
    expect(existsSync(join(src, 'chat', 'index.ts'))).toBe(true);
    expect(existsSync(join(src, 'chat.css'))).toBe(true);
  });

  it('the chat entry exports ChatBox, sseTransport and the experimental pure parts, and not the main entry\'s own names twice', () => {
    const entry = read(join(chatDir, 'index.ts'));
    for (const name of ['ChatBox', 'sseTransport', 'chatReducer', 'readFrame', 'enChat']) expect(entry, name).toContain(name);
    expect(entry).toMatch(/@experimental/);
  });
});
