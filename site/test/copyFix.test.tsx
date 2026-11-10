// The matcher does not claim to catch every dodge: spaced or hyphenated letters are deliberately not read (its README says so).
// The page must not claim more, and the FAQ must state the limit.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { FAQ, FEATURES } from '../src/content';
import { Faq } from '../src/sections/Faq';
import { Hero } from '../src/sections/Hero';

afterEach(cleanup);
const site = join(__dirname, '..');
const read = (p: string) => readFileSync(join(site, p), 'utf8');

describe('no overclaim about dodged filters', () => {
  it('the hero lead says "simple filters"', () => {
    render(<Hero />);
    expect(document.querySelector('.lead')?.textContent).toMatch(/refuses slurs that dodge simple filters/i);
  });
  it('the meta description, og:description and twitter:description say "simple filters"', () => {
    const html = read('index.html');
    const contents = [...html.matchAll(/(?:name|property)="(?:description|og:description|twitter:description)"\s+content="([^"]*)"/g)].map((m) => m[1] as string);
    expect(contents).toHaveLength(3);
    for (const c of contents) expect(c).toMatch(/dodge simple filters/i);
  });
  it('llms.txt says "simple filters" too', () => {
    expect(read('public/llms.txt')).toMatch(/dodge simple filters/i);
  });
  it('no page text anywhere promises a bare "slurs that dodge filters"', () => {
    const everything = [read('index.html'), read('public/llms.txt'), read('src/content.ts'), read('src/sections/Hero.tsx')].join('\n');
    expect(everything).not.toMatch(/dodge filters/i);
  });
  it('the matching feature card says "simple filters"', () => {
    expect(FEATURES.find((f) => f.id === 'match')?.title).toMatch(/dodge simple filters/i);
  });
});

describe('the FAQ states the spaced-letters limit', () => {
  it('has a question about spaced or hyphenated letters, answered "no, on purpose", with the reason and the report path', () => {
    const item = FAQ.find((f) => /spaced|hyphen/i.test(f.q));
    expect(item).toBeTruthy();
    expect(item?.a).toMatch(/^No/);
    expect(item?.a).toMatch(/on purpose|deliberate/i);
    expect(item?.a).toMatch(/innocent/i);
    expect(item?.a).toMatch(/report/i);
  });
  it('matches the matcher README, which says the same', () => {
    const readme = readFileSync(join(site, '..', 'packages', 'matcher', 'README.md'), 'utf8').replace(/\s+/g, ' ');
    expect(readme).toMatch(/Spaces and hyphens between letters/i);
    expect(readme).toMatch(/deliberate choice/i);
  });
  it('is on the page, in the FAQ list', () => {
    render(<Faq />);
    expect(screen.getByText(/spaced or hyphenated letters/i)).toBeTruthy();
  });
});
