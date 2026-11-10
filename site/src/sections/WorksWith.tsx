import type { ReactNode } from 'react';
import { DiscordIcon, ExpressIcon, ServerIcon, WebhookIcon } from '../components/Icons';
import { WORKS_WITH } from '../content';

const ICONS: Record<string, ReactNode> = {
  express: <ExpressIcon />,
  node: <ServerIcon />,
  discord: <DiscordIcon />,
  webhooks: <WebhookIcon />,
};

export function WorksWith() {
  return (
    <section id="works-with" aria-labelledby="works-with-title" className="section section-alt">
      <div className="wrap">
        <div className="section-head">
          <h2 id="works-with-title">Works with</h2>
          <p className="section-lead">Plain TypeScript on Node 22.13 or newer. No framework required.</p>
        </div>
        <ul className="grid tiles">
          {WORKS_WITH.map((w) => (
            <li key={w.id} className="card tile" data-card>
              <span className="card-icon">{ICONS[w.id]}</span>
              <h3>{w.title}</h3>
              <p>{w.body}</p>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
