import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// hub-react's stylesheet as its rules read, for tests that check what a rule says (a layout, a token used for a space): comments
// gone, and a token read written `var(--cw-x, var(--cwd-x))` folded to `var(--cw-x)`. The fallback is the same text on every read;
// tokens.test.ts holds that, so these tests can talk about the token alone.

const PATH = join(process.cwd(), 'packages', 'hub-react', 'src', 'styles.css');

export function rulesCss(): string {
  return readFileSync(PATH, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/var\((--cw-[a-z0-9-]+), var\(--cwd-[a-z0-9-]+\)\)/g, 'var($1)');
}
