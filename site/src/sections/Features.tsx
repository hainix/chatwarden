import type { ReactNode } from 'react';
import { DiscordIcon, EvidenceIcon, ExternalIcon, EyeShieldIcon, HubIcon, LadderIcon, NoticeIcon } from '../components/Icons';
import { FEATURES } from '../content';

const ICONS: Record<string, ReactNode> = {
  match: <EyeShieldIcon />,
  reports: <EvidenceIcon />,
  ladder: <LadderIcon />,
  notices: <NoticeIcon />,
  hub: <HubIcon />,
  discord: <DiscordIcon />,
};

export function Features() {
  return (
    <section id="features" aria-labelledby="features-title" className="section">
      <div className="wrap">
        <div className="section-head">
          <h2 id="features-title">What you get</h2>
          <p className="section-lead">Everything a small team needs between “someone said something awful” and “it’s handled”.</p>
        </div>
        <ul className="grid cards">
          {FEATURES.map((f) => (
            <li key={f.id} className="card" data-card>
              <span className="card-icon">{ICONS[f.id]}</span>
              <h3>{f.title}</h3>
              <p>{f.body}</p>
              {f.tag && <span className="pill pill-soon">{f.tag}</span>}
              {f.link && (
                <a className="card-link" href={f.link.href} target="_blank" rel="noopener noreferrer">
                  {f.link.label} <ExternalIcon />
                </a>
              )}
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
