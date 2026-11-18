import { describe, expect, it } from 'vitest';
import { MemoryStore } from '@chatwarden/store-memory';
import { createChatwarden } from '../src/index.js';
import type { KitEvent } from '../src/events.js';
import type { RawWho } from '../src/types.js';
import { OWNER, world } from './reportingWorld.js';
import type { World } from './reportingWorld.js';

// U6: the staff comment thread on a report (desk.workflow). Text only, staff only, never in an event, a webhook, a post, an audit row, a notice, an AI input or a log.

const WORKFLOW = { overrides: { desk: { workflow: true } } };
const SENTINEL = 'SENTINEL-quissel-comment-text';
const MOD = 'mod_ann';
const MOD_B = 'mod_bea';
const SENIOR = 'sen_cy';

const on = () => world(WORKFLOW);
const file = (w: World) => w.file({ reason: 'harassment' });

describe('adding a comment', () => {
  it('add and list oldest first, with the author, the role and the time', async () => {
    const w = await on();
    const f = await file(w);
    const first = w.cw.comments.add(f.id, MOD, 'moderator', 'seen it');
    w.clock.t += 1000;
    const second = w.cw.comments.add(f.id, SENIOR, 'senior', 'waiting for the owner');
    expect(first).toMatchObject({ ok: true, comment: { reportId: f.id, author: MOD, role: 'moderator', kind: 'comment', text: 'seen it' } });
    expect(second.ok).toBe(true);
    const list = w.cw.comments.list(f.id);
    expect(list.map((c) => [c.author, c.text, c.kind])).toEqual([[MOD, 'seen it', 'comment'], [SENIOR, 'waiting for the owner', 'comment']]);
    expect(list[0]?.at).toBe(w.clock.t - 1000);
    expect(typeof list[0]?.id).toBe('string');
    expect(Object.keys(list[0] ?? {}).sort()).toEqual(['at', 'author', 'id', 'kind', 'reportId', 'role', 'text']);
  });

  it('500 code points accepted and 501 refused; 1000 emoji counted as code points, not units', async () => {
    const w = await on();
    const f = await file(w);
    expect(w.cw.comments.add(f.id, MOD, 'moderator', 'a'.repeat(500)).ok).toBe(true);
    expect(w.cw.comments.add(f.id, MOD, 'moderator', 'a'.repeat(501))).toEqual({ ok: false, refused: 'invalid' });
    expect(w.cw.comments.add(f.id, MOD, 'moderator', '\u{1F600}'.repeat(500)).ok).toBe(true);
    expect(w.cw.comments.add(f.id, MOD, 'moderator', '\u{1F600}'.repeat(1000))).toEqual({ ok: false, refused: 'invalid' });
    expect(w.cw.comments.list(f.id)).toHaveLength(2);
  });

  it('empty, whitespace-only and non-text are refused; the text is trimmed', async () => {
    const w = await on();
    const f = await file(w);
    for (const text of ['', '   ', '\n\t ', '\u{200b}\u{200b}', null, undefined, 5, {}]) {
      expect(w.cw.comments.add(f.id, MOD, 'moderator', text as never), JSON.stringify(text)).toEqual({ ok: false, refused: 'invalid' });
    }
    expect(w.cw.comments.add(f.id, MOD, 'moderator', '  hello  ')).toMatchObject({ ok: true, comment: { text: 'hello' } });
  });

  it('a lone surrogate, NUL, bidi and zero-width characters are stripped; blank lines stay as paragraph breaks', async () => {
    const w = await on();
    const f = await file(w);
    const res = w.cw.comments.add(f.id, MOD, 'moderator', 'one\u{202e}\u{200b}two\u{0}\u{d800}\n\n\n\nthree');
    expect(res).toMatchObject({ ok: true, comment: { text: 'onetwo\n\nthree' } });
  });

  it('a term from the matcher is stored as typed (a comment is not a chat line: nothing is masked or struck)', async () => {
    const w = await world({ ...WORKFLOW, matcher: { match: (t) => (/zorbak/i.test(t) ? { termId: 'syn:zorbak' } : null) } });
    const f = await file(w);
    expect(w.cw.comments.add(f.id, MOD, 'moderator', 'he said zorbak twice')).toMatchObject({ ok: true, comment: { text: 'he said zorbak twice' } });
    expect(w.cw.blocked.list({ days: 7 })).toEqual([]);
  });

  it('the 51st comment is refused; removing one makes room', async () => {
    const w = await on();
    const f = await file(w);
    const ids: string[] = [];
    for (let i = 0; i < 50; i++) {
      const r = w.cw.comments.add(f.id, MOD, 'moderator', `c${i}`);
      if (!r.ok) throw new Error(String(i));
      ids.push(r.comment.id);
    }
    expect(w.cw.comments.add(f.id, MOD, 'moderator', 'one too many')).toEqual({ ok: false, refused: 'full' });
    expect(w.cw.comments.remove(f.id, ids[0] as string, MOD, 'moderator')).toEqual({ ok: true });
    expect(w.cw.comments.add(f.id, MOD, 'moderator', 'room again').ok).toBe(true);
  });

  it('an unknown report is not_found; a malformed actor, role or id is a RangeError', async () => {
    const w = await on();
    const f = await file(w);
    expect(w.cw.comments.add('nope', MOD, 'moderator', 'x')).toEqual({ ok: false, refused: 'not_found' });
    expect(() => w.cw.comments.add(f.id, '', 'moderator', 'x')).toThrow(RangeError);
    expect(() => w.cw.comments.add(f.id, 'has space', 'moderator', 'x')).toThrow(RangeError);
    expect(() => w.cw.comments.add(f.id, MOD, 'admin' as never, 'x')).toThrow(RangeError);
  });

  it('a decided report keeps its thread and still takes a comment', async () => {
    const w = await on();
    const f = await file(w);
    w.cw.comments.add(f.id, MOD, 'moderator', 'before');
    await w.cw.decide({ reportId: f.id, verdict: 'no_action', actions: [], actor: MOD });
    expect(w.cw.comments.add(f.id, MOD, 'moderator', 'after').ok).toBe(true);
    expect(w.cw.comments.list(f.id)).toHaveLength(2);
  });

  it('is never claim-gated: a moderator who does not hold the case can comment', async () => {
    const w = await on();
    const f = await file(w);
    expect(w.cw.cases.claim(f.target, MOD_B)).toMatchObject({ ok: true });
    expect(w.cw.comments.add(f.id, MOD, 'moderator', 'a word from another desk').ok).toBe(true);
    expect(w.cw.cases.holder(f.target)?.by).toBe(MOD_B);
  });

  it('the comment moves the change token', async () => {
    const w = await on();
    const f = await file(w);
    const before = w.cw.changes.token();
    w.cw.comments.add(f.id, MOD, 'moderator', 'x');
    expect(w.cw.changes.token()).not.toBe(before);
  });
});

describe('removing a comment', () => {
  it('the author may; a senior may remove any; another moderator may not; an unknown id gets the same answer as someone else\'s', async () => {
    const w = await on();
    const f = await file(w);
    const mine = w.cw.comments.add(f.id, MOD, 'moderator', 'mine');
    const theirs = w.cw.comments.add(f.id, MOD_B, 'moderator', 'theirs');
    const other = w.cw.comments.add(f.id, MOD_B, 'moderator', 'also theirs');
    if (!mine.ok || !theirs.ok || !other.ok) throw new Error('add failed');
    const notYours = w.cw.comments.remove(f.id, theirs.comment.id, MOD, 'moderator');
    const unknown = w.cw.comments.remove(f.id, 'no-such-id', MOD, 'moderator');
    expect(notYours).toEqual({ ok: false, refused: 'not_found' });
    expect(unknown).toEqual(notYours);
    expect(w.cw.comments.remove(f.id, mine.comment.id, MOD, 'moderator')).toEqual({ ok: true });
    expect(w.cw.comments.remove(f.id, theirs.comment.id, SENIOR, 'senior')).toEqual({ ok: true });
    expect(w.cw.comments.remove(f.id, other.comment.id, 'owner_ann', 'owner')).toEqual({ ok: true });
    expect(w.cw.comments.list(f.id)).toEqual([]);
    expect(w.cw.comments.remove(f.id, mine.comment.id, MOD, 'moderator')).toEqual({ ok: false, refused: 'not_found' });
  });

  it('a comment id of another report is not removable through this one', async () => {
    const w = await on();
    const a = await file(w);
    const b = await file(w);
    const c = w.cw.comments.add(a.id, MOD, 'moderator', 'on a');
    if (!c.ok) throw new Error('add failed');
    expect(w.cw.comments.remove(b.id, c.comment.id, MOD, 'moderator')).toEqual({ ok: false, refused: 'not_found' });
    expect(w.cw.comments.list(a.id)).toHaveLength(1);
  });
});

describe('where a comment is never found', () => {
  it('is not in events, webhooks, audit rows, notices, AI inputs or logs (each output scanned for a sentinel)', async () => {
    const w = await on();
    const events: KitEvent[] = [];
    w.cw.on('*', (e) => void events.push(e));
    const f = await file(w);
    w.cw.comments.add(f.id, MOD, 'moderator', SENTINEL);
    w.cw.cases.escalate(f.id, MOD, 'moderator', { to: 'senior', note: SENTINEL });
    w.cw.cases.handoff(f.id, MOD);
    await w.cw.decide({ reportId: f.id, verdict: 'no_action', actions: [], actor: MOD });
    expect(w.cw.audit.record({ actor: MOD, role: 'moderator', action: 'report.comment', target: { type: 'report', ref: f.id } })).toBe(true);
    const scans: Array<[string, unknown]> = [
      ['events', events],
      ['audit', w.cw.audit.list({ limit: 50 }).items],
      ['logged', w.logged],
      ['notices', w.cw.notices.pending({ clientKey: 'key-target-1' })],
      ['reporter notices', w.cw.notices.pending({ clientKey: 'key-reporter' })],
      ['the report list', w.cw.reports.list({}).items.map((r) => ({ ...r, excerpt: undefined }))],
      ['the person history', w.cw.history(f.target)],
    ];
    for (const [name, value] of scans) expect(JSON.stringify(value), name).not.toContain(SENTINEL);
  });

  it('is not in the AI brief: prepareCase renders the same prompt with and without comments', async () => {
    const { prepareCase } = await import('../src/ai/case.js');
    const { mkReport } = await import('./ai/reportFixtures.js');
    const { PRESETS } = await import('../src/profile.js');
    const { defineRules, starterRules } = await import('../src/rules.js');
    const { defaultReporting } = await import('../src/reporting.js');
    const report = mkReport([{ who: 'target', text: 'you are a zorbak' }], { reason: 'harassment', note: 'a note' });
    const policy = { profile: PRESETS.standard, rules: defineRules(starterRules('standard')) };
    const prepared = prepareCase({ report, policy, reasons: defaultReporting().reasons, adapterId: 'fake:one', mask: false });
    expect(JSON.stringify(prepared.input)).not.toContain(SENTINEL);
  });

  it('deleting a report deletes its comments (purge and erase)', async () => {
    const w = await on();
    const f = await w.file({ reason: 'harassment' });
    const g = await w.file({ reason: 'harassment' });
    w.cw.comments.add(f.id, MOD, 'moderator', SENTINEL);
    w.cw.comments.add(g.id, MOD, 'moderator', 'kept');
    w.clock.t += 100 * 86_400_000;
    await w.cw.purge();
    expect(w.cw.comments.list(f.id)).toEqual([]);
    expect(w.store.listComments?.(f.id)).toEqual([]);
    expect(w.store.listComments?.(g.id)).toEqual([]);
  });
});

describe('desk.workflow off', () => {
  it('add is off, list is empty, remove is off, nothing is written; cw.desk.workflowEnabled() is false', async () => {
    const w = await world();
    const f = await file(w);
    expect(w.cw.desk.workflowEnabled()).toBe(false);
    expect(w.cw.comments.add(f.id, MOD, 'moderator', 'x')).toEqual({ ok: false, refused: 'off' });
    expect(w.cw.comments.list(f.id)).toEqual([]);
    expect(w.cw.comments.remove(f.id, 'x', MOD, 'moderator')).toEqual({ ok: false, refused: 'off' });
    expect(w.store.countComments?.(f.id)).toBe(0);
  });

  it('the owner turns it on in the layer and it works at once; turning it off again hides the thread without deleting it', async () => {
    const w = await world();
    const f = await file(w);
    expect(w.cw.policy.save({ desk: { workflow: true } }, { version: 0, ...OWNER })).toMatchObject({ ok: true });
    expect(w.cw.desk.workflowEnabled()).toBe(true);
    expect(w.cw.comments.add(f.id, MOD, 'moderator', 'on').ok).toBe(true);
    expect(w.cw.policy.reset('desk')).toMatchObject({ ok: true });
    expect(w.cw.comments.list(f.id)).toEqual([]);
    expect(w.store.countComments?.(f.id)).toBe(1);
  });
});

describe('a store that cannot keep comments', () => {
  const bare = (): MemoryStore => {
    const s = new MemoryStore();
    for (const m of ['insertComment', 'listComments', 'deleteComment', 'countComments', 'setEscalation', 'countOpenEscalated'] as const) (s as unknown as Record<string, unknown>)[m] = undefined;
    return s;
  };

  it('createChatwarden throws a plain message when desk.workflow is on and the store lacks the methods', async () => {
    await expect(
      createChatwarden({ store: bare(), secret: 's', platform: { identify: (c) => c as RawWho }, retention: false, overrides: { desk: { workflow: true } } }),
    ).rejects.toThrow(/desk\.workflow needs a store/);
    // off: fine
    await expect(createChatwarden({ store: bare(), secret: 's', platform: { identify: (c) => c as RawWho }, retention: false })).resolves.toBeDefined();
  });

  it('a layer that turns it on over such a store is refused when saved, and a stored one reads as off', async () => {
    const store = bare();
    const w = await world({}, store);
    expect(w.cw.policy.save({ desk: { workflow: true } }, { version: 0, ...OWNER })).toEqual({ ok: false, error: 'invalid', path: 'layer.desk.workflow' });
    store.savePolicyLayer?.({ desk: { workflow: true } } as never, 0);
    const again = await world({}, store);
    expect(again.cw.desk.workflowEnabled()).toBe(false);
  });
});
