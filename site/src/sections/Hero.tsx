import { useRef, useState, type PointerEvent } from 'react';
import { CopyButton } from '../components/CopyButton';
import { ReplayIcon } from '../components/Icons';
import { HERO_CHAT, INSTALL_KIT } from '../content';

// Delays (seconds) for the one orchestrated moment: lines arrive, the invented slur is refused with a stamp.
const DELAYS = [0.5, 1.7, 3.1, 5.4];

function ChatSnippet() {
  const [run, setRun] = useState(0);
  return (
    <div className="hud" data-run={run}>
      <div className="hud-bar">
        <span className="hud-title">lobby</span>
        <span className="hud-tag">standard preset</span>
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
                {refused && (
                  <span className="stamp">
                    Refused!
                  </span>
                )}
              </div>
              {refused && m.notice && <p className="msg-notice">{m.notice}</p>}
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** The install command, one nowrap chunk per word, so a phone wraps between words and never inside a package name. */
function InstallText({ text }: { text: string }) {
  const words = text.split(' ');
  return (
    <>
      {words.map((w, i) => (
        <span key={i}>
          <span className="nw">{w}</span>
          {i < words.length - 1 ? ' ' : ''}
        </span>
      ))}
    </>
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
            <span className="h1-line">Your game has chat.</span> <span className="h1-line">Give it a warden.</span>
          </h1>
          <p className="lead">
            Chatwarden is a free, open-source moderation kit for games. It refuses slurs that dodge filters, keeps the
            evidence when players report, and lets trash talk be trash talk.
          </p>
          <div className="hero-actions">
            <a className="btn btn-primary" href="#demo">
              Try the demo
            </a>
            <div className="cmd">
              <code>
                <InstallText text={INSTALL_KIT} />
              </code>
              <CopyButton text={INSTALL_KIT} label="Copy install command" />
            </div>
          </div>
          <p className="hero-note">Made for indie developers and the coding agents that help them.</p>
        </div>
        <ChatSnippet />
      </div>
    </section>
  );
}
