// @vitest-environment node
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// The README says how the appeal form counts, and says it the way the code does.

const readme = readFileSync(fileURLToPath(new URL('../README.md', import.meta.url)), 'utf8').replace(/\s+/g, ' ');

describe('the README on the appeal count', () => {
  it('says the client counts code points of the trimmed text, may count slightly more than the server, never less', () => {
    expect(readme).toMatch(/code points of the trimmed text/);
    expect(readme).toMatch(/slightly more than the server[^.]*never less/);
  });
  it('says Send is off while empty or over the limit and the text is refused, never cut', () => {
    expect(readme).toMatch(/refused, never cut/);
  });
});
