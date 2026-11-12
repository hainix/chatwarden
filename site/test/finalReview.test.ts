// @vitest-environment node
// Final whole-branch review: copy that must stay true, the deploy notes, the no-JavaScript fallback and the tracked follow-up.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const site = join(__dirname, '..');
const repo = join(site, '..');
const text = (...p: string[]) => readFileSync(join(...p), 'utf8').replace(/\r\n/g, '\n');
const readme = () => text(site, 'README.md');
const flat = (s: string) => s.replace(/\s+/g, ' ');

describe('claims the site makes about itself', () => {
  const files = ['src/content.ts', 'src/sections/OpenSource.tsx', 'src/sections/Footer.tsx', 'index.html', 'public/llms.txt'];
  it('says nothing about Moxgate at all, and never "Used by Moxgate" (cut until it ships on the kit; ruling 8 of the copy rewrite)', () => {
    for (const f of files) expect(text(site, f), f).not.toMatch(/moxgate/i);
  });
  it('never promises "forever" and never says "No strings"', () => {
    for (const f of files) {
      expect(text(site, f), f).not.toMatch(/free forever/i);
      expect(text(site, f), f).not.toMatch(/no strings/i);
    }
    expect(text(site, 'src/sections/Footer.tsx')).toContain('Apache-2.0. Pre-release, provided as is. Not a child-safety tool.');
  });
  it('does not pin a version that will be stale: no "0.1.0" on the page', () => {
    expect(text(site, 'src/sections/OpenSource.tsx')).not.toMatch(/0\.1\.0/);
  });
  it('llms.txt keeps the store-memory npm link (0.1.1 is published before the first deploy)', () => {
    expect(text(site, 'public/llms.txt')).toContain('https://www.npmjs.com/package/@chatwarden/store-memory');
  });
});

describe('the deploy notes in site/README.md', () => {
  it('deploys to production explicitly: --branch main, and says why', () => {
    const r = readme();
    expect(r).toContain('npx wrangler pages deploy site/dist --project-name chatwarden --branch main');
    expect(r).not.toMatch(/pages deploy site\/dist --project-name chatwarden\s*$/m);
    expect(flat(r)).toMatch(/production deployment is the one made from the project's production branch/i);
    expect(flat(r)).toMatch(/preview/i);
    expect(flat(r)).toMatch(/detached HEAD/i);
  });
  it('checks first that the packages the page names are on npm', () => {
    const r = readme();
    expect(r).toContain('npm view @chatwarden/store-memory version');
    expect(flat(r)).toMatch(/before the first deploy/i);
    expect(flat(r)).toMatch(/v0\.1\.1/);
  });
  it('says there is no 404.html and what Pages does about it', () => {
    expect(flat(readme())).toMatch(/there is no `?404\.html`?.*Pages serves `?index\.html`? for unknown paths/i);
    expect(existsSync(join(site, 'public', '404.html'))).toBe(false);
  });
  it('tells the deployer to leave Cloudflare Web Analytics, Rocket Loader and email obfuscation off (the CSP blocks injected scripts)', () => {
    const r = flat(readme());
    expect(r).toMatch(/Web Analytics/);
    expect(r).toMatch(/Rocket Loader/);
    expect(r).toMatch(/email (address )?obfuscation/i);
    expect(r).toMatch(/CSP blocks/i);
  });
  it('says the PNG drift guard has not yet run on Linux, so CI is the first run', () => {
    expect(flat(readme())).toMatch(/drift guard.*first run on Linux|first run on Linux.*drift guard/i);
  });
});

describe('the no-JavaScript fallback', () => {
  const html = () => text(site, 'index.html');
  const noscript = () => /<noscript>([\s\S]*?)<\/noscript>/.exec(html())?.[1] ?? '';
  it('has a <noscript> in the body with the pitch, the GitHub link and the npm link', () => {
    const n = noscript();
    expect(html().indexOf('<noscript>')).toBeGreaterThan(html().indexOf('<body>'));
    expect(n).toMatch(/free, open-source chat moderation for games/i);
    expect(n).toContain('href="https://github.com/hainix/chatwarden"');
    expect(n).toContain('href="https://www.npmjs.com/package/@chatwarden/core"');
  });
  it('has the proposal’s words: blocks slurs, one-tap reports, a moderator hub, your own Node server, and that the demo needs JavaScript', () => {
    const n = flat(noscript().replace(/<[^>]+>/g, ' '));
    expect(n).toContain('Chatwarden is free, open-source chat moderation for games. It blocks slurs before they');
    expect(n).toContain('lets players report a message in one tap');
    expect(n).toContain('gives your team a moderator hub to handle each report in one click');
    expect(n).toContain('It runs on your own Node server.');
    expect(n).toContain('The live demo needs JavaScript.');
    expect(n).not.toMatch(/refus|fair ladder|dodge simple filters/i);
  });
  it('is one paragraph styled by a class from the stylesheet (the CSP forbids inline style)', () => {
    const n = noscript();
    expect(n.match(/<p[\s>]/g)).toHaveLength(1);
    expect(n).toMatch(/class="noscript"/);
    expect(n).not.toMatch(/\sstyle=|<script|<style|\son\w+=/i);
    expect(text(site, 'src', 'styles.css')).toMatch(/\.noscript\s*\{/);
  });
  it('makes no promise the page does not keep: invents no customer, number or "used by"', () => {
    expect(noscript()).not.toMatch(/used by|trusted by|forever|\b\d+k?\+? (users|customers|games)\b/i);
  });
});

describe('the obscenity follow-up is closed in the repo', () => {
  it('says it was fixed in the matcher in 0.1.3 and that the site workaround is gone', () => {
    const f = flat(text(repo, 'docs', 'plans', 'follow-ups.md'));
    expect(f).toMatch(/@chatwarden\/matcher/);
    expect(f).toMatch(/englishDataset/);
    expect(f).toMatch(/Fixed in 0\.1\.3/);
    expect(f).toMatch(/issue #8/i);
    expect(f).toMatch(/site workaround .*removed/i);
  });
});
