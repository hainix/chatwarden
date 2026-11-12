import type { ReactNode } from 'react';
import { EvidenceIcon, EyeShieldIcon, HubIcon } from '../components/Icons';
import { HOW, HOW_PANELS, RULES_STRIP } from '../content';

const ICONS: Record<string, ReactNode> = {
  chat: <EyeShieldIcon />,
  game: <EvidenceIcon />,
  hub: <HubIcon />,
};

export function HowItWorks() {
  return (
    <section id="how" aria-labelledby="how-title" className="section">
      <div className="wrap">
        <div className="section-head">
          <h2 id="how-title">{HOW.title}</h2>
          <p className="section-lead">{HOW.lead}</p>
        </div>
        <ul className="grid cards panels">
          {HOW_PANELS.map((p) => (
            <li key={p.id} className="card" data-card>
              <span className="card-icon">{ICONS[p.id]}</span>
              <h3>{p.title}</h3>
              <p>{p.body}</p>
              {p.aside !== undefined && <p className="card-aside">{p.aside}</p>}
            </li>
          ))}
        </ul>
        <div className="rules-strip" data-rules>
          <h3>{RULES_STRIP.title}</h3>
          <p>{RULES_STRIP.body}</p>
        </div>
      </div>
    </section>
  );
}
