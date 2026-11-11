import { StrictMode } from 'react';
import { act, render, renderHook, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PREVIEW_DELAY_MS, usePreview } from '../../src/policy/usePreview.js';
import type { PolicyLayer, PolicySamples } from '../../src/types.js';

// The preview of the settings screen as a hook: asked for at once the first time, then 400 ms after the last edit; a late answer
// to an older draft is dropped; a timer is cancelled when the screen goes.

afterEach(() => vi.useRealTimers());

const samples = (label: string): PolicySamples =>
  ({ clean: { banter: { label, kind: 'none', durationMs: null } } }) as unknown as PolicySamples;
const deferred = <T,>() => {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
};
type Ask = (layer: PolicyLayer, rule?: number) => Promise<{ ok: true; value: PolicySamples } | { ok: false; error: never }>;

describe('usePreview', () => {
  it('asks at once the first time, and 400 ms after the last edit afterwards', async () => {
    vi.useFakeTimers();
    const ask = vi.fn<Ask>(() => Promise.resolve({ ok: true, value: samples('a') }));
    const { rerender } = renderHook(({ layer }) => usePreview(layer, null, ask), { initialProps: { layer: {} as PolicyLayer | null } });
    expect(ask).toHaveBeenCalledTimes(1);
    rerender({ layer: { customDuration: false } });
    rerender({ layer: { customDuration: true } });
    rerender({ layer: { durations: [3_600_000] } });
    await act(async () => void (await vi.advanceTimersByTimeAsync(PREVIEW_DELAY_MS - 1)));
    expect(ask).toHaveBeenCalledTimes(1);
    await act(async () => void (await vi.advanceTimersByTimeAsync(1)));
    expect(ask).toHaveBeenCalledTimes(2);
    expect(ask.mock.calls[1]?.[0]).toEqual({ durations: [3_600_000] });
  });

  it('an older answer that arrives after a newer one is dropped', async () => {
    vi.useFakeTimers();
    const slow = deferred<{ ok: true; value: PolicySamples }>();
    const fast = deferred<{ ok: true; value: PolicySamples }>();
    const ask = vi.fn<Ask>().mockReturnValueOnce(slow.promise).mockReturnValueOnce(fast.promise);
    const { result, rerender } = renderHook(({ layer }) => usePreview(layer, null, ask), { initialProps: { layer: {} as PolicyLayer | null } });
    rerender({ layer: { customDuration: false } });
    await act(async () => void (await vi.advanceTimersByTimeAsync(PREVIEW_DELAY_MS)));
    expect(ask).toHaveBeenCalledTimes(2);
    await act(async () => fast.resolve({ ok: true, value: samples('newer') }));
    expect(result.current.samples?.clean.banter.label).toBe('newer');
    await act(async () => slow.resolve({ ok: true, value: samples('older') }));
    expect(result.current.samples?.clean.banter.label).toBe('newer');
  });

  it('a pending timer is cancelled when the screen goes, so nothing is asked of a screen that is gone', async () => {
    vi.useFakeTimers();
    const ask = vi.fn<Ask>(() => Promise.resolve({ ok: true, value: samples('a') }));
    const { rerender, unmount } = renderHook(({ layer }) => usePreview(layer, null, ask), { initialProps: { layer: {} as PolicyLayer | null } });
    rerender({ layer: { customDuration: false } });
    unmount();
    await act(async () => void (await vi.advanceTimersByTimeAsync(PREVIEW_DELAY_MS * 3)));
    expect(ask).toHaveBeenCalledTimes(1);
  });

  it('an answer that arrives after the screen has gone changes nothing and does not throw', async () => {
    const late = deferred<{ ok: true; value: PolicySamples }>();
    const ask = vi.fn<Ask>(() => late.promise);
    const { unmount } = renderHook(() => usePreview({}, null, ask));
    unmount();
    await expect(Promise.resolve(late.resolve({ ok: true, value: samples('a') }))).resolves.toBeUndefined();
  });

  it('a draft with a problem (no layer) asks nothing and says it is blocked, keeping the last samples', async () => {
    vi.useFakeTimers();
    const ask = vi.fn<Ask>(() => Promise.resolve({ ok: true, value: samples('kept') }));
    const { result, rerender } = renderHook(({ layer }) => usePreview(layer, null, ask), { initialProps: { layer: {} as PolicyLayer | null } });
    await act(async () => void (await vi.advanceTimersByTimeAsync(0)));
    rerender({ layer: null });
    await act(async () => void (await vi.advanceTimersByTimeAsync(PREVIEW_DELAY_MS * 2)));
    expect(ask).toHaveBeenCalledTimes(1);
    expect(result.current.note).toBe('blocked');
    expect(result.current.samples?.clean.banter.label).toBe('kept');
  });

  it('a refused layer is a note, keeping the last samples', async () => {
    vi.useFakeTimers();
    const ask = vi.fn<Ask>().mockResolvedValueOnce({ ok: true, value: samples('kept') }).mockResolvedValueOnce({ ok: false, error: {} as never });
    const { result, rerender } = renderHook(({ layer }) => usePreview(layer, null, ask), { initialProps: { layer: {} as PolicyLayer | null } });
    await act(async () => void (await vi.advanceTimersByTimeAsync(0)));
    rerender({ layer: { customDuration: false } });
    await act(async () => void (await vi.advanceTimersByTimeAsync(PREVIEW_DELAY_MS)));
    expect(result.current.note).toBe('failed');
    expect(result.current.samples?.clean.banter.label).toBe('kept');
  });

  it('under StrictMode (effects run twice in development) the first answer still comes at once', async () => {
    vi.useFakeTimers();
    const ask = vi.fn<Ask>(() => Promise.resolve({ ok: true, value: samples('first') }));
    const Probe = () => <p>{usePreview({}, null, ask).samples?.clean.banter.label ?? 'none'}</p>;
    render(
      <StrictMode>
        <Probe />
      </StrictMode>,
    );
    // The effect ran twice (two asks, the first one dropped), and the answer is there well before the 400 ms delay.
    await act(async () => void (await vi.advanceTimersByTimeAsync(10)));
    expect(ask.mock.calls.length).toBe(2);
    expect(screen.getByText('first')).toBeInTheDocument();
  });
});
