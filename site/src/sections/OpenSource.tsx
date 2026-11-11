import { ExternalIcon, GitHubIcon, PadIcon, ShieldCheckIcon } from '../components/Icons';
import { NPM_PACKAGES, NPM_URL, REPO_URL } from '../content';

export function OpenSource() {
  return (
    <section id="open" aria-labelledby="open-title" className="section">
      <div className="wrap">
        <div className="section-head">
          <h2 id="open-title">Built in the open</h2>
          <p className="section-lead">Read the code, fork it, send a pull request. The kit is pre-release (0.1.x) and provided as-is.</p>
        </div>
        <div className="open-panel">
          <div className="open-license">
            <p className="open-big">Apache-2.0</p>
            <p>Use it, change it, ship it. Keep the licence notice.</p>
          </div>
          <ul className="open-badges">
            <li className="open-badge">
              <ShieldCheckIcon /> Published with npm provenance
            </li>
            <li className="open-badge">
              <PadIcon /> Built for Moxgate, now being adopted
            </li>
          </ul>
          <div className="open-links">
            <a className="btn btn-ghost" href={REPO_URL} target="_blank" rel="noopener noreferrer">
              <GitHubIcon /> GitHub repository <ExternalIcon />
            </a>
            <a className="btn btn-ghost" href={NPM_URL} target="_blank" rel="noopener noreferrer">
              Packages on npm <ExternalIcon />
            </a>
          </div>
          <ul className="open-npm" aria-label="The UI packages on npm">
            {NPM_PACKAGES.map((p) => (
              <li key={p.name}>
                <a href={p.href} target="_blank" rel="noopener noreferrer">
                  <code>{p.name}</code>
                </a>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </section>
  );
}
