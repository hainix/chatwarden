import { StrictMode } from 'react';
import type { ReactNode } from 'react';
import { act, renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { HubProvider } from '../src/provider.js';
import { useBlocked, useCase, useCases, useClaim, useDecide, useMe, usePerson, useTerms } from '../src/embedHooks.js';
import { settle } from './headless/kit.js';
import { hubWorld } from './world.js';
import type { HubWorld } from './world.js';

// The eight headless hooks: the same Undo hold, claims, heartbeat and live queue as the hub, with no markup. Thin over the
// controller, and typed: an outcome they expect (a 409, a 404, a dropped connection) is a value, never a throw.

const wrapperFor =
  (w: HubWorld, strict = false) =>
  ({ children }: { children: ReactNode }) => {
    const tree = (
      <HubProvider client={w.client} now={w.now} bare>
        {children}
      </HubProvider>
    );
    return strict ? <StrictMode>{tree}</StrictMode> : tree;
  };


/** Mounts a hook under the provider and waits until the provider has asked who is signed in (before that the hook has not run). */
async function hook<T>(w: HubWorld, use: () => T, strict = false) {
  const view = renderHook(use, { wrapper: wrapperFor(w, strict) });
  await waitFor(() => expect(view.result.current).not.toBeNull());
  return view;
}
async function hookWith<T, P>(w: HubWorld, use: (props: P) => T, initialProps: P) {
  const view = renderHook(use, { wrapper: wrapperFor(w), initialProps });
  await waitFor(() => expect(view.result.current).not.toBeNull());
  return view;
}

describe('useMe', () => {
  it('says who is signed in and what the role may do', async () => {
    const w = await hubWorld({ role: 'senior', actor: 'sam@example.test' });
    const { result } = await hook(w, () => useMe());
    await waitFor(() => expect(result.current).not.toBeNull());
    expect(result.current.me.actor).toBe('sam@example.test');
    expect(result.current.me.role).toBe('senior');
    expect(result.current.can('audit.read')).toBe(true);
    expect(result.current.can('gaps.close')).toBe(false);
  });

  it('throws a plain message outside a provider', () => {
    expect(() => renderHook(() => useMe())).toThrow(/inside <HubProvider>/);
  });
});

describe('useCases', () => {
  it('loads the open cases and keeps them as groups, longest wait first', async () => {
    const w = await hubWorld();
    await w.file({ target: 'Alpha' });
    w.clock.t += 60_000;
    await w.file({ target: 'Bravo' });
    const { result } = await hook(w, () => useCases());
    await waitFor(() => expect(result.current.status).toBe('ready'));
    expect(result.current.cases.map((g) => g.handle)).toEqual(['Alpha', 'Bravo']);
    expect(result.current.reports).toBe(2);
    expect(result.current.connection).toBe('live');
    expect(result.current.error).toBeNull();
  });

  it('is loading first, and an error is a value with a reload', async () => {
    const w = await hubWorld();
    w.intercept.fn = (req) => (req.path === '/reports' ? { status: 500, body: { error: 'internal', message: 'x' } } : undefined);
    const seen: string[] = [];
    const { result } = await hook(w, () => {
      const r = useCases();
      seen.push(r.status);
      return r;
    });
    expect(seen[0]).toBe('loading');
    await waitFor(() => expect(result.current.status).toBe('error'));
    expect(result.current.error?.status).toBe(500);
    w.intercept.fn = null;
    await act(async () => void (await result.current.reload()));
    await waitFor(() => expect(result.current.status).toBe('ready'));
  });

  it('takeNext claims the oldest free case and says which, as a value', async () => {
    const w = await hubWorld();
    const a = await w.file({ target: 'Alpha' });
    const { result } = await hook(w, () => useCases());
    await waitFor(() => expect(result.current.status).toBe('ready'));
    let out: Awaited<ReturnType<typeof result.current.takeNext>> | undefined;
    await act(async () => {
      out = await result.current.takeNext();
    });
    expect(out).toMatchObject({ status: 'taken', reportId: a.id, person: a.person });
  });

  it('takeNext with nobody waiting says none', async () => {
    const w = await hubWorld();
    const { result } = await hook(w, () => useCases());
    await waitFor(() => expect(result.current.status).toBe('ready'));
    let out: Awaited<ReturnType<typeof result.current.takeNext>> | undefined;
    await act(async () => {
      out = await result.current.takeNext();
    });
    expect(out?.status).toBe('none');
  });

  it('takeNext for a role that cannot read reports says not_allowed, not busy', async () => {
    const w = await hubWorld({ role: 'moderator', permissions: { 'reports.read': 'owner' } });
    const { result } = await hook(w, () => useCases());
    let out: Awaited<ReturnType<typeof result.current.takeNext>> | undefined;
    await act(async () => {
      out = await result.current.takeNext();
    });
    expect(out).toEqual({ status: 'not_allowed' });
    expect(w.sent.filter((r) => r.path === '/cases/next')).toEqual([]);
  });

  it('the filter narrows the cases', async () => {
    const w = await hubWorld();
    await w.file({ target: 'Alpha', category: 'harassment' });
    await w.file({ target: 'Bravo', category: 'hate' });
    const { result } = await hook(w, () => useCases());
    await waitFor(() => expect(result.current.cases).toHaveLength(2));
    act(() => result.current.setFilter({ category: 'hate' }));
    await waitFor(() => expect(result.current.cases.map((g) => g.handle)).toEqual(['Bravo']));
  });

  it('a role that cannot read reports gets an empty, ready list and asks nothing', async () => {
    const w = await hubWorld({ role: 'moderator', permissions: { 'reports.read': 'owner' } });
    const { result } = await hook(w, () => useCases());
    await waitFor(() => expect(result.current.allowed).toBe(false));
    expect(result.current.cases).toEqual([]);
    expect(w.sent.filter((r) => r.path === '/reports' || r.path === '/changes')).toEqual([]);
  });
});

describe('useCase', () => {
  it('reads the report and claims it: the holder is you', async () => {
    const w = await hubWorld();
    const f = await w.file({ target: 'Alpha' });
    const seen: string[] = [];
    const { result } = await hook(w, () => {
      const r = useCase(f.id);
      seen.push(r.status);
      return r;
    });
    expect(seen[0]).toBe('loading');
    await waitFor(() => expect(result.current.status).toBe('ready'));
    expect(result.current.report?.id).toBe(f.id);
    expect(result.current.detail?.suggest).toBeDefined();
    await waitFor(() => expect(result.current.holder.kind).toBe('you'));
    expect(w.cw.cases.holder(f.person)?.by).toBe('ann@example.test');
  });

  it('claim: false reads the case and claims nothing', async () => {
    const w = await hubWorld();
    const f = await w.file({ target: 'Alpha' });
    const { result } = await hook(w, () => useCase(f.id, { claim: false }));
    await waitFor(() => expect(result.current.status).toBe('ready'));
    await act(() => settle());
    expect(w.sent.filter((r) => /\/claim$/.test(r.path))).toEqual([]);
    expect(result.current.holder.kind).toBe('none');
  });

  it('a case someone else holds is theirs: holder.kind is other, with their name', async () => {
    const w = await hubWorld();
    const f = await w.file({ target: 'Alpha' });
    await w.clientFor('bea@example.test').claimCase(f.person);
    const { result } = await hook(w, () => useCase(f.id));
    await waitFor(() => expect(result.current.holder).toEqual({ kind: 'other', by: 'bea@example.test' }));
  });

  it('a report that is not there is an error value, not a throw', async () => {
    const w = await hubWorld();
    const { result } = await hook(w, () => useCase('r_missing'));
    await waitFor(() => expect(result.current.status).toBe('error'));
    expect(result.current.error?.status).toBe(404);
    expect(result.current.report).toBeUndefined();
  });

  it('null is idle: nothing is read or claimed', async () => {
    const w = await hubWorld();
    await w.file({ target: 'Alpha' });
    const { result } = await hook(w, () => useCase(null));
    await act(() => settle());
    expect(result.current.status).toBe('idle');
    expect(w.sent.filter((r) => /^\/reports\/|\/claim$/.test(r.path))).toEqual([]);
  });

  it('follows the id: a new id is a new case, and the old one is let go', async () => {
    const w = await hubWorld();
    const a = await w.file({ target: 'Alpha' });
    const b = await w.file({ target: 'Bravo' });
    const { result, rerender } = await hookWith(w, ({ id }) => useCase(id), { id: a.id });
    await waitFor(() => expect(result.current.report?.id).toBe(a.id));
    rerender({ id: b.id });
    await waitFor(() => expect(result.current.report?.id).toBe(b.id));
    await waitFor(() => expect(w.cw.cases.holder(b.person)?.by).toBe('ann@example.test'));
    await waitFor(() => expect(w.cw.cases.holder(a.person)).toBeNull());
  });

  it('under StrictMode it claims once', async () => {
    const w = await hubWorld();
    const f = await w.file({ target: 'Alpha' });
    const { result } = await hook(w, () => useCase(f.id), true);
    await waitFor(() => expect(result.current.holder.kind).toBe('you'));
    await act(() => settle());
    expect(w.sent.filter((r) => r.method === 'POST' && r.path === `/cases/${f.person}/claim`)).toHaveLength(1);
  });
});

describe('useDecide', () => {
  it('decides at once with hold: false and answers how it ended', async () => {
    const w = await hubWorld();
    const f = await w.file({ target: 'Alpha' });
    const { result } = await hook(w, () => useDecide());
    await waitFor(() => expect(result.current.decide).toBeTypeOf('function'));
    let out: Awaited<ReturnType<typeof result.current.decide>> | undefined;
    await act(async () => {
      out = await result.current.decide({ reportId: f.id, person: f.person, input: { verdict: 'no_action', reason: 'banter', actions: [] } }, { hold: false });
    });
    expect(out).toMatchObject({ status: 'done', replay: false });
    expect((await w.client.getReport(f.id)).report.status).not.toBe('open');
  });

  it('holds for Undo by default: entry() says held, undo() takes it back, nothing is sent', async () => {
    const w = await hubWorld();
    const f = await w.file({ target: 'Alpha' });
    const { result } = await hook(w, () => useDecide());
    await waitFor(() => expect(result.current.decide).toBeTypeOf('function'));
    let pending: ReturnType<typeof result.current.decide> | undefined;
    act(() => {
      pending = result.current.decide({ reportId: f.id, person: f.person, input: { verdict: 'no_action', reason: 'banter', actions: [] } });
    });
    await waitFor(() => expect(result.current.entry(f.id)?.state.status).toBe('held'));
    expect(result.current.entries.size).toBe(1);
    act(() => result.current.undo(f.id));
    expect(await pending).toEqual({ status: 'undone' });
    expect(w.sent.filter((r) => /\/decide$/.test(r.path))).toHaveLength(0);
    act(() => result.current.dismiss(f.id));
    await waitFor(() => expect(result.current.entry(f.id)).toBeUndefined());
  });

  it('someone else deciding first is { status: conflict }, not a throw', async () => {
    const w = await hubWorld();
    const f = await w.file({ target: 'Alpha' });
    const { result } = await hook(w, () => useDecide());
    await waitFor(() => expect(result.current.decide).toBeTypeOf('function'));
    await w.clientFor('bea@example.test', 'senior').decide(f.id, { verdict: 'bad_faith', reason: 'Decided by someone else.', evidence: 'They reported a friend.', actions: [], takeOver: true });
    let out: Awaited<ReturnType<typeof result.current.decide>> | undefined;
    await act(async () => {
      out = await result.current.decide({ reportId: f.id, person: f.person, input: { verdict: 'no_action', reason: 'second', actions: [] } }, { hold: false });
    });
    expect(out?.status).toBe('conflict');
  });

  it('a dropped connection is { status: failed } and retry sends it again', async () => {
    const w = await hubWorld();
    const f = await w.file({ target: 'Alpha' });
    const { result } = await hook(w, () => useDecide());
    await waitFor(() => expect(result.current.decide).toBeTypeOf('function'));
    w.intercept.fn = (req) => (/\/decide$/.test(req.path) ? { status: 500, body: { error: 'internal', message: 'x' } } : undefined);
    let out: Awaited<ReturnType<typeof result.current.decide>> | undefined;
    await act(async () => {
      out = await result.current.decide({ reportId: f.id, person: f.person, input: { verdict: 'no_action', reason: 'banter', actions: [] } }, { hold: false });
    });
    expect(out?.status).toBe('failed');
    w.intercept.fn = null;
    let again: Awaited<ReturnType<typeof result.current.retry>> | undefined;
    await act(async () => {
      again = await result.current.retry(f.id);
    });
    expect(again?.status).toBe('done');
  });
});

describe('useClaim', () => {
  it('says who holds the case, and claims, takes over and releases it as values', async () => {
    const w = await hubWorld({ role: 'senior' });
    const f = await w.file({ target: 'Alpha' });
    await w.clientFor('bea@example.test').claimCase(f.person);
    const { result } = await hook(w, () => ({ claim: useClaim(f.person), cases: useCases() }));
    await waitFor(() => expect(result.current.claim.holder).toEqual({ kind: 'other', by: 'bea@example.test' }));
    let out: { ok: boolean } | undefined;
    await act(async () => {
      out = await result.current.claim.claim();
    });
    expect(out?.ok).toBe(false);
    await act(async () => {
      out = await result.current.claim.takeOver();
    });
    expect(out?.ok).toBe(true);
    await waitFor(() => expect(result.current.claim.holder.kind).toBe('you'));
    await act(async () => {
      out = await result.current.claim.release();
    });
    expect(out?.ok).toBe(true);
    await waitFor(() => expect(result.current.claim.holder.kind).toBe('none'));
    expect(w.cw.cases.holder(f.person)).toBeNull();
  });

  it('a claim someone else holds, asked for by a moderator, is { ok: false } with their name in the error', async () => {
    const w = await hubWorld();
    const f = await w.file({ target: 'Alpha' });
    await w.clientFor('bea@example.test').claimCase(f.person);
    const { result } = await hook(w, () => useClaim(f.person));
    await waitFor(() => expect(result.current.claim).toBeTypeOf('function'));
    let out: Awaited<ReturnType<typeof result.current.claim>> | undefined;
    await act(async () => {
      out = await result.current.claim();
    });
    expect(out).toMatchObject({ ok: false, error: { code: 'claimed', heldBy: 'bea@example.test' } });
  });
});

describe('useTerms, useBlocked and usePerson', () => {
  it('useTerms reads the term list', async () => {
    const w = await hubWorld({ role: 'senior' });
    const { result } = await hook(w, () => useTerms());
    await waitFor(() => expect(result.current.data).toBeDefined());
    expect(result.current.allowed).toBe(true);
    expect(result.current.data?.terms.length).toBeGreaterThan(0);
  });

  it('useTerms without the permission asks nothing and says it is not allowed', async () => {
    const w = await hubWorld({ role: 'moderator', permissions: { 'terms.read': 'owner' } });
    const { result } = await hook(w, () => useTerms());
    await waitFor(() => expect(result.current.allowed).toBe(false));
    expect(result.current.data).toBeUndefined();
    expect(result.current.loading).toBe(false);
    expect(w.sent.filter((r) => /^\/terms/.test(r.path))).toEqual([]);
  });

  it('useBlocked reads a window of days and starts over when it changes', async () => {
    const w = await hubWorld({ role: 'senior' });
    w.blockLine('Vantablob', 'you zorbak, learn');
    const { result, rerender } = await hookWith(w, ({ days }) => useBlocked({ days }), { days: 7 as 1 | 7 | 30 });
    await waitFor(() => expect(result.current.data?.items).toHaveLength(1));
    rerender({ days: 1 });
    await waitFor(() => expect(w.sent.some((r) => r.path === '/blocked' && r.query?.days === 1)).toBe(true));
  });

  it('usePerson reads one person, and null is idle', async () => {
    const w = await hubWorld({ role: 'senior' });
    const f = await w.file({ target: 'Vlemmo' });
    await w.sanction(f.person, 'chat', 1);
    const { result, rerender } = await hookWith(w, ({ ref }) => usePerson(ref), { ref: null as string | null });
    await act(() => settle());
    expect(result.current.data).toBeUndefined();
    expect(result.current.loading).toBe(false);
    expect(w.sent.filter((r) => /history$/.test(r.path))).toEqual([]);
    rerender({ ref: f.person });
    await waitFor(() => expect(result.current.data?.sanctions).toHaveLength(1));
    expect(result.current.data?.reports[0]?.id).toBe(f.id);
  });

  it('usePerson for an unknown person is a value: an empty history', async () => {
    const w = await hubWorld({ role: 'senior' });
    const { result } = await hook(w, () => usePerson('s_unknown_person_000000'));
    await waitFor(() => expect(result.current.data).toBeDefined());
    expect(result.current.data?.sanctions).toEqual([]);
  });
});
