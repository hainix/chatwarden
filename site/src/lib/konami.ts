import { useEffect } from 'react';

/** The classic code: up up down down left right left right B A. */
export const KONAMI: readonly string[] = ['ArrowUp', 'ArrowUp', 'ArrowDown', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'ArrowLeft', 'ArrowRight', 'b', 'a'];

const norm = (k: string) => (k.length === 1 ? k.toLowerCase() : k);

function isTyping(t: EventTarget | null): boolean {
  if (!(t instanceof HTMLElement)) return false;
  return t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName);
}

/** Calls `onMatch` each time the code is typed. The last ten keys slide, so a slip just means starting again. */
export function useKonami(onMatch: () => void): void {
  useEffect(() => {
    let seen: string[] = [];
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey || isTyping(e.target)) return;
      seen = [...seen, norm(e.key)].slice(-KONAMI.length);
      if (seen.length === KONAMI.length && seen.every((k, i) => k === norm(KONAMI[i] as string))) {
        seen = [];
        onMatch();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onMatch]);
}
