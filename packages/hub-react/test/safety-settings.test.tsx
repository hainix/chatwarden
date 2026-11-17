import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_SAFETY_GUIDANCE } from '@chatwarden/core';
import { renderHub } from './render.js';
import { hubWorld } from './world.js';
import type { HubWorld, WorldOptions } from './world.js';

// Settings > Advanced > "Safety and urgent cases" (design 4 and 5.3): the owner's words for an urgent case (guidance, studio contact, the
// reporter's resources), collapsed by default, a lazy panel, the owner edits and everyone else reads. The default guidance is only a
// placeholder and is never saved unless the owner edits it.

afterEach(() => cleanup());

const owner = (o: WorldOptions = {}) => hubWorld({ role: 'owner', actor: 'owen@example.test', ...o });
type User = ReturnType<typeof renderHub>['user'];

const panel = (): HTMLElement => screen.getByRole('region', { name: 'Safety and urgent cases' });
async function open(w: HubWorld, expand = true) {
  const r = renderHub(w, { path: '/settings/advanced' });
  await screen.findByRole('heading', { level: 2, name: 'Advanced' });
  await screen.findByRole('region', { name: 'Safety and urgent cases' });
  if (expand) await r.user.click(within(panel()).getByRole('button', { name: 'Guidance, contact and resources' }));
  return r;
}
const puts = (w: HubWorld) => w.sent.filter((r) => r.method === 'PUT' && r.path === '/policy/profile');
const guidance = (): HTMLTextAreaElement => within(panel()).getByRole('textbox', { name: 'Guidance for moderators' }) as HTMLTextAreaElement;
const contact = (): HTMLInputElement => within(panel()).getByRole('textbox', { name: 'Studio contact (staff only)' }) as HTMLInputElement;
async function save(user: User, why = 'Our safety process is set') {
  await user.click(within(panel()).getByRole('button', { name: 'Save changes' }));
  await user.type(screen.getByRole('textbox', { name: /Why are you changing this/ }), why);
  await user.click(within(panel()).getByRole('button', { name: 'Save changes' }));
}
const savedSafety = (w: HubWorld) => (puts(w)[0]?.body as { layer: { safety?: Record<string, unknown> } & Record<string, unknown> }).layer;

describe('the panel', () => {
  it('is in Advanced, collapsed by default, and the form opens from one button', async () => {
    const w = await owner();
    await open(w, false);
    const button = within(panel()).getByRole('button', { name: 'Guidance, contact and resources' });
    expect(button).toHaveAttribute('aria-expanded', 'false');
    expect(within(panel()).queryByRole('textbox')).toBeNull();
    fireEvent.click(button);
    expect(button).toHaveAttribute('aria-expanded', 'true');
    expect(guidance()).toBeInTheDocument();
  });

  it('is a lazy part: the Advanced screen asks for its code', async () => {
    const { partLoaders, resetLazyParts } = await import('../src/lazyParts.js');
    resetLazyParts();
    const asked: string[] = [];
    const real = { ...partLoaders };
    (partLoaders as Record<string, () => unknown>)['safetyPanel'] = () => {
      asked.push('safetyPanel');
      return (real as Record<string, () => unknown>)['safetyPanel']?.();
    };
    try {
      const w = await owner();
      await open(w, false);
      expect(asked).toEqual(['safetyPanel']);
    } finally {
      Object.assign(partLoaders, real);
    }
  });

  it('says what the kit does not do, and that the guidance is not legal advice', async () => {
    const w = await owner();
    await open(w);
    expect(within(panel()).getByText('Chatwarden does not judge risk, contact anyone or forward images. It holds text only.')).toBeInTheDocument();
    expect(within(panel()).getByText(/not legal advice/i)).toBeInTheDocument();
  });

  it('shows the default guidance as the placeholder, not as the value', async () => {
    const w = await owner();
    await open(w);
    expect(guidance().value).toBe('');
    expect(guidance().placeholder).toBe(DEFAULT_SAFETY_GUIDANCE);
  });

  it('the owner edits; a senior and a moderator read the same values, read-only, with no save bar', async () => {
    for (const role of ['senior', 'moderator'] as const) {
      cleanup();
      const w = await hubWorld({ role, actor: `${role}@example.test`, overrides: { safety: { guidance: 'Call the duty officer.', contact: 'Pat, 555-0100', resources: [{ label: 'Crisis line', url: 'https://help.example.test' }] } } });
      await open(w);
      expect(guidance().value).toBe('Call the duty officer.');
      expect(contact().value).toBe('Pat, 555-0100');
      expect(guidance()).toBeDisabled();
      expect(contact()).toBeDisabled();
      expect(within(panel()).getByRole('textbox', { name: 'Resource 1: name' })).toBeDisabled();
      expect(within(panel()).queryByRole('button', { name: 'Save changes' })).toBeNull();
      expect(within(panel()).queryByRole('button', { name: 'Add a resource' })).toBeNull();
    }
  });

  it('a role without policy.read has no Advanced, never reads the profile, and the contact is nowhere on the page', async () => {
    const w = await hubWorld({ role: 'moderator', permissions: { 'policy.read': 'owner' }, overrides: { safety: { contact: 'Pat, 555-0100' } } });
    renderHub(w, { path: '/settings/advanced' });
    await waitFor(() => expect(screen.queryByRole('heading', { level: 2, name: 'Advanced' })).toBeNull());
    expect(screen.queryByRole('region', { name: 'Safety and urgent cases' })).toBeNull();
    expect(w.sent.filter((r) => r.path === '/policy/profile')).toHaveLength(0);
    expect(document.body.textContent).not.toContain('555-0100');
  });
});

describe('saving', () => {
  it('sends the whole layer with safety merged in, and a reason: what another screen saved is kept', async () => {
    const w = await owner();
    w.cw.policy.save({ pace: { slowModeMs: 4000 } }, { version: 0, actor: 'x', reason: 'seed' });
    const { user } = await open(w);
    await user.type(guidance(), 'Pass it to Pat at once.');
    await user.type(contact(), 'Pat, 555-0100');
    await user.click(within(panel()).getByRole('button', { name: 'Add a resource' }));
    await user.type(within(panel()).getByRole('textbox', { name: 'Resource 1: name' }), 'Crisis line');
    await user.type(within(panel()).getByRole('textbox', { name: 'Resource 1: detail' }), 'Free, all night');
    await user.type(within(panel()).getByRole('textbox', { name: 'Resource 1: link' }), 'https://help.example.test/line');
    await save(user);
    await waitFor(() => expect(puts(w)).toHaveLength(1));
    const body = puts(w)[0]?.body as { layer: Record<string, unknown>; reason: string; version: number };
    expect(body.reason).toBe('Our safety process is set');
    expect(body.layer['pace']).toEqual({ slowModeMs: 4000 });
    expect(body.layer['safety']).toEqual({ guidance: 'Pass it to Pat at once.', contact: 'Pat, 555-0100', resources: [{ label: 'Crisis line', detail: 'Free, all night', url: 'https://help.example.test/line' }] });
    expect(w.cw.profile.safety.contact).toBe('Pat, 555-0100');
    expect(w.cw.profile.pace.slowModeMs).toBe(4000);
    await screen.findByText('Safety settings saved.');
  });

  it('the default guidance is not saved unless edited: a contact alone saves a safety section with no guidance', async () => {
    const w = await owner();
    const { user } = await open(w);
    await user.type(contact(), 'Pat, 555-0100');
    await save(user);
    await waitFor(() => expect(puts(w)).toHaveLength(1));
    expect(savedSafety(w).safety).toEqual({ contact: 'Pat, 555-0100' });
    expect(w.cw.profile.safety.guidance).toBe(DEFAULT_SAFETY_GUIDANCE);
  });

  it('typing and clearing again is not a change: Save changes asks for nothing', async () => {
    const w = await owner();
    const { user } = await open(w);
    await user.type(guidance(), 'abc');
    await user.clear(guidance());
    await user.click(within(panel()).getByRole('button', { name: 'Save changes' }));
    expect(screen.queryByRole('textbox', { name: /Why are you changing this/ })).toBeNull();
    expect(puts(w)).toHaveLength(0);
  });

  it('a reason is required', async () => {
    const w = await owner();
    const { user } = await open(w);
    await user.type(contact(), 'Pat');
    await user.click(within(panel()).getByRole('button', { name: 'Save changes' }));
    await user.click(within(panel()).getByRole('button', { name: 'Save changes' }));
    expect(await screen.findByText('Say why you are changing this.')).toBeInTheDocument();
    expect(puts(w)).toHaveLength(0);
  });

  it('a conflict (someone saved first) offers a reload that brings their values', async () => {
    const w = await owner();
    const { user } = await open(w);
    await user.type(contact(), 'Mine');
    await w.clientFor('bea@example.test', 'owner').savePolicyProfile({ layer: { safety: { contact: 'Theirs' } }, version: 0, reason: 'first' });
    await save(user);
    await screen.findByText('Someone else changed these settings.');
    await user.click(within(panel()).getByRole('button', { name: 'Reload' }));
    await waitFor(() => expect(contact().value).toBe('Theirs'));
  });

  it('reset restores what the profile in code says', async () => {
    const w = await owner({ overrides: { safety: { contact: 'From code' } } });
    w.cw.policy.save({ safety: { contact: 'Mine' } }, { version: 0, actor: 'x', reason: 'seed' });
    const { user } = await open(w);
    expect(contact().value).toBe('Mine');
    await user.click(within(panel()).getByRole('button', { name: 'Reset safety settings' }));
    await user.type(screen.getByRole('textbox', { name: /Why are you resetting/ }), 'Back to the base');
    await user.click(within(screen.getByRole('group', { name: 'Reset safety settings?' })).getByRole('button', { name: 'Reset' }));
    await waitFor(() => expect(contact().value).toBe('From code'));
    expect(w.cw.profile.safety.contact).toBe('From code');
  });

  it('a refusal from the kit that names the contact marks that field, in words', async () => {
    const w = await owner();
    const { user } = await open(w);
    await user.type(contact(), 'Pat');
    w.intercept.fn = (req) => (req.method === 'PUT' && req.path === '/policy/profile' ? { status: 400, body: { error: 'invalid_profile', message: 'x', path: 'layer.safety.contact' } } : undefined);
    await save(user);
    await waitFor(() => expect(contact()).toHaveAttribute('aria-invalid', 'true'));
    expect(within(panel()).getByText("This setting isn't allowed.")).toBeInTheDocument();
  });
});

describe('what is refused before anything is sent, in words that name the field', () => {
  it('guidance over 1500 characters', async () => {
    const w = await owner();
    const { user } = await open(w);
    fireEvent.change(guidance(), { target: { value: 'g'.repeat(1501) } });
    expect(within(panel()).getByText('Guidance is 1501 characters. Keep it to 1500 or fewer.')).toBeInTheDocument();
    expect(guidance()).toHaveAttribute('aria-invalid', 'true');
    await user.click(within(panel()).getByRole('button', { name: 'Save changes' }));
    expect(puts(w)).toHaveLength(0);
    fireEvent.change(guidance(), { target: { value: 'g'.repeat(1500) } });
    expect(within(panel()).queryByText(/Keep it to 1500/)).toBeNull();
  });

  it('a contact line over 300 characters', async () => {
    const w = await owner();
    await open(w);
    fireEvent.change(contact(), { target: { value: 'c'.repeat(301) } });
    expect(within(panel()).getByText('The contact line is 301 characters. Keep it to 300 or fewer.')).toBeInTheDocument();
    expect(contact()).toHaveAttribute('aria-invalid', 'true');
  });

  it('a sixth resource: the button stops at five and says why', async () => {
    const w = await owner();
    const { user } = await open(w);
    for (let i = 0; i < 5; i += 1) await user.click(within(panel()).getByRole('button', { name: 'Add a resource' }));
    expect(within(panel()).getAllByRole('textbox', { name: /Resource \d: name/ })).toHaveLength(5);
    const add = within(panel()).getByRole('button', { name: 'Add a resource' });
    expect(add).toHaveAttribute('aria-disabled', 'true');
    await user.click(add);
    expect(within(panel()).getAllByRole('textbox', { name: /Resource \d: name/ })).toHaveLength(5);
    expect(within(panel()).getByText('You can list at most 5 resources.')).toBeInTheDocument();
  });

  it('a link that is not https, and a resource with no name, name the resource', async () => {
    const w = await owner();
    const { user } = await open(w);
    await user.click(within(panel()).getByRole('button', { name: 'Add a resource' }));
    await user.click(within(panel()).getByRole('button', { name: 'Add a resource' }));
    await user.type(within(panel()).getByRole('textbox', { name: 'Resource 1: name' }), 'Line');
    await user.type(within(panel()).getByRole('textbox', { name: 'Resource 1: link' }), 'http://help.example.test');
    expect(within(panel()).getByText('Resource 1: the link must start with https://.')).toBeInTheDocument();
    expect(within(panel()).getByText('Resource 2: give it a name.')).toBeInTheDocument();
    await user.click(within(panel()).getByRole('button', { name: 'Save changes' }));
    expect(puts(w)).toHaveLength(0);
  });

  it('a javascript: link, a link with credentials, and a name over 60 characters are refused too', async () => {
    const w = await owner();
    const { user } = await open(w);
    await user.click(within(panel()).getByRole('button', { name: 'Add a resource' }));
    const name = within(panel()).getByRole('textbox', { name: 'Resource 1: name' });
    const link = within(panel()).getByRole('textbox', { name: 'Resource 1: link' });
    fireEvent.change(name, { target: { value: 'n'.repeat(61) } });
    expect(within(panel()).getByText('Resource 1: the name is over 60 characters.')).toBeInTheDocument();
    fireEvent.change(name, { target: { value: 'ok' } });
    for (const bad of ['javascript:alert(1)', 'ftp://help.example.test', 'HTTP://help.example.test']) {
      fireEvent.change(link, { target: { value: bad } });
      expect(within(panel()).getByText('Resource 1: the link must start with https://.'), bad).toBeInTheDocument();
    }
    fireEvent.change(link, { target: { value: 'https://user:pw@help.example.test' } });
    expect(within(panel()).getByText('Resource 1: the link must not hold a user name or password.')).toBeInTheDocument();
    fireEvent.change(link, { target: { value: 'https://' } });
    expect(within(panel()).getByText('Resource 1: that is not a valid link.')).toBeInTheDocument();
    fireEvent.change(link, { target: { value: 'https://help.example.test/ok' } });
    expect(within(panel()).queryByText(/Resource 1: (the link|that is)/)).toBeNull();
  });

  it('removing a resource keeps the others in order', async () => {
    const w = await owner({ overrides: { safety: { resources: [{ label: 'One' }, { label: 'Two' }, { label: 'Three' }] } } });
    const { user } = await open(w);
    await user.click(within(panel()).getByRole('button', { name: 'Remove resource 2' }));
    const names = within(panel()).getAllByRole('textbox', { name: /Resource \d: name/ }).map((e) => (e as HTMLInputElement).value);
    expect(names).toEqual(['One', 'Three']);
  });
});
