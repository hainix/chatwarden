// @vitest-environment node
import { gzipSync } from 'node:zlib';
import { beforeAll, describe, expect, it } from 'vitest';
// @ts-expect-error plain ESM build script with JSDoc types; the package tsconfig does not cover build/
import { bundle } from '../build/build.mjs';

// The two scripts the package ships, built the way `npm run build` builds them, in memory. The budget is on the self-contained
// script, minified and gzipped.
//
// Why this much: the script bundles React and react-dom so a page needs nothing else (no import map, no bundler, no peer to install).
// Measured on 2026-11-10: 639,750 bytes minified, about 175 KB gzipped (148 KB brotli). Of the raw bytes, hub-react is about 290 KB,
// react-dom and react about 220 KB, the hub's stylesheet about 100 KB and the part of core the hub uses about 20 KB. A team that already ships React should use
// @chatwarden/hub-react and pay for the hub alone. The budgets are the measured size plus about 6%; raising one is a decision.

const BUDGET_GZIP = 185 * 1024;
const BUDGET_RAW = 660 * 1024;

interface Built {
  standalone: { text: string; bytes: number; gzip: number };
  module: { text: string; bytes: number; gzip: number };
}

let built: Built;
beforeAll(async () => {
  const { standalone, module } = (await bundle()) as { standalone: Uint8Array; module: Uint8Array };
  const describeOne = (bytes: Uint8Array) => ({ text: Buffer.from(bytes).toString('utf8'), bytes: bytes.byteLength, gzip: gzipSync(bytes, { level: 9 }).byteLength });
  built = { standalone: describeOne(standalone), module: describeOne(module) };
  console.log(`hub-element standalone: ${built.standalone.bytes} bytes minified, ${built.standalone.gzip} bytes gzipped (budget ${BUDGET_GZIP} gzip, ${BUDGET_RAW} raw)`);
  console.log(`hub-element module:     ${built.module.bytes} bytes minified, ${built.module.gzip} bytes gzipped`);
}, 120_000);

describe('bundle size', () => {
  it('the self-contained script is under its gzip and raw budgets', () => {
    expect(built.standalone.gzip).toBeLessThan(BUDGET_GZIP);
    expect(built.standalone.bytes).toBeLessThan(BUDGET_RAW);
    // Not suspiciously small either: React, react-dom and the hub are really in there.
    expect(built.standalone.gzip).toBeGreaterThan(100 * 1024);
  });

  it('the module for bundlers is the same bundle without the registration, so about the same size', () => {
    expect(Math.abs(built.module.bytes - built.standalone.bytes)).toBeLessThan(2 * 1024);
    expect(built.module.gzip).toBeLessThan(BUDGET_GZIP);
  });
});

describe('what is in the scripts', () => {
  it.each(['standalone', 'module'] as const)('%s: imports nothing (it is self-contained), uses no Node builtin, no eval', (name) => {
    const { text } = built[name];
    expect(text).not.toMatch(/\bimport\b[^;"']*?\bfrom\s*["']/);
    expect(text).not.toMatch(/\bimport\s*["'][^"']+["']/);
    expect(text).not.toMatch(/\brequire\(\s*["']/);
    expect(text).not.toMatch(/["']node:[a-z]/);
    expect(text).not.toMatch(/\beval\(|new Function\(/);
  });

  it.each(['standalone', 'module'] as const)('%s: React is bundled, in its production build', (name) => {
    const { text } = built[name];
    expect(text).toContain('react.transitional.element');
    // The development build warns in prose; the production build does not carry that text.
    expect(text).not.toContain('Warning: ReactDOM.render');
    expect(text).not.toContain('Download the React DevTools');
  });

  it.each(['standalone', 'module'] as const)('%s: the hub CSS is inlined as a string, with the tokens on :host', (name) => {
    const { text } = built[name];
    expect(text).toContain('.cw-hub');
    expect(text).toContain(':host');
    expect(text).toContain('--cw-accent');
  });

  it('only the standalone registers the element', () => {
    expect(built.standalone.text).toMatch(/customElements\.define\(/);
    // The module has the define call inside defineChatwardenHub, which it never runs on load: the standalone is the same code
    // plus one call. Their difference is the point: the standalone is longer by that call.
    expect(built.standalone.bytes).toBeGreaterThanOrEqual(built.module.bytes);
  });
});
