import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { appealsHub, HOUR } from './appealsWorld.js';
import type { AppealsHub } from './appealsWorld.js';
import { renderHub } from './render.js';
import type { WorldOptions } from './world.js';
import type { TransportRequest } from '../src/transport.js';

// The appeal card (appeals, design 4.9): what the player said (plain text, hidden when it trips the filter), what they were shown, who gave the sanction, and
// three ways to rule on it with a private reason. Against the real routes. A senior decides (a moderator may not by default), and never the person who made the
// original decision. Synthetic words only: "zorbak" is a slur in the test term list.

const SENIOR: WorldOptions = { role: 'senior', actor: 'bea@example.test' };
const decides = (w: AppealsHub): TransportRequest[] => w.sent.filter((r) => r.method === 'POST' && /^\/appeals\/[^/]+\/decide$/.test(r.path));

async function open(w: AppealsHub, appealId: string, options: Parameters<typeof renderHub>[1] = {}) {
  const r = renderHub(w, { path: `/appeals/${appealId}`, ...options });
  await screen.findByRole('region', { name: 'What the player said' });
  await waitFor(() => expect(screen.queryByText('Loading', { exact: false })).not.toBeInTheDocument());
  return r;
}
const decision = (): HTMLElement => screen.getByRole('region', { name: 'Your decision on this appeal' });
const reason = (): HTMLTextAreaElement => within(decision()).getByLabelText('Why (private)');
const keep = (): HTMLElement => within(decision()).getByRole('button', { name: 'Keep the decision' });
const lighter = (): HTMLElement => within(decision()).getByRole('button', { name: 'Make it lighter...' });
const remove = (): HTMLElement => within(decision()).getByRole('button', { name: 'Remove it' });
const statement = (): HTMLElement => screen.getByRole('region', { name: 'What the player said' });

describe('what the card says', () => {
  it('names the sanction in the heading, with its referee card, the rule, who gave it and when', async () => {
    const w = await appealsHub(SENIOR);
    const a = await w.appeal({ target: 'Mallory', kind: 'chat', durationMs: 6 * HOUR, rule: 2, actor: 'mod_ann' });
    const { container } = await open(w, a.appealId);
    expect(screen.getByRole('heading', { level: 2, name: 'Appeal against Chat restriction, 6 hours' })).toBeInTheDocument();
    expect(container.querySelector('.cw-card--restriction')).not.toBeNull();
    const main = within(document.querySelector('main') as HTMLElement);
    expect(main.getByText('Rule 2')).toBeInTheDocument();
    expect(main.getByText('by mod_ann')).toBeInTheDocument();
    expect(main.getByText('Mallory')).toBeInTheDocument();
  });

  it('a warning gets the yellow card and no length; a ban the red one', async () => {
    const w = await appealsHub(SENIOR);
    const warn = await w.appeal({ kind: 'warning' });
    const { container, router } = await open(w, warn.appealId);
    expect(screen.getByRole('heading', { level: 2, name: 'Appeal against Warning' })).toBeInTheDocument();
    expect(container.querySelector('.cw-card--warning')).not.toBeNull();
    const ban = await w.appeal({ kind: 'ban', durationMs: null });
    router.navigate(`/appeals/${ban.appealId}`);
    await screen.findByRole('heading', { level: 2, name: 'Appeal against Ban, permanent' });
    expect(container.querySelector('.cw-card--ban')).not.toBeNull();
  });

  it('shows what the player was shown, and links to the report and the person in Detailed', async () => {
    const w = await appealsHub(SENIOR);
    const a = await w.appeal({ target: 'Mallory' });
    await open(w, a.appealId);
    expect(screen.getByRole('link', { name: 'Open the original report' })).toHaveAttribute('href', `#/reports/${a.reportId}`);
    expect(screen.getByRole('link', { name: 'Open their record' })).toHaveAttribute('href', `#/people/${a.person}`);
  });

  it('in Simple: their record is one line, and there is no link to the person or the report', async () => {
    const w = await appealsHub(SENIOR);
    const a = await w.appeal({ target: 'Mallory' });
    renderHub(w, { path: `/appeals/${a.appealId}`, mode: 'simple' });
    await screen.findByRole('region', { name: 'What the player said' });
    const record = await screen.findByRole('region', { name: 'Their record' });
    await waitFor(() => expect(within(record).getByText(/restriction/i)).toBeInTheDocument());
    expect(screen.queryByRole('link', { name: 'Open their record' })).toBeNull();
    expect(screen.queryByRole('link', { name: 'Open the original report' })).toBeNull();
    // Who gave it is for Detailed.
    expect(screen.queryByText('by mod_ann')).toBeNull();
  });

  it('no claim chrome: nothing claims the case, and nothing says it is unclaimed or handled', async () => {
    const w = await appealsHub(SENIOR);
    const a = await w.appeal();
    await open(w, a.appealId);
    expect(screen.queryByText(/unclaimed|handled by|take over|is on it/i)).toBeNull();
    expect(w.sent.filter((r) => /\/cases\//.test(r.path))).toEqual([]);
  });

  it('an unknown appeal says so, in words', async () => {
    const w = await appealsHub(SENIOR);
    renderHub(w, { path: '/appeals/nope' });
    expect(await screen.findByRole('alert')).toHaveTextContent(/could not load|not found/i);
  });

  it('a statement that was purged says so instead of showing nothing', async () => {
    const w = await appealsHub(SENIOR);
    const a = await w.appeal();
    const real = await w.client.appeal(a.appealId);
    w.intercept.fn = (req) => (req.method === 'GET' && req.path === `/appeals/${a.appealId}` ? { status: 200, body: { appeal: { ...real.appeal, statement: null } } } : undefined);
    await open(w, a.appealId);
    expect(within(statement()).getByText('This statement is no longer kept.')).toBeInTheDocument();
  });
});

describe('the statement is plain text, and a flagged one is hidden until shown', () => {
  it('renders a <script> statement and a markdown link literally', async () => {
    const w = await appealsHub(SENIOR);
    const text = '<script>window.__pwned = 1</script> and [click me](https://example.test/x) and **bold** <b>b</b>';
    const a = await w.appeal({ statement: text });
    const { container } = await open(w, a.appealId);
    expect(within(statement()).getByText(text)).toBeInTheDocument();
    expect(container.querySelector('script')).toBeNull();
    expect(statement().querySelector('a, strong, b, em, img')).toBeNull();
    expect((window as unknown as { __pwned?: number }).__pwned).toBeUndefined();
  });

  it('keeps its line breaks and does not collapse them', async () => {
    const w = await appealsHub(SENIOR);
    const a = await w.appeal({ statement: 'first line\nsecond line' });
    await open(w, a.appealId);
    const p = statement().querySelector('.cw-appeal-statement') as HTMLElement;
    expect(p.textContent).toBe('first line\nsecond line');
  });

  it('a flagged statement is masked, and Show reveals it for this statement only; Hide puts it back', async () => {
    const w = await appealsHub(SENIOR);
    const a = await w.appeal({ statement: 'you zorbak, it was a joke' });
    const { user } = await open(w, a.appealId);
    expect(within(statement()).getByText('Blocked words, hidden')).toBeInTheDocument();
    expect(/zorbak/i.test(document.body.innerHTML)).toBe(false);
    await user.click(within(statement()).getByRole('button', { name: 'Show the hidden statement' }));
    expect(within(statement()).getByText('you zorbak, it was a joke')).toBeInTheDocument();
    await user.click(within(statement()).getByRole('button', { name: 'Hide the statement' }));
    expect(within(statement()).queryByText('you zorbak, it was a joke')).toBeNull();
    expect(/zorbak/i.test(document.body.innerHTML)).toBe(false);
  });

  it('"Show blocked words" reveals the statement and the person\'s flagged name together', async () => {
    const w = await appealsHub(SENIOR);
    const a = await w.appeal({ target: 'zorbakKid', statement: 'you zorbak, it was a joke' });
    const { user } = await open(w, a.appealId);
    expect(/zorbak/i.test(document.body.innerHTML)).toBe(false);
    await user.click(screen.getByRole('checkbox', { name: 'Show blocked words' }));
    expect(within(statement()).getByText('you zorbak, it was a joke')).toBeInTheDocument();
    expect(screen.getByText('zorbakKid')).toBeInTheDocument();
    await user.click(screen.getByRole('checkbox', { name: 'Show blocked words' }));
    expect(/zorbak/i.test(document.body.innerHTML)).toBe(false);
  });

  it('an unflagged statement has no Show control and no "show all" switch', async () => {
    const w = await appealsHub(SENIOR);
    const a = await w.appeal({ target: 'Mallory', statement: 'a plain statement' });
    await open(w, a.appealId);
    expect(screen.queryByRole('button', { name: /^Show the hidden/ })).toBeNull();
    expect(screen.queryByRole('checkbox', { name: 'Show blocked words' })).toBeNull();
  });

  it('revealing does not carry to another appeal', async () => {
    const w = await appealsHub(SENIOR);
    const a = await w.appeal({ statement: 'you zorbak one' });
    const b = await w.appeal({ statement: 'you zorbak two' });
    const { user, router } = await open(w, a.appealId);
    await user.click(screen.getByRole('button', { name: 'Show the hidden statement' }));
    expect(screen.getByText('you zorbak one')).toBeInTheDocument();
    router.navigate(`/appeals/${b.appealId}`);
    await waitFor(() => expect(screen.getByText('Blocked words, hidden')).toBeInTheDocument());
    expect(screen.queryByText('you zorbak two')).toBeNull();
  });
});

describe('the reason is required, with the decision bar\'s length rules', () => {
  it('each of the three needs a reason: nothing is sent and the reason box is marked and focused', async () => {
    const w = await appealsHub(SENIOR);
    const a = await w.appeal();
    const { user } = await open(w, a.appealId);
    for (const button of [keep, remove]) {
      await user.click(button());
      expect(within(decision()).getByText('Write a reason. Only staff see it.')).toBeInTheDocument();
      expect(reason()).toHaveAttribute('aria-invalid', 'true');
      expect(reason()).toHaveFocus();
    }
    expect(decides(w)).toEqual([]);
  });

  it('a reason of spaces is no reason; more than 500 characters is too long; exactly 500 is fine', async () => {
    const w = await appealsHub(SENIOR);
    const a = await w.appeal();
    const { user } = await open(w, a.appealId);
    await user.type(reason(), '    ');
    await user.click(keep());
    expect(within(decision()).getByText('Write a reason. Only staff see it.')).toBeInTheDocument();
    fireEvent.change(reason(), { target: { value: 'x'.repeat(501) } });
    await user.click(keep());
    expect(within(decision()).getByText('The reason is over 500 characters. Shorten it.')).toBeInTheDocument();
    expect(decides(w)).toEqual([]);
    fireEvent.change(reason(), { target: { value: 'x'.repeat(500) } });
    await user.click(keep());
    await waitFor(() => expect(decides(w)).toHaveLength(1));
  });

  it('shows the count against the limit', async () => {
    const w = await appealsHub(SENIOR);
    const a = await w.appeal();
    const { user } = await open(w, a.appealId);
    await user.type(reason(), 'abc');
    expect(within(decision()).getByText('3 of 500')).toBeInTheDocument();
  });

  it('the saved reasons are chips: one press puts the text in the box, after what is there', async () => {
    const w = await appealsHub(SENIOR);
    await w.client.addReason({ label: 'Clear joke', text: 'It was banter between friends.' });
    const a = await w.appeal();
    const { user } = await open(w, a.appealId);
    const chip = await screen.findByRole('button', { name: 'Clear joke' });
    await user.click(chip);
    expect(reason()).toHaveValue('It was banter between friends.');
    await user.click(chip);
    expect(reason().value).toBe('It was banter between friends. It was banter between friends.');
  });
});

describe('Keep the decision, Remove it', () => {
  it('Keep sends uphold with the reason, takes the moderator back to the Appeals list and leaves no Undo', async () => {
    const w = await appealsHub(SENIOR);
    const a = await w.appeal();
    const { user, router } = await open(w, a.appealId);
    await user.type(reason(), 'The chat log is clear.');
    await user.click(keep());
    await waitFor(() => expect(router.path).toBe('/appeals'));
    expect(decides(w).map((r) => r.body)).toEqual([{ outcome: 'uphold', reason: 'The chat log is clear.' }]);
    expect((await w.client.appeals({ status: 'decided' })).items.map((i) => i.status)).toEqual(['upheld']);
    // Sent at once: there is no hold, and nothing to undo.
    expect(screen.queryByRole('button', { name: /undo/i })).toBeNull();
    expect(await screen.findByText('Appeal decided: the decision stands.')).toBeInTheDocument();
  });

  it('Remove revokes the sanction', async () => {
    const w = await appealsHub(SENIOR);
    const a = await w.appeal({ target: 'Mallory' });
    const { user, router } = await open(w, a.appealId);
    await user.type(reason(), 'A mistake: it was not aimed at anyone.');
    await user.click(remove());
    await waitFor(() => expect(router.path).toBe('/appeals'));
    expect(decides(w).map((r) => r.body)).toEqual([{ outcome: 'revoke', reason: 'A mistake: it was not aimed at anyone.' }]);
    const history = await w.client.personHistory(a.person);
    expect(history.sanctions.filter((s) => s.revokedAt !== null)).toHaveLength(1);
    expect(await screen.findByText('Appeal decided: the sanction was removed.')).toBeInTheDocument();
  });

  it('a second click while the first is on its way sends once', async () => {
    const w = await appealsHub(SENIOR);
    const a = await w.appeal();
    const { user } = await open(w, a.appealId);
    await user.type(reason(), 'Fine as it is.');
    await user.dblClick(keep());
    await waitFor(() => expect(decides(w).length).toBeGreaterThan(0));
    expect(decides(w)).toHaveLength(1);
  });
});

describe('Make it lighter...', () => {
  it('is disabled for a warning, and says why', async () => {
    const w = await appealsHub(SENIOR);
    const a = await w.appeal({ kind: 'warning' });
    await open(w, a.appealId);
    expect(lighter()).toBeDisabled();
    expect(within(decision()).getByText('A warning is the lightest there is.')).toBeInTheDocument();
  });

  it('offers only kinds below the original, then lengths from the profile below the original\'s', async () => {
    const w = await appealsHub({ ...SENIOR, overrides: { durations: [HOUR, 6 * HOUR, 24 * HOUR, 7 * 24 * HOUR] } });
    const a = await w.appeal({ kind: 'area', durationMs: 24 * HOUR });
    const { user } = await open(w, a.appealId);
    await user.click(lighter());
    const picker = screen.getByRole('group', { name: 'Make it lighter' });
    const kind = within(picker).getByLabelText('What it becomes') as HTMLSelectElement;
    expect([...kind.options].map((o) => o.textContent)).toEqual(['Warning', 'Chat restriction', 'Area restriction']);
    // Area, same kind: shorter only.
    await user.selectOptions(kind, 'area');
    const length = within(picker).getByLabelText('How long') as HTMLSelectElement;
    expect([...length.options].map((o) => o.textContent)).toEqual(['1 hour', '6 hours']);
    // A lower kind may keep the same length at most.
    await user.selectOptions(kind, 'chat');
    expect([...(within(picker).getByLabelText('How long') as HTMLSelectElement).options].map((o) => o.textContent)).toEqual(['1 hour', '6 hours', '24 hours']);
    // A warning has no length.
    await user.selectOptions(kind, 'warning');
    expect(within(picker).queryByLabelText('How long')).toBeNull();
  });

  it('a permanent ban can become a shorter ban, or any lighter kind, even permanent', async () => {
    const w = await appealsHub({ ...SENIOR, overrides: { durations: [HOUR, 24 * HOUR] } });
    const a = await w.appeal({ kind: 'ban', durationMs: null });
    const { user } = await open(w, a.appealId);
    await user.click(lighter());
    const picker = screen.getByRole('group', { name: 'Make it lighter' });
    const kind = within(picker).getByLabelText('What it becomes') as HTMLSelectElement;
    expect([...kind.options].map((o) => o.textContent)).toEqual(['Warning', 'Chat restriction', 'Area restriction', 'Ban']);
    await user.selectOptions(kind, 'ban');
    expect([...(within(picker).getByLabelText('How long') as HTMLSelectElement).options].map((o) => o.textContent)).toEqual(['1 hour', '24 hours']);
    await user.selectOptions(kind, 'area');
    expect([...(within(picker).getByLabelText('How long') as HTMLSelectElement).options].map((o) => o.textContent)).toEqual(['1 hour', '24 hours', 'Permanent']);
  });

  it('the shortest chat restriction has only a warning to go to', async () => {
    const w = await appealsHub({ ...SENIOR, overrides: { durations: [HOUR, 24 * HOUR] } });
    const a = await w.appeal({ kind: 'chat', durationMs: HOUR });
    const { user } = await open(w, a.appealId);
    await user.click(lighter());
    const picker = screen.getByRole('group', { name: 'Make it lighter' });
    expect([...(within(picker).getByLabelText('What it becomes') as HTMLSelectElement).options].map((o) => o.textContent)).toEqual(['Warning']);
  });

  it('sends reduce with the kind and length chosen and the reason, and the person gets the lighter one', async () => {
    const w = await appealsHub({ ...SENIOR, overrides: { durations: [HOUR, 6 * HOUR, 24 * HOUR] } });
    const a = await w.appeal({ kind: 'chat', durationMs: 24 * HOUR });
    const { user, router } = await open(w, a.appealId);
    await user.type(reason(), 'Too long for a first offence.');
    await user.click(lighter());
    const picker = screen.getByRole('group', { name: 'Make it lighter' });
    await user.selectOptions(within(picker).getByLabelText('How long'), '1h');
    await user.click(within(picker).getByRole('button', { name: 'Make it lighter' }));
    await waitFor(() => expect(router.path).toBe('/appeals'));
    expect(decides(w).map((r) => r.body)).toEqual([{ outcome: 'reduce', reason: 'Too long for a first offence.', to: { kind: 'chat', durationMs: HOUR } }]);
    const history = await w.client.personHistory(a.person);
    expect(history.sanctions.some((s) => s.kind === 'chat' && s.endsAt !== null && s.endsAt - s.startsAt === HOUR && s.revokedAt === null)).toBe(true);
    expect(await screen.findByText('Appeal decided: the sanction was made lighter.')).toBeInTheDocument();
  });

  it('a reduction to a warning sends no length', async () => {
    const w = await appealsHub(SENIOR);
    const a = await w.appeal({ kind: 'chat', durationMs: 24 * HOUR });
    const { user } = await open(w, a.appealId);
    await user.type(reason(), 'A warning is enough.');
    await user.click(lighter());
    const picker = screen.getByRole('group', { name: 'Make it lighter' });
    await user.selectOptions(within(picker).getByLabelText('What it becomes'), 'warning');
    await user.click(within(picker).getByRole('button', { name: 'Make it lighter' }));
    await waitFor(() => expect(decides(w)).toHaveLength(1));
    expect(decides(w)[0]?.body).toEqual({ outcome: 'reduce', reason: 'A warning is enough.', to: { kind: 'warning', durationMs: null } });
  });

  it('the picker needs the reason too, and closes again', async () => {
    const w = await appealsHub(SENIOR);
    const a = await w.appeal({ kind: 'chat', durationMs: 24 * HOUR });
    const { user } = await open(w, a.appealId);
    await user.click(lighter());
    expect(lighter()).toHaveAttribute('aria-expanded', 'true');
    await user.click(within(screen.getByRole('group', { name: 'Make it lighter' })).getByRole('button', { name: 'Make it lighter' }));
    expect(within(decision()).getByText('Write a reason. Only staff see it.')).toBeInTheDocument();
    expect(decides(w)).toEqual([]);
    await user.click(lighter());
    expect(screen.queryByRole('group', { name: 'Make it lighter' })).toBeNull();
  });
});

describe('a refusal comes back in words, with everything typed kept, and nothing is sent twice', () => {
  it('same_decider: the person who made the decision may not decide its appeal', async () => {
    const w = await appealsHub(SENIOR);
    const a = await w.appeal({ actor: 'bea@example.test' });
    const { user, router } = await open(w, a.appealId);
    await user.type(reason(), 'I stand by it.');
    await user.click(keep());
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('You made the original decision, so someone else has to decide this appeal.');
    expect(reason()).toHaveValue('I stand by it.');
    expect(router.path).toBe(`/appeals/${a.appealId}`);
    expect(alert).not.toHaveTextContent('same_decider');
  });

  it('already_decided: someone else got there first', async () => {
    const w = await appealsHub(SENIOR);
    const a = await w.appeal();
    const { user } = await open(w, a.appealId);
    await w.clientFor('cy@example.test', 'senior').decideAppeal(a.appealId, { outcome: 'uphold', reason: 'first' });
    await user.type(reason(), 'second');
    await user.click(remove());
    expect(await screen.findByRole('alert')).toHaveTextContent('Someone else has already decided this appeal.');
    expect(reason()).toHaveValue('second');
  });

  it('gone: the sanction is gone', async () => {
    const w = await appealsHub(SENIOR);
    const a = await w.appeal();
    const { user } = await open(w, a.appealId);
    w.intercept.fn = (req) => (req.method === 'POST' && /\/decide$/.test(req.path) ? { status: 409, body: { error: 'gone', message: 'The sanction is gone.' } } : undefined);
    await user.type(reason(), 'whatever');
    await user.click(keep());
    expect(await screen.findByRole('alert')).toHaveTextContent('The sanction is gone, so this appeal is closed.');
    expect(reason()).toHaveValue('whatever');
  });

  it('a duration the profile does not offer, a bad request, a dropped connection and a server error each say what happened and keep the form', async () => {
    const w = await appealsHub(SENIOR);
    const a = await w.appeal({ kind: 'chat', durationMs: 24 * HOUR });
    const { user } = await open(w, a.appealId);
    await user.type(reason(), 'keep me');
    const answers: Array<[number, string, string]> = [
      [400, 'duration_not_offered', 'That length is not one of the lengths offered. Choose another length and try again.'],
      [400, 'invalid', 'The server could not use that. Check the reason and try again.'],
      [500, 'internal', 'The server had a problem. Try again in a moment.'],
    ];
    for (const [status, error, words] of answers) {
      w.intercept.fn = (req) => (req.method === 'POST' && /\/decide$/.test(req.path) ? { status, body: { error, message: 'x' } } : undefined);
      await user.click(keep());
      expect(await screen.findByRole('alert')).toHaveTextContent(words);
      expect(reason()).toHaveValue('keep me');
    }
    w.intercept.fn = () => {
      throw new Error('offline');
    };
    await user.click(keep());
    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument());
    expect(reason()).toHaveValue('keep me');
  });

  it('after a refusal the moderator can change the text and try again; success clears the error', async () => {
    const w = await appealsHub(SENIOR);
    const a = await w.appeal();
    const { user, router } = await open(w, a.appealId);
    let fail = true;
    w.intercept.fn = (req) => (fail && req.method === 'POST' && /\/decide$/.test(req.path) ? { status: 500, body: { error: 'internal', message: 'x' } } : undefined);
    await user.type(reason(), 'first try');
    await user.click(keep());
    await screen.findByRole('alert');
    fail = false;
    await user.click(keep());
    await waitFor(() => expect(router.path).toBe('/appeals'));
  });
});

describe('who may decide', () => {
  it('a moderator (appeals.decide defaults to senior) reads the appeal but sees no controls, and says so', async () => {
    const w = await appealsHub({ role: 'moderator', actor: 'ann@example.test' });
    const a = await w.appeal();
    await open(w, a.appealId);
    expect(screen.queryByRole('button', { name: 'Keep the decision' })).toBeNull();
    expect(screen.queryByLabelText('Why (private)')).toBeNull();
    expect(screen.getByText('A senior moderator decides appeals.')).toBeInTheDocument();
  });

  it('with appeals.decide lowered to moderator, a moderator decides', async () => {
    const w = await appealsHub({ role: 'moderator', actor: 'ann@example.test', permissions: { 'appeals.decide': 'moderator' } });
    const a = await w.appeal({ actor: 'someone_else' });
    const { user, router } = await open(w, a.appealId);
    await user.type(reason(), 'ok');
    await user.click(keep());
    await waitFor(() => expect(router.path).toBe('/appeals'));
  });

  it('an appeal that is already decided shows the outcome and the reason, and no controls', async () => {
    const w = await appealsHub(SENIOR);
    const a = await w.appeal();
    await w.clientFor('cy@example.test', 'senior').decideAppeal(a.appealId, { outcome: 'revoke', reason: 'Clearly a joke.' });
    await open(w, a.appealId);
    expect(screen.queryByRole('button', { name: 'Keep the decision' })).toBeNull();
    expect(screen.getByText('Decided: the sanction was removed.')).toBeInTheDocument();
    expect(screen.getByText('Clearly a joke.')).toBeInTheDocument();
  });
});
