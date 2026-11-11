import { describe, expect, it } from 'vitest';
import { rankCommands } from '../src/commands.js';
import type { CommandItem } from '../src/commands.js';

const item = (id: string, kind: CommandItem['kind'], label: string, over: Partial<CommandItem> = {}): CommandItem => ({
  id,
  kind,
  label,
  target: { type: 'go', route: { name: 'overview' } },
  ...over,
});

const items: CommandItem[] = [
  item('a1', 'action', 'Take next case'),
  item('a2', 'action', 'Show keyboard shortcuts'),
  item('s1', 'screen', 'Overview'),
  item('s2', 'screen', 'Reports'),
  item('s3', 'screen', 'Rule gaps'),
  item('p1', 'person', 'Vantablob', { hint: 's_LMJjYQ', keywords: 'vantablob s_lmjjyq' }),
  item('p2', 'person', 'GrimJaw', { hint: 's_AtEafb', keywords: 'grimjaw s_ateafb' }),
  item('p3', 'person', 'Person s_KlrvUv', { keywords: 's_klrvuv' }),
  item('r1', 'report', 'Report ab12cd', { hint: 'Vantablob', keywords: 'ab12cd vantablob' }),
  item('t1', 'term', 'quibblex'),
];
const ids = (list: CommandItem[]): string[] => list.map((i) => i.id);

describe('rankCommands', () => {
  it('with no query lists the actions and the screens, in the order given, and no people, reports or terms', () => {
    expect(ids(rankCommands(items, ''))).toEqual(['a1', 'a2', 's1', 's2', 's3']);
    expect(ids(rankCommands(items, '   '))).toEqual(['a1', 'a2', 's1', 's2', 's3']);
  });

  it('matches without caring about case', () => {
    expect(ids(rankCommands(items, 'GRIM'))).toEqual(['p2']);
    expect(ids(rankCommands(items, 'overVIEW'))).toEqual(['s1']);
  });

  it('puts a label that starts with the query before one that only contains it', () => {
    const out = rankCommands([item('x', 'screen', 'Ruled out'), item('y', 'screen', 'Rule gaps'), item('z', 'screen', 'Brule')], 'rule');
    expect(ids(out)).toEqual(['x', 'y', 'z']);
    const out2 = rankCommands([item('c', 'person', 'Zed Grimm'), item('d', 'person', 'Grim')], 'grim');
    expect(ids(out2)).toEqual(['d', 'c']);
  });

  it('matches the start of a later word before a match in the middle of a word', () => {
    const out = rankCommands([item('m', 'person', 'xxgapxx'), item('w', 'screen', 'Rule gaps')], 'gap');
    expect(ids(out)).toEqual(['w', 'm']);
  });

  it('finds a person by their short tag or a report by its id, through the keywords', () => {
    expect(ids(rankCommands(items, 's_lmjj'))).toEqual(['p1']);
    expect(ids(rankCommands(items, 'ab12'))).toEqual(['r1']);
    expect(ids(rankCommands(items, 'KlrvU'))).toEqual(['p3']);
  });

  it('matches the hint too: the report against Vantablob shows up for the name', () => {
    expect(ids(rankCommands(items, 'vantablob'))).toEqual(['p1', 'r1']);
  });

  it('keeps the given order among equal matches', () => {
    const same = [item('1', 'person', 'Alex'), item('2', 'person', 'Alexa'), item('3', 'person', 'Alexander')];
    expect(ids(rankCommands(same, 'alex'))).toEqual(['1', '2', '3']);
  });

  it('returns nothing when nothing matches', () => {
    expect(rankCommands(items, 'zzzz')).toEqual([]);
  });

  it('caps the list (default 12) and honours a limit', () => {
    const many = Array.from({ length: 40 }, (_, i) => item(`p${i}`, 'person', `Player ${i}`));
    expect(rankCommands(many, 'player')).toHaveLength(12);
    expect(rankCommands(many, 'player', 5)).toHaveLength(5);
    expect(rankCommands(many, '', 5)).toEqual([]);
  });

  it('treats the query as plain text, not a pattern', () => {
    const odd = [item('1', 'person', 'a.b'), item('2', 'person', 'axb'), item('3', 'person', '(x)')];
    expect(ids(rankCommands(odd, 'a.b'))).toEqual(['1']);
    expect(ids(rankCommands(odd, '('))).toEqual(['3']);
    expect(ids(rankCommands(odd, '.*'))).toEqual([]);
  });

  it('does not change its input', () => {
    const copy = structuredClone(items);
    rankCommands(items, 'v');
    expect(items).toEqual(copy);
  });
});
