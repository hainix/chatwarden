import { describe, expect, it } from 'vitest';
import { checkRows } from '../src/components.js';

const btn = (over: Record<string, unknown> = {}) => ({ type: 2, style: 2, label: 'Nothing wrong here', custom_id: 'cw1:dis:abc', ...over });
const link = (over: Record<string, unknown> = {}) => ({ type: 2, style: 5, label: 'Open report', url: 'https://hub.example.test/reports/abc', ...over });
const row = (...components: unknown[]) => ({ type: 1, components });

describe('checkRows', () => {
  it('accepts a row of dismiss, suggestion and link buttons and returns them unchanged', () => {
    const rows = [row(btn(), btn({ style: 1, label: 'Apply suggestion', custom_id: 'cw1:sug:abc' }), link())];
    expect(checkRows(rows)).toEqual(rows);
  });

  it('accepts every style from 1 to 4 with a custom_id and 5 with a url', () => {
    for (const style of [1, 2, 3, 4]) expect(checkRows([row(btn({ style }))])).not.toBeNull();
    expect(checkRows([row(link())])).not.toBeNull();
  });

  it('accepts exactly five buttons, an 80 character label, a 100 character custom_id and a 512 character url', () => {
    expect(checkRows([row(btn(), btn(), btn(), btn(), btn())])).not.toBeNull();
    expect(checkRows([row(btn({ label: 'a'.repeat(80) }))])).not.toBeNull();
    expect(checkRows([row(btn({ custom_id: 'c'.repeat(100) }))])).not.toBeNull();
    const url = `https://hub.example.test/${'p'.repeat(512 - 'https://hub.example.test/'.length)}`;
    expect(url).toHaveLength(512);
    expect(checkRows([row(link({ url }))])).not.toBeNull();
  });

  it('accepts no rows at all (nothing to send) and returns an empty list', () => {
    expect(checkRows([])).toEqual([]);
  });

  it('copies: a later change to the input changes nothing, and fields Discord does not know are dropped', () => {
    const input = [row(btn({ extra: 'x', disabled: true }))];
    const out = checkRows(input);
    expect(out).toEqual([row({ type: 2, style: 2, label: 'Nothing wrong here', custom_id: 'cw1:dis:abc' })]);
    (input[0]!.components[0] as { label: string }).label = 'changed';
    expect(out?.[0]?.components[0]).toMatchObject({ label: 'Nothing wrong here' });
  });

  it.each([
    ['6 buttons', [row(btn(), btn(), btn(), btn(), btn(), btn())]],
    ['two rows', [row(btn()), row(btn())]],
    ['an empty row', [row()]],
    ['an 81 character label', [row(btn({ label: 'a'.repeat(81) }))]],
    ['an empty label', [row(btn({ label: '' }))]],
    ['a missing label', [row(btn({ label: undefined }))]],
    ['a numeric label', [row(btn({ label: 5 }))]],
    ['a 101 character custom_id', [row(btn({ custom_id: 'c'.repeat(101) }))]],
    ['an empty custom_id', [row(btn({ custom_id: '' }))]],
    ['a non-string custom_id', [row(btn({ custom_id: 7 }))]],
    ['a missing custom_id on a non-link button', [row({ type: 2, style: 1, label: 'x' })]],
    ['a link with a custom_id', [row(link({ custom_id: 'cw1:x' }))]],
    ['a link without a url', [row({ type: 2, style: 5, label: 'x' })]],
    ['a button with a url', [row(btn({ url: 'https://hub.example.test/x' }))]],
    ['a javascript: url', [row(link({ url: 'javascript:alert(1)' }))]],
    ['a data: url', [row(link({ url: 'data:text/html,hi' }))]],
    ['a discord:// url', [row(link({ url: 'discord://x' }))]],
    ['an unparseable url', [row(link({ url: 'not a url' }))]],
    ['a 513 character url', [row(link({ url: `https://hub.example.test/${'p'.repeat(513 - 'https://hub.example.test/'.length)}` }))]],
    ['a style of 0', [row(btn({ style: 0 }))]],
    ['a style of 6', [row(btn({ style: 6 }))]],
    ['a style that is a string', [row(btn({ style: '1' }))]],
    ['a type other than 2', [row(btn({ type: 3 }))]],
    ['a row type other than 1', [{ type: 2, components: [btn()] }]],
    ['a row without components', [{ type: 1 }]],
    ['components that are not an array', [{ type: 1, components: btn() }]],
    ['a null button', [row(null)]],
    ['a null row', [null]],
    ['a non-array', 'rows'],
    ['an object', { type: 1 }],
    ['null', null],
    ['undefined', undefined],
    ['a number', 3],
  ])('rejects %s', (_name, input) => {
    expect(checkRows(input)).toBeNull();
  });

  it('never throws on hostile shapes (getters that throw, a proxy, a huge array)', () => {
    const throwing = { type: 2, style: 1, get label(): string { throw new Error('x'); }, custom_id: 'a' };
    expect(checkRows([row(throwing)])).toBeNull();
    expect(checkRows(new Proxy([], { get() { throw new Error('x'); } }))).toBeNull();
    expect(checkRows(new Array(10_000).fill(row(btn())))).toBeNull();
  });
});
