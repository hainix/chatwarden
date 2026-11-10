import { forwardRef } from 'react';
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
  /** 0 to 3 for the four steps, 4 when the tour is finished. */
  step: number;
  total: number;
  title: string;
  body: string;
  hint: string | null;
  codeOpen: boolean;
  /** True while a modal dialog is open: the card is then out of reach for keyboard and assistive tech. */
  inert: boolean;
  pos: TourPos | null;
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
  { step, total, title, body, hint, codeOpen, inert, pos, onNext, onSkip, onToggleCode, onPlayAgain },
  ref,
) {
  const done = step >= total;
  const style: CSSProperties | undefined = pos
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
      style={style}
      inert={inert}
      onKeyDown={onKeyDown}
    >
      <div className="tour-top">
        <span className="tour-count">{done ? 'Tour done' : `Step ${step + 1} of ${total}`}</span>
        <span className="tour-pips" aria-hidden="true">
          {Array.from({ length: total }, (_, i) => (
            <i key={i} data-pip={i < step ? 'done' : i === step ? 'current' : 'todo'} />
          ))}
        </span>
      </div>
      <p className="tour-title">{title}</p>
      <p className="tour-body">{body}</p>
      {hint !== null && <p className="tour-hint">{hint}</p>}
      <div className="tour-actions">
        <button type="button" className="tbtn tbtn-code" aria-expanded={codeOpen} aria-controls={codeOpen ? 'demo-code' : undefined} onClick={onToggleCode}>
          <CodeIcon />
          <span>Show me the code</span>
        </button>
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
