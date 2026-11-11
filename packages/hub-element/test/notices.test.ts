// @vitest-environment node
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// React and react-dom are MIT code inside the bundles, so the bundles must keep Meta's licence banners and the tarball must carry a notice
// that names every third-party package, with its licence text. The notice is generated from the esbuild metafile, never typed.

const root = process.cwd();
let dir = '';
let standalone = '';
let module = '';
let notices = '';
let metaInputs: string[] = [];

beforeAll(() => {
  mkdirSync(join(root, 'node_modules', '.cache'), { recursive: true });
  dir = mkdtempSync(join(root, 'node_modules', '.cache', 'cw-hub-notices-'));
  execFileSync(process.execPath, [join(root, 'packages', 'hub-element', 'build', 'build.mjs'), '--out', dir], { stdio: 'pipe' });
  standalone = readFileSync(join(dir, 'hub-element.js'), 'utf8');
  module = readFileSync(join(dir, 'index.js'), 'utf8');
  notices = readFileSync(join(dir, 'THIRD_PARTY_NOTICES.txt'), 'utf8');
  // The metafiles of both builds, straight from esbuild, in a child process (the build module is the unit under test only for its output).
  const buildUrl = pathToFileURL(join(root, 'packages', 'hub-element', 'build', 'build.mjs')).href;
  const script = [
    `import { bundle } from ${JSON.stringify(buildUrl)};`,
    'const { metafiles } = await bundle();',
    'process.stdout.write(JSON.stringify(metafiles.flatMap((m) => Object.keys(m.inputs))));',
  ].join('\n');
  metaInputs = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })) as string[];
}, 120_000);

afterAll(() => {
  if (dir !== '') rmSync(dir, { recursive: true, force: true });
});

/** The packages named in the metafile's inputs that live under node_modules, worked out here independently of the build's own helper. */
const bundledNames = (): string[] => {
  const names = new Set<string>();
  for (const input of metaInputs) {
    const parts = input.replaceAll('\\', '/').split('/');
    const at = parts.lastIndexOf('node_modules');
    if (at < 0) continue;
    const first = parts[at + 1] ?? '';
    names.add(first.startsWith('@') ? `${first}/${parts[at + 2] ?? ''}` : first);
  }
  return [...names].sort();
};

const listed = (): string[] => [...notices.matchAll(/^={78}\n(\S+) \S+\nLicense: /gm)].map((m) => m[1] ?? '').sort();

describe('the bundles keep the third-party licence banners', () => {
  it('both scripts carry the React @license banner (Meta, MIT)', () => {
    for (const [name, text] of [['hub-element.js', standalone], ['index.js', module]] as const) {
      expect(text, name).toMatch(/@license React/);
      expect(text, name).toMatch(/Meta Platforms, Inc\. and affiliates/);
      expect(text, name).toMatch(/licensed under the MIT license found in the\s+\*\s+LICENSE file/);
    }
  });
  it('there is a banner for react, react-dom and scheduler each', () => {
    expect(standalone).toMatch(/@license React\s+\*\s+react\.production\.js/);
    expect(standalone).toMatch(/@license React\s+\*\s+react-dom\.production\.js/);
    expect(standalone).toMatch(/@license React\s+\*\s+scheduler\.production\.js/);
  });
});

describe('THIRD_PARTY_NOTICES.txt', () => {
  it('lists exactly the third-party packages esbuild bundled, no more and no fewer', () => {
    const expected = bundledNames();
    expect(expected).toEqual(expect.arrayContaining(['react', 'react-dom', 'scheduler']));
    expect(listed()).toEqual(expected);
  });
  it('carries each package licence text (MIT, with the copyright line)', () => {
    for (const name of bundledNames()) {
      const licence = readFileSync(join(root, 'node_modules', name, 'LICENSE'), 'utf8').trim();
      expect(notices, name).toContain(licence);
    }
    expect(notices).toMatch(/Permission is hereby granted, free of charge/);
    expect(notices).toMatch(/Meta Platforms, Inc\. and affiliates/);
  });
  it('names the version of each package, as installed', () => {
    for (const name of bundledNames()) {
      const version = (JSON.parse(readFileSync(join(root, 'node_modules', name, 'package.json'), 'utf8')) as { version: string }).version;
      expect(notices, name).toContain(`\n${name} ${version}\nLicense: MIT\n`);
    }
  });
  it('does not list the workspace packages (they are this package licence) or build tools', () => {
    expect(notices).not.toMatch(/^@chatwarden\//m);
    expect(listed()).not.toContain('@chatwarden/hub-react');
    expect(notices).not.toMatch(/esbuild/);
  });
});
