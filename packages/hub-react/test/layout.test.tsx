import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { renderHub } from './render.js';
import { hubWorld } from './world.js';
import { rulesCss } from './css.js';

// The panes, as the page lays them out. jsdom has no layout, so this checks the structure the stylesheet lays out (the classes
// and data attributes, and the order of the panes) and the breakpoints written in the stylesheet itself. A real browser checks
// the pixels: three panes from 75rem (1200px), two from 51.25rem (820px), stacked below, no sideways scroll down to 360px.

const css = rulesCss();

/** The bodies of every `@media (query) { ... }` block, matching braces, one after the other. */
function media(query: string): string {
  const parts: string[] = [];
  let from = 0;
  for (;;) {
    const start = css.indexOf(`@media (${query})`, from);
    if (start < 0) return parts.join('\n');
    const open = css.indexOf('{', start);
    let depth = 0;
    let i = open;
    for (; i < css.length; i += 1) {
      if (css[i] === '{') depth += 1;
      if (css[i] === '}') {
        depth -= 1;
        if (depth === 0) break;
      }
    }
    parts.push(css.slice(open + 1, i));
    from = i + 1;
  }
}

describe('the pane structure', () => {
  it('lays out rail, queue and a work column with the case and its panel, in that order', async () => {
    const w = await hubWorld();
    const a = await w.file({ target: 'Alpha' });
    const { container } = renderHub(w, { path: `/reports/${a.id}` });
    await screen.findByRole('complementary', { name: 'About this case' });
    const body = container.querySelector('.cw-body') as HTMLElement;
    expect(body).toHaveAttribute('data-queue', 'true');
    expect(body).toHaveAttribute('data-case', 'true');
    const kids = [...body.children].map((c) => c.className);
    expect(kids).toEqual(['cw-rail', 'cw-queue', 'cw-work']);
    const work = body.querySelector('.cw-work') as HTMLElement;
    expect([...work.children].map((c) => c.tagName)).toEqual(['MAIN', 'ASIDE']);
  });

  it('has no case panel on a screen that is not a case, so the work column is one pane', async () => {
    const w = await hubWorld();
    const { container } = renderHub(w);
    await screen.findByRole('region', { name: 'Open cases' });
    expect(container.querySelector('.cw-body')).toHaveAttribute('data-case', 'false');
    expect(container.querySelector('.cw-ctx')).toBeNull();
  });

  it('a role that cannot read reports gets two columns: no queue pane, rail and work', async () => {
    const w = await hubWorld({ role: 'moderator', permissions: { 'reports.read': 'owner' } });
    const { container } = renderHub(w);
    await waitFor(() => expect(container.querySelector('.cw-body')).not.toBeNull());
    const body = container.querySelector('.cw-body') as HTMLElement;
    expect(body).toHaveAttribute('data-queue', 'false');
    expect([...body.children].map((c) => c.className)).toEqual(['cw-rail', 'cw-work']);
    expect(within(body).queryByRole('region', { name: 'Open cases' })).toBeNull();
  });

  it('the top bar comes before the body, then the live regions and windows are outside the panes', async () => {
    const w = await hubWorld();
    const { container } = renderHub(w);
    await screen.findByRole('region', { name: 'Open cases' });
    const root = container.querySelector('.cw-hub') as HTMLElement;
    const order = [...root.children].map((c) => c.className || c.tagName);
    expect(order.indexOf('cw-top')).toBeLessThan(order.indexOf('cw-body'));
    expect(root.querySelector('.cw-body .cw-toasts')).toBeNull();
  });
});

describe('the breakpoints in the stylesheet', () => {
  it('three panes from 75rem (1200px): the case and its panel side by side, each scrolling on its own', () => {
    const three = media('min-width: 75rem');
    expect(three).toMatch(/\.cw-body\[data-case='true'\] \.cw-work\s*\{[^}]*grid-template-columns:\s*minmax\(0, 1fr\) var\(--cw-context-width\)/);
    expect(three).toMatch(/overflow-y:\s*auto/);
  });

  it('the body is rail, queue and work as columns, from the layout tokens', () => {
    expect(css).toMatch(/\.cw-hub \.cw-body\[data-queue='true'\]\s*\{[^}]*grid-template-columns:\s*var\(--cw-nav-width\) var\(--cw-queue-width\) minmax\(0, 1fr\)/);
  });

  it('two panes between 51.25rem (820px) and 75rem: the case panel is not a third column', () => {
    // Nothing outside the 75rem block turns the work column into a grid, so below it the case panel stacks under the case.
    const outside = css.replace(media('min-width: 75rem'), '');
    expect(outside).not.toMatch(/\.cw-work\s*\{[^}]*display:\s*grid/);
  });

  it('stacked below 820px: the page grows, the body is a block, the queue list is a short scroll box', () => {
    const phone = media('max-width: 51.1875rem');
    expect(phone).toMatch(/\.cw-hub\s*\{[^}]*height:\s*auto/);
    expect(phone).toMatch(/\.cw-body,\s*\.cw-hub \.cw-body\[data-queue='true'\]\s*\{[^}]*display:\s*block/);
    expect(phone).toMatch(/\.cw-queue-list\s*\{[^}]*max-height:\s*20rem/);
  });

  it('the breakpoints meet without a gap: 51.1875rem and 51.25rem are one pixel apart at 16px', () => {
    expect(51.25 * 16).toBe(820);
    expect(51.1875 * 16).toBe(819);
  });

  it('nothing is a fixed width wider than a phone outside a min-width query or min()', () => {
    // At 360px a rem width over 22rem would make the page scroll sideways.
    const base = css
      .replace(/@media \(min-width[^)]*\)\s*\{/g, '@@')
      .replace(/@container[^{]*min-width[^{]*\{/g, '@@')
      .split('\n')
      .filter((line) => /^\s*(min-)?width:\s*[\d.]+rem/.test(line) && !line.includes('min('));
    const wide = base.filter((line) => Number(/([\d.]+)rem/.exec(line)?.[1]) > 22);
    expect(wide).toEqual([]);
  });

  it('every pane can shrink: the grid children set min-width 0 and the case pane is a size container', () => {
    expect(css).toMatch(/\.cw-hub \.cw-work\s*\{[^}]*min-width:\s*0/);
    expect(css).toMatch(/\.cw-hub \.cw-main\s*\{[^}]*container-type:\s*inline-size/);
    expect(css).toMatch(/\.cw-hub \.cw-queue\s*\{[^}]*min-width:\s*0/);
  });

  it('the case pane reflows by its own width, not the window: the transcript drops its time and name columns when narrow', () => {
    expect(css).toMatch(/@container cwmain \(max-width: 34rem\)\s*\{[^}]*\.cw-line\s*\{[^}]*grid-template-columns:\s*1\.5rem auto minmax\(0, 1fr\)/);
    expect(media('min-width: 75rem') + media('max-width: 51.1875rem')).not.toMatch(/cw-line-text/);
  });
});

// The three things that made the report page scroll sideways by 107px at 390px in the first real-browser look: the "Only <name>"
// segment, the transcript box and the conduct-level segment (clipped to "Sever"). jsdom cannot measure, so these pin the rules that
// fix them; the real-browser check (Playwright at 360 and 390px) is in the task report.
describe('narrow screens: nothing makes the case pane wider than the page', () => {
  // The declarations of the first rule written as `selector {` on its own line (top level or inside a block).
  const rule = (selector: string): string => {
    const lines = css.split('\n');
    const at = lines.findIndex((l) => l.trim() === `${selector} {`);
    if (at < 0) return '';
    const end = lines.findIndex((l, i) => i > at && l.includes('}'));
    return lines.slice(at + 1, end).join('\n');
  };

  it('a segmented filter wraps onto more lines instead of clipping its buttons ("Only <name>", "Banter, Rude, Hostile, Severe")', () => {
    const seg = rule('.cw-hub .cw-seg');
    expect(seg).toMatch(/flex-wrap:\s*wrap/);
    expect(seg).toMatch(/min-width:\s*0/);
    expect(rule('.cw-hub .cw-seg button')).toMatch(/min-width:\s*0/);
    expect(rule('.cw-hub .cw-seg button')).toMatch(/overflow-wrap:\s*anywhere/);
  });

  it('the transcript can shrink and breaks long words: no fixed width, grid children with min-width 0', () => {
    expect(rule('.cw-hub .cw-transcript')).toMatch(/min-width:\s*0/);
    expect(rule('.cw-hub .cw-lines')).toMatch(/min-width:\s*0/);
    expect(rule('.cw-hub .cw-line')).toMatch(/min-width:\s*0/);
    expect(rule('.cw-hub .cw-line-text')).toMatch(/overflow-wrap:\s*anywhere/);
    expect(rule('.cw-hub .cw-line-text')).toMatch(/min-width:\s*0/);
  });

  it('the conduct-level picker and the verdict row wrap, and the suggestion card can shrink', () => {
    expect(rule('.cw-hub .cw-suggest-level')).toMatch(/min-width:\s*0/);
    // B6: the three verdicts are a three-column grid at every width, so they share one row at 360px (the key caps go on a phone).
    expect(rule('.cw-hub .cw-verdict-grid')).toMatch(/grid-template-columns:\s*repeat\(3, minmax\(0, 1fr\)\)/);
    expect(media('max-width: 51.1875rem')).toMatch(/\.cw-radio \.cw-kbd\s*\{[^}]*display:\s*none/);
    expect(rule('.cw-hub .cw-suggest-text')).toMatch(/min-width:\s*0/);
  });

  it('the pane columns are size-limited: the case pane, the dock body and the context sections can all shrink', () => {
    expect(rule('.cw-hub .cw-casepane')).toMatch(/min-width:\s*0/);
    expect(rule('.cw-hub .cw-dock')).toMatch(/min-width:\s*0/);
    expect(rule('.cw-hub .cw-ctx-section')).toMatch(/min-width:\s*0/);
  });

  it('tabs scroll inside their own row instead of widening the page', () => {
    expect(rule('.cw-hub .cw-tabs')).toMatch(/overflow-x:\s*auto/);
  });

  it('on a phone the decision bar is a sheet: closed it hides its body, open it scrolls inside itself, and the page keeps its own scroll', () => {
    const phone = media('max-width: 51.1875rem');
    expect(phone).toMatch(/\.cw-dock\[data-open='false'\] \.cw-dock-body\s*\{[^}]*display:\s*none/);
    expect(phone).toMatch(/\.cw-dock-body\s*\{[^}]*max-height:\s*70dvh/);
    expect(phone).toMatch(/\.cw-dock-bar\s*\{[^}]*display:\s*flex/);
    // The bar sticks to the bottom edge, on every width.
    expect(rule('.cw-hub .cw-dock')).toMatch(/position:\s*sticky/);
    expect(rule('.cw-hub .cw-dock')).toMatch(/bottom:\s*0/);
    // Outside a phone the sheet's toggle bar is not drawn.
    expect(rule('.cw-hub .cw-dock-bar')).toMatch(/display:\s*none/);
  });

  it('a desktop case pane is a column: header and tabs stay, the evidence scrolls, the decision bar is docked', () => {
    expect(rule('.cw-hub .cw-casepane')).toMatch(/flex-direction:\s*column/);
    expect(rule('.cw-hub .cw-case-scroll')).toMatch(/overflow-y:\s*auto/);
    expect(media('min-width: 75rem')).toMatch(/\.cw-body\[data-case='true'\] \.cw-main\s*\{[^}]*overflow:\s*hidden/);
  });
});

describe('the person page on a phone', () => {
  const rule = (selector: string): string => {
    const lines = css.split('\n');
    const at = lines.findIndex((l) => l.trim() === `${selector} {`);
    if (at < 0) return '';
    return lines.slice(at + 1, lines.findIndex((l, n) => n > at && l.includes('}'))).join('\n');
  };

  it('the title and its buttons wrap instead of widening the page, and can shrink', () => {
    expect(rule('.cw-hub .cw-personhead')).toMatch(/flex-wrap:\s*wrap/);
    expect(rule('.cw-hub .cw-personhead')).toMatch(/min-width:\s*0/);
    expect(rule('.cw-hub .cw-bar-actions')).toMatch(/flex-wrap:\s*wrap/);
  });

  it('a line of the timeline can shrink, and the revoke form fills the line instead of having a width', () => {
    expect(rule('.cw-hub .cw-rec-body')).toMatch(/min-width:\s*0/);
    expect(rule('.cw-hub .cw-revoke-form')).toMatch(/justify-self:\s*stretch/);
    expect(rule('.cw-hub .cw-revoke-form')).not.toMatch(/\bwidth:/);
  });

  it('a long unbroken handle breaks instead of widening the page: the person title and the name in an action row', () => {
    for (const sel of ['.cw-hub .cw-personhead .cw-screen-title', '.cw-hub .cw-arow-who']) {
      expect(rule(sel), sel).toMatch(/overflow-wrap:\s*anywhere/);
      expect(rule(sel), sel).toMatch(/min-width:\s*0/);
    }
  });

  it('colours nothing: the person page rules use neutral tokens only', () => {
    for (const sel of ['.cw-hub .cw-personhead', '.cw-hub .cw-revoke-form', '.cw-hub .cw-arow-who']) {
      expect(rule(sel), sel).not.toMatch(/var\(--cw-(accent|red|yellow|live)/);
    }
  });
});

// Fix round 1 (the real-browser check B2, B3, B5, B6): where the toasts stand, how tall the docked bar may be, what a hidden line
// looks like, and what is left of a decided case.
describe('fix round 1: the pane in the browser', () => {
  // Top-level rules only (a line that starts with the selector): the phone rules are read through media().
  const rule2 = (selector: string): string => {
    const lines = css.split('\n');
    const at = lines.findIndex((l) => l === `${selector} {`);
    if (at < 0) return '';
    const end = lines.findIndex((l, i) => i > at && l.includes('}'));
    return lines.slice(at + 1, end).join('\n');
  };

  it('B3: the toasts stand over the queue on a desktop, never centred at the bottom where the decision buttons are', () => {
    const toasts = rule2('.cw-hub .cw-toasts');
    expect(toasts).toMatch(/left:\s*calc\(var\(--cw-nav-width\) \+ var\(--cw-space-4\)\)/);
    expect(toasts).toMatch(/max-width:\s*calc\(var\(--cw-queue-width\)/);
    expect(toasts).not.toMatch(/left:\s*50%/);
    expect(toasts).not.toMatch(/translateX/);
  });

  it('B3: on a phone they hang from the top, under the header, inside the safe area, and not from the bottom', () => {
    const phone = media('max-width: 51.1875rem');
    expect(phone).toMatch(/\.cw-toasts\s*\{[^}]*top:\s*calc\(3\.5rem \+ env\(safe-area-inset-top, 0px\)\)/);
    expect(phone).toMatch(/\.cw-toasts\s*\{[^}]*bottom:\s*auto/);
  });

  // The phone rules only win if they come after the base rule they override: same specificity, so source order decides. A phone
  // block placed before its base rule lost to it in the browser (the toast stack kept the base bottom and left, took the phone top,
  // and stretched over the whole screen).
  it('every phone override comes after the base rule it overrides, so it wins the cascade', () => {
    const query = '@media (max-width: 51.1875rem)';
    const blocks: { start: number; body: string }[] = [];
    for (let from = css.indexOf(query); from >= 0; from = css.indexOf(query, from + 1)) {
      const open = css.indexOf('{', from);
      let depth = 0;
      let i = open;
      for (; i < css.length; i += 1) {
        if (css[i] === '{') depth += 1;
        if (css[i] === '}') {
          depth -= 1;
          if (depth === 0) break;
        }
      }
      blocks.push({ start: from, body: css.slice(open + 1, i) });
    }
    expect(blocks.length).toBeGreaterThan(0);
    const late: string[] = [];
    let checked = 0;
    for (const { start, body } of blocks) {
      for (const m of body.matchAll(/^\s+([^{}\n@][^{}\n]*?)\s*\{\s*$/gm)) {
        for (const selector of (m[1] as string).split(',').map((s) => s.trim())) {
          for (let at = css.indexOf(`\n${selector} {`); at >= 0; at = css.indexOf(`\n${selector} {`, at + 1)) {
            checked += 1;
            if (at > start) late.push(selector);
          }
        }
      }
    }
    expect(checked).toBeGreaterThan(10);
    expect(late).toEqual([]);
  });

  it('B5: the docked bar is capped to a third of the screen and scrolls inside itself, its buttons kept in view', () => {
    const body = rule2('.cw-hub .cw-dock-body');
    expect(body).toMatch(/max-height:\s*min\(34vh, 21rem\)/);
    expect(body).toMatch(/overflow-y:\s*auto/);
    expect(rule2('.cw-hub .cw-submit')).toMatch(/position:\s*sticky/);
  });

  it('B2: a hidden line is a quiet neutral pill (sunken surface, muted words), not an ink bar', () => {
    const mask = rule2('.cw-hub .cw-mask');
    expect(mask).toMatch(/background:\s*var\(--cw-surface-sunken\)/);
    expect(mask).toMatch(/color:\s*var\(--cw-ink-muted\)/);
    expect(mask).toMatch(/border-radius:\s*999px/);
    expect(mask).not.toMatch(/var\(--cw-ink\)/);
  });

  it('B1: a decided case leaves only the bar: it is static, its toggle is gone and its body is always shown, even on a phone', () => {
    expect(rule2(".cw-hub .cw-dock[data-gone='true']")).toMatch(/position:\s*static/);
    expect(rule2(".cw-hub .cw-dock[data-gone='true'] .cw-dock-bar")).toMatch(/display:\s*none/);
    expect(rule2(".cw-hub .cw-dock[data-gone='true'] .cw-dock-body")).toMatch(/display:\s*grid/);
    // The rule that closes the phone sheet comes first, so the decided case's rule (same weight, later) wins.
    expect(css.indexOf(".cw-dock[data-open='false'] .cw-dock-body")).toBeLessThan(css.indexOf(".cw-dock[data-gone='true'] .cw-dock-body"));
    expect(rule2('.cw-hub .cw-ctx[hidden]')).toMatch(/display:\s*none/);
  });
});

// Terms, Blocked, Rule gaps, Audit and the Guide are middle-pane views. A wide table scrolls inside its own box and never widens
// the page; every word, handle, note and guide line may break anywhere. jsdom has no layout, so this pins the structure and the
// rules; the real-browser check at 360px is in the task report.
describe('the admin screens on a phone', () => {
  const rule = (selector: string): string => {
    const lines = css.split('\n');
    const at = lines.findIndex((l) => l.trim() === `${selector} {`);
    if (at < 0) return '';
    return lines.slice(at + 1, lines.findIndex((l, n) => n > at && l.includes('}'))).join('\n');
  };

  it('a table lives in a scroll box that scrolls on its own and is never wider than the pane', () => {
    expect(rule('.cw-hub .cw-scroll')).toMatch(/overflow:\s*auto/);
    expect(rule('.cw-hub .cw-scroll')).toMatch(/max-width:\s*100%/);
  });

  it('every column has a floor, so a phone scrolls the table instead of squeezing it to nothing, and no floor is wider than a phone', () => {
    for (const sel of ['.cw-hub .cw-term-note', '.cw-hub .cw-term-count']) expect(rule(sel), sel).toMatch(/min-width:\s*[\d.]+rem/);
    expect(css).toMatch(/\.cw-hub \.cw-term-word,\n\.cw-hub \.cw-term-note,\n\.cw-hub \.cw-term-changed\s*\{[^}]*min-width:\s*8rem/);
  });

  it('long words break instead of widening anything: words, notes, gaps, rules, hits and the guide', () => {
    expect(css).toMatch(/\.cw-hub \.cw-term-word,\n\.cw-hub \.cw-term-note,\n\.cw-hub \.cw-term-changed\s*\{[^}]*overflow-wrap:\s*anywhere/);
    for (const sel of ['.cw-hub .cw-hits-list li', '.cw-hub .cw-doc pre']) expect(rule(sel), sel).toMatch(/overflow-wrap:\s*anywhere/);
    expect(css).toMatch(/\.cw-hub \.cw-gap-note,\n\.cw-hub \.cw-rule-text,\n\.cw-hub \.cw-rule-title\s*\{[^}]*overflow-wrap:\s*anywhere/);
    expect(css).toMatch(/\.cw-hub \.cw-doc p,\n\.cw-hub \.cw-doc li\s*\{[^}]*overflow-wrap:\s*anywhere/);
    expect(rule('.cw-hub .cw-doc pre')).toMatch(/white-space:\s*pre-wrap/);
    expect(rule('.cw-hub .cw-gap-note')).toMatch(/white-space:\s*pre-wrap/);
  });

  it('the forms lay their fields out by the room there is, not by the window', () => {
    for (const sel of ['.cw-hub .cw-termform-fields', '.cw-hub .cw-audit-filter']) {
      expect(rule(sel), sel).toMatch(/grid-template-columns:\s*repeat\(auto-fit, minmax\(min\(14rem, 100%\), 1fr\)\)/);
    }
  });

  it('colours nothing: these screens are neutral, and the document typography adds no link colour of its own', () => {
    const own = ['.cw-nowrap', '.cw-term-count', '.cw-row-actions', '.cw-terms-group', '.cw-hits', '.cw-hits-list', '.cw-gap', '.cw-rule', '.cw-doc', '.cw-doc code', '.cw-doc pre', '.cw-ladder-cell'];
    for (const sel of own) expect(rule(`.cw-hub ${sel}`), sel).not.toMatch(/var\(--cw-(accent|red|yellow|live)/);
    expect(css).not.toMatch(/\.cw-doc a\b/);
  });

  it('adds no phone-only rule: nothing here needs the cascade order to win', () => {
    expect(media('max-width: 51.1875rem')).not.toMatch(/cw-(term|doc\b|gap|rule|hits|ladder|audit|blocked-table)/);
  });

  it('each screen draws its table inside the scroll box', async () => {
    const w = await hubWorld({ role: 'senior' });
    w.blockLine('Vantablob', 'zorbak');
    const f = await w.file({ target: 'Vantablob' });
    await w.sanction(f.person, 'warning', 'uncovered');
    for (const [path, name] of [
      ['/terms', /^Terms in English/],
      ['/blocked', 'Blocked lines'],
      ['/audit', 'Audit entries'],
      ['/guide', 'Escalation ladder by step'],
    ] as const) {
      const { unmount } = renderHub(w, { path });
      const box = await screen.findByRole('region', { name });
      expect(box).toHaveClass('cw-scroll');
      expect(box).toHaveAttribute('tabindex', '0');
      expect(box.querySelector('table')).not.toBeNull();
      unmount();
    }
  });
});

describe('the bulk dismissal on a phone (360 px)', () => {
  const rule = (selector: string): string => {
    const lines = css.split('\n');
    const at = lines.findIndex((l) => l.trim() === `${selector} {`);
    if (at < 0) return '';
    return lines.slice(at + 1, lines.findIndex((l, n) => n > at && l.includes('}'))).join('\n');
  };

  it('the disclosure and its rows shrink and wrap: no fixed width, long names break, buttons wrap onto more lines', () => {
    expect(rule('.cw-hub .cw-bulk')).toMatch(/min-width:\s*0/);
    expect(rule('.cw-hub .cw-bulk-rows')).toMatch(/flex-wrap:\s*wrap/);
    expect(rule('.cw-hub .cw-bulk-rows .cw-btn')).toMatch(/max-width:\s*100%/);
    expect(rule('.cw-hub .cw-bulk-rows .cw-btn')).toMatch(/overflow-wrap:\s*anywhere/);
    expect(rule('.cw-hub .cw-bulk-row')).toMatch(/min-width:\s*0/);
  });

  it('the confirm window is never wider than the page, its title breaks long names and its buttons wrap', () => {
    expect(rule('.cw-hub .cw-bulk-dialog')).toMatch(/max-width:\s*100%/);
    expect(rule('.cw-hub .cw-bulk-title')).toMatch(/overflow-wrap:\s*anywhere/);
    expect(rule('.cw-hub .cw-bulk-buttons')).toMatch(/flex-wrap:\s*wrap/);
    expect(rule('.cw-hub .cw-dialog')).toMatch(/width:\s*min\(38rem,\s*100%\)/);
  });

  it('colours nothing: the disclosure is neutral (its focus ring is the one accent use)', () => {
    for (const sel of ['.cw-hub .cw-bulk', '.cw-hub .cw-bulk > summary', '.cw-hub .cw-bulk-rows', '.cw-hub .cw-bulk-dialog']) {
      expect(rule(sel), sel).not.toMatch(/--cw-(red|yellow|green|accent)/);
    }
  });
});
