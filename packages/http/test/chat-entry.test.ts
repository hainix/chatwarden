import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import * as root from '../src/index.js';
import * as entry from '../src/chat/index.js';
import * as aliased from '@chatwarden/http/chat';

// `@chatwarden/http/chat` is the entry a browser bundles for the chat box: the broadcaster, the routes, the wire types and encoding, and
// nothing that imports a Node builtin.

const here = dirname(fileURLToPath(import.meta.url));
const SRC = join(here, '..', 'src');
const PKG = JSON.parse(readFileSync(join(here, '..', 'package.json'), 'utf8')) as {
  exports: Record<string, { types: string; default: string }>;
  typesVersions: { '*': Record<string, string[]> };
  files: string[];
};

/** Every file the entry reaches through relative imports and re-exports (type-only ones included: they ride along in a .d.ts). */
function reach(start: string): Map<string, string> {
  const seen = new Map<string, string>();
  const queue = [start];
  while (queue.length > 0) {
    const file = queue.pop() as string;
    if (seen.has(file)) continue;
    const text = readFileSync(file, 'utf8');
    seen.set(file, text);
    for (const m of text.matchAll(/(?:from|import)\s*\(?\s*['"](\.[^'"]+)['"]/g)) {
      queue.push(join(dirname(file), (m[1] as string).replace(/\.js$/, '.ts')));
    }
  }
  return seen;
}

const DOCUMENTED = [
  'createRoomBroadcaster',
  'ROOM_BROADCASTER_DEFAULTS',
  'chatRoutes',
  'encodeFrame',
  'HEARTBEAT',
  'CHAT_WIRE_VERSION',
  'refusalOf',
];

describe('@chatwarden/http/chat', () => {
  it('exports the documented names', () => {
    for (const name of DOCUMENTED) expect(name in entry, name).toBe(true);
    expect(typeof entry.createRoomBroadcaster).toBe('function');
    expect(typeof entry.chatRoutes).toBe('function');
    expect(entry.CHAT_WIRE_VERSION).toBe(1);
    expect(entry.HEARTBEAT).toBe(': ping\n\n');
  });

  it('exports only those names (the surface is small on purpose)', () => {
    expect(Object.keys(entry).sort()).toEqual([...DOCUMENTED].sort());
  });

  it('the root re-exports the same bindings, not copies', () => {
    for (const name of Object.keys(entry) as Array<keyof typeof entry>) {
      expect((root as Record<string, unknown>)[name], name).toBe(entry[name]);
    }
  });

  it('the alias a consumer uses resolves to the entry', () => {
    for (const name of Object.keys(entry) as Array<keyof typeof entry>) expect((aliased as Record<string, unknown>)[name], name).toBe(entry[name]);
  });

  it('exports nothing from the Node side of the package', () => {
    for (const name of ['playerRoutes', 'toExpress', 'webhookIn', 'webhooksOut', 'sign', 'verify', 'healthRoutes', 'Limiter', 'adminRoutes']) {
      expect(name in entry, name).toBe(false);
    }
  });

  it('the entry imports no node: module, no Buffer and no process', () => {
    const files = reach(join(SRC, 'chat', 'index.ts'));
    for (const [file, text] of files) {
      const code = text.replaceAll(/\/\*[\s\S]*?\*\//g, '').replaceAll(/^\s*\/\/.*$/gm, '');
      expect(code, file).not.toMatch(/['"]node:/);
      expect(code, file).not.toMatch(/\bBuffer\b/);
      expect(code, file).not.toMatch(/\bprocess\./);
      expect(code, file).not.toMatch(/\bfrom\s+['"](?:crypto|fs|path|http|https|stream|util|os|events)['"]/);
      expect(code, file).not.toMatch(/\bfetch\s*\(/);
    }
    // and it does not reach the Node-side modules of the package
    const names = [...files.keys()].map((f) => f.split(String.fromCharCode(92)).join('/').split('/src/')[1] as string);
    for (const nodeSide of ['index.ts', 'player.ts', 'express.ts', 'health.ts', 'webhooks/in.ts', 'webhooks/out.ts', 'webhooks/sign.ts', 'admin-entry.ts']) {
      expect(names, nodeSide).not.toContain(nodeSide);
    }
    expect(names).toContain('limiter.ts');
    expect(names).toContain('chat/routes.ts');
  });

  it('is a subpath of the package, with types for both resolution modes', () => {
    expect(PKG.exports['./chat']).toEqual({ types: './dist/src/chat/index.d.ts', default: './dist/src/chat/index.js' });
    expect(PKG.typesVersions['*'].chat).toEqual(['dist/src/chat/index.d.ts']);
    expect(PKG.files).toContain('dist/src');
    // the existing subpaths are untouched
    expect(Object.keys(PKG.exports)).toEqual(['.', './admin', './chat', './express']);
  });
});
