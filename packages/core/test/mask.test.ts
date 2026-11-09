import { describe, expect, it } from 'vitest';
import { maskSpans } from '../src/index.js';

const sp = (start: number, end: number) => ({ start, end, termId: 't' });

describe('maskSpans', () => {
  it('replaces a span with stars of its length', () => {
    expect(maskSpans('you zorbak now', [sp(4, 10)])).toBe('you ****** now');
  });

  it('no spans (or an empty text) returns the text unchanged', () => {
    expect(maskSpans('hello', [])).toBe('hello');
    expect(maskSpans('', [sp(0, 3)])).toBe('');
  });

  it('masks several spans', () => {
    expect(maskSpans('ab cd ef', [sp(0, 2), sp(6, 8)])).toBe('** cd **');
  });

  it('handles unsorted spans', () => {
    expect(maskSpans('ab cd ef', [sp(6, 8), sp(0, 2)])).toBe('** cd **');
  });

  it('handles overlapping spans (union) and duplicates', () => {
    expect(maskSpans('abcdefgh', [sp(1, 5), sp(3, 7)])).toBe('a******h');
    expect(maskSpans('abcdef', [sp(1, 3), sp(1, 3)])).toBe('a**def');
    expect(maskSpans('abcdef', [sp(0, 6), sp(2, 3)])).toBe('******');
  });

  it('adjacent spans mask the whole run', () => {
    expect(maskSpans('abcdef', [sp(0, 3), sp(3, 6)])).toBe('******');
  });

  it('clamps out-of-range values', () => {
    expect(maskSpans('abc', [sp(-5, 2)])).toBe('**c');
    expect(maskSpans('abc', [sp(1, 99)])).toBe('a**');
    expect(maskSpans('abc', [sp(-9, 99)])).toBe('***');
    expect(maskSpans('abc', [sp(10, 20)])).toBe('abc');
    expect(maskSpans('abc', [sp(-20, -10)])).toBe('abc');
  });

  it('ignores empty, inverted and non-finite spans', () => {
    expect(maskSpans('abc', [sp(2, 2), sp(2, 1), sp(Number.NaN, 2), sp(0, Number.NaN)])).toBe('abc');
  });

  it('treats infinite bounds as clamped', () => {
    expect(maskSpans('abc', [sp(1, Number.POSITIVE_INFINITY)])).toBe('a**');
    expect(maskSpans('abc', [sp(Number.NEGATIVE_INFINITY, 1)])).toBe('*bc');
  });

  it('truncates fractional bounds', () => {
    expect(maskSpans('abcdef', [sp(1.7, 3.2)])).toBe('a**def');
  });

  it('does not mutate its inputs', () => {
    const spans = [sp(4, 6), sp(0, 2)];
    const copy = JSON.parse(JSON.stringify(spans));
    maskSpans('abcdefgh', spans);
    expect(spans).toEqual(copy);
  });

  it('survives a non-array spans value', () => {
    expect(maskSpans('abc', undefined as never)).toBe('abc');
    expect(maskSpans('abc', null as never)).toBe('abc');
  });
});
