import { Logo } from '../components/Logo';
import { ISSUES_URL, LICENSE_URL, NPM_URL, REPO_URL } from '../content';

export function Footer() {
  return (
    <footer className="site-footer">
      <div className="wrap footer-row">
        <div className="footer-brand">
          <Logo height={30} />
          <p>Free chat moderation for games.</p>
        </div>
        <nav aria-label="Footer" className="footer-links">
          <a href={REPO_URL} target="_blank" rel="noopener noreferrer">
            GitHub
          </a>
          <a href={NPM_URL} target="_blank" rel="noopener noreferrer">
            npm
          </a>
          <a href={ISSUES_URL} target="_blank" rel="noopener noreferrer">
            Report an issue
          </a>
          <a href={LICENSE_URL} target="_blank" rel="noopener noreferrer">
            Licence
          </a>
        </nav>
      </div>
      <div className="wrap footer-fine">
        <p>Apache-2.0. Free forever, with no SLA and no support promise. Not a child-safety tool.</p>
      </div>
    </footer>
  );
}
