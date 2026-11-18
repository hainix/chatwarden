import { fireEvent, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { DEFAULT_REPORT_REASONS, DEFAULT_REPORT_THANKS } from '@chatwarden/core';
import type { PlayerReporting, ReportResult } from '@chatwarden/core';
import { ReportDialog } from '../src/ReportDialog.js';
import type { ReportDialogProps } from '../src/ReportDialog.js';
import { enChat } from '../src/chat/words.js';
import { createT, en } from '../src/i18n.js';
import { es } from '../src/locales/es.js';
import { pt } from '../src/locales/pt.js';
import { FIXED, findStatus, renderUi } from './render.js';

// The report reasons and the thank-you travel in the profile (`GET /rules`) as English defaults. The dialog uses the catalogue's words only
// while the server's text still equals the English default; a label the owner edited is the game's own words and is shown as sent.

const DEFAULTS = DEFAULT_REPORT_REASONS.filter((r) => r.enabled);

const reporting = (more: Partial<PlayerReporting> = {}, edit: Record<string, Record<string, unknown>> = {}): PlayerReporting =>
  ({
    flow: 'one_tap',
    thanks: DEFAULT_REPORT_THANKS,
    resources: [],
    reasons: DEFAULTS.map((r) => ({ id: r.id, label: r.label, hint: r.hint, group: r.group, asksNote: r.asksNote, thanks: null, showResources: false, ...edit[r.id] })),
    ...more,
  }) as unknown as PlayerReporting;

const tEs = createT({ ...en, ...enChat, ...es }, 'es');
const tPt = createT({ ...en, ...enChat, ...pt }, 'pt');
const ok = (): ReportResult => ({ ok: true, reportId: 'r1', remaining: 5 });
const props = (more: Partial<ReportDialogProps> = {}): ReportDialogProps => ({ onSubmit: () => Promise.resolve(ok()), onClose: () => undefined, ...FIXED, line: 'a line', ...more });
const labels = (): string[] => within(screen.getByRole('combobox')).getAllByRole('option').map((o) => o.textContent ?? '');
const text = (c: Record<string, string>, key: string): string => c[key] as string;

describe('the report reasons in the dialog', () => {
  it('with the server\'s English default and an es catalogue, every reason shows the Spanish label', () => {
    renderUi(<ReportDialog {...props({ reporting: reporting(), t: tEs, locale: 'es' })} />);
    const shown = labels();
    for (const r of DEFAULTS) expect(shown, r.id).toContain(text(es, `player.report.reason.${r.id}.label`));
    for (const r of DEFAULTS) expect(shown, r.id).not.toContain(r.label);
  });

  it('the same in Portuguese', () => {
    renderUi(<ReportDialog {...props({ reporting: reporting(), t: tPt, locale: 'pt' })} />);
    const shown = labels();
    for (const r of DEFAULTS) expect(shown, r.id).toContain(text(pt, `player.report.reason.${r.id}.label`));
  });

  it('with an owner-edited label it shows the owner\'s text, and the other reasons still follow the catalogue', () => {
    renderUi(<ReportDialog {...props({ reporting: reporting({}, { harassment: { label: 'Rude words' } }), t: tEs, locale: 'es' })} />);
    const shown = labels();
    expect(shown).toContain('Rude words');
    expect(shown).not.toContain(text(es, 'player.report.reason.harassment.label'));
    expect(shown).toContain(text(es, 'player.report.reason.hate.label'));
  });

  it('an owner-edited label equal to the English default of ANOTHER reason is still the owner\'s text', () => {
    renderUi(<ReportDialog {...props({ reporting: reporting({}, { hate: { label: 'Cheating' } }), t: tEs, locale: 'es' })} />);
    expect(labels().filter((l) => l === 'Cheating')).toHaveLength(1);
  });

  it('a custom reason the catalogue has no key for shows the server\'s text', () => {
    const custom = { ...reporting(), reasons: [...reporting().reasons, { id: 'vlemmo', label: 'Zorbak talk', hint: 'Plain hint', group: 'Chat', asksNote: false, thanks: null, showResources: false }] } as PlayerReporting;
    renderUi(<ReportDialog {...props({ reporting: custom, t: tEs, locale: 'es' })} />);
    expect(labels()).toContain('Zorbak talk');
  });

  it('with a catalogue that lacks the key it shows the server\'s text', () => {
    const { 'player.report.reason.hate.label': _gone, ...rest } = { ...en, ...enChat, ...es } as Record<string, string>;
    void _gone;
    // A catalogue with no key at all for the reason (not even the English): the server's text stays.
    const noKey = createT(rest, 'es');
    renderUi(<ReportDialog {...props({ reporting: reporting(), t: noKey, locale: 'es' })} />);
    expect(labels()).toContain(DEFAULTS.find((r) => r.id === 'hate')?.label);
  });

  it('with no t given (English) the labels are the server\'s', () => {
    renderUi(<ReportDialog {...props({ reporting: reporting() })} />);
    for (const r of DEFAULTS) expect(labels()).toContain(r.label);
  });

  it('the hint follows the same rule: the catalogue\'s while the server\'s hint is the default, the owner\'s when edited', () => {
    const { unmount } = renderUi(<ReportDialog {...props({ reporting: reporting(), t: tEs, locale: 'es' })} />);
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'hate' } });
    expect(screen.getByText(text(es, 'player.report.reason.hate.hint'))).toBeInTheDocument();
    unmount();
    renderUi(<ReportDialog {...props({ reporting: reporting({}, { hate: { hint: 'Our own hint' } }), t: tEs, locale: 'es' })} />);
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'hate' } });
    expect(screen.getByText('Our own hint')).toBeInTheDocument();
    expect(screen.queryByText(text(es, 'player.report.reason.hate.hint'))).toBeNull();
  });
});

describe('the thank-you', () => {
  it('with the server\'s default thank-you and an es catalogue it shows the Spanish thanks', async () => {
    const view = renderUi(<ReportDialog {...props({ reporting: reporting(), t: tEs, locale: 'es' })} />);
    await view.user.click(screen.getByRole('button', { name: text(es, 'player.report.oneTap.send') }));
    expect(await findStatus()).toHaveTextContent(text(es, 'player.report.thanks'));
  });

  it('an owner-edited thank-you is shown as sent', async () => {
    const view = renderUi(<ReportDialog {...props({ reporting: reporting({ thanks: 'We will look. Promise.' }), t: tEs, locale: 'es' })} />);
    await view.user.click(screen.getByRole('button', { name: text(es, 'player.report.oneTap.send') }));
    const status = await findStatus();
    expect(status).toHaveTextContent('We will look. Promise.');
    expect(status).not.toHaveTextContent(text(es, 'player.report.thanks'));
  });

  it('a reason\'s own thank-you is the owner\'s text and is never swapped, even when it equals the default', async () => {
    const view = renderUi(<ReportDialog {...props({ reporting: reporting({}, { threat: { thanks: DEFAULT_REPORT_THANKS } }), t: tEs, locale: 'es' })} />);
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'threat' } });
    await view.user.click(screen.getByRole('button', { name: text(es, 'player.report.oneTap.send') }));
    expect(await findStatus()).toHaveTextContent(DEFAULT_REPORT_THANKS);
  });

  it('with no thanks from the server the catalogue\'s thanks shows, in English and in Portuguese', async () => {
    const eng = renderUi(<ReportDialog {...props({ reporting: reporting({ thanks: '' }) })} />);
    await eng.user.click(screen.getByRole('button', { name: 'Report' }));
    expect(await findStatus()).toHaveTextContent(DEFAULT_REPORT_THANKS);
    eng.unmount();
    const view = renderUi(<ReportDialog {...props({ reporting: reporting({ thanks: '' }), t: tPt, locale: 'pt' })} />);
    await view.user.click(screen.getByRole('button', { name: text(pt, 'player.report.oneTap.send') }));
    expect(await findStatus()).toHaveTextContent(text(pt, 'player.report.thanks'));
  });

  it('a catalogue with no thanks key leaves the server\'s default text', async () => {
    const { 'player.report.thanks': _gone, ...rest } = { ...en, ...enChat, ...es } as Record<string, string>;
    void _gone;
    const view = renderUi(<ReportDialog {...props({ reporting: reporting(), t: createT(rest, 'es'), locale: 'es' })} />);
    await view.user.click(screen.getByRole('button', { name: text(es, 'player.report.oneTap.send') }));
    expect(await findStatus()).toHaveTextContent(DEFAULT_REPORT_THANKS);
  });
});
