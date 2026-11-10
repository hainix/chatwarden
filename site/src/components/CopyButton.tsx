import { useEffect, useRef, useState } from 'react';
import { CheckIcon, CopyIcon } from './Icons';

type State = 'idle' | 'copied' | 'failed';

/** Copies `text` to the clipboard. Confirms (or says it failed) in a polite live region, then resets. */
export function CopyButton({ text, label, className = '' }: { text: string; label: string; className?: string }) {
  const [state, setState] = useState<State>('idle');
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => () => clearTimeout(timer.current), []);

  async function copy() {
    let ok = false;
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
        ok = true;
      }
    } catch {
      ok = false;
    }
    setState(ok ? 'copied' : 'failed');
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setState('idle'), 2200);
  }

  const copied = state === 'copied';
  return (
    <>
      <button
        type="button"
        className={`copy ${copied ? 'is-copied' : ''} ${state === 'failed' ? 'is-failed' : ''} ${className}`.replace(/\s+/g, ' ').trim()}
        aria-label={label}
        onClick={copy}
      >
        {copied ? <CheckIcon /> : <CopyIcon />}
        <span aria-hidden="true">{copied ? 'Copied' : state === 'failed' ? 'Copy failed' : 'Copy'}</span>
      </button>
      <span className="sr-only" role="status" aria-live="polite">
        {state === 'copied' ? 'Copied' : state === 'failed' ? 'Copy failed. Select the text and copy it.' : ''}
      </span>
    </>
  );
}
