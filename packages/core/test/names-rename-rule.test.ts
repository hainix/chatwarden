import { describe, expect, it } from 'vitest';
import { MemoryStore } from '@chatwarden/store-memory';
import type { NoticeRow, RawWho, SubjectId } from '../src/types.js';
import { defineRules, starterRules } from '../src/rules.js';
import { world } from './reportingWorld.js';

// A rename always cites a rule (0.2.0): `rule` is required, must be an active integer rule, and no default (the slur filter's
// `autoRestrictRule`) stands in any more.

const ACTOR = 'mod_ann';
const REASON = 'private note: a name against the rules';

async function kit(over: Record<string, unknown> = {}) {
  const w = await world({
    overrides: { names: { renames: true } },
    platform: { identify: (ctx: unknown) => ctx as RawWho },
    ...over,
  } as never, new MemoryStore());
  w.cw.rooms.seat('room', 'p1', { clientKey: 'k1' }, 'Name');
  await w.cw.flush();
  const subject = w.cw.rooms.subjectAt('room', 'p1') as SubjectId;
  const rows = (): NoticeRow[] => (w.store as MemoryStore).rawNotices();
  const ask = (input: Record<string, unknown>) => w.cw.names.requireRename({ subject, actor: ACTOR, reason: REASON, ...input } as never);
  return { ...w, subject, rows, ask };
}

describe('requireRename: the rule is required', () => {
  it.each([
    ['missing', {}],
    ['undefined', { rule: undefined }],
    ['null', { rule: null }],
    ['a string', { rule: '2' }],
    ['a float', { rule: 1.5 }],
    ['NaN', { rule: Number.NaN }],
    ['Infinity', { rule: Number.POSITIVE_INFINITY }],
    ['zero', { rule: 0 }],
    ['negative', { rule: -3 }],
    ['unknown', { rule: 9999 }],
    ['unsafe', { rule: Number.MAX_SAFE_INTEGER + 2 }],
  ])('a %s rule is invalid and writes nothing', async (_name, over) => {
    const k = await kit();
    expect(k.ask(over)).toEqual({ ok: false, error: 'invalid' });
    expect(k.rows()).toEqual([]);
  });

  it('a retired rule is invalid', async () => {
    const rules = defineRules(starterRules('standard').map((r) => (r.number === 8 ? { ...r, retired: true } : r)));
    const k = await kit({ rules });
    expect(k.ask({ rule: 8 })).toEqual({ ok: false, error: 'invalid' });
    expect(k.rows()).toEqual([]);
    expect(k.ask({ rule: 7 })).toMatchObject({ ok: true });
  });

  it.each([1, 2, 7])('a numbered rule (%i) is accepted and shown on the notice and the event', async (rule) => {
    const k = await kit();
    const events: unknown[] = [];
    k.cw.on('*', (e) => void events.push(e));
    expect(k.ask({ rule })).toMatchObject({ ok: true });
    expect(k.rows()[0]).toMatchObject({ kind: 'rename_required', rule: String(rule) });
    expect(k.cw.notices.pending({ clientKey: 'k1' })[0]).toMatchObject({ kind: 'rename_required', rule });
    expect(events.filter((e) => (e as { type: string }).type === 'rename.required')).toMatchObject([{ rule }]);
  });

  it('the checks keep their order: off first, whatever the rule', async () => {
    const k = await kit({ overrides: { names: {} } });
    expect(k.ask({})).toEqual({ ok: false, error: 'off' });
    expect(k.ask({ rule: 7 })).toEqual({ ok: false, error: 'off' });
  });

  it('no default rule is used any more: the slur filter rule is not borrowed', async () => {
    const k = await kit({ autoRestrictRule: 3 });
    expect(k.ask({ rule: undefined })).toEqual({ ok: false, error: 'invalid' });
    expect(k.rows()).toEqual([]);
    expect(k.ask({ rule: 7 })).toMatchObject({ ok: true });
    expect(k.rows()[0]?.rule).toBe('7');
  });
});
