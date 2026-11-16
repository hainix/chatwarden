import { readFileSync } from 'node:fs';
import { JSDOM, type El } from 'jsdom';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PAGE_CSP } from '../src/review.js';
import { ALICE, makeReviewWorld, withReviewers, type ReviewWorld } from './review-world.js';
import { wordN } from './world.js';

// The review page: a strict CSP, no inline code, no HTML built from data, and no term on screen until a reveal.

let rw: ReviewWorld;
beforeEach(async () => {
  rw = await makeReviewWorld();
  await withReviewers(rw);
});
afterEach(() => rw.restore());

const file = (name: string) => readFileSync(new URL(`../page/admin/${name}`, import.meta.url), 'utf8');

describe('the page sets a strict CSP and renders no term until revealed', () => {
  it('serves the three files with a content security policy that allows only the page\u2019s own script and style', async () => {
    for (const [path, type] of [
      ['/admin', 'text/html'],
      ['/admin/', 'text/html'],
      ['/admin/page.js', 'text/javascript'],
      ['/admin/page.css', 'text/css'],
    ] as const) {
      const res = await rw.admin(path);
      expect(res.status, path).toBe(200);
      expect(res.headers.get('content-type'), path).toContain(type);
      expect(res.headers.get('content-security-policy'), path).toBe(PAGE_CSP);
      expect(res.headers.get('cache-control')).toBe('no-store');
      expect(res.headers.get('x-content-type-options')).toBe('nosniff');
      expect(res.headers.get('x-frame-options')).toBe('DENY');
      expect(res.headers.get('referrer-policy')).toBe('no-referrer');
    }
  });

  it('the policy has no unsafe-inline, no unsafe-eval, no wildcard, no remote source, and denies framing and forms', () => {
    expect(PAGE_CSP).toContain("default-src 'none'");
    expect(PAGE_CSP).toContain("script-src 'self'");
    expect(PAGE_CSP).toContain("style-src 'self'");
    expect(PAGE_CSP).toContain("connect-src 'self'");
    expect(PAGE_CSP).toContain("frame-ancestors 'none'");
    expect(PAGE_CSP).toContain("form-action 'none'");
    expect(PAGE_CSP).toContain("base-uri 'none'");
    expect(PAGE_CSP).not.toMatch(/unsafe-|\*|https?:|data:|blob:/);
  });

  it('the html has no inline script or style, no event handler attribute, no remote URL and no form', () => {
    const html = file('index.html');
    for (const m of html.matchAll(/<script\b[^>]*>/gi)) expect(m[0]).toMatch(/\bsrc="\/admin\/page\.js"/);
    expect(html).not.toMatch(/<script\b[^>]*>[^<]*\S[^<]*<\/script>/i);
    expect(html).not.toMatch(/<style\b/i);
    expect(html).not.toMatch(/\sstyle\s*=/i);
    expect(html).not.toMatch(/\son[a-z]+\s*=/i);
    expect(html).not.toMatch(/https?:\/\//i);
    expect(html).not.toMatch(/<form\b|<iframe\b|<object\b|<embed\b|javascript:/i);
  });

  it('the script builds no HTML from data and uses no eval: every piece of text goes in through textContent', () => {
    const js = file('page.js');
    expect(js).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|document\.write|\beval\s*\(|new Function|setTimeout\s*\(\s*['"`]|setInterval\s*\(\s*['"`]|createContextualFragment|DOMParser|srcdoc/);
    expect(js).not.toMatch(/localStorage|sessionStorage|document\.cookie|XMLHttpRequest|WebSocket|importScripts|window\.open|location\s*=/);
    expect(js).not.toMatch(/https?:\/\//);
    expect(js).toContain('textContent');
  });

  it('no file holds a real or invented word, a note or a key: the page is code only', () => {
    for (const name of ['index.html', 'page.js', 'page.css']) expect(file(name), name).not.toMatch(/zorbak|vlemmo|quissel|drakkuun|fenrisk|tarvo|snerp|glarn|-----BEGIN/i);
  });

  it('the files are ASCII with LF endings', () => {
    for (const name of ['index.html', 'page.js', 'page.css']) {
      const text = file(name);
      expect([...text].every((c) => c.charCodeAt(0) < 128), name).toBe(true);
      expect(text, name).not.toContain('\r');
    }
  });

  describe('in a browser', () => {
    const settle = async (until: () => boolean) => {
      for (let i = 0; i < 200 && !until(); i += 1) await new Promise((r) => setTimeout(r, 5));
      expect(until()).toBe(true);
    };

    async function open(who = ALICE) {
      const token = await rw.access.token({ claims: { email: who } });
      const dom = new JSDOM(file('index.html'), { url: 'https://corpus.test/admin', runScripts: 'outside-only' });
      const window = dom.window;
      window.fetch = ((path: string, init: RequestInit = {}) =>
        rw.w.fetch(new Request(`https://corpus.test${path}`, { method: init.method ?? 'GET', headers: { ...(init.headers as Record<string, string>), 'cf-access-jwt-assertion': token }, ...(init.body === undefined ? {} : { body: init.body }) }))) as typeof fetch;
      window.eval(file('page.js'));
      const doc = window.document;
      return { dom, doc, items: () => [...doc.querySelectorAll('#list li')], text: () => doc.body.textContent ?? '' };
    }

    it('lists the queue with no word on screen, then shows a word only for the row that was revealed, as text', async () => {
      const words = ['zorbak', 'vlemmo', 'quissel'];
      for (const [i, term] of words.entries()) await rw.seed({ term, note: i === 0 ? '<img src=x onerror=alert(1)> seen twice' : null, category: 'abuse' });
      const page = await open();
      await settle(() => page.items().length === 3);
      for (const word of words) expect(page.text()).not.toContain(word);
      expect(page.text()).not.toContain('seen twice');
      expect(page.doc.querySelectorAll('.word.masked')).toHaveLength(3);
      expect(page.text()).toContain('abuse');
      expect(page.doc.getElementById('who')?.textContent).toContain(ALICE);

      const first = page.items()[2] as El; // newest first: the oldest is last
      (first.querySelector('button') as El).click();
      await settle(() => first.querySelector('.word.masked') === null);
      expect(first.querySelector('.word')?.textContent).toBe('zorbak');
      expect(first.textContent).toContain('<img src=x onerror=alert(1)> seen twice');
      expect(first.querySelector('img')).toBeNull();
      for (const other of [page.items()[0], page.items()[1]]) expect(other?.textContent).not.toMatch(/zorbak|vlemmo|quissel/);
    });

    it('shows a break reminder at the 20th reveal and not before', async () => {
      for (let n = 0; n < 21; n += 1) await rw.seed({ term: wordN(n) });
      const page = await open();
      await settle(() => page.items().length === 21);
      const box = page.doc.getElementById('break') as El;
      expect(box.hidden).toBe(true);
      for (let n = 0; n < 19; n += 1) {
        const li = page.items()[n] as El;
        (li.querySelector('button') as El).click();
        await settle(() => li.querySelector('.word.masked') === null);
      }
      expect(box.hidden).toBe(true);
      const twentieth = page.items()[19] as El;
      (twentieth.querySelector('button') as El).click();
      await settle(() => !box.hidden);
      expect(box.textContent).toContain('Take a short break');
      (page.doc.getElementById('break-ok') as El).click();
      expect(box.hidden).toBe(true);
    });

    it('approves from the page, naming a target for a slur, and the list shows the new count', async () => {
      await rw.seed({ term: 'drakkuun', category: 'slur', target: 'none' });
      const page = await open();
      await settle(() => page.items().length === 1);
      const li = page.items()[0] as El;
      (li.querySelector('button') as El).click();
      await settle(() => li.querySelector('select') !== null);
      const approve = [...li.querySelectorAll('button')].find((b) => b.textContent === 'Approve') as El;
      approve.click();
      await settle(() => page.text().includes('1 approval'));
      expect((await rw.rows('SELECT status, target FROM terms'))[0]).toEqual({ status: 'provisional', target: 'ethnicity' });
      expect(page.doc.getElementById('message')?.textContent).toBe('');
    });

    it('declines with a closed reason, and shows a refusal as its code', async () => {
      await rw.seed({ term: 'fenrisk', category: 'abuse' });
      const page = await open();
      await settle(() => page.items().length === 1);
      const li = page.items()[0] as El;
      (li.querySelector('button') as El).click();
      await settle(() => li.querySelector('select') !== null);
      const decline = [...li.querySelectorAll('button')].find((b) => b.textContent === 'Decline') as El;
      decline.click();
      await settle(() => page.items().length === 0);
      expect((await rw.rows('SELECT status, reason FROM submissions'))[0]).toEqual({ status: 'declined', reason: 'not_a_term' });

      await rw.seed({ term: 'tarvo', category: 'slur', target: 'none' });
      const again = await open();
      await settle(() => again.items().length === 1);
      const row = again.items()[0] as El;
      (row.querySelector('button') as El).click();
      await settle(() => row.querySelector('select') !== null);
      await rw.w.db.prepare("UPDATE submissions SET status = 'accepted' WHERE term = 'tarvo'").run();
      ([...row.querySelectorAll('button')].find((b) => b.textContent === 'Approve') as El).click();
      await settle(() => (again.doc.getElementById('message')?.textContent ?? '').startsWith('Not done'));
      expect(again.doc.getElementById('message')?.textContent).toBe('Not done: closed');
    });

    it('the terms tabs list masked terms; a disputed term offers Restore', async () => {
      await rw.w.addTerm('CWT-2026-00001', 'zorbak', 'disputed');
      const page = await open();
      await settle(() => page.doc.querySelectorAll('#tabs button').length === 5);
      const tab = [...page.doc.querySelectorAll('#tabs button')].find((b) => b.textContent === 'Disputed terms') as El;
      tab.click();
      await settle(() => page.items().length === 1);
      expect(page.text()).not.toContain('zorbak');
      const li = page.items()[0] as El;
      (li.querySelector('button') as El).click();
      await settle(() => li.querySelector('.word.masked') === null);
      expect(li.querySelector('.word')?.textContent).toBe('zorbak');
      expect([...li.querySelectorAll('button')].map((b) => b.textContent)).toEqual(expect.arrayContaining(['Restore', 'Add line']));
    });
  });
});
