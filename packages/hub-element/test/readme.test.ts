import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHubClient, createT, en, fetchTransport } from '@chatwarden/hub-react';
import { waitFor } from '@testing-library/dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ChatwardenHubElement, defineChatwardenHub, VERSION } from '../src/index.js';
import { hubShown, mount } from './helpers.js';
import { hubWorld } from './world.js';

// The README is the product an adopter copies from: its quick start is the form the CDN gives, its attribute and event tables are the
// element's real ones, every token it names exists in the stylesheet, and its snippets RUN as written (the imports swapped for ours).
// (scripts/readme.test.ts compiles the ```ts blocks of every package; the ```js and ```html blocks are run here.)

const root = process.cwd();
const readme = readFileSync(join(root, 'packages', 'hub-element', 'README.md'), 'utf8').replace(/\r\n/g, '\n');
const css = readFileSync(join(root, 'packages', 'hub-react', 'src', 'styles.css'), 'utf8');

const section = (heading: string): string => {
  const start = readme.indexOf(`\n## ${heading}\n`);
  expect(start, `section ${heading}`).toBeGreaterThanOrEqual(0);
  const next = readme.indexOf('\n## ', start + 1);
  return readme.slice(start, next === -1 ? undefined : next);
};
const blocks = (text: string, lang: string): string[] => [...text.matchAll(new RegExp('```' + lang + '\\n([\\s\\S]*?)```', 'g'))].map((m) => m[1] as string);
const tableRows = (text: string): string[][] =>
  text
    .split('\n')
    .filter((l) => l.startsWith('|') && !/^\|[ |-]+\|$/.test(l))
    .map((l) => l.split('|').slice(1, -1).map((c) => c.trim()))
    .slice(1);

afterEach(() => {
  vi.restoreAllMocks();
});

describe('the quick start', () => {
  const quick = section('Quick start');
  const html = blocks(quick, 'html')[0] ?? '';

  it('comes first, and is the script tag from the npm CDN plus the element, and nothing more', () => {
    expect(readme.indexOf('\n## ')).toBe(readme.indexOf('\n## Quick start\n'));
    expect(html.trim().split('\n')).toEqual([
      '<script type="module" src="https://cdn.jsdelivr.net/npm/@chatwarden/hub-element@0.1/dist/hub-element.js"></script>',
      '<chatwarden-hub base-url="/admin"></chatwarden-hub>',
    ]);
  });

  it('the CDN version is a range the published package satisfies, and the file it names is the one the package ships', () => {
    const manifest = JSON.parse(readFileSync(join(root, 'packages', 'hub-element', 'package.json'), 'utf8')) as { version: string; files: string[] };
    expect(manifest.version.startsWith('0.1.')).toBe(true);
    expect(manifest.files).toContain('dist/hub-element.js');
    expect(VERSION).toBe(manifest.version);
  });

  it('the element markup works: on a page that has the script, it draws the hub (the script tag itself is a network load, so it is left out)', async () => {
    const world = await hubWorld();
    defineChatwardenHub();
    const markup = html.split('\n').filter((l) => !l.includes('<script')).join('\n');
    const host = document.createElement('div');
    host.innerHTML = markup;
    const el = host.querySelector('chatwarden-hub') as ChatwardenHubElement;
    expect(el).toBeInstanceOf(ChatwardenHubElement);
    expect(el.getAttribute('base-url')).toBe('/admin');
    el.client = world.client;
    document.body.append(host);
    await hubShown(el);
  });
});

describe('the tables', () => {
  it('list exactly the attributes the element observes', () => {
    const names = tableRows(section('Attributes')).map((r) => (r[0] ?? '').replaceAll('`', ''));
    expect(names.sort()).toEqual([...ChatwardenHubElement.observedAttributes].sort());
  });

  it('give the defaults and values the element really has', async () => {
    const rows = Object.fromEntries(tableRows(section('Attributes')).map((r) => [(r[0] ?? '').replaceAll('`', ''), r]));
    expect(rows['base-url']?.[2]).toBe('`/admin`');
    expect(rows['theme']?.[2]).toBe('`auto`');
    expect(rows['locale']?.[2]).toBe('`en`');
    expect(rows['shortcuts']?.[2]).toBe('`true`');
    expect(rows['router']?.[2]).toBe('`hash`');
    expect(rows['mode']?.[1]).toBe('`simple`, `detailed`');
    expect(rows['theme']?.[1]).toBe('`auto`, `light`, `dark`');
    expect(rows['router']?.[1]).toBe('`hash`, `memory`');
  });

  it('list exactly the two properties, and the two events', () => {
    expect(tableRows(section('Properties')).map((r) => (r[0] ?? '').replaceAll('`', '')).sort()).toEqual(['client', 't']);
    expect(tableRows(section('Events')).map((r) => (r[0] ?? '').replaceAll('`', '')).sort()).toEqual(['cw-decided', 'cw-navigate']);
  });

  it('every --cw- custom property the theming section names is declared in hub-react\'s stylesheet', () => {
    const named = [...new Set([...section('Theming').matchAll(/`(--cw-[a-z0-9-]+)`/g)].map((m) => m[1] as string))];
    expect(named.length).toBeGreaterThan(15);
    for (const name of named) expect(css, name).toMatch(new RegExp(`^\\s*${name}:`, 'm'));
    // The spacing range the table names ends at --cw-space-6.
    expect(css).toMatch(/--cw-space-6:/);
  });

  it('the CSS example is a rule on the element with --cw- values', () => {
    const rule = blocks(section('Theming'), 'css')[0] ?? '';
    expect(rule).toMatch(/^chatwarden-hub \{/);
    expect(rule).toContain('--cw-hub-height');
  });
});

describe('the Content Security Policy section', () => {
  const csp = section('Content Security Policy').replace(/\s+/g, ' ');
  it('says constructable stylesheets need no unsafe-inline, and what the <style> fallback needs', () => {
    expect(csp).toMatch(/constructable stylesheet/);
    expect(csp).toMatch(/needs no `'unsafe-inline'`/);
    expect(csp).toMatch(/`<style>` element/);
    expect(csp).toMatch(/needs `style-src 'unsafe-inline'`/);
  });
  it('says there is no eval, and what to allow for the script and the calls', () => {
    expect(csp).toMatch(/no `eval`/);
    expect(csp).toMatch(/`script-src`/);
    expect(csp).toMatch(/`connect-src`/);
  });
});

describe('the snippets run as written', () => {
  /** Runs a ```js block with its imports bound to the real modules. */
  async function run(code: string): Promise<void> {
    const modules: Record<string, Record<string, unknown>> = {
      '@chatwarden/hub-element': { defineChatwardenHub, ChatwardenHubElement, VERSION },
      '@chatwarden/hub-react': { createHubClient, fetchTransport, createT, en },
    };
    const body = code.replace(/^import \{([^}]*)\} from '([^']+)';$/gm, (_m, names: string, from: string) => {
      expect(modules[from], `module ${from}`).toBeDefined();
      return `const {${names}} = __modules['${from}'];`;
    });
    const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor as new (...args: string[]) => (...args: unknown[]) => Promise<void>;
    await new AsyncFunction('__modules', 'token', body)(modules, 'csrf-value');
  }

  it('the property example hands the element a client built for another origin', async () => {
    defineChatwardenHub();
    const el = mount();
    const code = blocks(section('Properties'), 'js')[0] ?? '';
    await run(code);
    expect(el.client).not.toBeNull();
    expect(typeof el.client?.me).toBe('function');
  });

  it('the event examples listen on the element and hear its events', async () => {
    const world = await hubWorld();
    const logged: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => void logged.push(args.join(' ')));
    const el = mount({}, { client: world.client });
    const code = blocks(section('Events'), 'js')[0] ?? '';
    await run(code);
    await hubShown(el);
    await waitFor(() => expect(document.title).toMatch(/^Moderation \//));
    // The decided listener is attached: a fake event of the right shape reaches it.
    el.dispatchEvent(new CustomEvent('cw-decided', { detail: { reportId: 'r1', verdict: 'upheld' } }));
    expect(logged).toContain('report r1: upheld');
  });

  it('the bundler example registers the element and draws a hub with its client', async () => {
    const [ts, js] = [blocks(section('Use it from a bundler'), 'ts')[0] ?? '', blocks(section('Use it from a bundler'), 'js')[0] ?? ''];
    expect(ts).toContain("defineChatwardenHub('ops-hub')");
    const world = await hubWorld();
    await run(js);
    const el = document.querySelector('chatwarden-hub') as ChatwardenHubElement;
    expect(el).toBeInstanceOf(ChatwardenHubElement);
    expect(el.getAttribute('mode')).toBe('detailed');
    expect(el.client).not.toBeNull();
    el.client = world.client;
    await hubShown(el);
  });
});

describe('the README is plain', () => {
  it('uses no marketing words, no emoji, and links to absolute addresses', () => {
    expect(readme).not.toMatch(/\b(blazing|seamless|powerful|robust|world-class|cutting-edge|revolutionary)\b/i);
    expect(readme).not.toMatch(/\p{Extended_Pictographic}/u);
    for (const m of readme.matchAll(/\]\(([^)]+)\)/g)) expect(m[1], 'link').toMatch(/^https:\/\//);
  });

  it('names the installed size honestly: the number in the Size section is within the budget in the size test', () => {
    const size = section('Size');
    expect(size.replace(/\s+/g, ' ')).toMatch(/about 640 KB minified, about 175 KB gzipped/);
    expect(size).toMatch(/under 185 KB gzipped/);
  });
});
