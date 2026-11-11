import { useEffect, useId, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';
import { rankCommands } from '../commands.js';
import type { CommandItem, CommandKind, CommandTarget } from '../commands.js';
import { useHub } from '../context.js';
import { Dialog } from '../Dialog.js';
import { personTag } from '../format.js';
import { Icon } from '../icons.js';
import { groupName } from '../labels.js';
import { useOptionalQueue } from '../liveQueue.js';
import { TABS } from '../nav.js';
import { keyLabel } from '../shortcuts.js';
import { Kbd } from '../ui.js';

const KIND_LABEL = {
  action: 'hub.command.kind.action',
  screen: 'hub.command.kind.screen',
  person: 'hub.command.kind.person',
  report: 'hub.command.kind.report',
  term: 'hub.command.kind.term',
} as const satisfies Record<CommandKind, string>;

/**
 * The command bar (Ctrl or Cmd+K): one box that jumps to a screen, a person or report in the queue, or a term, and runs the
 * two actions that have shortcuts. Arrow keys choose, Enter goes, Escape closes. It is a combobox over a listbox, so a screen
 * reader hears the results and the one chosen.
 */
export function CommandBar({ shortcuts, onClose, onChoose }: { shortcuts: boolean; onClose: () => void; onChoose: (target: CommandTarget) => void }) {
  const { t, can, client } = useHub();
  const queue = useOptionalQueue();
  const [query, setQuery] = useState('');
  // The result that is chosen, by id: results join the list as the terms arrive, and the chosen one must not slide away.
  const [activeId, setActiveId] = useState<string | null>(null);
  const [terms, setTerms] = useState<string[]>([]);
  const input = useRef<HTMLInputElement>(null);
  const listId = useId();
  const optionId = (i: number): string => `${listId}-${i}`;

  // Terms are only read when the bar opens, and only for a role that may read them. A failure just leaves them out.
  const canTerms = can('terms.read');
  useEffect(() => {
    if (!canTerms) return;
    let cancelled = false;
    client.listTerms().then(
      (list) => {
        if (!cancelled) setTerms(list.terms.map((x) => x.term));
      },
      () => undefined,
    );
    return () => {
      cancelled = true;
    };
  }, [client, canTerms]);

  const items = useMemo<CommandItem[]>(() => {
    const out: CommandItem[] = [];
    if (queue !== null && can('reports.decide')) out.push({ id: 'action:take-next', kind: 'action', label: t('hub.queue.takeNext'), target: { type: 'takeNext' } });
    out.push({ id: 'action:shortcuts', kind: 'action', label: t('hub.command.shortcuts'), target: { type: 'shortcuts' } });
    for (const tab of TABS) {
      if (tab.permission === null || can(tab.permission)) out.push({ id: `screen:${tab.tab}`, kind: 'screen', label: t(tab.label), target: { type: 'go', route: tab.route } });
    }
    if (queue !== null) {
      for (const g of queue.groups) {
        const name = groupName(t, g);
        out.push({
          id: `person:${g.person}`,
          kind: 'person',
          label: name,
          hint: personTag(g.person),
          keywords: `${g.handles.join(' ')} ${personTag(g.person)}`,
          target: { type: 'go', route: { name: 'person', ref: g.person } },
        });
      }
      for (const g of queue.groups) {
        const name = groupName(t, g);
        for (const e of g.entries) {
          out.push({
            id: `report:${e.id}`,
            kind: 'report',
            label: t('hub.command.report', { id: e.id }),
            hint: name,
            keywords: `${e.id} ${g.handles.join(' ')}`,
            target: { type: 'go', route: { name: 'report', id: e.id } },
          });
        }
      }
    }
    for (const term of terms) out.push({ id: `term:${term}`, kind: 'term', label: term, target: { type: 'go', route: { name: 'terms' } } });
    return out;
  }, [queue, can, t, terms]);

  const results = useMemo(() => rankCommands(items, query), [items, query]);
  const found = activeId === null ? -1 : results.findIndex((r) => r.id === activeId);
  const chosen = results.length === 0 ? -1 : Math.max(0, found);

  const choose = (item: CommandItem | undefined): void => {
    if (item !== undefined) onChoose(item.target);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (results.length === 0) return;
      setActiveId(results[(chosen + (e.key === 'ArrowDown' ? 1 : -1) + results.length) % results.length]?.id ?? null);
    } else if (e.key === 'Home' || e.key === 'End') {
      if (results.length === 0) return;
      e.preventDefault();
      setActiveId(results[e.key === 'Home' ? 0 : results.length - 1]?.id ?? null);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      choose(results[chosen]);
    }
  };

  return (
    <Dialog label={t('hub.command.label')} onClose={onClose} initialFocus={input} className="cw-cmdk">
      <div className="cw-cmdk-field">
        <Icon name="search" />
        <input
          ref={input}
          type="text"
          role="combobox"
          aria-label={t('hub.command.input')}
          aria-expanded="true"
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={chosen < 0 ? undefined : optionId(chosen)}
          autoComplete="off"
          spellCheck={false}
          value={query}
          placeholder={t('hub.command.input')}
          onChange={(e) => {
            setQuery(e.target.value);
            setActiveId(null);
          }}
          onKeyDown={onKeyDown}
        />
        {shortcuts && <Kbd>{keyLabel(t, 'Esc')}</Kbd>}
      </div>
      <ul id={listId} role="listbox" aria-label={t('hub.command.results')} className="cw-cmdk-list">
        {results.map((item, i) => (
          <li
            key={item.id}
            id={optionId(i)}
            role="option"
            aria-selected={i === chosen}
            className="cw-cmdk-item"
            data-kind={item.kind}
            // The input keeps focus; a click chooses without taking it (mousedown would blur the input and drop the list).
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => choose(item)}
            onMouseMove={() => setActiveId(item.id)}
          >
            <span className="cw-cmdk-label">{item.label}</span>
            {item.hint !== undefined && <span className="cw-cmdk-hint">{item.hint}</span>}
            <span className="cw-cmdk-kind">{t(KIND_LABEL[item.kind])}</span>
          </li>
        ))}
      </ul>
      {results.length === 0 && <p className="cw-cmdk-none">{t('hub.command.none', { query: query.trim() })}</p>}
      <p className="cw-sr" role="status">
        {results.length === 0 ? '' : t('hub.command.count', { count: results.length })}
      </p>
      <p className="cw-cmdk-hint-line">{t('hub.command.hint')}</p>
    </Dialog>
  );
}
