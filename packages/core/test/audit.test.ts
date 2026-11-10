import { describe, expect, it } from 'vitest';
import { createChatwarden } from '../src/chatwarden.js';
import type { ChatwardenOptions } from '../src/chatwarden.js';
import { AUDIT_ACTIONS, AuditQueryError, ROLES } from '../src/audit.js';
import type { AuditAction, AuditRow, Role } from '../src/audit.js';
import { ProfileError } from '../src/profile.js';
import { RETENTION_DEFAULTS } from '../src/retention.js';
import type { Logger, Platform, RawWho } from '../src/types.js';
import { MemoryStore } from './memoryStore.js';

const NOW = 1_800_000_000_000;
const DAY = 86_400_000;

type Logged = Array<[string, Record<string, string | number | boolean> | undefined]>;

async function setup(over: Partial<ChatwardenOptions> = {}, store = new MemoryStore()) {
  const clock = { t: NOW, now: () => clock.t };
  const logged: Logged = [];
  const logger: Logger = { warn: (event, detail) => void logged.push([event, detail]) };
  const platform: Platform = { identify: (ctx) => ctx as RawWho };
  const cw = await createChatwarden({ store, secret: 'audit-secret', platform, clock, logger, retention: false, ...over });
  logged.length = 0; // creation warnings (no matcher, no profanity filter) are not what these tests look at
  return { cw, store, clock, logged };
}

const rec = (cw: Awaited<ReturnType<typeof setup>>['cw'], over: Record<string, unknown> = {}): boolean =>
  cw.audit.record({ actor: 'alice', role: 'moderator', action: 'report.view', ...over } as never);

describe('AUDIT_ACTIONS and ROLES', () => {
  it('are the closed lists of the brief, in order', () => {
    expect([...AUDIT_ACTIONS]).toEqual([
      'report.view',
      'report.decide',
      'sanction.apply',
      'sanction.revoke',
      'gap.close',
      'term.add',
      'term.update',
      'term.toggle',
      'exception.add',
      'exception.update',
      'exception.toggle',
      'history.view',
      'suggest',
      'policy.view',
    ]);
    expect([...ROLES]).toEqual(['moderator', 'senior', 'owner']);
  });
});

describe('cw.audit.record and list', () => {
  it('round-trips one entry, stamped with the injected clock', async () => {
    const { cw, clock } = await setup();
    clock.t = NOW + 5;
    expect(rec(cw, { actor: 'alice', role: 'senior', action: 'report.decide', target: { type: 'report', ref: 'r_1' } })).toBe(true);
    const page = cw.audit.list({ limit: 10 });
    expect(page.next).toBeNull();
    expect(page.items).toHaveLength(1);
    expect(page.items[0]).toEqual({
      id: expect.stringMatching(/^[A-Za-z0-9_-]{22}$/),
      at: NOW + 5,
      actor: 'alice',
      role: 'senior',
      action: 'report.decide',
      target: { type: 'report', ref: 'r_1' },
    });
  });

  it('an entry without a target has no target key at all', async () => {
    const { cw } = await setup();
    rec(cw, { action: 'policy.view' });
    const [item] = cw.audit.list({ limit: 5 }).items;
    expect(item).toBeDefined();
    expect('target' in (item as object)).toBe(false);
    expect(Object.keys(item as object).sort()).toEqual(['action', 'actor', 'at', 'id', 'role']);
  });

  it('accepts every action, every role and every target type', async () => {
    const { cw } = await setup();
    for (const action of AUDIT_ACTIONS) expect(rec(cw, { action })).toBe(true);
    for (const role of ROLES) expect(rec(cw, { role })).toBe(true);
    for (const type of ['report', 'sanction', 'person', 'term', 'exception']) {
      expect(rec(cw, { target: { type, ref: 'x1' } })).toBe(true);
    }
    expect(cw.audit.list({ limit: 200 }).items).toHaveLength(AUDIT_ACTIONS.length + ROLES.length + 5);
  });

  it('lists newest first', async () => {
    const { cw, clock } = await setup();
    for (let i = 0; i < 4; i++) {
      clock.t = NOW + i;
      rec(cw, { actor: `a${i}` });
    }
    expect(cw.audit.list({ limit: 10 }).items.map((x) => x.actor)).toEqual(['a3', 'a2', 'a1', 'a0']);
  });

  it('stores only the fields it is given: extra keys (chat text, reasons) never reach the store', async () => {
    const { cw, store } = await setup();
    rec(cw, { reason: 'SECRET REASON', text: 'SECRET TEXT', note: 'SECRET NOTE', target: { type: 'report', ref: 'r1', text: 'SECRET T2' } });
    const dumped = JSON.stringify(store.listAudit({ limit: 10 }));
    expect(dumped).not.toContain('SECRET');
    expect(Object.keys(store.listAudit({ limit: 10 })[0] as object).sort()).toEqual(['action', 'actor', 'at', 'id', 'role', 'target']);
  });

  it('a stored row is a copy: changing a listed item does not change the next list', async () => {
    const { cw } = await setup();
    rec(cw, { target: { type: 'report', ref: 'r1' } });
    const first = cw.audit.list({ limit: 5 }).items[0] as { actor: string; target?: { ref: string } };
    first.actor = 'mallory';
    if (first.target) first.target.ref = 'zzz';
    const again = cw.audit.list({ limit: 5 }).items[0];
    expect(again?.actor).toBe('alice');
    expect(again?.target?.ref).toBe('r1');
  });
});

describe('cw.audit.record: refusals and fencing', () => {
  it('refuses an unknown action: false, nothing stored, one log line with no identifier', async () => {
    const { cw, logged } = await setup();
    expect(rec(cw, { action: 'report.delete' })).toBe(false);
    expect(rec(cw, { action: 'term.edit' })).toBe(false);
    expect(rec(cw, { action: '' })).toBe(false);
    expect(rec(cw, { action: undefined })).toBe(false);
    expect(rec(cw, { action: 7 })).toBe(false);
    expect(cw.audit.list({ limit: 10 }).items).toEqual([]);
    expect(logged).toHaveLength(5);
    expect(logged.every(([e, d]) => e === 'chatwarden.audit_refused' && d === undefined)).toBe(true);
  });

  it('refuses an unknown role, a missing actor and a malformed target', async () => {
    const { cw } = await setup();
    const bad: Array<Record<string, unknown>> = [
      { role: 'admin' },
      { role: null },
      { role: undefined },
      { actor: '' },
      { actor: undefined },
      { actor: 42 },
      { actor: 'x'.repeat(129) },
      { actor: 'Jane Doe' },
      { actor: ' alice' },
      { actor: 'alice ' },
      { actor: 'a	b' },
      { actor: 'zoë' },
      { actor: 'a/b' },
      { actor: '<b>' },
      { target: { type: 'report', ref: 'x'.repeat(65) } },
      { actor: 'line\nbreak' },
      { target: { type: 'chat', ref: 'x' } },
      { target: { type: 'report', ref: '' } },
      { target: { type: 'report', ref: 'has space' } },
      { target: { type: 'report', ref: 'a line of chat text' } },
      { target: { type: 'report', ref: 'x'.repeat(129) } },
      { target: { type: 'report' } },
      { target: 'report:r1' },
      { target: null },
    ];
    for (const over of bad) expect(rec(cw, over), JSON.stringify(over)).toBe(false);
    expect(cw.audit.list({ limit: 10 }).items).toEqual([]);
  });

  it('refuses a non-object input without throwing', async () => {
    const { cw } = await setup();
    expect(cw.audit.record(undefined as never)).toBe(false);
    expect(cw.audit.record(null as never)).toBe(false);
    expect(cw.audit.record('x' as never)).toBe(false);
  });

  it('is fenced: a store that throws gives false and a log line carrying only the error class', async () => {
    class Broken extends MemoryStore {
      override insertAudit(): void {
        throw new RangeError('secret detail with 198.51.100.1');
      }
    }
    const { cw, logged } = await setup({}, new Broken());
    expect(rec(cw)).toBe(false);
    expect(logged).toEqual([['chatwarden.audit_failed', { error: 'RangeError' }]]);
  });

  it('is fenced against a logger that throws', async () => {
    const { cw } = await setup({ logger: { warn: () => { throw new Error('logger down'); } } });
    expect(rec(cw, { action: 'nope' })).toBe(false);
  });

  it('is synchronous: it returns a boolean, not a promise', async () => {
    const { cw } = await setup();
    expect(typeof rec(cw)).toBe('boolean');
  });
});

describe('cw.audit.record: actor and ref charsets', () => {
  it('accepts a staff ref or an email-style login', async () => {
    const { cw } = await setup();
    for (const actor of ['alice', 's_Ab-1_2', 'jane.doe@example.com', 'jane+ops@example.co.uk', 'mod:42', 'x'.repeat(128)]) {
      expect(rec(cw, { actor }), actor).toBe(true);
    }
    expect(cw.audit.list({ limit: 10, actor: 'jane.doe@example.com' }).items).toHaveLength(1);
  });

  it('a ref of 64 characters is accepted and 65 is refused', async () => {
    const { cw } = await setup();
    expect(rec(cw, { target: { type: 'report', ref: 'r'.repeat(64) } })).toBe(true);
    expect(rec(cw, { target: { type: 'report', ref: 'r'.repeat(65) } })).toBe(false);
  });

  it('list can still filter on a legacy actor with spaces (the restriction is for record only)', async () => {
    class Legacy extends MemoryStore {}
    const store = new Legacy();
    store.insertAudit({ id: 'legacy', at: NOW, actor: 'Old Mod Name', role: null, action: 'term.add', target: null });
    const { cw } = await setup({}, store);
    expect(cw.audit.list({ limit: 5, actor: 'Old Mod Name' }).items).toHaveLength(1);
  });
});

describe('cw.audit.list: filters', () => {
  async function seeded() {
    const t = await setup();
    const rows: Array<[string, Role, AuditAction]> = [
      ['alice', 'moderator', 'report.view'],
      ['bob', 'senior', 'report.decide'],
      ['alice', 'moderator', 'report.decide'],
      ['carol', 'owner', 'term.add'],
      ['alice', 'moderator', 'report.view'],
    ];
    rows.forEach(([actor, role, action], i) => {
      t.clock.t = NOW + i;
      rec(t.cw, { actor, role, action });
    });
    return t;
  }

  it('by actor', async () => {
    const { cw } = await seeded();
    expect(cw.audit.list({ limit: 10, actor: 'alice' }).items.map((x) => x.action)).toEqual(['report.view', 'report.decide', 'report.view']);
    expect(cw.audit.list({ limit: 10, actor: 'carol' }).items).toHaveLength(1);
  });

  it('by action', async () => {
    const { cw } = await seeded();
    expect(cw.audit.list({ limit: 10, action: 'report.decide' }).items.map((x) => x.actor)).toEqual(['alice', 'bob']);
    expect(cw.audit.list({ limit: 10, action: 'term.add' }).items.map((x) => x.actor)).toEqual(['carol']);
  });

  it('both filters together are an AND', async () => {
    const { cw } = await seeded();
    expect(cw.audit.list({ limit: 10, actor: 'alice', action: 'report.decide' }).items).toHaveLength(1);
    expect(cw.audit.list({ limit: 10, actor: 'bob', action: 'report.view' }).items).toEqual([]);
  });

  it('a filter that matches nothing is an empty page with no cursor (control: no filter returns all)', async () => {
    const { cw } = await seeded();
    expect(cw.audit.list({ limit: 10, actor: 'nobody' })).toEqual({ items: [], next: null });
    expect(cw.audit.list({ limit: 10 }).items).toHaveLength(5);
  });

  it('actor is matched exactly, not as a prefix or case-insensitively', async () => {
    const { cw } = await seeded();
    expect(cw.audit.list({ limit: 10, actor: 'ali' }).items).toEqual([]);
    expect(cw.audit.list({ limit: 10, actor: 'ALICE' }).items).toEqual([]);
  });

  it('an unknown action filter or a non-string actor filter is an AuditQueryError', async () => {
    const { cw } = await seeded();
    expect(() => cw.audit.list({ limit: 10, action: 'nope' as never })).toThrow(AuditQueryError);
    expect(() => cw.audit.list({ limit: 10, action: 3 as never })).toThrow(AuditQueryError);
    expect(() => cw.audit.list({ limit: 10, actor: 3 as never })).toThrow(AuditQueryError);
    expect(() => cw.audit.list({ limit: 10, actor: '' })).toThrow(AuditQueryError);
    try {
      cw.audit.list({ limit: 10, action: 'nope' as never });
    } catch (err) {
      expect((err as AuditQueryError).field).toBe('action');
      expect((err as Error).message).not.toContain('nope');
    }
  });
});

describe('cw.audit.list: limit', () => {
  it.each([0, -1, 201, 1000, 1.5, Number.NaN, Number.POSITIVE_INFINITY, '5', null, undefined, {}, [3]])(
    'limit %j throws RangeError',
    async (limit) => {
      const { cw } = await setup();
      rec(cw);
      expect(() => cw.audit.list({ limit: limit as never })).toThrow(RangeError);
    },
  );

  it('1 and 200 are accepted', async () => {
    const { cw } = await setup();
    rec(cw);
    expect(cw.audit.list({ limit: 1 }).items).toHaveLength(1);
    expect(cw.audit.list({ limit: 200 }).items).toHaveLength(1);
  });

  it('a missing query throws RangeError, not a TypeError', async () => {
    const { cw } = await setup();
    expect(() => (cw.audit.list as (q?: unknown) => unknown)()).toThrow(RangeError);
  });

  it('the message never echoes the input', async () => {
    const { cw } = await setup();
    try {
      cw.audit.list({ limit: 9999 });
      expect.unreachable();
    } catch (err) {
      expect((err as Error).message).not.toContain('9999');
    }
  });
});

describe('cw.audit.list: keyset paging', () => {
  async function ties(n: number) {
    const t = await setup();
    for (let i = 0; i < n; i++) rec(t.cw, { actor: `a${i}` });
    return t;
  }

  function walk(cw: Awaited<ReturnType<typeof setup>>['cw'], limit: number, extra: Record<string, unknown> = {}) {
    const pages: AuditRow[][] = [];
    let before: string | undefined;
    for (let guard = 0; guard < 50; guard++) {
      const page = cw.audit.list({ limit, ...(before === undefined ? {} : { before }), ...extra } as never);
      pages.push(page.items as never);
      if (page.next === null) break;
      before = page.next;
    }
    return pages;
  }

  it('ties on `at` are broken by id: every entry appears exactly once across pages', async () => {
    const { cw } = await ties(7);
    const pages = walk(cw, 2);
    const all = pages.flat();
    expect(all).toHaveLength(7);
    expect(new Set(all.map((x) => x.id)).size).toBe(7);
    // id descending within the shared instant
    const ids = all.map((x) => x.id);
    expect(ids).toEqual([...ids].sort().reverse());
  });

  it('paging a mixed set (ties and distinct times) is the same as one big page', async () => {
    const { cw, clock } = await setup();
    for (let i = 0; i < 12; i++) {
      clock.t = NOW + Math.floor(i / 3);
      rec(cw, { actor: `a${i}` });
    }
    const whole = cw.audit.list({ limit: 200 }).items;
    for (const size of [1, 2, 3, 4, 5, 11, 12, 13]) {
      expect(walk(cw, size).flat().map((x) => x.id), `page size ${size}`).toEqual(whole.map((x) => x.id));
    }
  });

  it('next is null on a short page; a full page carries a cursor and the page after an exactly-full one is empty', async () => {
    const { cw } = await ties(4);
    expect(cw.audit.list({ limit: 5 }).next).toBeNull();
    const full = cw.audit.list({ limit: 4 });
    expect(full.items).toHaveLength(4);
    expect(typeof full.next).toBe('string');
    expect(cw.audit.list({ limit: 4, before: full.next as string })).toEqual({ items: [], next: null });
  });

  it('paging composes with filters', async () => {
    const { cw, clock } = await setup();
    for (let i = 0; i < 9; i++) {
      clock.t = NOW + Math.floor(i / 2);
      rec(cw, { actor: i % 3 === 0 ? 'alice' : 'bob', action: i % 2 === 0 ? 'report.view' : 'suggest' });
    }
    const all = cw.audit.list({ limit: 200, actor: 'alice', action: 'report.view' }).items;
    expect(all.length).toBeGreaterThan(0);
    const paged = walk(cw, 1, { actor: 'alice', action: 'report.view' }).flat();
    expect(paged.map((x) => x.id)).toEqual(all.map((x) => x.id));
  });

  it('a cursor stays valid when newer entries arrive meanwhile (no duplicates, no skips)', async () => {
    const { cw, clock } = await setup();
    for (let i = 0; i < 4; i++) {
      clock.t = NOW + i;
      rec(cw, { actor: `a${i}` });
    }
    const first = cw.audit.list({ limit: 2 });
    clock.t = NOW + 100;
    rec(cw, { actor: 'late' });
    const second = cw.audit.list({ limit: 2, before: first.next as string });
    expect([...first.items, ...second.items].map((x) => x.actor)).toEqual(['a3', 'a2', 'a1', 'a0']);
  });

  it.each(['', 'not a cursor', '!!!!', 'AAAA', 'Zm9v', 'x'.repeat(5000), '..', '\u0000'])(
    'a cursor that we did not issue (%j) is an AuditQueryError on `before`',
    async (bad) => {
      const { cw } = await setup();
      rec(cw);
      try {
        cw.audit.list({ limit: 5, before: bad });
        expect.unreachable();
      } catch (err) {
        expect(err).toBeInstanceOf(AuditQueryError);
        expect((err as AuditQueryError).field).toBe('before');
        expect((err as Error).message).not.toContain('not a cursor');
      }
    },
  );

  it('a non-string before is refused and a null before is the first page', async () => {
    const { cw } = await setup();
    expect(() => cw.audit.list({ limit: 5, before: 12 as never })).toThrow(AuditQueryError);
    expect(() => cw.audit.list({ limit: 5, before: null as never })).not.toThrow();
  });
});

describe('legacy term rows through the store contract', () => {
  it('the facade never returns anything but the five fields (no json, no text)', async () => {
    const { cw } = await setup();
    rec(cw, { target: { type: 'term', ref: 't1' } });
    for (const item of cw.audit.list({ limit: 5 }).items) {
      expect(Object.keys(item).every((k) => ['id', 'at', 'actor', 'role', 'action', 'target'].includes(k))).toBe(true);
    }
  });
});

describe('retention: non-finite values are refused for every field', () => {
  const fields = ['reportsMs', 'sanctionAfterEndMs', 'strikesMs', 'noticesMs', 'badFaithMs', 'auditMs'] as const;
  for (const field of fields) {
    for (const bad of [Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, Number.NaN]) {
      it(`${field} = ${bad} is a ProfileError naming the field, at creation and on purge(policy)`, async () => {
        await expect(setup({ retention: { [field]: bad } })).rejects.toThrow(new RegExp(`^retention[.]${field} `));
        await expect(setup({ retention: { [field]: bad } })).rejects.toBeInstanceOf(ProfileError);
        const { cw } = await setup();
        await expect(cw.purge({ [field]: bad })).rejects.toBeInstanceOf(ProfileError);
      });
    }
  }

  it('one bad override does not poison the next purge', async () => {
    const { cw } = await setup();
    await expect(cw.purge({ auditMs: Number.POSITIVE_INFINITY })).rejects.toBeInstanceOf(ProfileError);
    await expect(cw.purge()).resolves.toMatchObject({ audit: 0 });
  });

  it('finite values are unaffected (control)', async () => {
    const { cw } = await setup({ retention: { reportsMs: 1, strikesMs: 1 } });
    await cw.close();
  });
});

describe('retention.auditMs', () => {
  it('defaults to 365 days', () => {
    expect(RETENTION_DEFAULTS.auditMs).toBe(365 * DAY);
  });

  async function aged(over: Partial<ChatwardenOptions> = {}) {
    const t = await setup(over);
    const put = (at: number, actor: string) => {
      t.clock.t = at;
      rec(t.cw, { actor });
    };
    put(NOW - 366 * DAY, 'old');
    put(NOW - 365 * DAY - 1, 'just-old');
    put(NOW - 365 * DAY, 'on-the-line');
    put(NOW - 364 * DAY, 'young');
    t.clock.t = NOW;
    return t;
  }

  it('purge deletes entries strictly older than 365 days and keeps the one on the line', async () => {
    const { cw } = await aged();
    const res = await cw.purge();
    expect(res.audit).toBe(2);
    expect(cw.audit.list({ limit: 10 }).items.map((x) => x.actor)).toEqual(['young', 'on-the-line']);
  });

  it('a second purge deletes nothing more', async () => {
    const { cw } = await aged();
    await cw.purge();
    expect((await cw.purge()).audit).toBe(0);
  });

  it('a longer auditMs keeps more; a purge(policy) override wins over the creation policy', async () => {
    const { cw } = await aged({ retention: { auditMs: 400 * DAY } });
    // `retention: false` was replaced by a policy, so a timer exists; close it at the end.
    expect((await cw.purge()).audit).toBe(0);
    expect((await cw.purge({ auditMs: 365 * DAY })).audit).toBe(2);
    await cw.close();
  });

  it('90 days is allowed; under 90 days is a ProfileError naming the field', async () => {
    const { cw } = await aged();
    expect((await cw.purge({ auditMs: 90 * DAY })).audit).toBe(4);
    await expect(cw.purge({ auditMs: 90 * DAY - 1 })).rejects.toBeInstanceOf(ProfileError);
    await expect(cw.purge({ auditMs: 0 })).rejects.toThrow(/^retention\.auditMs must be at least 90 days/);
    await expect(setup({ retention: { auditMs: 30 * DAY } })).rejects.toThrow(/^retention\.auditMs must be at least 90 days/);
    await expect(setup({ retention: { auditMs: Number.NaN } })).rejects.toBeInstanceOf(ProfileError);
    await expect(setup({ retention: { auditMs: '365' as never } })).rejects.toBeInstanceOf(ProfileError);
  });

  it('retention.auditMs at the floor is accepted at creation', async () => {
    const { cw } = await setup({ retention: { auditMs: 90 * DAY } });
    await cw.close();
  });

  it('a purge failure in the audit step undoes the whole purge', async () => {
    class Failing extends MemoryStore {
      override purgeAudit(): number {
        throw new Error('boom');
      }
    }
    const { cw, store } = await setup({}, new Failing());
    rec(cw);
    store.insertReport({
      id: 'old', createdAt: NOW - 400 * DAY, roomId: 'R', tags: {}, reporterSubject: 's_a', reporterSeat: 'p1', reporterHandle: 'A',
      targetSubject: 's_b', targetSeat: 'p2', targetHandle: 'B', category: 'spam', note: null, lineId: null, excerpt: [], people: [],
      status: 'open',
    });
    await expect(cw.purge()).rejects.toThrow('boom');
    expect(store.loadReport('old')).not.toBeNull();
  });
});
