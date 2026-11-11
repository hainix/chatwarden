// @vitest-environment node
// Builds the site and scans what would ship: no third-party URLs, no word from the deny list, no lorem.
//
// The deny list is not written out here (the repo carries no real slur, anywhere). It is the English dataset of
// `obscenity`, the library @chatwarden/matcher is built on, run with its recommended transformers over every text file
// in dist. The only terms the site may mention are the invented ones from @chatwarden/matcher/fixtures.
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { extname, join, relative, sep } from 'node:path';
import { RegExpMatcher, englishDataset, englishRecommendedTransformers } from 'obscenity';
import { beforeAll, describe, expect, it } from 'vitest';
import { datasetWords, scanForSlurs, wordSafeChunks } from './helpers/slurScan';
import { SYNTHETIC_TERMS } from '../../packages/matcher/src/fixtures/syntheticPack';

const siteDir = join(__dirname, '..');
const dist = join(siteDir, 'dist');

// The invented words (the matcher test's allow-list, plus the exception phrase's `glarn`).
const INVENTED = ['zorbak', 'vlemmo', 'quissel', 'drakkuun', 'fenrisk', 'tarvo', 'snerp', 'glarn'];

// Hosts the shipped site may name. Inert namespace identifiers that React and SVG put in strings are listed exactly.
const ALLOWED_HOSTS = new Set(['github.com', 'www.npmjs.com', 'npmjs.com', 'chatwarden.dev']);
const INERT_URLS = [
  /^https?:\/\/www\.w3\.org\/((XML\/)?\d{4}\/)[a-z0-9/]+$/i, // XML, SVG, MathML and XLink namespaces (never fetched)
  /^https?:\/\/www\.sitemaps\.org\/schemas\/sitemap\/[\d.]+$/i, // the sitemap XML namespace (never fetched)
  /^https:\/\/react\.dev\/errors\b/i, // the text of React's production error messages (never fetched)
  // The one-script-tag sample from the hub-element README, shown as TEXT in "Then add the moderator hub" (a code block, never a
  // <script>). test/browser.test.ts proves the page requests nothing from this host; only this exact address is let through.
  /^https:\/\/cdn\.jsdelivr\.net\/npm\/@chatwarden\/hub-element@\d+(?:\.\d+)*\/dist\/hub-element\.js$/,
];

// A quoted string of 3+ characters on one line. A backtick string only counts when it looks like prose (no code
// punctuation), because a minified bundle pairs backticks across code.
const STRING_LITERAL = /"(?:[^"\\\n]|\\.){3,}"|'(?:[^'\\\n]|\\.){3,}'|`[^`\\\n(){};=<>]{3,}`/g;

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}
const TEXT_EXT = new Set(['.html', '.js', '.css', '.svg', '.json', '.txt', '.webmanifest', '.xml']);
const isFontLicence = (p: string) => /fonts[\\/]OFL-.*\.txt$/.test(p);

let files: string[] = [];
let texts: Map<string, string>;

// dist/ is built once by test/globalBuild.ts before any test file runs.
beforeAll(() => {
  files = walk(dist);
  texts = new Map(files.filter((f) => TEXT_EXT.has(extname(f))).map((f) => [f, readFileSync(f, 'utf8')]));
});

describe('built dist', () => {
  it('exists with an index.html and self-hosted fonts', () => {
    expect(existsSync(join(dist, 'index.html'))).toBe(true);
    expect(files.some((f) => f.endsWith('.woff2'))).toBe(true);
  });

  it('references no third-party host (only github.com, npmjs.com, chatwarden.dev)', () => {
    const bad: string[] = [];
    for (const [file, text] of texts) {
      if (isFontLicence(file)) continue; // the OFL text cites its own home page; it is a licence file, not a page
      for (const m of text.matchAll(/(?:https?:)?\/\/[a-z0-9][a-z0-9.-]*\.[a-z]{2,}[^\s"'`)<>\\]*/gi)) {
        const url = m[0];
        if (INERT_URLS.some((re) => re.test(url))) continue;
        let host: string;
        try {
          host = new URL(url.startsWith('//') ? `https:${url}` : url).hostname;
        } catch {
          continue;
        }
        if (!ALLOWED_HOSTS.has(host)) bad.push(`${relative(dist, file)}: ${url}`);
      }
    }
    expect(bad).toEqual([]);
  });

  it('loads no script, stylesheet, font, image or frame from another origin', () => {
    const html = texts.get(join(dist, 'index.html')) ?? '';
    // The canonical link is an identifier for crawlers, not a load; every other src/href must be same-origin.
    // Links a visitor may follow (the <a> in the no-JavaScript fallback) load nothing; the host test above limits where they point.
    const withoutCanonical = html.replace(/<link\s+rel="canonical"[^>]*>/, '').replace(/<a\s[^>]*>/g, '');
    const refs = [...withoutCanonical.matchAll(/\s(?:src|href)="([^"]+)"/g)].map((m) => m[1] as string);
    expect(refs.length).toBeGreaterThan(0);
    for (const r of refs) expect(r.startsWith('/') && !r.startsWith('//'), r).toBe(true);
    const css = [...texts].filter(([f]) => f.endsWith('.css')).map(([, t]) => t).join('\n');
    for (const m of css.matchAll(/url\(([^)]+)\)/g)) {
      const u = (m[1] as string).replace(/["']/g, '');
      expect(/^(https?:)?\/\//.test(u), u).toBe(false);
    }
  });

  it('has no analytics, tracker or beacon code', () => {
    for (const [file, text] of texts) {
      if (isFontLicence(file)) continue;
      expect(text, file).not.toMatch(/google-analytics|googletagmanager|gtag\(|plausible|segment\.com|mixpanel|hotjar|sendBeacon/i);
    }
  });

  it('has no lorem ipsum', () => {
    for (const [file, text] of texts) expect(text.toLowerCase(), file).not.toMatch(/lorem ipsum|dolor sit amet/);
  });

  it('mentions no word from the obscenity English deny set', () => {
    // Control: the deny set is really loaded, so an empty result means a clean dist and not an empty list.
    expect(englishDataset.build().blacklistedTerms.length).toBeGreaterThan(100);
    const hits: string[] = [];
    for (const [file, text] of texts) {
      if (isFontLicence(file)) continue;
      // A minified bundle is mostly code, which the matcher's look-alike folding would misread (`f(k`). Scan the
      // words a visitor could read instead: for scripts, every string literal; for everything else, the whole file.
      const readable = extname(file) === '.js' ? (text.match(STRING_LITERAL) ?? []).filter((l) => !/[{};]|=>|function/.test(l)).join('\n') : text;
      for (const hit of scanForSlurs(readable)) hits.push(`${relative(dist, file)}: ${hit}`);
    }
    expect(hits).toEqual([]);
  });

  it('the scan reads whole tokens: "document" is not flagged where a fixed window would cut it (control)', () => {
    // 3998 characters of harmless words, then "document.body" starting at index 3998: a window that restarts at 4000 begins
    // inside the word ("cument") and the matcher reads a slur in it.
    const text = `${'ab '.repeat(1332)}a document.body is fine`;
    expect(text.indexOf('document')).toBe(3998);
    const naive = new RegExpMatcher({ ...englishDataset.build(), ...englishRecommendedTransformers });
    expect(naive.getAllMatches(text.slice(4000, 4040), true).length, 'the fixed window false-positive is real').toBeGreaterThan(0);
    expect(scanForSlurs(text)).toEqual([]);
    expect(wordSafeChunks(text).join('')).toBe(text); // nothing lost, nothing repeated
    expect(wordSafeChunks(text).every((c, i, all) => i === all.length - 1 || /\s$/.test(c) || /^\s/.test(all[i + 1] ?? ''))).toBe(true); // cut only at whitespace
  });
  it('the scan still catches a real deny-set word, wherever it falls (control)', () => {
    // The word comes from obscenity's own file at run time: no real slur is written in this repo.
    const sample = datasetWords().find((w) => w.length >= 6) as string;
    expect(sample).toBeDefined();
    for (const pad of [0, 3990, 3998, 4000, 4010]) {
      expect(scanForSlurs(`${'ab '.repeat(2000).slice(0, pad)} ${sample} tail`).length, `pad ${pad}`).toBeGreaterThan(0);
    }
  });

  it('the invented-word allow-list is exactly the matcher fixtures pack, and the demo word ships', () => {
    // The real guard against a stray term is the obscenity scan above; this pins the allow-list to the fixtures.
    const fixtureTerms = SYNTHETIC_TERMS.map((t) => t.term).sort();
    expect(fixtureTerms).toEqual(INVENTED.filter((t) => t !== 'glarn').sort());
    const js = [...texts].filter(([f]) => f.endsWith('.js')).map(([, t]) => t).join('\n');
    expect(js).toMatch(/zorbak/i);
  });

  // ---- Budgets (gzip). The page's first load, and the demo chunk that only loads when the demo section nears the viewport. ----
  //
  // First load (index.html + its JS + its CSS), measured on the production build:
  //   before the real hub (BASE f89abd0):  JS 79.3 KB, CSS 5.9 KB
  //   now:                                 JS 80.0 KB, CSS 6.0 KB
  // The +0.6 KB JS and +0.1 KB CSS are the page's own new words (the hub card, "Then add the moderator hub" with its two README
  // snippets, the npm links); the hub, the player components and their styles are NOT in it. Budgets leave about 2 KB of room for
  // copy edits, so a dependency that creeps into the first load fails here. (The old ceiling for JS alone was 120 KB.)
  const FIRST_LOAD_JS_GZ = 82 * 1024;
  const FIRST_LOAD_CSS_GZ = 7 * 1024;
  // The demo chunk: the real kit (core, the matcher with its synthetic pack, the in-memory store) AND now the real hub
  // (@chatwarden/hub-react), the staff routes it runs over (@chatwarden/http/admin) and the player components
  // (@chatwarden/player-react), with their stylesheets. Measured: JS 177.5 KB (600 KB raw), CSS 14.8 KB (105 KB raw); it was JS 77.6
  // KB and CSS 5.0 KB with the hand-built console. The hub alone is most of the growth (its own README budgets it at about 140 KB
  // gzip with React). React itself stays in the first-load chunk, shared. Budgets leave about 7% room.
  const DEMO_JS_GZ = 190 * 1024;
  const DEMO_CSS_GZ = 16 * 1024;

  const STAFF_AND_CLIENT_MARKERS = ['GET /changes', 'POST /cases/next', 'POST /reports/:id/decide', 'GET /policy/profile', 'POST /terms/check', '/cases/:ref/claim', 'HubError', 'createHubClient'];

  const gzipSize = async (file: string) => (await import('node:zlib')).gzipSync(readFileSync(file)).length;

  it('ships the favicon and keeps the first load small: JS under 82 KB gzip, CSS under 7 KB gzip', async () => {
    expect(existsSync(join(dist, 'favicon.svg'))).toBe(true);
    const html = texts.get(join(dist, 'index.html')) ?? '';
    // What the page loads up front: every script, preload and stylesheet index.html names. The lazy demo chunk is not among them.
    const refs = [...html.matchAll(/<(?:script|link)[^>]+(?:src|href)="(\/assets\/[^"]+\.(?:js|css))"/g)].map((m) => join(dist, (m[1] as string).slice(1)));
    const js = refs.filter((f) => f.endsWith('.js'));
    const css = refs.filter((f) => f.endsWith('.css'));
    expect(js.length).toBeGreaterThan(0);
    expect(css.length).toBeGreaterThan(0);
    const jsGz = (await Promise.all(js.map(gzipSize))).reduce((n, v) => n + v, 0);
    const cssGz = (await Promise.all(css.map(gzipSize))).reduce((n, v) => n + v, 0);
    expect(jsGz, `first-load JS is ${(jsGz / 1024).toFixed(1)} KB gzip`).toBeLessThan(FIRST_LOAD_JS_GZ);
    expect(cssGz, `first-load CSS is ${(cssGz / 1024).toFixed(1)} KB gzip`).toBeLessThan(FIRST_LOAD_CSS_GZ);
    // and none of the hub, the player components or the staff routes is in it
    for (const f of js) {
      const text = readFileSync(f, 'utf8');
      expect(text, relative(dist, f)).not.toMatch(/chatwarden\.hub\.mode|cw-hub|cw-player|\/reports\/:id|LADDER_TABLE/);
      // markers only the staff routes (`@chatwarden/http/admin`) and the hub client carry, so a leak of the same size is still caught
      for (const marker of STAFF_AND_CLIENT_MARKERS) expect(text, `${relative(dist, f)} has ${marker}`).not.toContain(marker);
    }
  });

  it('the staff-route and hub-client markers are real: every one is in the demo chunk (so the first-load check above can fail)', () => {
    const demo = files.filter((f) => /Demo-[\w-]+\.js$/.test(f));
    expect(demo).toHaveLength(1);
    const text = texts.get(demo[0] as string) ?? '';
    for (const marker of STAFF_AND_CLIENT_MARKERS) expect(text, marker).toContain(marker);
  });

  it('code-splits the demo: its own JS and CSS, not named by index.html, within the demo budget', async () => {
    const html = texts.get(join(dist, 'index.html')) ?? '';
    const demo = files.filter((f) => /Demo-[\w-]+\.js$/.test(f));
    const demoCss = files.filter((f) => /Demo-[\w-]+\.css$/.test(f));
    expect(demo).toHaveLength(1);
    expect(demoCss).toHaveLength(1);
    for (const f of [...demo, ...demoCss]) expect(html).not.toContain(relative(dist, f).split(sep).join('/'));
    const jsGz = await gzipSize(demo[0] as string);
    const cssGz = await gzipSize(demoCss[0] as string);
    expect(jsGz, `demo JS is ${(jsGz / 1024).toFixed(1)} KB gzip`).toBeLessThan(DEMO_JS_GZ);
    expect(cssGz, `demo CSS is ${(cssGz / 1024).toFixed(1)} KB gzip`).toBeLessThan(DEMO_CSS_GZ);
    // the hub and the player are in the demo chunk, with their stylesheets
    expect(texts.get(demo[0] as string) ?? '').toMatch(/chatwarden\.hub\.mode/);
    const css = texts.get(demoCss[0] as string) ?? '';
    expect(css).toContain('.cw-hub');
    expect(css).toContain('.cw-player');
    const initialCss = texts.get(files.find((f) => /index-[\w-]+\.css$/.test(f)) ?? '') ?? '';
    expect(initialCss).not.toContain('.tour'); // the demo's styles ship with the demo chunk
    expect(initialCss).not.toContain('.cw-hub');
  });

  it('no font of the hub ships: the site keeps its own two fonts (hub-react font.css is not loaded)', () => {
    const woff = files.filter((f) => f.endsWith('.woff2')).map((f) => f.toLowerCase());
    expect(woff.some((f) => f.includes('instrument'))).toBe(false);
    expect(woff).toHaveLength(2);
  });

  it('the demo chunk is the real kit and runs in a browser: no node: import, no eval, no wasm, no network call', () => {
    const demo = files.filter((f) => /Demo-[\w-]+\.js$/.test(f));
    expect(demo).toHaveLength(1);
    const text = texts.get(demo[0] as string) ?? '';
    // The kit looks up node:crypto at run time through a guarded `process.getBuiltinModule?.(...)` (a string, never an import),
    // and falls back to its own pure-JS hashing in a browser. Take that one guarded lookup out, and no node: is left.
    const leftover = text.replaceAll(/\?\.getBuiltinModule\?\.\(\s*[`"']node:crypto[`"']\s*\)/g, '');
    expect(leftover).not.toContain('node:');
    expect(text).not.toMatch(/\b(?:from|import)\s*\(?\s*["'`]node:/);
    expect(text).not.toMatch(/\brequire\s*\(/);
    // The Content-Security-Policy allows no 'unsafe-eval' and no 'wasm-unsafe-eval': the kit must need neither.
    expect(text).not.toMatch(/\beval\s*\(|new\s+Function\s*\(|\bWebAssembly\b/);
    expect(text).not.toMatch(/\bfetch\s*\(|XMLHttpRequest|WebSocket|sendBeacon/);
    // and it really is the kit: the matcher's pack term id and a core string are in there
    expect(text).toMatch(/syn:zorbak/);
    expect(text).toMatch(/chatwarden\./);
  });
  it('the guarded lookup is the only way the scan above can pass: a real node: import would be caught (control)', () => {
    const bad = 'import{createHash}from"node:crypto";';
    expect(bad.replaceAll(/\?\.getBuiltinModule\?\.\(\s*[`"']node:crypto[`"']\s*\)/g, '')).toContain('node:');
    expect(bad).toMatch(/\b(?:from|import)\s*\(?\s*["'`]node:/);
  });
});
