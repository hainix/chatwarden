import { act, renderHook } from '@testing-library/react';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import type { NoticeOp } from '@chatwarden/core/notice-copy';
import { HubContext } from '../src/context.js';
import type { HubContextValue } from '../src/context.js';
import { createT, en } from '../src/i18n.js';
import { usePlan } from '../src/preview/usePreview.js';

// The plan hook reads the clock when the FORM changes, not on every render: the ops are built fresh in each render, so the hook keys on what is in them.

const OP = { op: 'sanction' as const, kind: 'chat', durationMs: 3_600_000 };

function setup() {
  let t = 1_000_000;
  const now = vi.fn(() => (t += 1000));
  const context = {
    t: createT(en, 'en'),
    locale: 'en',
    now,
    me: { features: {} },
    can: () => false,
    session: { policy: () => Promise.resolve(null) },
  } as unknown as HubContextValue;
  const wrapper = ({ children }: { children: ReactNode }) => <HubContext.Provider value={context}>{children}</HubContext.Provider>;
  return { now, wrapper };
}

describe('usePlan', () => {
  it('re-rendering with a new object holding the same op does not read the clock again or redo the plan', () => {
    const { now, wrapper } = setup();
    const { result, rerender } = renderHook(({ op }: { op: NoticeOp | null }) => usePlan(op), { wrapper, initialProps: { op: { ...OP } as NoticeOp | null } });
    const reads = now.mock.calls.length;
    const first = result.current;
    expect(first.plan).not.toBeNull();
    for (let i = 0; i < 5; i++) rerender({ op: { ...OP } as NoticeOp });
    expect(now.mock.calls.length, 'the clock is not read again').toBe(reads);
    expect(result.current.plan).toBe(first.plan);
    expect(result.current.ctx).toBe(first.ctx);
  });

  it('a change in the op reads the clock again and gives a new plan', () => {
    const { now, wrapper } = setup();
    const { result, rerender } = renderHook(({ op }: { op: NoticeOp | null }) => usePlan(op), { wrapper, initialProps: { op: { ...OP } as NoticeOp | null } });
    const reads = now.mock.calls.length;
    const before = result.current.ctx.now();
    act(() => rerender({ op: { ...OP, durationMs: 7_200_000 } as NoticeOp }));
    expect(now.mock.calls.length).toBeGreaterThan(reads);
    expect(result.current.ctx.now(), 'the plan is made against the moment of the change').toBeGreaterThan(before);
  });

  it('nothing chosen (null) is no plan, and going back to null reads nothing new', () => {
    const { now, wrapper } = setup();
    const { result, rerender } = renderHook(({ op }: { op: NoticeOp | null }) => usePlan(op), { wrapper, initialProps: { op: null as NoticeOp | null } });
    expect(result.current.plan).toBeNull();
    const reads = now.mock.calls.length;
    rerender({ op: null });
    expect(now.mock.calls.length).toBe(reads);
    rerender({ op: { ...OP } as NoticeOp });
    expect(result.current.plan).not.toBeNull();
  });
});
