// @vitest-environment node
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// jsdom has no layout, so this checks the rules the stylesheet lays out with: no fixed width that a 320px phone cannot hold, long
// words that wrap instead of pushing the page sideways, and a dialog that scrolls inside itself. The browser run of the preview
// page measures the real pixels (scrollWidth against clientWidth at 320px).

// Comments gone, and a token read written `var(--cw-x, var(--cwd-x))` folded to `var(--cw-x)`: these tests talk about the token alone
// (tokens.test.ts holds that every read carries its own private default).
const css = readFileSync(join(fileURLToPath(new URL('..', import.meta.url)), 'src', 'styles.css'), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/var\((--cw-[a-z0-9-]+), var\(--cwd-[a-z0-9-]+\)\)/g, 'var($1)');

/** The declarations of the first rule whose selector list contains `selector` exactly (whitespace-normalised). */
function rule(selector: string): string {
  for (const m of css.matchAll(/([^{}@;]+)\{([^{}]*)\}/g)) {
    const list = (m[1] as string).split(',').map((s) => s.trim().replace(/\s+/g, ' '));
    if (list.includes(selector)) return m[2] as string;
  }
  return '';
}

/** The declarations of every rule whose selector list contains `selector`, joined (a property may sit in any of them). */
function allRules(selector: string): string {
  let out = '';
  for (const m of css.matchAll(/([^{}@;]+)\{([^{}]*)\}/g)) {
    if ((m[1] as string).split(',').map((x) => x.trim().replace(/\s+/g, ' ')).includes(selector)) out += m[2] as string;
  }
  return out;
}

describe('a 320px phone', () => {
  it('the root never grows past its container and counts padding in its width', () => {
    const r = rule('.cw-player');
    expect(r).toMatch(/max-width:\s*100%/);
    expect(r).toMatch(/min-width:\s*0/);
    expect(r).toMatch(/box-sizing:\s*border-box/);
  });

  it('long words wrap everywhere text from the player or the server can land', () => {
    for (const sel of ['.cw-player', '.cw-player .cw-line-text', '.cw-player .cw-facts dd', '.cw-player .cw-rule-text', '.cw-player .cw-title', '.cw-player .cw-error']) {
      expect(rule(sel), sel).toMatch(/overflow-wrap:\s*(anywhere|break-word)/);
    }
  });

  it('the dialog is at most the screen wide, keeps a margin, and scrolls inside itself when it is taller than the screen', () => {
    const d = rule('.cw-player .cw-dialog');
    expect(d).toMatch(/width:\s*min\(var\(--cw-dialog-width\), 100%\)/);
    expect(d).toMatch(/max-height:\s*100%/);
    expect(d).toMatch(/overflow-y:\s*auto/);
    expect(rule('.cw-player .cw-scrim')).toMatch(/padding:\s*var\(--cw-space-3\)/);
    expect(rule('.cw-player .cw-scrim')).toMatch(/position:\s*fixed/);
  });

  it('the note field and the button row fit the dialog', () => {
    expect(rule('.cw-player textarea')).toMatch(/width:\s*100%/);
    expect(rule('.cw-player textarea')).toMatch(/max-width:\s*100%/);
    expect(rule('.cw-player .cw-actions')).toMatch(/flex-wrap:\s*wrap/);
  });

  it('a button may wrap its words rather than force the dialog wider', () => {
    expect(rule('.cw-player .cw-btn')).toMatch(/white-space:\s*normal/);
  });

  it('the facts stack (term above value), so a long code or date never needs a second column', () => {
    expect(rule('.cw-player .cw-facts')).not.toMatch(/grid-template-columns|display:\s*flex/);
  });

  it('no rule fixes a width a 320px screen cannot hold (over 272px)', () => {
    for (const m of css.matchAll(/(?<![a-z-])(?:min-)?width:\s*([\d.]+)(px|rem)/g)) {
      const px = Number(m[1]) * (m[2] === 'rem' ? 16 : 1);
      expect(px, m[0]).toBeLessThanOrEqual(272);
    }
    expect(css).not.toMatch(/(?<![a-z-])min-width:\s*[\d.]+(px|rem)/);
  });

  it('the dialog width is a token with a phone-safe use: min() against the container', () => {
    expect(css).toMatch(/--cwd-dialog-width:\s*30rem;/);
  });

  it('nothing scrolls the page sideways: no negative margin and no fixed 100vw', () => {
    expect(css).not.toMatch(/100vw/);
    expect(css).not.toMatch(/margin(-left|-right|-inline)?:\s*-/);
  });
});

describe('the report dialog on a 320px phone', () => {
  it('the select and the note are as wide as the dialog and never wider (the form stacks, field over field)', () => {
    for (const sel of ['.cw-player select', '.cw-player textarea']) {
      expect(rule(sel), sel).toMatch(/width:\s*100%/);
      expect(rule(sel), sel).toMatch(/max-width:\s*100%/);
      expect(rule(sel), sel).toMatch(/min-width:\s*0/);
    }
    expect(rule('.cw-player .cw-field')).toMatch(/min-width:\s*0/);
  });
  it('a long hint, label or error wraps in the dialog (the root breaks long words) and the select shows an ellipsis, not a scrollbar', () => {
    expect(rule('.cw-player')).toMatch(/overflow-wrap:\s*anywhere/);
    expect(allRules('.cw-player select')).toMatch(/text-overflow:\s*ellipsis/);
  });
  it('the select is a full control tall, so a thumb can hit it', () => {
    expect(allRules('.cw-player select')).toMatch(/min-height:\s*var\(--cw-control-height\)/);
  });
  it('the quoted line wraps long words and is a block of its own', () => {
    expect(rule('.cw-player .cw-quote')).toMatch(/overflow-wrap:\s*(anywhere|break-word)/);
    expect(rule('.cw-player .cw-quote')).not.toMatch(/white-space:\s*nowrap/);
  });
  it('the "Add a note" door is a small text button that is still at least 2rem tall', () => {
    expect(rule('.cw-player .cw-linkbtn')).toMatch(/min-height:\s*2rem/);
    expect(rule('.cw-player .cw-linkbtn')).not.toMatch(/white-space:\s*nowrap/);
  });
});

describe('the busy and error states keep their place', () => {
  it('the inline error sits in the flow (no absolute position), so it is read with the notice', () => {
    expect(rule('.cw-player .cw-error')).not.toMatch(/position:\s*(absolute|fixed)/);
  });
  it('the heading that takes focus shows no ring of its own (it is a focus target, not a control)', () => {
    expect(rule('.cw-player .cw-title:focus')).toMatch(/outline:\s*none/);
  });
});
