import { ExternalIcon, GitHubIcon } from '../components/Icons';
import { NPM_URL, OPEN_SOURCE, REPO_URL } from '../content';

export function OpenSource() {
  return (
    <section id="open" aria-labelledby="open-title" className="section">
      <div className="wrap">
        <div className="open-band">
          <h2 id="open-title">{OPEN_SOURCE.title}</h2>
          <p className="open-body">{OPEN_SOURCE.body}</p>
          <div className="open-links">
            <a className="btn btn-ghost" href={REPO_URL} target="_blank" rel="noopener noreferrer">
              <GitHubIcon /> View on GitHub <ExternalIcon />
            </a>
            <a className="btn btn-ghost" href={NPM_URL} target="_blank" rel="noopener noreferrer">
              Packages on npm <ExternalIcon />
            </a>
          </div>
          <p className="open-small">{OPEN_SOURCE.small}</p>
        </div>
      </div>
    </section>
  );
}
