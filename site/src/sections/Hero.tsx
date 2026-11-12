import { useRef, useState, type PointerEvent } from 'react';
import { ReplayIcon } from '../components/Icons';
import { HERO, HERO_CHAT } from '../content';

// Delays (seconds) for the one orchestrated moment: lines arrive, the invented slur is blocked with a stamp.
const DELAYS = [0.5, 1.7, 3.1, 5.4];

function ChatSnippet() {
  const [run, setRun] = useState(0);
  return (
    <div className="hud" data-run={run}>
      <div className="hud-bar">
        <span className="hud-title">lobby</span>
        <span className="hud-tag">{HERO.tag}</span>
        <button type="button" className="hud-replay" onClick={() => setRun((n) => n + 1)}>
          <ReplayIcon />
          <span>Replay</span>
        </button>
      </div>
      <div className="hud-screen" role="log" aria-label="Example chat" aria-live="off" key={run}>
        {HERO_CHAT.map((m, i) => {
          const delay = DELAYS[i] ?? 0;
          const refused = m.verdict === 'refused';
          return (
            <div
              key={i}
              className={`msg ${refused ? 'msg-refused' : ''}`}
              data-verdict={m.verdict}
              style={{ ['--d' as string]: `${delay}s` }}
            >
              <span className={`avatar avatar-${m.who === 'Ada' ? 'a' : 'b'}`} aria-hidden="true">
                {m.who.slice(0, 1)}
              </span>
              <div className="bubble">
                <span className="who">{m.who}</span>
                <span className="said">{m.text}</span>
                {refused && <span className="stamp">{HERO.stamp}</span>}
              </div>
              {refused && m.notice && <p className="msg-notice">{m.notice}</p>}
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** A glow that follows the mouse over the hero. Mouse and pen only, never under reduced motion; the CSS eases it. */
function useGlow() {
  const ref = useRef<HTMLElement | null>(null);
  const onPointerMove = (e: PointerEvent<HTMLElement>) => {
    if (e.pointerType === 'touch') return;
    if (typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return;
    el.style.setProperty('--mx', `${Math.round(((e.clientX - r.left) / r.width) * 100)}%`);
    el.style.setProperty('--my', `${Math.round(((e.clientY - r.top) / r.height) * 100)}%`);
  };
  return { ref, onPointerMove };
}

export function Hero() {
  const glow = useGlow();
  return (
    <section id="hero" aria-labelledby="hero-title" className="hero" ref={glow.ref} onPointerMove={glow.onPointerMove}>
      <div className="wrap hero-grid">
        <div className="hero-copy">
          <h1 id="hero-title">
            {HERO.title.map((line, i) => (
              <span key={line}>
                {i > 0 ? ' ' : ''}
                <span className="h1-line">{line}</span>
              </span>
            ))}
          </h1>
          <p className="lead">{HERO.lead}</p>
          <div className="hero-actions">
            <a className="btn btn-primary" href="#demo">
              {HERO.primary}
            </a>
            <a className="btn btn-ghost" href="#add-it">
              {HERO.secondary}
            </a>
          </div>
          <p className="hero-note">{HERO.proof}</p>
        </div>
        <ChatSnippet />
      </div>
    </section>
  );
}
