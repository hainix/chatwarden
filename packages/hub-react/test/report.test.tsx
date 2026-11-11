import { act, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { personTag } from '../src/format.js';
import { renderHub } from './render.js';
import { DAY, HOUR, hubWorld } from './world.js';
import type { HubWorld, RichLine } from './world.js';

// The report page: what happened, who is in it, and the excerpt. Against the real staff routes.

const heading = (name: string | RegExp) => screen.findByRole('heading', { level: 2, name });

async function open(w: HubWorld, id: string, options: Parameters<typeof renderHub>[1] = {}) {
  const r = renderHub(w, { path: `/reports/${id}`, ...options });
  await heading(/report against/);
  return r;
}

const chat = (): HTMLElement => screen.getByRole('list', { name: 'Chat lines' });
const lines = (): HTMLElement[] => within(chat()).getAllByRole('listitem');
const lineOf = (text: string): HTMLElement => within(chat()).getByText(text).closest('li') as HTMLElement;
const peopleList = (): HTMLElement => screen.getByRole('list', { name: 'People in this report' });
const personRow = (name: string): HTMLElement => {
  const row = within(peopleList())
    .getAllByRole('listitem')
    .find((li) => within(li).queryByText(name, { selector: '.cw-person-name' }) !== null);
  if (row === undefined) throw new Error(`no person row for ${name}`);
  return row;
};
const filter = () => screen.getByRole('group', { name: 'Show lines from' });
/** The reporters in the pane beside the case (their track records). */
const reporterRow = (name: string): HTMLElement => {
  const row = within(screen.getByRole('list', { name: 'Reporters of this case' }))
    .getAllByRole('listitem')
    .find((li) => within(li).queryByText(name, { selector: '.cw-reporter-name' }) !== null);
  if (row === undefined) throw new Error(`no reporter row for ${name}`);
  return row;
};

const TALK: RichLine[] = [
  { who: 'reporter', text: 'hello there' },
  { who: 'target', text: 'a line from the target' },
  { who: 'bystander', text: 'what is going on' },
  { who: 'target', text: 'another line from the target' },
];

describe('ReportView: the header', () => {
  it('names the category and the reported person, and says it is open', async () => {
    const w = await hubWorld();
    const f = await w.fileRich({ category: 'hate' });
    await open(w, f.id);
    expect(screen.getByRole('heading', { level: 2, name: 'Hate report against Mallory' })).toBeInTheDocument();
    const facts = screen.getByRole('group', { name: 'About this report' });
    expect(within(facts).getByText('Open')).toBeInTheDocument();
    // The category is a chip in the header, beside the name.
    expect(screen.getByText('Hate', { selector: '.cw-casecats *' })).toBeInTheDocument();
  });

  it('shows the room, the tags and when it was filed', async () => {
    const w = await hubWorld();
    const f = await w.fileRich({ room: 'lobby-7', tags: { mode: 'ranked' } });
    w.clock.t += 5 * 60_000;
    await open(w, f.id);
    const facts = screen.getByRole('group', { name: 'About this report' });
    expect(within(facts).getByText('Room lobby-7')).toBeInTheDocument();
    expect(within(facts).getByText('mode: ranked')).toBeInTheDocument();
    expect(within(facts).getByText(/Filed .*minutes? ago/)).toBeInTheDocument();
  });

  it('leaves out the room when the report has none recorded', async () => {
    const w = await hubWorld();
    const f = await w.fileRich();
    const report = w.cw.reports.get(f.id)!;
    w.intercept.fn = async (req) => {
      if (req.method === 'GET' && req.path === `/reports/${f.id}`) {
        const real = await w.direct.getReport(f.id);
        return { status: 200, body: { ...real, report: { ...real.report, roomId: '', tags: { mode: 'ranked', region: 'eu' } } } };
      }
      return undefined;
    };
    expect(report.roomId).not.toBe('');
    await open(w, f.id);
    const facts = screen.getByRole('group', { name: 'About this report' });
    expect(within(facts).queryByText(/^Room /)).not.toBeInTheDocument();
    expect(within(facts).getByText('mode: ranked')).toBeInTheDocument();
    expect(within(facts).getByText('region: eu')).toBeInTheDocument();
  });

  it('links back to the reports queue', async () => {
    const w = await hubWorld();
    const f = await w.fileRich();
    const { user, router } = await open(w, f.id);
    await user.click(screen.getByRole('link', { name: 'All reports' }));
    expect(router.path).toBe('/reports');
  });

  it('a decided report shows its status', async () => {
    const w = await hubWorld();
    const f = await w.fileRich();
    await w.client.decide(f.id, { verdict: 'no_action', reason: 'fine', actions: [] });
    await open(w, f.id);
    const facts = screen.getByRole('group', { name: 'About this report' });
    expect(within(facts).getByText('Dismissed')).toBeInTheDocument();
  });

  it('a bad-faith dismissal says so', async () => {
    const w = await hubWorld();
    const f = await w.fileRich();
    await w.client.decide(f.id, { verdict: 'bad_faith', reason: 'abuse', evidence: 'made it up', actions: [] });
    await open(w, f.id);
    const facts = screen.getByRole('group', { name: 'About this report' });
    expect(within(facts).getByText('Bad faith')).toBeInTheDocument();
  });
});

describe('ReportView: the note', () => {
  it('shows the reporter\'s note as plain text', async () => {
    const w = await hubWorld();
    const f = await w.fileRich({ note: 'They keep following me <b>around</b>' });
    await open(w, f.id);
    const note = screen.getByText('They keep following me <b>around</b>');
    expect(note).toHaveClass('cw-note-text');
    expect(note.parentElement?.querySelector('b')).toBeNull();
  });

  it('says so when there is no note', async () => {
    const w = await hubWorld();
    const f = await w.fileRich();
    await open(w, f.id);
    expect(screen.getByText('The reporter did not add a note.')).toBeInTheDocument();
  });
});

describe('ReportView: the excerpt', () => {
  it('shows every line in order with its writer', async () => {
    const w = await hubWorld();
    const f = await w.fileRich({ lines: TALK });
    await open(w, f.id);
    expect(lines().map((li) => li.textContent)).toEqual([
      expect.stringMatching(/Reporter\d+.*hello there/),
      expect.stringMatching(/Mallory.*a line from the target/),
      expect.stringMatching(/Bystander.*what is going on/),
      expect.stringMatching(/Mallory.*another line from the target/),
    ]);
    expect(screen.getByText(/: 4 lines kept$/)).toBeInTheDocument();
  });

  it('marks the reported line, and only that one', async () => {
    const w = await hubWorld();
    const f = await w.fileRich({ lines: TALK, cite: 3 });
    await open(w, f.id);
    expect(within(lineOf('another line from the target')).getByText('Reported line')).toBeInTheDocument();
    expect(screen.getAllByText('Reported line')).toHaveLength(1);
    expect(lineOf('another line from the target')).toHaveAttribute('data-reported', 'true');
    expect(lineOf('a line from the target')).not.toHaveAttribute('data-reported', 'true');
  });

  it('marks nothing when the report cites no line', async () => {
    const w = await hubWorld();
    const f = await w.fileRich({ lines: TALK, cite: null });
    await open(w, f.id);
    expect(screen.queryByText('Reported line')).not.toBeInTheDocument();
  });

  it('hides the blocked words behind a placeholder until shown, labels the line, and then shows what was typed struck through', async () => {
    const w = await hubWorld();
    const f = await w.fileRich({
      lines: [
        { who: 'reporter', text: 'hi' },
        { who: 'target', text: 'you zorbak' },
        { who: 'target', text: 'sorry about that' },
      ],
      cite: 1,
    });
    const { user } = await open(w, f.id);
    // Hidden: the words are not in the page at all, a screen reader hears "Blocked words, hidden".
    expect(within(chat()).queryByText('you zorbak')).toBeNull();
    expect(chat().textContent).not.toContain('zorbak');
    const blocked = within(chat()).getByText('Blocked words, hidden').closest('li') as HTMLElement;
    // A quiet placeholder (visible words), not a bar: nothing about the words, not even their length.
    expect(within(blocked).getByText('Blocked words, hidden')).toHaveClass('cw-mask');
    expect(within(blocked).getByText('Blocked')).toBeInTheDocument();
    expect(blocked).toHaveAttribute('data-blocked', 'true');
    expect(lineOf('sorry about that')).not.toHaveAttribute('data-blocked');
    expect(within(chat()).getAllByText('Blocked')).toHaveLength(1);
    await user.click(within(blocked).getByRole('button', { name: /^Show the blocked words in the line by Mallory/ }));
    expect(within(blocked).getByText('you zorbak')).toHaveClass('cw-line-text');
    expect(within(blocked).queryByText('Blocked words, hidden')).toBeNull();
  });

  it('shows the time of each line', async () => {
    const w = await hubWorld();
    const f = await w.fileRich({ lines: TALK });
    await open(w, f.id);
    const first = lines()[0]!.querySelector('time');
    expect(first).not.toBeNull();
    expect(first!.getAttribute('datetime')).toMatch(/^2027-01-15T/);
  });

  it('says who could see a line when it was not the whole room', async () => {
    const w = await hubWorld();
    const f = await w.fileRich({ lines: [{ who: 'reporter', text: 'hi' }] });
    w.intercept.fn = async (req) => {
      if (req.method === 'GET' && req.path === `/reports/${f.id}`) {
        const real = await w.direct.getReport(f.id);
        const excerpt = real.report.excerpt.map((l) => ({ ...l, audience: ['p1', 'p2'] }));
        return { status: 200, body: { ...real, report: { ...real.report, excerpt } } };
      }
      return undefined;
    };
    await open(w, f.id);
    expect(within(lineOf('hi')).getByText('Seen by 2 players')).toBeInTheDocument();
  });

  it('shows what others saw when it differs from what was typed', async () => {
    const w = await hubWorld();
    const f = await w.fileRich({ lines: [{ who: 'reporter', text: 'plain words' }] });
    w.intercept.fn = async (req) => {
      if (req.method === 'GET' && req.path === `/reports/${f.id}`) {
        const real = await w.direct.getReport(f.id);
        const excerpt = real.report.excerpt.map((l) => ({ ...l, delivered: 'p***n w***s' }));
        return { status: 200, body: { ...real, report: { ...real.report, excerpt } } };
      }
      return undefined;
    };
    await open(w, f.id);
    expect(within(lineOf('plain words')).getByText('Others saw: p***n w***s')).toBeInTheDocument();
  });

  it('renders hostile text as text', async () => {
    const w = await hubWorld();
    const f = await w.fileRich({ lines: [{ who: 'reporter', text: 'hi' }, { who: 'target', text: '<img src=x onerror=alert(1)> & "quotes"' }] });
    const { container } = await open(w, f.id);
    expect(within(chat()).getByText('<img src=x onerror=alert(1)> & "quotes"')).toBeInTheDocument();
    expect(container.querySelector('img')).toBeNull();
  });

  it('says so when no lines were saved', async () => {
    const w = await hubWorld();
    const f = await w.fileRich({ lines: [], cite: null });
    await open(w, f.id);
    expect(screen.getByText('No chat lines were saved with this report.')).toBeInTheDocument();
    expect(screen.queryByRole('list', { name: 'Chat lines' })).not.toBeInTheDocument();
  });

  it('copes with a hundred lines', async () => {
    const w = await hubWorld();
    const many: RichLine[] = Array.from({ length: 100 }, (_, i) => ({ who: i % 2 === 0 ? 'reporter' : 'target', text: `line number ${i}` }));
    const f = await w.fileRich({ lines: many });
    await open(w, f.id);
    expect(lines()).toHaveLength(100);
  });
});

describe('ReportView: the "Only <name>" filter and the silence warning', () => {
  it('offers Everyone and one button per person, Everyone on', async () => {
    const w = await hubWorld();
    const f = await w.fileRich({ lines: TALK });
    await open(w, f.id);
    const buttons = within(filter()).getAllByRole('button');
    expect(buttons.map((b) => b.textContent)).toEqual(['Everyone', 'Only Mallory', expect.stringMatching(/^Only Reporter\d+$/), 'Only Bystander']);
    expect(within(filter()).getByRole('button', { name: 'Everyone' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('shows just that person\'s lines, and Everyone brings the rest back', async () => {
    const w = await hubWorld();
    const f = await w.fileRich({ lines: TALK });
    const { user } = await open(w, f.id);
    await user.click(within(filter()).getByRole('button', { name: 'Only Mallory' }));
    expect(lines().map((li) => li.textContent)).toEqual([expect.stringContaining('a line from the target'), expect.stringContaining('another line from the target')]);
    expect(within(filter()).getByRole('button', { name: 'Only Mallory' })).toHaveAttribute('aria-pressed', 'true');
    await user.click(within(filter()).getByRole('button', { name: 'Everyone' }));
    expect(lines()).toHaveLength(4);
  });

  it('is operable by keyboard', async () => {
    const w = await hubWorld();
    const f = await w.fileRich({ lines: TALK });
    const { user } = await open(w, f.id);
    within(filter()).getByRole('button', { name: 'Only Bystander' }).focus();
    await user.keyboard('{Enter}');
    expect(lines()).toHaveLength(1);
    expect(within(filter()).getByRole('button', { name: 'Only Bystander' })).toHaveFocus();
  });

  it('warns that the reported person sent no messages, before anything is pressed', async () => {
    const w = await hubWorld();
    const f = await w.fileRich({
      lines: [
        { who: 'reporter', text: 'hello' },
        { who: 'bystander', text: 'who said that' },
      ],
      cite: null,
    });
    await open(w, f.id);
    expect(screen.getByText('Mallory sent no messages in this excerpt.')).toBeInTheDocument();
  });

  it('does not warn when the reported person did write', async () => {
    const w = await hubWorld();
    const f = await w.fileRich({ lines: TALK });
    await open(w, f.id);
    expect(screen.queryByText(/sent no messages/)).not.toBeInTheDocument();
  });

  it('warns for whoever is picked when they wrote nothing, and lists no lines', async () => {
    const w = await hubWorld();
    const f = await w.fileRich({ lines: [{ who: 'target', text: 'only me talking' }] });
    const { user } = await open(w, f.id);
    const reporterButton = within(filter()).getAllByRole('button').find((b) => /Only Reporter/.test(b.textContent ?? ''))!;
    await user.click(reporterButton);
    expect(screen.getByText(/^Reporter\d+ sent no messages in this excerpt\.$/)).toBeInTheDocument();
    expect(screen.queryByRole('list', { name: 'Chat lines' })).not.toBeInTheDocument();
  });
});

describe('ReportView: people', () => {
  it('lists the reported person, the reporter and the bystander with their tags, roles and line counts', async () => {
    const w = await hubWorld();
    const f = await w.fileRich({ lines: TALK });
    await open(w, f.id);
    const rows = within(peopleList()).getAllByRole('listitem');
    expect(rows).toHaveLength(3);
    const target = personRow('Mallory');
    expect(within(target).getByText('Reported')).toBeInTheDocument();
    expect(within(target).getByText(personTag(f.person))).toBeInTheDocument();
    expect(within(target).getByText('Wrote 2 lines')).toBeInTheDocument();
    const bystander = personRow('Bystander');
    expect(within(bystander).getByText('Wrote 1 line')).toBeInTheDocument();
    expect(within(bystander).queryByText('Reported')).not.toBeInTheDocument();
    expect(within(bystander).queryByText('Reporter')).not.toBeInTheDocument();
    const reporter = rows.find((r) => within(r).queryByText('Reporter') !== null);
    expect(reporter).toBeDefined();
    expect(within(reporter!).getByText(personTag(f.reporter))).toBeInTheDocument();
  });

  it('never prints a whole person ref as text', async () => {
    const w = await hubWorld();
    const f = await w.fileRich({ lines: TALK });
    const { container } = await open(w, f.id);
    for (const ref of [f.person, f.reporter, f.bystander as string]) {
      expect(ref.length).toBeGreaterThan(8);
      expect(container.textContent).not.toContain(ref);
      // One more character than the tag must not be printed either. Checked on each piece of text, not on the page's whole text:
      // the tag sits next to a word in its own element, and that word's first letter can by chance be the ref's ninth character.
      const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) expect(node.textContent ?? '').not.toContain(ref.slice(0, 9));
      for (const el of container.querySelectorAll('[aria-label],[title],[alt]')) {
        expect(el.getAttribute('aria-label') ?? '').not.toContain(ref);
        expect(el.getAttribute('title') ?? '').not.toContain(ref);
      }
    }
  });

  it('links every person to their page', async () => {
    const w = await hubWorld();
    const f = await w.fileRich({ lines: TALK });
    const { user, router } = await open(w, f.id);
    const link = within(personRow('Mallory')).getByRole('link', { name: 'Open the history of Mallory' });
    expect(link).toHaveAttribute('href', expect.stringContaining(`/people/${f.person}`));
    await user.click(link);
    expect(router.path).toBe(`/people/${f.person}`);
  });

  it('tells two people with the same handle apart by their tags', async () => {
    const w = await hubWorld();
    const f = await w.fileRich({ lines: TALK, bystander: 'Mallory' });
    await open(w, f.id);
    const names = [...document.querySelectorAll('.cw-person-name')].map((n) => n.textContent);
    expect(names).toContain(`Mallory (${personTag(f.person)})`);
    expect(names).toContain(`Mallory (${personTag(f.bystander as string)})`);
  });

  it('a person without a handle is "Person" and their tag', async () => {
    const w = await hubWorld();
    const f = await w.fileRich({ lines: [{ who: 'reporter', text: 'hi' }] });
    w.intercept.fn = async (req) => {
      if (req.method === 'GET' && req.path === `/reports/${f.id}`) {
        const real = await w.direct.getReport(f.id);
        return { status: 200, body: { ...real, report: { ...real.report, targetHandle: '' } } };
      }
      return undefined;
    };
    renderHub(w, { path: `/reports/${f.id}` });
    expect(await heading(`Insults or harassment report against Person ${personTag(f.person)}`)).toBeInTheDocument();
  });
});

describe('ReportView: records', () => {
  it('a person with nothing on record says so', async () => {
    const w = await hubWorld();
    const f = await w.fileRich({ lines: TALK });
    await open(w, f.id);
    expect(within(personRow('Mallory')).getByText('Nothing on record in the last 90 days.')).toBeInTheDocument();
  });

  it('counts what stands in the last 90 days, by kind', async () => {
    const w = await hubWorld();
    const f = await w.fileRich({ lines: TALK });
    await w.sanction(f.person, 'warning');
    await w.sanction(f.person, 'warning');
    await w.sanction(f.person, 'chat');
    await open(w, f.id);
    expect(within(personRow('Mallory')).getByText('Last 90 days: 2 warnings and 1 chat restriction.')).toBeInTheDocument();
  });

  it('mentions revoked actions without counting them', async () => {
    const w = await hubWorld();
    const f = await w.fileRich({ lines: TALK });
    const s = await w.sanction(f.person, 'chat');
    await w.sanction(f.person, 'warning');
    await w.client.revokeSanction(s.groupId, 'mistake');
    await open(w, f.id);
    expect(within(personRow('Mallory')).getByText('Last 90 days: 1 warning.')).toBeInTheDocument();
    expect(within(personRow('Mallory')).getByText('1 revoked.')).toBeInTheDocument();
  });

  it('ignores what is older than 90 days', async () => {
    const w = await hubWorld();
    const f = await w.fileRich({ lines: TALK });
    await w.sanction(f.person, 'ban');
    w.clock.t += 95 * DAY;
    await open(w, f.id);
    expect(within(personRow('Mallory')).getByText('Nothing on record in the last 90 days.')).toBeInTheDocument();
  });

  it('every person has their own record', async () => {
    const w = await hubWorld();
    const f = await w.fileRich({ lines: TALK });
    await w.sanction(f.bystander as string, 'note');
    await open(w, f.id);
    expect(within(personRow('Bystander')).getByText('Last 90 days: 1 note.')).toBeInTheDocument();
    expect(within(personRow('Mallory')).getByText('Nothing on record in the last 90 days.')).toBeInTheDocument();
  });

  it('shows how the reporter\'s own reports stand', async () => {
    const w = await hubWorld();
    const first = await w.fileRich({ reporter: 'Rae', target: 'A', room: 'a' });
    const second = await w.fileRich({ reporter: 'Rae', target: 'B', room: 'b' });
    await w.fileRich({ reporter: 'Rae', target: 'C', room: 'c' });
    await w.client.decide(first.id, { verdict: 'no_action', reason: 'fine', actions: [] });
    await w.client.decide(second.id, { verdict: 'bad_faith', reason: 'lied', evidence: 'made up', actions: [] });
    renderHub(w, { path: `/reports/${first.id}` });
    await heading(/report against/);
    expect(await within(reporterRow('Rae')).findByText('3 reports, 0 upheld')).toBeInTheDocument();
    expect(within(reporterRow('Rae')).getByText('1 for bad faith.')).toBeInTheDocument();
    expect(within(reporterRow('Rae')).getByRole('meter', { name: '0 of 2 decided reports upheld' })).toBeInTheDocument();
  });

  it('says when the reporter is suspended from reporting', async () => {
    const w = await hubWorld();
    const ids: string[] = [];
    for (let i = 0; i < 4; i += 1) ids.push((await w.fileRich({ reporter: 'Rae', target: `T${i}`, room: `s${i}` })).id);
    for (const id of ids.slice(0, 3)) await w.client.decide(id, { verdict: 'bad_faith', reason: 'lied', evidence: 'made up', actions: [] });
    renderHub(w, { path: `/reports/${ids[3]}` });
    await heading(/report against/);
    const reporter = reporterRow('Rae');
    expect(await within(reporter).findByText('4 reports, 0 upheld')).toBeInTheDocument();
    expect(within(reporter).getByText('3 for bad faith.')).toBeInTheDocument();
    expect(within(reporter).getByText(/^Reporting is suspended until /)).toBeInTheDocument();
  });

  it('does not mention suspension for a reporter in good standing', async () => {
    const w = await hubWorld();
    const f = await w.fileRich({ reporter: 'Rae' });
    await open(w, f.id);
    await within(reporterRow('Rae')).findByText('1 report, 0 upheld');
    expect(screen.queryByText(/suspended/)).not.toBeInTheDocument();
  });

  it('keeps the page when the reporter\'s record cannot be loaded, and says so', async () => {
    const w = await hubWorld();
    const f = await w.fileRich({ reporter: 'Rae', lines: TALK });
    w.intercept.fn = (req) => (req.path.startsWith('/people/') ? { status: 500, body: { error: 'internal', message: 'x' } } : undefined);
    renderHub(w, { path: `/reports/${f.id}` });
    await heading(/report against/);
    expect(await within(reporterRow('Rae')).findByText('The reporter\'s record could not be loaded.')).toBeInTheDocument();
    expect(lines()).toHaveLength(4);
  });

  it('asks for the reporter\'s record once, and for nothing about the other people', async () => {
    const w = await hubWorld();
    const f = await w.fileRich({ lines: TALK });
    await open(w, f.id);
    await screen.findByText('1 report, 0 upheld');
    // The reported person's record and the reporter's track record: one read each, and nothing about the bystander.
    const calls = w.sent.filter((r) => r.path.startsWith('/people/'));
    expect(calls.map((r) => r.path).sort()).toEqual([`/people/${f.person}/history`, `/people/${f.reporter}/history`].sort());
  });
});

describe('ReportView: loading and failing', () => {
  it('shows the plain title while loading', async () => {
    const w = await hubWorld();
    const f = await w.fileRich();
    // The report read is held, so "loading" is on screen for as long as the test looks (not a race against the router).
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => (release = resolve));
    w.intercept.fn = async (req) => {
      if (req.method === 'GET' && req.path === `/reports/${f.id}`) await held;
      return undefined;
    };
    renderHub(w, { path: `/reports/${f.id}` });
    expect(await screen.findByRole('heading', { level: 2, name: 'Report' })).toBeInTheDocument();
    release();
    await heading(/report against/);
  });

  it('a report that does not exist says so', async () => {
    const w = await hubWorld();
    renderHub(w, { path: '/reports/nope' });
    expect(await screen.findByText('That no longer exists.')).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 2, name: 'Report' })).toBeInTheDocument();
  });

  it('a failed load offers a retry that works', async () => {
    const w = await hubWorld();
    const f = await w.fileRich();
    let fail = true;
    w.intercept.fn = (req) => (fail && req.path === `/reports/${f.id}` ? { status: 500, body: { error: 'internal', message: 'x' } } : undefined);
    const { user } = renderHub(w, { path: `/reports/${f.id}` });
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not load the report.');
    fail = false;
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    await heading(/report against/);
  });

  it('a network failure says so', async () => {
    const w = await hubWorld();
    const f = await w.fileRich();
    w.intercept.fn = () => {
      throw new TypeError('offline');
    };
    renderHub(w, { path: `/reports/${f.id}` });
    // `me` also fails, so the hub shows its own start-up failure: the page is never half drawn.
    expect(await screen.findByText('Could not reach the server. Check your connection and try again.')).toBeInTheDocument();
  });

  it('reads the report once (it is audited each time)', async () => {
    const w = await hubWorld();
    const f = await w.fileRich({ lines: TALK });
    await open(w, f.id);
    await screen.findByText('1 report, 0 upheld');
    expect(w.sent.filter((r) => r.method === 'GET' && r.path === `/reports/${f.id}`)).toHaveLength(1);
  });

  it('opens a different report without showing the first one\'s lines', async () => {
    const w = await hubWorld();
    const a = await w.fileRich({ target: 'Alpha', lines: [{ who: 'reporter', text: 'text of alpha' }, { who: 'target', text: 'alpha spoke' }] });
    const b = await w.fileRich({ target: 'Beta', lines: [{ who: 'reporter', text: 'text of beta' }, { who: 'target', text: 'beta spoke' }] });
    const { router } = await open(w, a.id);
    expect(screen.getByText('alpha spoke')).toBeInTheDocument();
    act(() => router.navigate(`/reports/${b.id}`));
    await heading('Insults or harassment report against Beta');
    expect(screen.queryByText('alpha spoke')).not.toBeInTheDocument();
    expect(screen.getByText('beta spoke')).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByText(/text of alpha/)).not.toBeInTheDocument());
  });
});

describe('ReportView: roles', () => {
  it.each(['moderator', 'senior', 'owner'] as const)('a %s can read a report', async (role) => {
    const w = await hubWorld({ role });
    const f = await w.fileRich({ lines: TALK });
    await open(w, f.id);
    expect(lines()).toHaveLength(4);
  });

  it('does not ask for the reporter\'s record when the role cannot read histories', async () => {
    const w = await hubWorld({ permissions: { 'history.read': 'owner' } });
    const f = await w.fileRich({ lines: TALK });
    await open(w, f.id);
    expect(w.sent.some((r) => r.path.startsWith('/people/'))).toBe(false);
    expect(screen.queryByText(/Has filed/)).not.toBeInTheDocument();
    expect(within(personRow('Mallory')).queryByRole('link')).not.toBeInTheDocument();
  });
});

describe('the report is old', () => {
  it('shows an old report\'s relative time', async () => {
    const w = await hubWorld();
    const f = await w.fileRich();
    w.clock.t += 3 * DAY + HOUR;
    await open(w, f.id);
    expect(screen.getByText(/Filed 3 days ago/)).toBeInTheDocument();
  });
});
