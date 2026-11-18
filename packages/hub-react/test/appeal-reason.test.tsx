import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { APPEAL_REASONS } from '@chatwarden/core';
import { appealsHub, HOUR } from './appealsWorld.js';
import type { AppealsHub } from './appealsWorld.js';
import { renderHub } from './render.js';
import type { WorldOptions } from './world.js';
import type { TransportRequest } from '../src/transport.js';

// The fixed reason in the decision bar (appeals landing, 5.1): once an outcome is chosen, a radio group of that outcome's three reasons, the first one already
// chosen, sits under the outcome and above the private reason. The hub always sends the chosen code with the decision. Against the real routes.

const SENIOR: WorldOptions = { role: 'senior', actor: 'bea@example.test' };
const decides = (w: AppealsHub): TransportRequest[] => w.sent.filter((r) => r.method === 'POST' && /^\/appeals\/[^/]+\/decide$/.test(r.path));

const SENTENCES = {
  uphold: ['The rule applies to what was said.', 'The chat record shows the rule was broken.', 'We looked at the whole conversation, and the decision stands.'],
  reduce: ['We lightened it because this was a first offence.', 'A lighter action fits what happened.', 'We looked at the whole conversation and lightened it.'],
  revoke: ['This was our mistake. We are sorry.', 'What was said does not break the rules.', 'We looked at the whole conversation and lifted it.'],
} as const;
const OUTCOME_LABEL = { uphold: 'Keep the decision', reduce: 'Make it lighter', revoke: 'Remove it' } as const;
type Outcome = keyof typeof SENTENCES;

async function open(w: AppealsHub, appealId: string) {
  const r = renderHub(w, { path: `/appeals/${appealId}` });
  await screen.findByRole('region', { name: 'What the player said' });
  await waitFor(() => expect(screen.queryByText('Loading', { exact: false })).not.toBeInTheDocument());
  return r;
}
const decision = (): HTMLElement => screen.getByRole('region', { name: 'Your decision on this appeal' });
const outcomeRadio = (o: Outcome): HTMLElement => within(decision()).getByRole('radio', { name: OUTCOME_LABEL[o] });
const group = (): HTMLElement => within(decision()).getByRole('group', { name: 'What the person is shown as the reason' });
const codeRadios = (): HTMLInputElement[] => within(group()).getAllByRole('radio') as HTMLInputElement[];
const send = (): HTMLElement => within(decision()).getByRole('button', { name: 'Send decision' });
const reasonBox = (): HTMLTextAreaElement => within(decision()).getByLabelText('Why (private)');

describe('the group appears once an outcome is chosen', () => {
  it.each(['uphold', 'reduce', 'revoke'] as const)('choosing %s shows three radios of that outcome in order with the first checked', async (o) => {
    const w = await appealsHub(SENIOR);
    const a = await w.appeal({ kind: 'chat', durationMs: 6 * HOUR });
    const { user } = await open(w, a.appealId);
    expect(within(decision()).queryByRole('group', { name: 'What the person is shown as the reason' })).toBeNull();
    await user.click(outcomeRadio(o));
    const radios = codeRadios();
    expect(radios.map((r) => r.labels?.[0]?.textContent)).toEqual([...SENTENCES[o]]);
    expect(radios.map((r) => r.checked)).toEqual([true, false, false]);
    expect(radios.every((r) => r.closest('.cw-radio') !== null)).toBe(true);
    // The order of the group is the order of core's table.
    expect(APPEAL_REASONS[o]).toHaveLength(3);
  });

  it('sits under the outcome choice and above the private reason', async () => {
    const w = await appealsHub(SENIOR);
    const a = await w.appeal();
    const { user } = await open(w, a.appealId);
    await user.click(outcomeRadio('uphold'));
    const outcomes = within(decision()).getByRole('group', { name: 'Decision' });
    const reasons = group();
    const box = reasonBox();
    expect(outcomes.compareDocumentPosition(reasons) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(reasons.compareDocumentPosition(box) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('changing the outcome resets the selection to the first of the new outcome', async () => {
    const w = await appealsHub(SENIOR);
    const a = await w.appeal({ kind: 'chat', durationMs: 6 * HOUR });
    const { user } = await open(w, a.appealId);
    await user.click(outcomeRadio('uphold'));
    await user.click(within(group()).getByRole('radio', { name: SENTENCES.uphold[2] }));
    expect(codeRadios().map((r) => r.checked)).toEqual([false, false, true]);
    await user.click(outcomeRadio('revoke'));
    expect(codeRadios().map((r) => r.labels?.[0]?.textContent)).toEqual([...SENTENCES.revoke]);
    expect(codeRadios().map((r) => r.checked)).toEqual([true, false, false]);
    await user.click(within(group()).getByRole('radio', { name: SENTENCES.revoke[1] }));
    await user.click(outcomeRadio('reduce'));
    expect(codeRadios().map((r) => r.checked)).toEqual([true, false, false]);
    await user.click(outcomeRadio('revoke'));
    expect(codeRadios().map((r) => r.checked)).toEqual([true, false, false]);
  });
});

const PAIRS = (['uphold', 'reduce', 'revoke'] as const).flatMap((o) => APPEAL_REASONS[o].map((code, i) => [o, code, i] as const));

describe('what is sent', () => {
  it.each(PAIRS)('%s with %s sends that code and the private reason', async (o, code, i) => {
    const w = await appealsHub(SENIOR);
    const a = await w.appeal({ kind: 'chat', durationMs: 6 * HOUR });
    const { user } = await open(w, a.appealId);
    await user.click(outcomeRadio(o));
    if (i > 0) await user.click(codeRadios()[i] as HTMLElement);
    await user.type(reasonBox(), 'my private reason');
    await user.click(send());
    await waitFor(() => expect(decides(w)).toHaveLength(1));
    const body = decides(w)[0]!.body as Record<string, unknown>;
    expect(body['outcome']).toBe(o);
    expect(body['reasonCode']).toBe(code);
    expect(body['reason']).toBe('my private reason');
    expect(Object.keys(body).sort()).toEqual(o === 'reduce' ? ['outcome', 'reason', 'reasonCode', 'to'] : ['outcome', 'reason', 'reasonCode']);
    // The server kept it as the appeal's fixed reason.
    await waitFor(async () => expect((await w.client.appeal(a.appealId)).appeal.decided?.reasonCode).toBe(code));
  });

  it('the first (preselected) code is sent when the moderator never touches the group', async () => {
    const w = await appealsHub(SENIOR);
    const a = await w.appeal();
    const { user } = await open(w, a.appealId);
    await user.click(outcomeRadio('revoke'));
    await user.type(reasonBox(), 'a slip');
    await user.click(send());
    await waitFor(() => expect(decides(w)).toHaveLength(1));
    expect((decides(w)[0]!.body as { reasonCode: string }).reasonCode).toBe('mistake');
  });

  it('a code picked, then an outcome changed, sends the first code of the last outcome, never the old one', async () => {
    const w = await appealsHub(SENIOR);
    const a = await w.appeal();
    const { user } = await open(w, a.appealId);
    await user.click(outcomeRadio('uphold'));
    await user.click(codeRadios()[2] as HTMLElement);
    await user.click(outcomeRadio('revoke'));
    await user.type(reasonBox(), 'second thoughts');
    await user.click(send());
    await waitFor(() => expect(decides(w)).toHaveLength(1));
    expect((decides(w)[0]!.body as { outcome: string; reasonCode: string }).outcome).toBe('revoke');
    expect((decides(w)[0]!.body as { reasonCode: string }).reasonCode).toBe('mistake');
  });
});

describe('the private reason and the keyboard', () => {
  it('the private reason is still required, and nothing is sent without it', async () => {
    const w = await appealsHub(SENIOR);
    const a = await w.appeal();
    const { user } = await open(w, a.appealId);
    await user.click(outcomeRadio('uphold'));
    await user.click(send());
    expect(decides(w)).toHaveLength(0);
    expect(within(decision()).getByText('Write a reason. Only staff see it.')).toBeInTheDocument();
    await waitFor(() => expect(reasonBox()).toHaveFocus());
  });

  it('with no outcome chosen there is no group and nothing is sent', async () => {
    const w = await appealsHub(SENIOR);
    const a = await w.appeal();
    const { user } = await open(w, a.appealId);
    await user.type(reasonBox(), 'a reason');
    await user.click(send());
    expect(decides(w)).toHaveLength(0);
    expect(within(decision()).queryByRole('group', { name: 'What the person is shown as the reason' })).toBeNull();
  });

  it('is reachable with the keyboard in order: outcome, then the checked reason, arrows move the choice, then the private reason', async () => {
    const w = await appealsHub(SENIOR);
    const a = await w.appeal();
    const { user } = await open(w, a.appealId);
    await user.click(outcomeRadio('uphold'));
    outcomeRadio('uphold').focus();
    await user.tab();
    expect(document.activeElement).toBe(codeRadios()[0]);
    await user.keyboard('{ArrowDown}');
    expect(document.activeElement).toBe(codeRadios()[1]);
    expect(codeRadios().map((r) => r.checked)).toEqual([false, true, false]);
    await user.tab();
    // Past the group the next stop is not another reason radio.
    expect(codeRadios().includes(document.activeElement as HTMLInputElement)).toBe(false);
  });

  it('a refusal with invalid_reason says in words that the reason does not fit, keeps the form and offers the group again', async () => {
    const w = await appealsHub(SENIOR);
    const a = await w.appeal();
    const { user } = await open(w, a.appealId);
    w.intercept.fn = (req) => (req.method === 'POST' && /\/decide$/.test(req.path) ? { status: 400, headers: {}, body: { error: 'invalid_reason', message: 'x' } } : undefined);
    await user.click(outcomeRadio('uphold'));
    await user.type(reasonBox(), 'a reason');
    await user.click(send());
    expect(await screen.findByRole('alert')).toHaveTextContent('That reason does not fit this decision. Choose one of the reasons listed.');
    expect(reasonBox()).toHaveValue('a reason');
    expect(group()).toBeInTheDocument();
  });

  it('a settled appeal (someone else decided it) loses the group with the other controls', async () => {
    const w = await appealsHub(SENIOR);
    const a = await w.appeal();
    const { user } = await open(w, a.appealId);
    await user.click(outcomeRadio('uphold'));
    await w.clientFor('cy@example.test', 'senior').decideAppeal(a.appealId, { outcome: 'revoke', reason: 'first' });
    await user.type(reasonBox(), 'late');
    await user.click(send());
    await screen.findByRole('alert');
    expect(within(decision()).queryByRole('group', { name: 'What the person is shown as the reason' })).toBeNull();
  });
});
