import { forwardRef, useEffect, useId, useState } from 'react';
import type { KeyboardEvent } from 'react';
import { CodeIcon } from './icons';

interface Props {
  /** 0 for the first step, up to `total - 1`; `total` when the tour is finished. */
  step: number;
  total: number;
  title: string;
  body: string;
  hint: string | null;
  /** On one pane at a time: which tab to open next ("Open the Moderator tab."). Null when the right pane is already showing. */
  tabHint: string | null;
  codeOpen: boolean;
  /** True while a modal dialog is open: the card is then out of reach for keyboard and assistive tech. */
  inert: boolean;
  /** A phone (under 600px): a bar at the bottom ("Step 2 of 4", the instruction, Next, Skip tour) that opens to the full text on a tap. */
  compact?: boolean;
  onNext: () => void;
  onSkip: () => void;
  onToggleCode: () => void;
  onPlayAgain: () => void;
}

/**
 * The tour card: step count, progress pips, the instruction, Show the code, Skip tour and Next. It is docked: a strip above the
 * panes (a bar at the bottom of the window on a phone). It never floats next to the control, never covers the page and never takes
 * focus. The control it is about wears a gold ring instead.
 */
export const TourCard = forwardRef<HTMLElement, Props>(function TourCard(
  { step, total, title, body, hint, tabHint, codeOpen, inert, compact = false, onNext, onSkip, onToggleCode, onPlayAgain },
  ref,
) {
  const done = step >= total;
  const [open, setOpen] = useState(false);
  const textId = useId();
  // The bar stays small as the tour moves on: a new step closes it.
  useEffect(() => setOpen(false), [step]);
  const showText = !compact || open;
  const count = done ? 'Tour done' : `Step ${step + 1} of ${total}`;

  function onKeyDown(e: KeyboardEvent<HTMLElement>) {
    if (e.key === 'Escape') {
      e.stopPropagation();
      onSkip();
    }
  }

  return (
    <section
      ref={ref}
      className="tour"
      aria-label="Guided tour"
      data-done={done ? 'true' : undefined}
      data-compact={compact ? 'true' : undefined}
      data-open={compact && open ? 'true' : undefined}
      inert={inert}
      onKeyDown={onKeyDown}
    >
      {compact ? (
        <button type="button" className="tour-toggle" aria-expanded={open} aria-controls={open ? textId : undefined} onClick={() => setOpen((o) => !o)}>
          <span className="tour-count">{count}</span>
          <span className="tour-title">{title}</span>
          {tabHint !== null && <span className="tour-tabhint">{tabHint}</span>}
        </button>
      ) : (
        <div className="tour-head">
          <div className="tour-top">
            <span className="tour-count">{count}</span>
            <span className="tour-pips" aria-hidden="true">
              {Array.from({ length: total }, (_, i) => (
                <i key={i} data-pip={i < step ? 'done' : i === step ? 'current' : 'todo'} />
              ))}
            </span>
          </div>
          <p className="tour-title">{title}</p>
        </div>
      )}
      {showText && (
        <div id={textId} className="tour-text">
          <p className="tour-body">{body}</p>
          {!compact && tabHint !== null && <p className="tour-hint">{tabHint}</p>}
          {hint !== null && <p className="tour-hint">{hint}</p>}
        </div>
      )}
      <div className="tour-actions">
        {showText && (
          <button type="button" className="tbtn tbtn-code" aria-expanded={codeOpen} aria-controls={codeOpen ? 'demo-code' : undefined} onClick={onToggleCode}>
            <CodeIcon />
            <span>Show the code</span>
          </button>
        )}
        <span className="tour-spacer" />
        {done ? (
          <>
            <a className="tbtn tbtn-next" href="#add-it">
              Add it to your game
            </a>
            <button type="button" className="tbtn" onClick={onPlayAgain}>
              Play again
            </button>
            <button type="button" className="tbtn" onClick={onSkip}>
              Close
            </button>
          </>
        ) : (
          <>
            <button type="button" className="tbtn" onClick={onSkip}>
              Skip tour
            </button>
            <button type="button" className="tbtn tbtn-next" onClick={onNext}>
              Next
            </button>
          </>
        )}
      </div>
    </section>
  );
});
