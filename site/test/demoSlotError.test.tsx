// If the demo chunk cannot load (offline, a stale deploy), the page says so plainly instead of going blank.
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/demo/Demo', () => {
  throw new Error('chunk failed');
});

afterEach(cleanup);

describe('DemoSlot when the chunk fails', () => {
  it('shows a plain message and keeps the rest of the section', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.stubGlobal('IntersectionObserver', undefined);
    const { DemoSlot } = await import('../src/sections/DemoSlot');
    render(<DemoSlot />);
    expect(await screen.findByText(/could not load the demo/i)).toBeTruthy();
    expect(screen.getByRole('heading', { level: 2, name: /play both sides/i })).toBeTruthy();
    expect(screen.getByRole('link', { name: /steps|add it/i }).getAttribute('href')).toBe('#add-it');
    vi.unstubAllGlobals();
  });
});
