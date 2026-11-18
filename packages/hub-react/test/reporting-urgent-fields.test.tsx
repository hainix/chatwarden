import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { renderHub } from './render.js';
import { hubWorld } from './world.js';
import type { HubWorld } from './world.js';

// Reporting settings, the per-reason fields of the urgent lane (design 4 and 17): "Urgent", "Thank-you for this reason" and "Show help
// resources", behind a disclosure on each reason; `welfare` listed switched off with its help; a thank-you over 300 characters refused;
// switching urgent off warns that reports already filed stay urgent. Real staff routes, real kit.

const owner = (o: Parameters<typeof hubWorld>[0] = {}) => hubWorld({ role: 'owner', actor: 'owen@example.test', ...o });
type User = ReturnType<typeof renderHub>['user'];

async function open(w: HubWorld) {
  const r = renderHub(w, { path: '/settings/reporting' });
  await screen.findByRole('heading', { level: 2, name: 'Reporting' });
  await screen.findByRole('list', { name: 'Reasons' });
  return r;
}
const row = (name: string): HTMLElement => screen.getByRole('group', { name: `Reason: ${name}` });
const more = (name: string): HTMLElement => within(row(name)).getByRole('button', { name: `More about ${name}` });
async function expand(user: User, name: string): Promise<HTMLElement> {
  await user.click(more(name));
  return within(row(name)).getByRole('group', { name: `After a report about ${name}` });
}
async function save(user: User, reason = 'Tournament week') {
  await user.click(screen.getByRole('button', { name: 'Save changes' }));
  await user.type(screen.getByRole('textbox', { name: /Why are you changing this/ }), reason);
  await user.click(screen.getByRole('button', { name: 'Save changes' }));
}
const puts = (w: HubWorld) => w.sent.filter((r) => r.method === 'PUT' && r.path === '/policy/profile');

describe('the three fields under each reason', () => {
  it('are behind a disclosure on each reason, closed by default, and add nothing else to the row', async () => {
    const w = await owner();
    await open(w);
    const button = more('Threats');
    expect(button).toHaveAttribute('aria-expanded', 'false');
    expect(within(row('Threats')).queryByRole('checkbox', { name: 'Urgent' })).toBeNull();
    expect(within(row('Threats')).queryByRole('textbox', { name: 'Thank-you for this reason' })).toBeNull();
  });

  it('show Urgent, Thank-you for this reason and Show help resources when opened', async () => {
    const w = await owner();
    const { user } = await open(w);
    const box = await expand(user, 'Spam or ads');
    expect(more('Spam or ads')).toHaveAttribute('aria-expanded', 'true');
    expect(within(box).getByRole('checkbox', { name: 'Urgent' })).not.toBeChecked();
    expect(within(box).getByRole('textbox', { name: 'Thank-you for this reason' })).toHaveValue('');
    expect(within(box).getByRole('checkbox', { name: 'Show help resources' })).not.toBeChecked();
    await user.click(more('Spam or ads'));
    expect(within(row('Spam or ads')).queryByRole('checkbox', { name: 'Urgent' })).toBeNull();
  });

  it('the Urgent box is checked for Threats and for the welfare reason by default', async () => {
    const w = await owner();
    const { user } = await open(w);
    expect(within(await expand(user, 'Threats')).getByRole('checkbox', { name: 'Urgent' })).toBeChecked();
    expect(within(await expand(user, 'Someone may be in trouble')).getByRole('checkbox', { name: 'Urgent' })).toBeChecked();
    expect(within(row('Someone may be in trouble')).getByRole('checkbox', { name: 'Show help resources' })).toBeChecked();
  });

  it('the welfare reason is listed switched off, with its help in one line', async () => {
    const w = await owner();
    await open(w);
    const welfare = row('Someone may be in trouble');
    expect(within(welfare).getByRole('checkbox', { name: 'Switched on' })).not.toBeChecked();
    expect(within(welfare).getByText(/Off until you turn it on/)).toBeInTheDocument();
    expect(within(row('Threats')).queryByText(/Off until you turn it on/)).toBeNull();
  });

  it('a read-only role sees them without opening anything, disabled', async () => {
    const w = await hubWorld({ role: 'moderator' });
    await open(w);
    expect(within(row('Threats')).queryByRole('button', { name: 'More about Threats' })).toBeNull();
    const box = within(row('Threats')).getByRole('group', { name: 'After a report about Threats' });
    expect(within(box).getByRole('checkbox', { name: 'Urgent' })).toBeDisabled();
    expect(within(box).getByRole('textbox', { name: 'Thank-you for this reason' })).toBeDisabled();
    expect(within(box).getByRole('checkbox', { name: 'Show help resources' })).toBeDisabled();
  });
});

describe('the thank-you for one reason', () => {
  it('shows a count, and over 300 characters it is refused in words and nothing is sent', async () => {
    const w = await owner();
    const { user } = await open(w);
    const box = await expand(user, 'Spam or ads');
    const field = within(box).getByRole('textbox', { name: 'Thank-you for this reason' });
    expect(within(box).getByText('0 of 300 characters')).toBeInTheDocument();
    fireEvent.change(field, { target: { value: 'x'.repeat(300) } });
    expect(within(box).getByText('300 of 300 characters')).toBeInTheDocument();
    expect(within(box).queryByText(/300 characters or fewer/)).toBeNull();
    fireEvent.change(field, { target: { value: 'x'.repeat(301) } });
    expect(within(box).getByText('301 of 300 characters')).toBeInTheDocument();
    expect(field).toHaveAttribute('aria-invalid', 'true');
    expect(within(box).getByText('Keep this to 300 characters or fewer.')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    expect(screen.queryByRole('textbox', { name: /Why are you changing this/ })).toBeNull();
    expect(puts(w)).toHaveLength(0);
  });

  it('counts an emoji as one character', async () => {
    const w = await owner();
    const { user } = await open(w);
    const box = await expand(user, 'Spam or ads');
    fireEvent.change(within(box).getByRole('textbox', { name: 'Thank-you for this reason' }), { target: { value: '\u{1F600}'.repeat(300) } });
    expect(within(box).getByText('300 of 300 characters')).toBeInTheDocument();
    expect(within(box).queryByText('Keep this to 300 characters or fewer.')).toBeNull();
  });

  it('a blank thank-you means the general one: nothing is sent for it', async () => {
    const w = await owner();
    const { user } = await open(w);
    const box = await expand(user, 'Spam or ads');
    const field = within(box).getByRole('textbox', { name: 'Thank-you for this reason' });
    await user.type(field, '   ');
    await user.click(within(box).getByRole('checkbox', { name: 'Urgent' }));
    await save(user);
    await waitFor(() => expect(puts(w)).toHaveLength(1));
    const spam = w.cw.profile.reporting.reasons.find((r) => r.id === 'spam');
    expect(spam?.thanks).toBeNull();
    expect(spam?.urgent).toBe(true);
  });

  it('shows what a player reads after reporting this reason, in a plain read-only box: the reason\'s own, else the general one', async () => {
    const w = await owner();
    const { user } = await open(w);
    const box = await expand(user, 'Spam or ads');
    const shown = within(box).getByRole('note', { name: 'What a player reads after reporting this' });
    const general = (screen.getByRole('textbox', { name: 'What players read after they report' }) as HTMLTextAreaElement).value;
    expect(shown).toHaveTextContent(general);
    await user.type(within(box).getByRole('textbox', { name: 'Thank-you for this reason' }), 'Thanks, a moderator will look.');
    expect(shown).toHaveTextContent('Thanks, a moderator will look.');
    expect(shown.tagName).not.toBe('TEXTAREA');
    expect(shown).not.toHaveAttribute('contenteditable');
  });

  it('renders hostile text as text (the box and the field never make markup)', async () => {
    const w = await owner();
    const { user } = await open(w);
    const box = await expand(user, 'Spam or ads');
    fireEvent.change(within(box).getByRole('textbox', { name: 'Thank-you for this reason' }), { target: { value: '<img src=x onerror=alert(1)> [a](https://x.test)' } });
    expect(box.querySelector('img, a')).toBeNull();
  });
});

describe('switching urgent off', () => {
  it('warns that reports already filed stay urgent, and the warning goes when it is switched back on', async () => {
    const w = await owner();
    const { user } = await open(w);
    const box = await expand(user, 'Threats');
    expect(within(box).queryByText('Reports already filed stay urgent.')).toBeNull();
    await user.click(within(box).getByRole('checkbox', { name: 'Urgent' }));
    expect(within(box).getByText('Reports already filed stay urgent.')).toBeInTheDocument();
    await user.click(within(box).getByRole('checkbox', { name: 'Urgent' }));
    expect(within(box).queryByText('Reports already filed stay urgent.')).toBeNull();
  });

  it('does not warn for a reason that was never urgent', async () => {
    const w = await owner();
    const { user } = await open(w);
    const box = await expand(user, 'Spam or ads');
    await user.click(within(box).getByRole('checkbox', { name: 'Urgent' }));
    await user.click(within(box).getByRole('checkbox', { name: 'Urgent' }));
    expect(within(box).queryByText('Reports already filed stay urgent.')).toBeNull();
  });

  it('saves it: new reports under the reason are no longer urgent, those already filed stay so', async () => {
    const w = await owner();
    const before = await w.file({ target: 'Early', reason: 'threat' });
    const { user } = await open(w);
    const box = await expand(user, 'Threats');
    await user.click(within(box).getByRole('checkbox', { name: 'Urgent' }));
    await save(user);
    await waitFor(() => expect(puts(w)).toHaveLength(1));
    const after = await w.file({ target: 'Late', reason: 'threat' });
    expect((await w.direct.getReport(before.id)).report.urgent).toBe(true);
    expect((await w.direct.getReport(after.id)).report.urgent).toBe(false);
  });
});

describe('saving the fields', () => {
  it('sends the reason\'s thank-you, urgent and resources flags in the whole reasons list', async () => {
    const w = await owner();
    const { user } = await open(w);
    const box = await expand(user, 'Spam or ads');
    await user.type(within(box).getByRole('textbox', { name: 'Thank-you for this reason' }), 'We will check it.');
    await user.click(within(box).getByRole('checkbox', { name: 'Show help resources' }));
    await save(user);
    await waitFor(() => expect(puts(w)).toHaveLength(1));
    const reasons = (puts(w)[0]?.body as { layer: { reporting: { reasons: Array<{ id: string; thanks: string | null; urgent: boolean; showResources: boolean }> } } }).layer.reporting.reasons;
    const spam = reasons.find((r) => r.id === 'spam');
    expect(spam).toMatchObject({ thanks: 'We will check it.', urgent: false, showResources: true });
    // The others keep what they had (the list replaces the whole list).
    expect(reasons.find((r) => r.id === 'threat')).toMatchObject({ urgent: true, thanks: null });
    expect(w.cw.profile.reporting.reasons.find((r) => r.id === 'spam')?.thanks).toBe('We will check it.');
  });

  it('is dirty only for a real change: opening the disclosure and leaving the values alone changes nothing', async () => {
    const w = await owner();
    const { user } = await open(w);
    await expand(user, 'Threats');
    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    expect(screen.queryByRole('textbox', { name: /Why are you changing this/ })).toBeNull();
    expect(puts(w)).toHaveLength(0);
  });

  it('a refusal from the kit that names the thank-you marks that field', async () => {
    const w = await owner();
    const { user } = await open(w);
    const box = await expand(user, 'Spam or ads');
    await user.type(within(box).getByRole('textbox', { name: 'Thank-you for this reason' }), 'Hello');
    w.intercept.fn = (req) => {
      if (req.method === 'PUT' && req.path === '/policy/profile') {
        const index = w.cw.profile.reporting.reasons.findIndex((r) => r.id === 'spam');
        return { status: 400, body: { error: 'invalid_profile', message: 'x', path: `layer.reporting.reasons[${index}].thanks` } };
      }
      return undefined;
    };
    await save(user);
    await waitFor(() => expect(within(row('Spam or ads')).getByRole('textbox', { name: 'Thank-you for this reason' })).toHaveAttribute('aria-invalid', 'true'));
  });
});
