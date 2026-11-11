import { forwardRef, useEffect, useId, useState } from 'react';
import type { CSSProperties, KeyboardEvent } from 'react';
import { CodeIcon } from './icons';

export interface TourPos {
  left: number;
  top: number;
  arrowX: number;
  arrowY: number;
  /** Which side of the control the tooltip sits on. */
  placement: 'above' | 'below' | 'left' | 'right';
}

interface Props {
  /** 0 for the first step, up to `total - 1`; `total` when the tour is finished. */
  step: number;
  total: number;
  /** The step is one the tour can do without. */
  optional?: boolean;
  title: string;
  body: string;
  hint: string | null;
  codeOpen: boolean;
  /** True while a modal dialog is open: the card is then out of reach for keyboard and assistive tech. */
  inert: boolean;
  pos: TourPos | null;
  /** A phone (under 600px): a bar at the bottom ("Step 4 of 7: Apply the suggestion", Next, Skip) that opens to the full text on a tap. */
  compact?: boolean;
  onNext: () => void;
  onSkip: () => void;
  onToggleCode: () => void;
  onPlayAgain: () => void;
}

/**
 * The tour tooltip: step count, progress pips, the instruction, Show me the code, Skip and Next. It floats next to the control
 * the step is about, never covers the page (it is inside the demo) and never takes focus.
 */
export const TourCard = forwardRef<HTMLElement, Props>(function TourCard(
  { step, total, optional = false, title, body, hint, codeOpen, inert, pos, compact = false, onNext, onSkip, onToggleCode, onPlayAgain },
  ref,
) {
  const done = step >= total;
  const [open, setOpen] = useState(false);
  const textId = useId();
  // The bar stays small as the tour moves on: a new step closes it.
  useEffect(() => setOpen(false), [step]);
  const showText = !compact || open;
  const count = done ? 'Tour done' : `Step ${step + 1} of ${total}${optional ? ' (optional)' : ''}`;
  const style: CSSProperties | undefined = pos && !compact
    ? ({ left: pos.left, top: pos.top, ['--arrow-x' as string]: `${pos.arrowX}px`, ['--arrow-y' as string]: `${pos.arrowY}px` } as CSSProperties)
    : undefined;

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
      data-placement={pos?.placement ?? 'below'}
      data-done={done ? 'true' : undefined}
      data-compact={compact ? 'true' : undefined}
      data-open={compact && open ? 'true' : undefined}
      style={style}
      inert={inert}
      onKeyDown={onKeyDown}
    >
      {compact ? (
        <button type="button" className="tour-toggle" aria-expanded={open} aria-controls={open ? textId : undefined} onClick={() => setOpen((o) => !o)}>
          <span className="tour-count">{count}</span>
          <span className="tour-title">{title}</span>
        </button>
      ) : (
        <>
          <div className="tour-top">
            <span className="tour-count">{count}</span>
            <span className="tour-pips" aria-hidden="true">
              {Array.from({ length: total }, (_, i) => (
                <i key={i} data-pip={i < step ? 'done' : i === step ? 'current' : 'todo'} />
              ))}
            </span>
          </div>
          <p className="tour-title">{title}</p>
        </>
      )}
      {showText && (
        <div id={textId} className="tour-text">
          <p className="tour-body">{body}</p>
          {hint !== null && <p className="tour-hint">{hint}</p>}
        </div>
      )}
      <div className="tour-actions">
        {showText && (
          <button type="button" className="tbtn tbtn-code" aria-expanded={codeOpen} aria-controls={codeOpen ? 'demo-code' : undefined} onClick={onToggleCode}>
            <CodeIcon />
            <span>Show me the code</span>
          </button>
        )}
        <span className="tour-spacer" />
        {done ? (
          <>
            <button type="button" className="tbtn" onClick={onSkip}>
              Close
            </button>
            <button type="button" className="tbtn tbtn-next" onClick={onPlayAgain}>
              Play again
            </button>
          </>
        ) : (
          <>
            <button type="button" className="tbtn" aria-label="Skip tour" onClick={onSkip}>
              Skip
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
