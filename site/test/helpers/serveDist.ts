// A tiny static server for dist/ that applies the `_headers` file the way Cloudflare Pages does, so a test can load the
// built page under the real Content-Security-Policy.
import { createServer, type Server } from 'node:http';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import type { AddressInfo } from 'node:net';

export const SITE_DIR = join(__dirname, '..', '..');
export const DIST = join(SITE_DIR, 'dist');

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml',
  '.json': 'application/json',
};

export interface HeaderRule {
  pattern: string;
  headers: Record<string, string>;
}

/** Parses the Cloudflare Pages `_headers` format: a path pattern line, then indented `Name: value` lines. */
export function parseHeaders(text: string): HeaderRule[] {
  const rules: HeaderRule[] = [];
  let cur: HeaderRule | null = null;
  for (const raw of text.split(/\r?\n/)) {
    if (!raw.trim() || raw.trim().startsWith('#')) continue;
    if (/^\s/.test(raw)) {
      const i = raw.indexOf(':');
      if (cur && i > 0) cur.headers[raw.slice(0, i).trim()] = raw.slice(i + 1).trim();
    } else {
      cur = { pattern: raw.trim(), headers: {} };
      rules.push(cur);
    }
  }
  return rules;
}

/** Pages patterns: `*` matches anything (including slashes); everything else is literal. */
function matches(pattern: string, path: string): boolean {
  const literal = pattern.split('*').map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&'));
  return new RegExp(`^${literal.join('.*')}$`).test(path);
}

export function headersFor(rules: HeaderRule[], path: string): Record<string, string> {
  const out: Record<string, string> = {};
  // Cloudflare joins a header that more than one matching rule sets, with ", ".
  for (const r of rules) {
    if (!matches(r.pattern, path)) continue;
    for (const [k, v] of Object.entries(r.headers)) out[k] = out[k] === undefined ? v : `${out[k]}, ${v}`;
  }
  return out;
}

export async function serveDist(): Promise<{ url: string; close: () => Promise<void>; requests: string[] }> {
  const headersFile = join(DIST, '_headers');
  const rules = existsSync(headersFile) ? parseHeaders(readFileSync(headersFile, 'utf8')) : [];
  const requests: string[] = [];
  const server: Server = createServer((req, res) => {
    const path = decodeURIComponent((req.url ?? '/').split('?')[0] ?? '/');
    requests.push(path);
    const file = normalize(join(DIST, path === '/' ? 'index.html' : path));
    if (!file.startsWith(DIST) || !existsSync(file) || statSync(file).isDirectory()) {
      res.writeHead(404, { 'content-type': 'text/plain' }).end('not found');
      return;
    }
    res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream', ...headersFor(rules, path) });
    res.end(readFileSync(file));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/`,
    requests,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
