// @vitest-environment node
// Builds the site and scans what would ship: no third-party URLs, no word from the deny list, no lorem.
//
// The deny list is not written out here (the repo carries no real slur, anywhere). It is the English dataset of
// `obscenity`, the library @chatwarden/matcher is built on, run with its recommended transformers over every text file
// in dist. The only terms the site may mention are the invented ones from @chatwarden/matcher/fixtures.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { extname, join, relative } from 'node:path';
import {
  RegExpMatcher,
  englishDataset,
  englishRecommendedTransformers,
} from 'obscenity';
import { beforeAll, describe, expect, it } from 'vitest';
import { SYNTHETIC_TERMS } from '../../packages/matcher/src/fixtures/syntheticPack';

const siteDir = join(__dirname, '..');
const dist = join(siteDir, 'dist');
const VITE_BIN = join(siteDir, '..', 'node_modules', 'vite', 'bin', 'vite.js');

// The invented words (the matcher test's allow-list, plus the exception phrase's `glarn`).
const INVENTED = ['zorbak', 'vlemmo', 'quissel', 'drakkuun', 'fenrisk', 'tarvo', 'snerp', 'glarn'];

// Hosts the shipped site may name. Inert namespace identifiers that React and SVG put in strings are listed exactly.
const ALLOWED_HOSTS = new Set(['github.com', 'www.npmjs.com', 'npmjs.com', 'chatwarden.dev']);
const INERT_URLS = [
  /^https?:\/\/www\.w3\.org\/((XML\/)?\d{4}\/)[a-z0-9/]+$/i, // XML, SVG, MathML and XLink namespaces (never fetched)
  /^https:\/\/react\.dev\/errors\b/i, // the text of React's production error messages (never fetched)
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

beforeAll(() => {
  execFileSync(process.execPath, [VITE_BIN, 'build', '--logLevel', 'error'], {
    cwd: siteDir,
    stdio: 'inherit',
    env: { ...process.env, NODE_ENV: 'production' },
  });
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
    const refs = [...html.matchAll(/\s(?:src|href)="([^"]+)"/g)].map((m) => m[1] as string);
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
    const dataset = englishDataset.build();
    // Control: the deny set is really loaded, so an empty result means a clean dist and not an empty list.
    expect(dataset.blacklistedTerms.length).toBeGreaterThan(100);
    const matcher = new RegExpMatcher({ ...dataset, ...englishRecommendedTransformers });
    const hits: string[] = [];
    for (const [file, text] of texts) {
      if (isFontLicence(file)) continue;
      // A minified bundle is mostly code, which the matcher's look-alike folding would misread (`f(k`). Scan the
      // words a visitor could read instead: for scripts, every string literal; for everything else, the whole file.
      const readable = extname(file) === '.js' ? (text.match(STRING_LITERAL) ?? []).filter((l) => !/[{};]|=>|function/.test(l)).join('\n') : text;
      for (let i = 0; i < readable.length; i += 4000) {
        const chunk = readable.slice(i, i + 4000 + 40);
        for (const m of matcher.getAllMatches(chunk, true)) {
          hits.push(`${relative(dist, file)}: ${chunk.slice(m.startIndex, m.endIndex + 1)}`);
        }
      }
    }
    expect(hits).toEqual([]);
  });

  it('the invented-word allow-list is exactly the matcher fixtures pack, and the demo word ships', () => {
    // The real guard against a stray term is the obscenity scan above; this pins the allow-list to the fixtures.
    const fixtureTerms = SYNTHETIC_TERMS.map((t) => t.term).sort();
    expect(fixtureTerms).toEqual(INVENTED.filter((t) => t !== 'glarn').sort());
    const js = [...texts].filter(([f]) => f.endsWith('.js')).map(([, t]) => t).join('\n');
    expect(js).toMatch(/zorbak/i);
  });

  it('ships the favicon and keeps the initial JS small (under 120 KB gzip)', async () => {
    const { gzipSync } = await import('node:zlib');
    expect(existsSync(join(dist, 'favicon.svg'))).toBe(true);
    const js = files.filter((f) => f.endsWith('.js'));
    const gz = js.reduce((n, f) => n + gzipSync(readFileSync(f)).length, 0);
    expect(gz).toBeLessThan(120 * 1024);
  });
});
