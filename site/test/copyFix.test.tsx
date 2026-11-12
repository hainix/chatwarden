// The matcher does not claim to catch every dodge: spaced or hyphenated letters are deliberately not read (its README says so).
// The page must not claim more, and the FAQ must state the limit.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { FAQ, HOW_PANELS } from '../src/content';
import { Faq } from '../src/sections/Faq';
import { Hero } from '../src/sections/Hero';

afterEach(cleanup);
const site = join(__dirname, '..');
const read = (p: string) => readFileSync(join(site, p), 'utf8');

describe('no overclaim about dodged filters', () => {
  it('the hero lead promises blocking, not catching every dodge', () => {
    render(<Hero />);
    const lead = document.querySelector('.lead')?.textContent ?? '';
    expect(lead).toMatch(/blocks slurs from your word list before they're posted/);
    expect(lead).not.toMatch(/catches? every|all slurs|any slur|never|dodge/i);
  });
  it('no meta tag, llms.txt, content or hero file promises a bare "slurs that dodge filters" or "every" dodge', () => {
    const html = read('index.html');
    const contents = [...html.matchAll(/(?:name|property)="(?:description|og:description|twitter:description)"\s+content="([^"]*)"/g)].map((m) => m[1] as string);
    expect(contents).toHaveLength(3);
    const everything = [html, read('public/llms.txt'), read('src/content.ts'), read('src/sections/Hero.tsx')].join('\n');
    expect(everything).not.toMatch(/dodge filters|catches? every|all dodges/i);
  });
  it('the chat panel names the tricks it reads through (a list, not a blanket claim) and says the word list is yours', () => {
    const chat = HOW_PANELS.find((p) => p.id === 'chat')?.body ?? '';
    expect(chat).toMatch(/Slurs on your word list are blocked, even written with numbers for letters \(z0rbak\), look-alike letters, accents or repeated letters\./);
    expect(chat).not.toMatch(/catches? every|any dodge|all dodges|any way|all (the )?ways/i);
  });
});

describe('the FAQ states the spaced-letters limit', () => {
  const item = () => FAQ.find((f) => f.id === 'words');
  it('the word-list answer says spaced letters are not caught, on purpose, with the reason and the report path', () => {
    expect(item()?.q).toBe('Which words does it block?');
    expect(item()?.a).toMatch(/Words with spaces between the letters are not caught, on purpose/);
    expect(item()?.a).toMatch(/innocent/i);
    expect(item()?.a).toMatch(/Players can report those\./);
  });
  it('matches the matcher README, which says the same', () => {
    const readme = readFileSync(join(site, '..', 'packages', 'matcher', 'README.md'), 'utf8').replace(/\s+/g, ' ');
    expect(readme).toMatch(/Spaces and hyphens between letters/i);
    expect(readme).toMatch(/deliberate choice/i);
  });
  it('is on the page, in the FAQ list', () => {
    render(<Faq />);
    expect(screen.getByText(/Words with spaces between the letters are not caught, on purpose/)).toBeTruthy();
  });
  it('the profanity filter is described the way its README does: an optional package, allow, star or block, with an English list built in', () => {
    const a = item()?.a ?? '';
    expect(a).toContain('the optional @chatwarden/profanity package');
    expect(item()?.links?.map((l) => l.label)).toContain('@chatwarden/profanity');
    expect(a).toMatch(/built-in English list that you can allow, star or block/);
    const readme = readFileSync(join(site, '..', 'packages', 'profanity', 'README.md'), 'utf8');
    expect(readme).toMatch(/allow/i);
    expect(readme).toMatch(/star/i);
  });
});
