import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Markdown, isSafeHref } from '../src/markdown.js';
import { hubWorld } from './world.js';

// The safe renderer: an allow-list of headings, paragraphs, lists, emphasis, code, tables and links. Everything else is text.
// A link is drawn only for https: or a relative address. Nothing here ever builds HTML from the text.

const tableLabel = (n: number): string => `Table ${n}`;
function show(source: string, headingBase?: number) {
  return render(<Markdown source={source} tableLabel={tableLabel} {...(headingBase === undefined ? {} : { headingBase })} />);
}

describe('isSafeHref', () => {
  it.each([
    'https://example.test/guide',
    'HTTPS://example.test',
    '/rules',
    './rules',
    '../rules',
    '#section',
    '?page=2',
    'rules/one',
    'rules/a:b',
    '/terms',
    '#guide',
    '/a/b?c=d#e',
    '/%5Cevil.example.test',
    '/path:with:colons',
  ])('allows %s', (href) => {
    expect(isSafeHref(href)).toBe(true);
  });

  it.each([
    'javascript:alert(1)',
    'JaVaScRiPt:alert(1)',
    ' javascript:alert(1)',
    'java\tscript:alert(1)',
    'java\nscript:alert(1)',
    'jav&#x61;script:alert(1)',
    'data:text/html,<b>x</b>',
    'vbscript:x',
    'http://example.test',
    'mailto:a@example.test',
    'ftp://example.test',
    'file:///etc/passwd',
    '//evil.example.test/x',
    '\\\\evil.example.test\\x',
    '',
    '   ',
    '/\\evil.example.test',
    '/\\/evil.example.test',
    '/\\\\evil.example.test',
    '/ /evil.example.test',
    '/\t/evil.example.test',
    '/\n/evil.example.test',
    '/ /evil.example.test',
    '/ /evil.example.test',
    '\t//evil.example.test',
    '\n//evil.example.test',
    ' \t //evil.example.test',
    ' //evil.example.test',
    'rules\\x',
    'a\\b',
    '/rules\\..',
    'https:\\/evil.example.test',
    'https:/\\evil.example.test',
    'https:\\\\evil.example.test',
    'java\u0000script:alert(1)',
    'jav\tascript:alert(1)',
    'https:',
    'https://',
  ])('refuses %j', (href) => {
    expect(isSafeHref(href)).toBe(false);
  });
});

describe('relative addresses stay on this site', () => {
  it.each(['/terms', '#guide', './x', '../x', '?q=1', 'rules/one', '/%5Cevil.example.test', '/a:b', '/a//b'])('%s resolves to the hub origin', (href) => {
    expect(isSafeHref(href)).toBe(true);
    expect(new URL(href, 'https://hub.example.test/app/').origin).toBe('https://hub.example.test');
  });

  it('every address it allows resolves to this origin or is a plain https one (a sweep of slash, backslash and space mixes)', () => {
    const bits = ['/', '\\', ' ', '\t', 'a', ':', '%5C', '.', '?', '#'];
    let checked = 0;
    for (const a of bits)
      for (const b of bits)
        for (const c of bits) {
          const href = `${a}${b}${c}evil.example.test`;
          if (!isSafeHref(href)) continue;
          checked += 1;
          const url = new URL(href, 'https://hub.example.test/app/');
          const plainHttps = href.trim().toLowerCase().startsWith('https://');
          expect(url.origin === 'https://hub.example.test' || plainHttps, JSON.stringify(href)).toBe(true);
        }
    expect(checked).toBeGreaterThan(20);
  });
});

describe('blocks', () => {
  it('draws headings below the screen title: # is a level 3 heading by default', () => {
    const { container } = show('# One\n\n## Two\n\n### Three\n\n#### Four\n\n##### Five\n\n###### Six');
    expect([...container.querySelectorAll('h3,h4,h5,h6')].map((h) => `${h.tagName}:${h.textContent}`)).toEqual(['H3:One', 'H4:Two', 'H5:Three', 'H6:Four', 'H6:Five', 'H6:Six']);
    expect(container.querySelector('h1,h2')).toBeNull();
  });

  it('the heading base can move', () => {
    const { container } = show('# One\n\n## Two', 2);
    expect([...container.querySelectorAll('h2,h3')].map((h) => h.tagName)).toEqual(['H2', 'H3']);
  });

  it('joins the lines of a paragraph and splits paragraphs at a blank line', () => {
    const { container } = show('first line\nsecond line\n\nnext paragraph');
    const p = [...container.querySelectorAll('p')].map((x) => x.textContent);
    expect(p).toEqual(['first line second line', 'next paragraph']);
  });

  it('draws bullet and numbered lists', () => {
    const { container } = show('- one\n- two\n* three\n\n1. first\n2. second');
    expect([...container.querySelectorAll('ul > li')].map((x) => x.textContent)).toEqual(['one', 'two', 'three']);
    expect([...container.querySelectorAll('ol > li')].map((x) => x.textContent)).toEqual(['first', 'second']);
  });

  it('a list item continues on an indented line, and nested items stay in the list', () => {
    const { container } = show('- one\n  more of one\n  - nested\n- two');
    expect([...container.querySelectorAll('li')].map((x) => x.textContent)).toEqual(['one more of one', 'nested', 'two']);
  });

  it('draws a table in its own scroll box with a header and body, named by the label', () => {
    const { container, getByRole } = show('| Step | Outcome |\n| --- | --- |\n| 0 | Warning |\n| 1 | Chat 24 hours |');
    const region = getByRole('region', { name: 'Table 1' });
    expect(region).toHaveClass('cw-scroll');
    expect(region.querySelector('table')).not.toBeNull();
    expect([...container.querySelectorAll('th')].map((x) => x.textContent)).toEqual(['Step', 'Outcome']);
    expect([...container.querySelectorAll('tbody td')].map((x) => x.textContent)).toEqual(['0', 'Warning', '1', 'Chat 24 hours']);
    expect(container.querySelectorAll('th[scope="col"]')).toHaveLength(2);
  });

  it('two tables get two names', () => {
    const { getByRole } = show('| a |\n| --- |\n| 1 |\n\n| b |\n| --- |\n| 2 |');
    expect(getByRole('region', { name: 'Table 1' })).toBeInTheDocument();
    expect(getByRole('region', { name: 'Table 2' })).toBeInTheDocument();
  });

  it('a cell keeps an escaped pipe, and a short row is padded', () => {
    const { container } = show('| a | b |\n| --- | --- |\n| x \\| y |\n');
    expect([...container.querySelectorAll('tbody td')].map((x) => x.textContent)).toEqual(['x | y', '']);
  });

  it('draws a fenced code block as text, whatever is in it', () => {
    const { container } = show('```\n<b>not bold</b> **nor this**\n```');
    const code = container.querySelector('pre code');
    expect(code?.textContent).toBe('<b>not bold</b> **nor this**');
    expect(container.querySelector('b, strong')).toBeNull();
  });

  it('an unclosed fence runs to the end and does not throw', () => {
    const { container } = show('```\nline one\nline two');
    expect(container.querySelector('pre code')?.textContent).toBe('line one\nline two');
  });

  it('empty text draws nothing', () => {
    expect(show('').container.textContent).toBe('');
    expect(show('\n\n  \n').container.textContent).toBe('');
  });
});

describe('inline', () => {
  it('strong, emphasis and code', () => {
    const { container } = show('a **bold** b *soft* c _under_ d `mono` e');
    expect(container.querySelector('strong')?.textContent).toBe('bold');
    expect([...container.querySelectorAll('em')].map((x) => x.textContent)).toEqual(['soft', 'under']);
    expect(container.querySelector('code')?.textContent).toBe('mono');
  });

  it('an underscore inside a word is not emphasis', () => {
    const { container } = show('snake_case_name and more_here');
    expect(container.querySelector('em')).toBeNull();
    expect(container.textContent).toBe('snake_case_name and more_here');
  });

  it('a lone star or backtick is text', () => {
    const { container } = show('2 * 3 and a ` tick');
    expect(container.textContent).toBe('2 * 3 and a ` tick');
  });

  it('a backslash escape gives the character itself, as the kit writes it', () => {
    const { container } = show('CR 1\\. Respect \\*everyone\\* \\[now\\] \\<tag\\> a\\&b');
    expect(container.textContent).toBe('CR 1. Respect *everyone* [now] <tag> a&b');
    expect(container.querySelector('em, a')).toBeNull();
  });

  it('emphasis inside a link text and strong inside a heading are drawn', () => {
    const { container } = show('# A **big** title\n\n[a *nice* link](https://example.test/x)');
    expect(container.querySelector('h3 strong')?.textContent).toBe('big');
    expect(container.querySelector('a em')?.textContent).toBe('nice');
  });
});

describe('links', () => {
  it('an https link and a relative link are anchors that open safely', () => {
    const { container } = show('[site](https://example.test/a?b=1) and [rules](/rules)');
    const [a, b] = [...container.querySelectorAll('a')] as HTMLAnchorElement[];
    expect(a?.getAttribute('href')).toBe('https://example.test/a?b=1');
    expect(a?.getAttribute('rel')).toBe('noopener noreferrer');
    expect(a?.getAttribute('target')).toBe('_blank');
    expect(b?.getAttribute('href')).toBe('/rules');
  });

  it.each([
    '[x](javascript:alert(1))',
    '[x](JAVASCRIPT:alert%281%29)',
    '[x](data:text/html;base64,PHNjcmlwdD4=)',
    '[x](http://example.test)',
    '[x](//evil.test/x)',
    '[x](vbscript:y)',
    '[x](mailto:a@example.test)',
    '[x]()',
  ])('%s draws the words and no anchor', (source) => {
    const { container } = show(source);
    expect(container.querySelector('a')).toBeNull();
    expect(container.querySelector('p')?.textContent?.startsWith('x')).toBe(true);
  });

  it('an unsafe link keeps its words but not its address anywhere in the page', () => {
    const { container } = show('[click me](javascript:alert(1))');
    expect(container.textContent).toBe('click me');
    expect(container.innerHTML).not.toMatch(/javascript/i);
  });

  it('an image is not drawn: no img element, and no address as a src', () => {
    const { container } = show('![alt text](https://example.test/x.png) ![](/y.png)');
    expect(container.querySelector('img')).toBeNull();
    expect(container.innerHTML).not.toMatch(/src=/i);
  });

  it('a link in a table cell and in a heading follows the same rule', () => {
    const { container } = show('# [h](javascript:x)\n\n| a |\n| --- |\n| [c](https://example.test) [d](javascript:x) |');
    expect([...container.querySelectorAll('a')].map((a) => a.getAttribute('href'))).toEqual(['https://example.test']);
  });
});

describe('hostile input', () => {
  it('raw HTML is shown as text: no script, no element, no handler', () => {
    const { container } = show('<script>alert(1)</script>\n\n<img src=x onerror=alert(1)>\n\n<b onclick="x()">bold</b> <iframe src="https://evil.test"></iframe>');
    expect(container.querySelector('script, img, iframe, b')).toBeNull();
    expect(container.innerHTML).not.toMatch(/<script|<img|<iframe/i);
    expect(container.querySelectorAll('[onerror],[onclick]')).toHaveLength(0);
    expect(container.textContent).toContain('<script>alert(1)</script>');
    expect(container.textContent).toContain('<img src=x onerror=alert(1)>');
  });

  it('HTML in a heading, a list item, a table cell and a code span is text too', () => {
    const { container } = show('# <script>x</script>\n\n- <style>p{}</style>\n\n| <svg onload=x> |\n| --- |\n| <a href="javascript:x">y</a> |\n\n`<script>`');
    expect(container.querySelector('script, style, svg, a')).toBeNull();
    expect(container.textContent).toContain('<script>x</script>');
    expect(container.textContent).toContain('<svg onload=x>');
  });

  it('an entity is not decoded into markup', () => {
    const { container } = show('&lt;script&gt; &#60;b&#62;');
    expect(container.querySelector('script, b')).toBeNull();
    expect(container.textContent).toBe('&lt;script&gt; &#60;b&#62;');
  });

  it('a blockquote, a horizontal rule and a footnote are plain text', () => {
    const { container } = show('> quoted\n\n---\n\n[^1]: note');
    expect(container.querySelector('blockquote, hr')).toBeNull();
    expect(container.textContent).toContain('quoted');
  });

  it('a very long line and deeply nested emphasis stay fast and do not throw', () => {
    const long = `${'*a '.repeat(2000)}end`;
    const nested = `${'**'.repeat(300)}x${'**'.repeat(300)}`;
    const started = Date.now();
    expect(() => show(`${long}\n\n${nested}`)).not.toThrow();
    expect(Date.now() - started).toBeLessThan(3000);
  });

  it('the output is built from elements, never from a string (control)', () => {
    const { container } = show('**x**');
    expect(container.innerHTML).toBe('<div class="cw-doc"><p><strong>x</strong></p></div>');
  });
});

describe('long and pathological lines', () => {
  const ms = (source: string): number => {
    const started = performance.now();
    show(source);
    return performance.now() - started;
  };

  it.each([
    ['60,000 spaces', ' '.repeat(60_000)],
    ['a heading marker and 60,000 spaces', `# ${' '.repeat(60_000)}x`],
    ['a table and 60,000 spaces in a row', `| a |\n| --- |\n|${' '.repeat(60_000)}|`],
    ['a separator-looking line of spaces', `|${' '.repeat(60_000)}\n${' '.repeat(60_000)}-`],
    ['a list marker and 60,000 spaces', `-${' '.repeat(60_000)}`],
    ['60,000 tabs', '\t'.repeat(60_000)],
    ['5,000 unmatched [', '['.repeat(5_000)],
    ['unmatched link openers', '[x]('.repeat(1_000)],
    ['5,000 unmatched stars', '*a '.repeat(2_000)],
    ['unmatched double stars', '**a '.repeat(1_500)],
    ['5,000 unmatched underscores', '_a '.repeat(2_000)],
    ['5,000 unmatched backticks', '`'.repeat(5_001)],
    ['5,000 backslashes', '\\'.repeat(5_000)],
    ['nested openers', '[*_`'.repeat(1_250)],
  ])('%s renders in well under 100 ms', (_name, source) => {
    ms(source);
    expect(Math.min(ms(source), ms(source))).toBeLessThan(100);
  });

  it('a line past the cap keeps all its words as plain text', () => {
    const words = `${'word '.repeat(1_000)}tail-end`;
    const { container } = show(`# ${words}`);
    expect(container.querySelector('h3')?.textContent).toBe(words);
    const long = show(`${'x'.repeat(5_000)} **late**`);
    expect(long.container.textContent).toContain('late');
  });

  it('a long line that is a table row still draws a table', () => {
    const { container } = show(`| a | b |\n| --- | --- |\n| ${'c'.repeat(2_500)} | d |`);
    expect(container.querySelectorAll('tbody td')).toHaveLength(2);
  });
});

describe('the kit guide', () => {
  it('renders the generated moderator guide: title, rules, tables and no stray markup characters', async () => {
    const w = await hubWorld();
    const md = w.cw.documents.moderatorGuide({ format: 'markdown' });
    const { container, getAllByRole } = show(md);
    expect(container.querySelector('h3')?.textContent).toMatch(/^Moderator guide:/);
    expect(container.querySelectorAll('ul li').length).toBeGreaterThan(5);
    expect(getAllByRole('region').length).toBeGreaterThanOrEqual(3);
    expect(container.textContent).not.toMatch(/\\[.*_`#|]|\*\*/);
    expect(container.querySelector('script, img, iframe')).toBeNull();
  });
});
