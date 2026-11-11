import { describe, expect, it } from 'vitest';
import { DEFAULT_REPORT_REASONS, createChatwarden, defaultReporting } from '@chatwarden/core';
import type { RawWho, ResolvedReporting } from '@chatwarden/core';
import { MemoryStore } from '@chatwarden/store-memory';
import {
  addReason,
  groupsOf,
  isLocked,
  moveReason,
  patchReason,
  playerGroups,
  removeReason,
  reportingDirty,
  reportingDraftOf,
  reportingFieldKey,
  reportingLayer,
  reportingProblems,
  slugOf,
} from '../../src/policy/reporting.js';
import type { ReportingDraft } from '../../src/policy/reporting.js';

// The Reporting settings as a draft: from the settings in force, to the section a save sends, what the kit would refuse, and which field a
// refusal names. Pure functions; the kit's own validator is the judge of what the layer may hold.

const base = (): ResolvedReporting => defaultReporting();
const fresh = (): ReportingDraft => reportingDraftOf(base());
const row = (d: ReportingDraft, id: string) => d.reasons.find((r) => r.id === id)!;

describe('reportingDraftOf', () => {
  it('makes one row per reason, in order, with every field', () => {
    const d = fresh();
    expect(d.flow).toBe('one_tap');
    expect(d.thanks).toBe("Thanks for the report. We'll look into it.");
    expect(d.reasons.map((r) => r.id)).toEqual(DEFAULT_REPORT_REASONS.map((r) => r.id));
    expect(row(d, 'harassment')).toMatchObject({ label: 'Insults or harassment', hint: 'Insults, put-downs or picking on someone', group: 'Chat', rules: [2], asksNote: false, enabled: true });
    expect(row(d, 'other')).toMatchObject({ group: '', rules: [], asksNote: true });
  });

  it('gives every row its own key, so two rows are never confused on the page', () => {
    const keys = fresh().reasons.map((r) => r.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('a kit that sends no reporting yet reads as the defaults', () => {
    expect(reportingDraftOf(undefined)).toEqual(fresh());
  });

  it('does not share its lists with the settings it was made from', () => {
    const b = base();
    const d = reportingDraftOf(b);
    (d.reasons[0] as { rules: number[] }).rules.push(99);
    expect(b.reasons[0]?.rules).toEqual([2]);
  });
});

describe('reportingDirty', () => {
  it('is false for an untouched draft, true for each kind of edit', () => {
    expect(reportingDirty(fresh(), base())).toBe(false);
    const edits: Array<(d: ReportingDraft) => ReportingDraft> = [
      (d) => ({ ...d, flow: 'reason_first' }),
      (d) => ({ ...d, thanks: 'Thank you.' }),
      (d) => patchReason(d, row(d, 'hate').key, { label: 'Hate speech' }),
      (d) => patchReason(d, row(d, 'hate').key, { hint: 'x' }),
      (d) => patchReason(d, row(d, 'hate').key, { group: 'Words' }),
      (d) => patchReason(d, row(d, 'hate').key, { rules: [1, 2] }),
      (d) => patchReason(d, row(d, 'hate').key, { asksNote: true }),
      (d) => patchReason(d, row(d, 'hate').key, { enabled: false }),
      (d) => moveReason(d, row(d, 'hate').key, 1),
      (d) => removeReason(d, row(d, 'hate').key),
      (d) => addReason(d).draft,
    ];
    for (const edit of edits) expect(reportingDirty(edit(fresh()), base())).toBe(true);
  });

  it('trailing spaces are not a change; an edit and its undo are not a change', () => {
    const d = fresh();
    expect(reportingDirty({ ...d, thanks: `${d.thanks}  ` }, base())).toBe(false);
    const there = patchReason(d, row(d, 'hate').key, { label: 'Zzz' });
    const back = patchReason(there, row(there, 'hate').key, { label: 'Hate' });
    expect(reportingDirty(back, base())).toBe(false);
  });
});

describe('slugOf', () => {
  it.each([
    ['Lag switching', 'lag_switching'],
    ['  Wrong-way  chat!! ', 'wrong_way_chat'],
    ['Ünïcode label', 'unicode_label'],
    ['***', 'reason'],
    ['', 'reason'],
    ['A'.repeat(80), 'a'.repeat(28)],
  ])('%j becomes %j', (label, id) => {
    expect(slugOf(label, new Set())).toBe(id);
  });

  it('never reuses an id, and never makes "none"', () => {
    expect(slugOf('Hate', new Set(['hate']))).toBe('hate_2');
    expect(slugOf('Hate', new Set(['hate', 'hate_2']))).toBe('hate_3');
    expect(slugOf('None', new Set())).toBe('none_2');
  });

  it('always makes an id the kit accepts', () => {
    for (const label of ['Cheating (hacks)', '1v1 griefing', '--', 'x'.repeat(31), 'Tab\tand\nnewline']) {
      const id = slugOf(label, new Set());
      expect(id).toMatch(/^[a-z0-9]+(?:[_-][a-z0-9]+)*$/);
      expect(id.length).toBeLessThanOrEqual(32);
    }
  });
});

describe('reportingLayer', () => {
  it('is null for an untouched draft, so a save never writes a copy of the defaults', () => {
    expect(reportingLayer(fresh(), base())).toBeNull();
  });

  it('sends only the flow when only the flow changed', () => {
    expect(reportingLayer({ ...fresh(), flow: 'reason_required' }, base())).toEqual({ flow: 'reason_required' });
  });

  it('sends only the thank-you when only that changed, trimmed', () => {
    expect(reportingLayer({ ...fresh(), thanks: '  Got it.  ' }, base())).toEqual({ thanks: 'Got it.' });
  });

  it('sends the whole reasons list when anything in it changed', () => {
    const d = patchReason(fresh(), row(fresh(), 'hate').key, { label: 'Hate speech' });
    const layer = reportingLayer(d, base());
    expect(Object.keys(layer ?? {})).toEqual(['reasons']);
    expect(layer?.reasons).toHaveLength(10);
    expect(layer?.reasons?.find((r) => r.id === 'hate')?.label).toBe('Hate speech');
    expect(layer?.reasons?.[0]).toEqual({ id: 'harassment', label: 'Insults or harassment', hint: 'Insults, put-downs or picking on someone', group: 'Chat', rules: [2], asksNote: false, enabled: true });
  });

  it('a new row gets an id from its label that no other row has, and keeps its place', () => {
    const d0 = fresh();
    const a = addReason(d0);
    const d1 = patchReason(a.draft, a.key as string, { label: 'Hate' });
    const layer = reportingLayer(d1, base());
    const ids = layer?.reasons?.map((r) => r.id);
    expect(ids).toEqual(['harassment', 'hate', 'sexual', 'threat', 'spam', 'personal_info', 'cheating', 'griefing', 'afk', 'hate_2', 'other']);
  });

  it('"Something else" is always sent switched on', () => {
    const d = fresh();
    const layer = reportingLayer({ ...d, thanks: 'Hi.', reasons: d.reasons.map((r) => (r.id === 'other' ? { ...r, enabled: false } : r)) }, base());
    expect(layer?.reasons).toBeUndefined();
    const changed = reportingLayer(patchReason({ ...d, reasons: d.reasons.map((r) => (r.id === 'other' ? { ...r, enabled: false } : r)) }, row(d, 'other').key, { label: 'Anything else' }), base());
    expect(changed?.reasons?.find((r) => r.id === 'other')).toMatchObject({ enabled: true, label: 'Anything else' });
  });

  it('what it builds is accepted by the real kit, and reads back as what was edited', async () => {
    let d = fresh();
    d = { ...d, flow: 'reason_first', thanks: 'We have it.' };
    const added = addReason(d);
    d = patchReason(added.draft, added.key as string, { label: 'Lag switching', hint: 'Cutting their own connection', group: 'Gameplay', rules: [5, 6], asksNote: true });
    d = moveReason(d, row(d, 'afk').key, -1);
    d = patchReason(d, row(d, 'sexual').key, { enabled: false });
    const layer = reportingLayer(d, base());
    const cw = await createChatwarden({ store: new MemoryStore(), secret: 'reporting-model-test-secret-0000', platform: { identify: (c) => c as RawWho }, retention: false, overrides: { reporting: layer ?? {} } });
    const r = cw.profile.reporting;
    expect(r.flow).toBe('reason_first');
    expect(r.thanks).toBe('We have it.');
    expect(r.reasons.map((x) => x.id)).toEqual(layer?.reasons?.map((x) => x.id));
    expect(r.reasons.find((x) => x.id === 'lag_switching')).toMatchObject({ label: 'Lag switching', group: 'Gameplay', rules: [5, 6], asksNote: true, enabled: true });
    expect(r.reasons.find((x) => x.id === 'sexual')?.enabled).toBe(false);
    expect(reportingDirty(reportingDraftOf(r), r)).toBe(false);
  });
});

describe('reportingProblems', () => {
  it('has none for the defaults', () => {
    expect(reportingProblems(fresh())).toEqual({});
  });

  it.each([
    ['an empty label', 'hate', { label: '   ' }, 'label'],
    ['a label over 60', 'hate', { label: 'x'.repeat(61) }, 'label'],
    ['a hint over 160', 'hate', { hint: 'x'.repeat(161) }, 'hint'],
    ['a group over 40', 'hate', { group: 'x'.repeat(41) }, 'group'],
  ] as const)('%s is marked on its own field', (_n, id, patch, field) => {
    const d = fresh();
    const p = reportingProblems(patchReason(d, row(d, id).key, patch));
    expect(Object.keys(p)).toEqual([`reason-${row(d, id).key}-${field}`]);
  });

  it('exactly at the limits is fine', () => {
    let d = fresh();
    d = patchReason(d, row(d, 'hate').key, { label: 'x'.repeat(60), hint: 'y'.repeat(160), group: 'z'.repeat(40) });
    d = { ...d, thanks: 't'.repeat(300) };
    expect(reportingProblems(d)).toEqual({});
  });

  it('an empty or over-long thank-you is marked', () => {
    expect(Object.keys(reportingProblems({ ...fresh(), thanks: '  ' }))).toEqual(['thanks']);
    expect(Object.keys(reportingProblems({ ...fresh(), thanks: 't'.repeat(301) }))).toEqual(['thanks']);
  });

  it('more than 20 rules on one reason is marked', () => {
    const d = fresh();
    const p = reportingProblems(patchReason(d, row(d, 'hate').key, { rules: Array.from({ length: 21 }, (_, i) => i + 1) }));
    expect(Object.keys(p)).toEqual([`reason-${row(d, 'hate').key}-rules`]);
  });

  it('with every reason off but "Something else", which cannot be off, there is still one on', () => {
    let d = fresh();
    for (const r of d.reasons) d = patchReason(d, r.key, { enabled: false });
    expect(reportingProblems(d)).toEqual({});
  });
});

describe('the rows', () => {
  it('"Something else" cannot be switched off or removed, but can be renamed, re-mapped and given a note', () => {
    const d = fresh();
    const k = row(d, 'other').key;
    expect(isLocked(row(d, 'other'))).toBe(true);
    expect(isLocked(row(d, 'hate'))).toBe(false);
    expect(row(patchReason(d, k, { enabled: false }), 'other').enabled).toBe(true);
    expect(removeReason(d, k)).toBe(d);
    const e = patchReason(d, k, { label: 'Anything else', rules: [7], asksNote: false, hint: 'h', group: 'g' });
    expect(row(e, 'other')).toMatchObject({ label: 'Anything else', rules: [7], asksNote: false, hint: 'h', group: 'g' });
  });

  it('removes any other reason', () => {
    const d = fresh();
    expect(removeReason(d, row(d, 'hate').key).reasons).toHaveLength(9);
    expect(removeReason(d, 'no-such-key')).toBe(d);
  });

  it('moves a row up or down, and the ends stay put', () => {
    const d = fresh();
    const k = (id: string) => row(d, id).key;
    expect(moveReason(d, k('hate'), -1).reasons.slice(0, 2).map((r) => r.id)).toEqual(['hate', 'harassment']);
    expect(moveReason(d, k('harassment'), 1).reasons.slice(0, 2).map((r) => r.id)).toEqual(['hate', 'harassment']);
    expect(moveReason(d, k('harassment'), -1)).toBe(d);
    expect(moveReason(d, k('other'), 1)).toBe(d);
    expect(moveReason(d, 'no-such-key', 1)).toBe(d);
  });

  it('adds a blank row on, before "Something else", up to 20 reasons, and then adds nothing', () => {
    let d = fresh();
    const a = addReason(d);
    expect(a.draft.reasons).toHaveLength(11);
    expect(a.draft.reasons.at(-1)?.id).toBe('other');
    expect(a.draft.reasons.at(-2)).toMatchObject({ key: a.key, id: '', label: '', enabled: true, asksNote: false, rules: [] });
    d = a.draft;
    for (let i = 0; i < 9; i += 1) d = addReason(d).draft;
    expect(d.reasons).toHaveLength(20);
    const full = addReason(d);
    expect(full.draft).toBe(d);
    expect(full.key).toBeNull();
  });

  it('a new blank row is marked until it has a label', () => {
    const a = addReason(fresh());
    expect(Object.keys(reportingProblems(a.draft))).toEqual([`reason-${a.key}-label`]);
  });

  it('lists the group names in use, once each, in order', () => {
    expect(groupsOf(fresh())).toEqual(['Chat', 'Gameplay']);
    const d = fresh();
    expect(groupsOf(patchReason(d, row(d, 'hate').key, { group: '  Zed ' }))).toEqual(['Chat', 'Zed', 'Gameplay']);
  });
});

describe('reportingFieldKey', () => {
  it('names the row by its position in the layer that was sent', () => {
    const d = fresh();
    expect(reportingFieldKey('layer.reporting.reasons[1].label', d)).toBe(`reason-${d.reasons[1]?.key}-label`);
    expect(reportingFieldKey('layer.reporting.reasons[2].hint', d)).toBe(`reason-${d.reasons[2]?.key}-hint`);
    expect(reportingFieldKey('layer.reporting.reasons[3].group', d)).toBe(`reason-${d.reasons[3]?.key}-group`);
    expect(reportingFieldKey('layer.reporting.reasons[4].rules[1]', d)).toBe(`reason-${d.reasons[4]?.key}-rules`);
    expect(reportingFieldKey('layer.reporting.reasons[5].id', d)).toBe(`reason-${d.reasons[5]?.key}-label`);
    expect(reportingFieldKey('layer.reporting.reasons[9].enabled', d)).toBe(`reason-${d.reasons[9]?.key}-label`);
  });

  it('names the list, the flow and the thank-you', () => {
    const d = fresh();
    expect(reportingFieldKey('layer.reporting.reasons', d)).toBe('reasons');
    expect(reportingFieldKey('layer.reporting.flow', d)).toBe('flow');
    expect(reportingFieldKey('layer.reporting.thanks', d)).toBe('thanks');
  });

  it('a row that is not there, and a path that is not reporting, name nothing useful', () => {
    const d = fresh();
    expect(reportingFieldKey('layer.reporting.reasons[40].label', d)).toBe('reasons');
    expect(reportingFieldKey('layer.ladder[0]', d)).toBeNull();
    expect(reportingFieldKey('', d)).toBeNull();
  });
});

describe('playerGroups: what players see', () => {
  it('lists the reasons that are on, grouped, "Something else" last, and leaves out a switched-off reason', () => {
    let d = fresh();
    d = patchReason(d, row(d, 'sexual').key, { enabled: false });
    const groups = playerGroups(d);
    expect(groups.map((g) => g.name)).toEqual(['Chat', 'Gameplay', '']);
    expect(groups[0]?.labels).toEqual(['Insults or harassment', 'Hate', 'Threats', 'Spam or ads', 'Sharing personal info']);
    expect(groups[2]?.labels).toEqual(['Something else']);
  });

  it('a row with no label yet is not shown', () => {
    const a = addReason(fresh());
    expect(playerGroups(a.draft).flatMap((g) => g.labels)).toHaveLength(10);
  });

  it('puts "Something else" last even when moved first or given a group', () => {
    let d = fresh();
    d = patchReason(d, row(d, 'other').key, { group: 'Chat' });
    d = moveReason(moveReason(d, row(d, 'other').key, -1), row(d, 'other').key, -1);
    const groups = playerGroups(d);
    expect(groups.at(-1)).toEqual({ name: '', labels: ['Something else'] });
    expect(groups.flatMap((g) => g.labels).at(-1)).toBe('Something else');
  });
});
