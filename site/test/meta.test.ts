// @vitest-environment node
// Meta, SEO, icons, crawler files and the Cloudflare Pages headers: what makes the built page shareable and deployable.
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { headersFor, parseHeaders } from './helpers/serveDist';

const site = join(__dirname, '..');
const repo = join(site, '..');
const dist = join(site, 'dist');
const read = (p: string) => readFileSync(join(dist, p), 'utf8');
const html = () => read('index.html');

/** The content of `<meta name|property=key content="...">`, or null. */
function meta(key: string): string | null {
  for (const m of html().matchAll(/<meta\s+([^>]*?)\/?>/g)) {
    const attrs = m[1] as string;
    const k = /(?:name|property)="([^"]+)"/.exec(attrs)?.[1];
    if (k === key) return /content="([^"]*)"/.exec(attrs)?.[1] ?? null;
  }
  return null;
}
function pngSize(path: string): { w: number; h: number } {
  const b = readFileSync(path);
  expect(b.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a'); // a real PNG
  return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) };
}

describe('document head', () => {
  it('has a title and a description of a sensible length', () => {
    expect(/<title>([^<]+)<\/title>/.exec(html())?.[1]).toMatch(/chatwarden/i);
    const d = meta('description') ?? '';
    expect(d.length).toBeGreaterThan(70);
    expect(d.length).toBeLessThanOrEqual(200);
  });
  it('has the canonical URL', () => {
    expect(html()).toMatch(/<link\s+rel="canonical"\s+href="https:\/\/chatwarden\.dev\/"\s*\/?>/);
  });
  it('has Open Graph tags with an absolute 1200x630 image and alt text', () => {
    expect(meta('og:type')).toBe('website');
    expect(meta('og:url')).toBe('https://chatwarden.dev/');
    expect(meta('og:site_name')).toBe('Chatwarden');
    expect(meta('og:title')).toMatch(/chatwarden/i);
    expect(meta('og:description')?.length).toBeGreaterThan(40);
    expect(meta('og:image')).toBe('https://chatwarden.dev/og.png');
    expect(meta('og:image:width')).toBe('1200');
    expect(meta('og:image:height')).toBe('630');
    expect(meta('og:image:alt')?.length).toBeGreaterThan(10);
  });
  it('has Twitter card tags', () => {
    expect(meta('twitter:card')).toBe('summary_large_image');
    expect(meta('twitter:title')).toMatch(/chatwarden/i);
    expect(meta('twitter:description')?.length).toBeGreaterThan(40);
    expect(meta('twitter:image')).toBe('https://chatwarden.dev/og.png');
    expect(meta('twitter:image:alt')?.length).toBeGreaterThan(10);
  });
  it('keeps the viewport, colour-scheme and theme-color tags', () => {
    expect(meta('viewport')).toContain('width=device-width');
    expect(meta('color-scheme')).toBe('dark light');
    expect(meta('theme-color')).toMatch(/^#[0-9a-f]{6}$/i);
  });
  it('links the SVG favicon, a PNG fallback and the apple-touch-icon, and they exist', () => {
    expect(html()).toMatch(/rel="icon"[^>]*type="image\/svg\+xml"[^>]*href="\/favicon\.svg"/);
    expect(html()).toMatch(/rel="icon"[^>]*type="image\/png"[^>]*href="\/favicon-32\.png"/);
    expect(html()).toMatch(/rel="apple-touch-icon"[^>]*href="\/apple-touch-icon\.png"/);
    expect(pngSize(join(dist, 'favicon-32.png'))).toEqual({ w: 32, h: 32 });
    expect(pngSize(join(dist, 'apple-touch-icon.png'))).toEqual({ w: 180, h: 180 });
    expect(read('favicon.svg')).toContain('<svg');
  });
  it('preloads the display font (crossorigin, as font)', () => {
    expect(html()).toMatch(/<link[^>]*rel="preload"[^>]*href="\/assets\/bungee-[^"]+\.woff2"[^>]*as="font"[^>]*type="font\/woff2"[^>]*crossorigin/);
  });
  it('also preloads the body font at its hashed path, so body text does not swap late', () => {
    expect(html()).toMatch(/<link[^>]*rel="preload"[^>]*href="\/assets\/atkinson-hyperlegible-next-latin-wght-normal-[^"]+\.woff2"[^>]*as="font"[^>]*type="font\/woff2"[^>]*crossorigin/);
  });
  it('every font preload names a file that exists in dist (a stale hash would 404 and waste the preload)', () => {
    const hrefs = [...html().matchAll(/<link[^>]*rel="preload"[^>]*href="([^"]+)"/g)].map((m) => m[1] as string);
    expect(hrefs.length).toBe(2);
    for (const h of hrefs) expect(existsSync(join(dist, h.slice(1))), h).toBe(true);
  });
  it('has no inline script: the theme bootstrap is a same-origin file', () => {
    const inline = [...html().matchAll(/<script(?![^>]*\ssrc=)[^>]*>([\s\S]*?)<\/script>/g)];
    expect(inline).toEqual([]);
    expect(html()).toMatch(/<script[^>]*\ssrc="\/theme-init\.js"/);
    expect(read('theme-init.js')).toContain('cw-theme');
  });
  it('has no inline style attribute or style element (the CSP forbids both)', () => {
    expect(html()).not.toMatch(/\sstyle="/);
    expect(html()).not.toMatch(/<style[\s>]/);
  });
});

describe('the OG image', () => {
  it('exists and is exactly 1200x630', () => {
    expect(pngSize(join(dist, 'og.png'))).toEqual({ w: 1200, h: 630 });
  });
  it('is a real render (not a blank or tiny file)', () => {
    expect(readFileSync(join(dist, 'og.png')).length).toBeGreaterThan(15_000);
  });
  it('is committed under public/ with its SVG source, so a plain vite build ships it', () => {
    expect(existsSync(join(site, 'public', 'og.png'))).toBe(true);
    expect(existsSync(join(site, 'scripts', 'og.svg'))).toBe(true);
  });
});

describe('crawler files', () => {
  it('robots.txt allows everything and names the sitemap', () => {
    const r = read('robots.txt');
    expect(r).toMatch(/User-agent: \*/);
    expect(r).not.toMatch(/Disallow: \/\s*$/m);
    expect(r).toContain('Sitemap: https://chatwarden.dev/sitemap.xml');
  });
  it('sitemap.xml lists the home page with the canonical URL', () => {
    const s = read('sitemap.xml');
    expect(s).toContain('<urlset');
    expect(s).toContain('<loc>https://chatwarden.dev/</loc>');
  });
  it('has no security.txt (there is no real contact to put in it)', () => {
    expect(existsSync(join(dist, '.well-known', 'security.txt'))).toBe(false);
  });
});

describe('llms.txt', () => {
  const txt = () => read('llms.txt');
  const urls = () => [...txt().matchAll(/https?:\/\/[^\s)>\]]+/g)].map((m) => m[0].replace(/[.,]$/, ''));
  it('starts with the project name and a one-line summary, then lists links with descriptions', () => {
    expect(txt()).toMatch(/^# Chatwarden\n/);
    expect(txt()).toMatch(/^> .{20,}/m);
    const linkLines = txt().split('\n').filter((l) => /^- \[[^\]]+\]\(https?:\/\//.test(l));
    expect(linkLines.length).toBeGreaterThanOrEqual(8);
    for (const l of linkLines) expect(l, l).toMatch(/\): .{10,}/); // every link has a one-line description
  });
  it('points at the repo README and every package README on GitHub', () => {
    const u = urls();
    expect(u).toContain('https://github.com/hainix/chatwarden/blob/main/README.md');
    for (const p of readdirSync(join(repo, 'packages'))) {
      expect(u, p).toContain(`https://github.com/hainix/chatwarden/blob/main/packages/${p}/README.md`);
    }
  });
  it('every GitHub link resolves to a real path in this repo', () => {
    const gh = urls().filter((x) => x.startsWith('https://github.com/hainix/chatwarden/'));
    expect(gh.length).toBeGreaterThan(5);
    for (const g of gh) {
      const m = /^https:\/\/github\.com\/hainix\/chatwarden\/(?:blob|tree)\/main\/(.+)$/.exec(g);
      if (!m) continue; // the bare repo URL and /issues are fine
      expect(existsSync(join(repo, m[1] as string)), g).toBe(true);
    }
  });
  it('every npm link names a published (non-private) package that exists in packages/', () => {
    const npm = urls().filter((x) => x.includes('npmjs.com'));
    expect(npm.length).toBeGreaterThanOrEqual(6);
    for (const n of npm) {
      const name = /^https:\/\/www\.npmjs\.com\/package\/(@chatwarden\/[a-z-]+)$/.exec(n)?.[1];
      expect(name, n).toBeTruthy();
      const dir = (name as string).split('/')[1] as string;
      const pkg = JSON.parse(readFileSync(join(repo, 'packages', dir, 'package.json'), 'utf8')) as { name: string; private?: boolean };
      expect(pkg.name).toBe(name);
      expect(pkg.private).not.toBe(true);
    }
  });
  it('lists the hub, player and element packages, with a README link and an npm link each', () => {
    const u = urls();
    for (const p of ['hub-react', 'player-react', 'hub-element']) {
      expect(u, p).toContain(`https://github.com/hainix/chatwarden/blob/main/packages/${p}/README.md`);
      expect(u, p).toContain(`https://www.npmjs.com/package/@chatwarden/${p}`);
    }
    expect(txt()).toMatch(/<chatwarden-hub>/);
  });
  it('is honest: pre-release, and no promises the site would not make', () => {
    expect(txt()).toMatch(/pre-release/i);
    expect(txt()).not.toMatch(/guarantee|enterprise|used by thousands/i);
  });
});

describe('_headers (Cloudflare Pages)', () => {
  const rules = () => parseHeaders(read('_headers'));
  const all = () => headersFor(rules(), '/');
  it('ships in dist', () => {
    expect(existsSync(join(dist, '_headers'))).toBe(true);
  });
  it('has a strict Content-Security-Policy: default-src self, no inline script, no unsafe-*', () => {
    const csp = all()['Content-Security-Policy'] ?? '';
    expect(csp).toContain("default-src 'self'");
    expect(csp).toMatch(/script-src 'self'(;|$)/);
    expect(csp).toMatch(/style-src 'self'(;|$)/);
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("base-uri 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).not.toMatch(/unsafe-inline|unsafe-eval|\*|http:/);
  });
  it('sets nosniff, a referrer policy and a permissions policy on every page', () => {
    expect(all()['X-Content-Type-Options']).toBe('nosniff');
    expect(all()['Referrer-Policy']).toBe('strict-origin-when-cross-origin');
    const pp = all()['Permissions-Policy'] ?? '';
    for (const f of ['camera=()', 'microphone=()', 'geolocation=()']) expect(pp).toContain(f);
  });
  it('caches hashed assets and fonts as immutable for a year', () => {
    for (const p of ['/assets/index-abc123.js', '/assets/Demo-abc123.css']) {
      const cc = headersFor(rules(), p)['Cache-Control'] ?? '';
      expect(cc, p).toMatch(/max-age=31536000/);
      expect(cc, p).toContain('immutable');
    }
  });
  it('revalidates the HTML and the unhashed files (never immutable)', () => {
    for (const p of ['/', '/index.html', '/theme-init.js', '/og.png', '/favicon.svg', '/llms.txt']) {
      const cc = headersFor(rules(), p)['Cache-Control'] ?? '';
      expect(cc, p).not.toContain('immutable');
    }
    // No rule sets Cache-Control for them, so Pages' default (max-age=0, must-revalidate) applies.
    expect(headersFor(rules(), '/')['Cache-Control']).toBeUndefined();
  });
  it('no header is set by two overlapping rules (Cloudflare would join the values)', () => {
    for (const path of ['/', '/index.html', '/assets/index-abc123.js', '/og.png']) {
      for (const [k, v] of Object.entries(headersFor(rules(), path))) {
        if (k === 'Cache-Control') expect(v, path).not.toContain(', public');
        expect(v.split(', ').length, `${k} at ${path}`).toBeLessThanOrEqual(k === 'Content-Security-Policy' || k === 'Permissions-Policy' ? 99 : 4);
      }
    }
    const cc = headersFor(rules(), '/assets/index-abc123.js')['Cache-Control'];
    expect(cc).toBe('public, max-age=31536000, immutable');
  });
  it('every hashed file in dist/assets is covered by the immutable rule', () => {
    for (const f of readdirSync(join(dist, 'assets'))) {
      expect(headersFor(rules(), `/assets/${f}`)['Cache-Control'], f).toContain('immutable');
    }
  });
});
