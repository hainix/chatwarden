// The comment at the top of every generated file (design 5.5), and the markers a starter hook carries.
import type { Ctx } from './frag.js';

/** The markers `chatwarden init --check` looks for: a starter that is still in place. */
export const MARKERS = ['TODO(auth)', 'TODO(identity)', 'TODO(terms)'] as const;

const WRITTEN = 'Written by `chatwarden init` (K4b). It is yours now: edit freely. Re-running never overwrites a file you changed.';

/** The fixed header of a code file: what the file is, and that it is the adopter's now. Ends with a blank line. `ctx` is taken so every template calls it alike. */
export function header(ctx: Ctx, what: string): string {
  return `// ${what}\n// ${WRITTEN}\n\n`;
}

/** The same for a file whose comments start with `#` (the env example). Ends with a blank line. */
export function headerHash(what: string): string {
  return `# ${what}\n# ${WRITTEN}\n\n`;
}
