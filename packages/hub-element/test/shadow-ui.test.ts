import { waitFor } from '@testing-library/dom';
import { userEvent } from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { goTo, hubShown, inside, mount } from './helpers.js';
import { hubWorld } from './world.js';

// The hub's windows (the command bar, the shortcut sheet), its toasts and its keys, inside a shadow root. hub-react draws every
// one of them in place (no portal to document.body), which is why the stylesheet in the shadow root reaches them. Its keys listen
// on the page and read `document.activeElement`; the element makes those work from inside the shadow root and keeps them quiet
// while the page outside has focus.

const root = (el: Element): ShadowRoot => el.shadowRoot as ShadowRoot;

describe('windows and toasts are drawn inside the shadow root', () => {
  it('the command bar (Ctrl+K) opens in the shadow root, takes focus, and gives it back on Escape', async () => {
    const w = await hubWorld();
    const el = mount({ mode: 'detailed' }, { client: w.client });
    await hubShown(el);
    const user = userEvent.setup();
    const skip = root(el).querySelector<HTMLElement>('.cw-skip') as HTMLElement;
    skip.focus();
    expect(root(el).activeElement).toBe(skip);
    await user.keyboard('{Control>}k{/Control}');
    const dialog = await inside(el).findByRole('dialog', { name: 'Command bar' });
    expect(root(el).contains(dialog)).toBe(true);
    expect(document.body.querySelector('[role="dialog"]')).toBeNull();
    await waitFor(() => expect(root(el).activeElement?.tagName).toBe('INPUT'));
    await user.keyboard('{Escape}');
    await waitFor(() => expect(inside(el).queryByRole('dialog')).toBeNull());
    // Focus is back where it was (inside the shadow root), not lost to the page.
    expect(root(el).activeElement).toBe(skip);
  });

  it('the shortcut sheet traps Tab inside itself', async () => {
    const w = await hubWorld();
    const el = mount({ mode: 'detailed' }, { client: w.client });
    await hubShown(el);
    const user = userEvent.setup();
    root(el).querySelector<HTMLElement>('.cw-skip')?.focus();
    await user.keyboard('?');
    const dialog = await inside(el).findByRole('dialog', { name: 'Keyboard shortcuts' });
    for (let i = 0; i < 4; i++) {
      await user.tab();
      expect(dialog.contains(root(el).activeElement)).toBe(true);
    }
    await user.tab({ shift: true });
    expect(dialog.contains(root(el).activeElement)).toBe(true);
  });

  it('the Undo toast is in the shadow root, never on the page', async () => {
    const w = await hubWorld();
    const f = await w.fileRich();
    goTo(`/reports/${f.id}`);
    const el = mount({ mode: 'simple' }, { client: w.client });
    const q = inside(el);
    (await q.findByRole('button', { name: /^Restrict chat, 24 hours/ }, { timeout: 5000 })).click();
    const undo = (await q.findAllByRole('button', { name: /^Undo/ }))[0] as HTMLElement;
    expect(root(el).contains(undo)).toBe(true);
    expect(document.body.textContent).not.toContain('Undo');
    expect(document.querySelector('[aria-label="Notifications"]')).toBeNull();
  });
});

describe('keys', () => {
  async function twoCases() {
    const w = await hubWorld();
    await w.fileRich({ target: 'Mallory', reporter: 'Rae', room: 'one' });
    await w.fileRich({ target: 'Zed', reporter: 'Kit', room: 'two' });
    const el = mount({ mode: 'detailed' }, { client: w.client });
    await hubShown(el);
    await waitFor(() => expect(root(el).querySelectorAll('.cw-queue .cw-case-link').length).toBe(2), { timeout: 5000 });
    const rows = [...root(el).querySelectorAll<HTMLElement>('.cw-queue .cw-case-link')];
    return { w, el, rows };
  }

  it('J and K move between cases when focus is inside the shadow root', async () => {
    const { el, rows } = await twoCases();
    const user = userEvent.setup();
    rows[0]?.focus();
    expect(root(el).activeElement).toBe(rows[0]);
    await user.keyboard('j');
    expect(root(el).activeElement).toBe(rows[1]);
    await user.keyboard('k');
    expect(root(el).activeElement).toBe(rows[0]);
  });

  it('do nothing while the page outside has focus', async () => {
    const { el } = await twoCases();
    const outside = document.createElement('button');
    outside.textContent = 'page button';
    document.body.append(outside);
    outside.focus();
    const user = userEvent.setup();
    await user.keyboard('j');
    await user.keyboard('?');
    await user.keyboard('{Control>}k{/Control}');
    await new Promise((r) => setTimeout(r, 30));
    expect(document.activeElement).toBe(outside);
    expect(inside(el).queryByRole('dialog')).toBeNull();
    expect(root(el).activeElement).toBeNull();
  });

  it('do nothing while typing in a field inside the shadow root', async () => {
    const w = await hubWorld({ role: 'owner' });
    goTo('/terms');
    const el = mount({ mode: 'detailed' }, { client: w.client });
    await hubShown(el);
    const field = await waitFor(
      () => {
        const f = root(el).querySelector<HTMLInputElement | HTMLTextAreaElement>('main input:not([type="checkbox"]):not([type="radio"]):not([type="hidden"]), main textarea');
        expect(f).not.toBeNull();
        return f as HTMLInputElement | HTMLTextAreaElement;
      },
      { timeout: 5000 },
    );
    field.focus();
    const user = userEvent.setup();
    await user.keyboard('j?n');
    expect(field.value).toBe('j?n');
    await new Promise((r) => setTimeout(r, 30));
    expect(inside(el).queryByRole('dialog')).toBeNull();
  });

  it('with shortcuts="false" nothing listens, inside or out', async () => {
    const { el, rows } = await twoCases();
    el.setAttribute('shortcuts', 'false');
    await new Promise((r) => setTimeout(r, 30));
    const user = userEvent.setup();
    rows[0]?.focus();
    await user.keyboard('j');
    expect(root(el).activeElement).toBe(rows[0]);
  });
});
