import { cleanup, fireEvent, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { PlayerReporting, ReportResult } from '@chatwarden/core';
import { ReportDialog } from '../src/ReportDialog.js';
import type { ReportDialogProps } from '../src/ReportDialog.js';
import { readReporting } from '../src/reporting.js';
import { FIXED, findStatus, renderUi } from './render.js';

// After a report: the reason's own thank-you (else the global one), then, for a reason with showResources, the owner's resources: a list of labels and details, an https link opening with rel="noopener noreferrer",
// plain text when there is no url. The dialog never says anyone was alerted, contacted or told: it cannot know.

const reason = (id: string, label: string, extra: Record<string, unknown> = {}) => ({ id, label, hint: '', group: '', asksNote: false, ...extra });

const REPORTING = {
  flow: 'one_tap',
  thanks: 'Thanks. A moderator will have a look.',
  reasons: [
    reason('harassment', 'Harassment'),
    reason('threat', 'Threats', { thanks: 'Thank you for telling us. This goes to the front of the queue.' }),
    reason('welfare', 'Someone may be in trouble', { thanks: 'Thank you. You did the right thing.', showResources: true }),
    reason('other', 'Something else'),
  ],
  resources: [
    { label: 'Crisis line', detail: 'Free, any time: 555-0100', url: 'https://help.example.test/crisis' },
    { label: 'Safety page', detail: 'Our own page on staying safe', url: 'https://example.test/safety?from=chat' },
    { label: 'Talk to someone you trust', detail: 'A friend, a parent or a teacher', url: null },
  ],
} as unknown as PlayerReporting;

const ok = (): ReportResult => ({ ok: true, reportId: 'r1', remaining: 5 });
const props = (more: Partial<ReportDialogProps> = {}): ReportDialogProps => ({ onSubmit: () => Promise.resolve(ok()), onClose: () => undefined, ...FIXED, reporting: REPORTING, line: 'a line', ...more });

async function sendWith(reasonLabel: string | null, more: Partial<ReportDialogProps> = {}): Promise<HTMLElement> {
  const view = renderUi(<ReportDialog {...props(more)} />);
  if (reasonLabel !== null) fireEvent.change(screen.getByRole('combobox'), { target: { value: (REPORTING.reasons.find((r) => r.label === reasonLabel) as { id: string }).id } });
  await view.user.click(screen.getByRole('button', { name: 'Report' }));
  await findStatus();
  return screen.getByRole('dialog');
}

describe('the thank-you', () => {
  it('shows the reason\'s own thanks when it has one, else the global one', async () => {
    const own = await sendWith('Threats');
    expect(within(own).getByText(/Thank you for telling us\. This goes to the front of the queue\./)).toBeInTheDocument();
    expect(within(own).queryByText(/A moderator will have a look/)).toBeNull();
  });

  it('a reason with no thanks of its own gets the global one; no reason chosen gets it too', async () => {
    const d = await sendWith('Harassment');
    expect(within(d).getByText(/Thanks\. A moderator will have a look\./)).toBeInTheDocument();
  });

  it('with no reason chosen the global thanks shows', async () => {
    const d = await sendWith(null);
    expect(within(d).getByText(/Thanks\. A moderator will have a look\./)).toBeInTheDocument();
  });

  it('with no thanks anywhere the catalog\'s own words show', async () => {
    const d = await sendWith(null, { reporting: { ...REPORTING, thanks: '' } as PlayerReporting });
    expect(within(d).getByText(/We.ll look into it/)).toBeInTheDocument();
  });

  it('a reason\'s thanks is plain text: markup in it is shown as text, never rendered', async () => {
    const hostile = { ...REPORTING, reasons: [reason('threat', 'Threats', { thanks: '<img src=x onerror=alert(1)> Thanks' })] } as unknown as PlayerReporting;
    const d = await sendWith('Threats', { reporting: hostile });
    expect(d.querySelector('img')).toBeNull();
    expect(d).toHaveTextContent('<img src=x onerror=alert(1)> Thanks');
  });
});

describe('the resources', () => {
  it('a showResources reason lists the resources with an https link that opens with rel="noopener noreferrer"; a resource with no url is plain text', async () => {
    const d = await sendWith('Someone may be in trouble');
    const list = within(d).getByRole('list');
    const items = within(list).getAllByRole('listitem');
    expect(items).toHaveLength(3);
    const crisis = within(items[0] as HTMLElement).getByRole('link', { name: 'Crisis line' });
    expect(crisis).toHaveAttribute('href', 'https://help.example.test/crisis');
    expect(crisis).toHaveAttribute('rel', 'noopener noreferrer');
    expect(crisis).toHaveAttribute('target', '_blank');
    expect(items[0]).toHaveTextContent('Free, any time: 555-0100');
    expect(within(items[1] as HTMLElement).getByRole('link', { name: 'Safety page' })).toHaveAttribute('href', 'https://example.test/safety?from=chat');
    expect(within(items[2] as HTMLElement).queryByRole('link')).toBeNull();
    expect(items[2]).toHaveTextContent('Talk to someone you trust');
    expect(items[2]).toHaveTextContent('A friend, a parent or a teacher');
  });

  it('comes after the thank-you and under its own heading', async () => {
    const d = await sendWith('Someone may be in trouble');
    expect(within(d).getByText(/Thank you. You did the right thing./)).toBeInTheDocument();
    expect(within(d).getByText('Where to get help')).toBeInTheDocument();
    const html = d.innerHTML;
    expect(html.indexOf('You did the right thing')).toBeLessThan(html.indexOf('Where to get help'));
  });

  it('a reason without showResources shows none, whatever the payload holds', async () => {
    const d = await sendWith('Threats');
    expect(within(d).queryByRole('list')).toBeNull();
    expect(d).not.toHaveTextContent('Crisis line');
  });

  it('with no resources in the payload a showResources reason shows only the thank-you', async () => {
    const d = await sendWith('Someone may be in trouble', { reporting: { ...REPORTING, resources: undefined } as unknown as PlayerReporting });
    expect(within(d).queryByRole('list')).toBeNull();
    expect(within(d).queryByText('Where to get help')).toBeNull();
  });

  it('a url that is not https never becomes a link: javascript:, http:, data: and a relative path read as plain text', async () => {
    const bad = {
      ...REPORTING,
      resources: ['javascript:alert(1)', 'http://help.example.test', 'data:text/html,x', '/relative/path', '//evil.example', 'https://', 'https://user:pw@help.example.test'].map((url, i) => ({ label: `Bad ${i}`, detail: 'd', url })),
    } as unknown as PlayerReporting;
    const d = await sendWith('Someone may be in trouble', { reporting: bad });
    expect(within(d).queryAllByRole('link')).toHaveLength(0);
    expect(d.querySelector('a')).toBeNull();
    expect(d).toHaveTextContent('Bad 0');
    expect(d.innerHTML).not.toMatch(/href=/);
  });

  it('a hostile label or detail is text, not markup', async () => {
    const bad = { ...REPORTING, resources: [{ label: '<b>Bold</b>', detail: '<script>x</script>', url: 'https://help.example.test' }] } as unknown as PlayerReporting;
    const d = await sendWith('Someone may be in trouble', { reporting: bad });
    expect(d.querySelector('script')).toBeNull();
    expect(d.querySelector('b')).toBeNull();
    expect(d).toHaveTextContent('<b>Bold</b>');
  });

  it('at most five resources are shown', async () => {
    const many = { ...REPORTING, resources: Array.from({ length: 9 }, (_, i) => ({ label: `Help ${i}`, detail: 'd', url: null })) } as unknown as PlayerReporting;
    const d = await sendWith('Someone may be in trouble', { reporting: many });
    expect(within(d).getAllByRole('listitem')).toHaveLength(5);
  });

  it('the dialog never says anyone was alerted, contacted, notified or told, in any case', async () => {
    for (const label of ['Harassment', 'Threats', 'Someone may be in trouble']) {
      const d = await sendWith(label);
      expect(d.textContent ?? '', label).not.toMatch(/alert|contact|notif|police|emergency services|has been told|were told/i);
      cleanup();
    }
  });

  it('the resources live in the polite status region of the dialog so they are read once', async () => {
    const d = await sendWith('Someone may be in trouble');
    const status = d.querySelector('[role="status"]') as HTMLElement;
    expect(status.querySelector('ul')).not.toBeNull();
  });
});

describe('readReporting keeps the new fields only when they are well formed', () => {
  it('copies a reason\'s thanks and showResources and the top-level resources, and nothing else', () => {
    const read = readReporting({
      ...REPORTING,
      reasons: [{ ...reason('welfare', 'W', { thanks: 'Thanks', showResources: true }), rule: 2, urgent: true, guidance: 'staff only' }],
    });
    expect(read?.reasons).toEqual([{ id: 'welfare', label: 'W', hint: '', group: '', asksNote: false, thanks: 'Thanks', showResources: true }]);
    expect(read?.resources).toHaveLength(3);
    expect(JSON.stringify(read)).not.toMatch(/staff only|urgent|"rule"/);
  });

  it('drops a thanks that is not text, a showResources that is not true, and resources that are not a list of labelled items', () => {
    const read = readReporting({ flow: 'one_tap', thanks: '', reasons: [reason('a', 'A', { thanks: 5, showResources: 'yes' })], resources: [{ detail: 'no label' }, 'text', null, { label: 'Ok', detail: 'd' }] });
    expect(read?.reasons[0]).toEqual({ id: 'a', label: 'A', hint: '', group: '', asksNote: false, thanks: null, showResources: false });
    expect(read?.resources).toEqual([{ label: 'Ok', detail: 'd', url: null }]);
    expect(readReporting({ flow: 'one_tap', thanks: '', reasons: [], resources: 'nope' })?.resources).toEqual([]);
  });
});

describe('a one-tap report with no reasons list', () => {
  it('still thanks with the global text and shows no resources', async () => {
    const onSubmit = vi.fn<ReportDialogProps['onSubmit']>(() => Promise.resolve(ok()));
    renderUi(<ReportDialog {...props({ onSubmit, reporting: undefined })} />);
    fireEvent.click(screen.getByRole('button', { name: 'Report' }));
    await findStatus();
    expect(screen.queryByRole('list')).toBeNull();
  });
});
