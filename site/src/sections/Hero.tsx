import { useState } from 'react';
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

export function Hero() {
  return (
    <section id="hero" aria-labelledby="hero-title" className="hero">
      <div className="wrap hero-grid">
        <div className="hero-copy">
          <h1 id="hero-title">Your game has chat. Give it a warden.</h1>
          <p className="lead">
            Chatwarden is a free, open-source moderation kit for games. It refuses slurs that dodge filters, keeps the
            evidence when players report, and lets trash talk be trash talk.
          </p>
          <div className="hero-actions">
            <a className="btn btn-primary" href="#demo">
              Try the demo
            </a>
            <div className="cmd">
              <code>{INSTALL_KIT}</code>
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
