import { useCallback, useEffect, useRef, useState } from 'react';
import { useKonami } from '../lib/konami';

/**
 * The easter egg: the konami code turns the warden gold (a `data-gold` flag on <html> that the stylesheet reads) and says
 * so in a polite live region. Typing it again turns the warden back, so nobody is stuck with it.
 */
export function GoldWarden() {
  const [message, setMessage] = useState('');
  const timer = useRef<number | undefined>(undefined);

  const toggle = useCallback(() => {
    const root = document.documentElement;
    const gold = root.dataset.gold !== 'true';
    if (gold) root.dataset.gold = 'true';
    else delete root.dataset.gold;
    setMessage(gold ? 'Warden promoted to gold. Level up!' : 'The warden is back to teal, on duty.');
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setMessage(''), 4000);
  }, []);

  useKonami(toggle);
  useEffect(() => () => window.clearTimeout(timer.current), []);

  return (
    <p className="gold-toast" role="status" aria-live="polite" data-show={message ? 'true' : 'false'}>
      {message}
    </p>
  );
}
