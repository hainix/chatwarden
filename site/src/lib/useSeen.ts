import { useEffect, useRef, useState } from 'react';

/**
 * 'idle' until the element first scrolls into view, then 'seen'. 'static' means no motion: reduced motion, no
 * IntersectionObserver or no JS yet. The stylesheet treats 'static' as the finished look, so the page is complete without it.
 */
export function useSeen<T extends Element>(): { ref: React.RefObject<T | null>; phase: 'static' | 'idle' | 'seen' } {
  const ref = useRef<T | null>(null);
  const [phase, setPhase] = useState<'static' | 'idle' | 'seen'>('static');
  useEffect(() => {
    const el = ref.current;
    const reduced = typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (!el || reduced || typeof IntersectionObserver === 'undefined') return;
    setPhase('idle');
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setPhase('seen');
          io.disconnect();
        }
      },
      { threshold: 0.35 },
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);
  return { ref, phase };
}
