import { useId, useRef, useState } from 'react';
import type { KeyboardEvent, ReactNode } from 'react';

export interface TabItem {
  id: string;
  label: string;
  panel: ReactNode;
}

/**
 * Tabs with the keyboard pattern of the ARIA authoring guide: Left and Right (wrapping) move and select, Home and End jump, and only
 * the selected tab is in the tab order. One panel is drawn at a time.
 */
export function Tabs({ label, items }: { label: string; items: TabItem[] }) {
  const base = useId();
  const [current, setCurrent] = useState(0);
  const refs = useRef<Array<HTMLButtonElement | null>>([]);
  const go = (i: number) => {
    const n = (i + items.length) % items.length;
    setCurrent(n);
    refs.current[n]?.focus();
  };
  function onKeyDown(e: KeyboardEvent<HTMLButtonElement>, i: number) {
    if (e.key === 'ArrowRight') go(i + 1);
    else if (e.key === 'ArrowLeft') go(i - 1);
    else if (e.key === 'Home') go(0);
    else if (e.key === 'End') go(items.length - 1);
    else return;
    e.preventDefault();
  }
  const active = items[current] ?? items[0];
  return (
    <div className="tabs">
      <div role="tablist" aria-label={label} className="tablist">
        {items.map((t, i) => (
          <button
            key={t.id}
            ref={(el) => {
              refs.current[i] = el;
            }}
            type="button"
            role="tab"
            id={`${base}-tab-${t.id}`}
            aria-selected={i === current}
            aria-controls={`${base}-panel`}
            tabIndex={i === current ? 0 : -1}
            className="tab"
            onClick={() => setCurrent(i)}
            onKeyDown={(e) => onKeyDown(e, i)}
          >
            {t.label}
          </button>
        ))}
      </div>
      {active !== undefined && (
        <div role="tabpanel" id={`${base}-panel`} aria-labelledby={`${base}-tab-${active.id}`} className="tabpanel">
          {active.panel}
        </div>
      )}
    </div>
  );
}
