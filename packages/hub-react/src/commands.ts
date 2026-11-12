import type { Route } from './router.js';

// What the command bar can find and how it orders a search. Pure: the shell builds the items from what it has loaded.

export type CommandKind = 'action' | 'screen' | 'person' | 'report' | 'term';

/** What choosing an item does. */
export type CommandTarget = { type: 'go'; route: Route } | { type: 'takeNext' } | { type: 'shortcuts' } | { type: 'undo' };

export interface CommandItem {
  id: string;
  kind: CommandKind;
  /** What is shown, already in words. */
  label: string;
  /** A second line: who a report is against, a person's tag. Searched too. */
  hint?: string;
  /** More text the search looks in (a tag, an id) that is not shown. */
  keywords?: string;
  target: CommandTarget;
}

/** How many results the bar shows at most. */
export const COMMAND_LIMIT = 12;

/**
 * The items that match a search, best first. An empty search lists the actions and screens (the things to jump to without
 * knowing a name). Otherwise, plain text, not a pattern and not case-sensitive: a label that starts with the search comes first,
 * then one with a word that starts with it, then one that contains it, then a match in the hint or keywords. Equal matches keep
 * the order they were given in.
 */
export function rankCommands(items: readonly CommandItem[], query: string, limit = COMMAND_LIMIT): CommandItem[] {
  const q = query.trim().toLowerCase();
  if (q === '') return items.filter((i) => i.kind === 'action' || i.kind === 'screen').slice(0, limit);
  const scored: Array<{ item: CommandItem; score: number; at: number }> = [];
  items.forEach((item, at) => {
    const label = item.label.toLowerCase();
    let score: number;
    if (label.startsWith(q)) score = 0;
    else if (label.split(/[\s_.-]+/).some((word) => word.startsWith(q))) score = 1;
    else if (label.includes(q)) score = 2;
    else if (`${item.hint ?? ''} ${item.keywords ?? ''}`.toLowerCase().includes(q)) score = 3;
    else return;
    scored.push({ item, score, at });
  });
  return scored
    .sort((a, b) => a.score - b.score || a.at - b.at)
    .slice(0, limit)
    .map((s) => s.item);
}
