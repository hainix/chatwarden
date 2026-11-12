import { Logo } from '../components/Logo';
import { GitHubIcon } from '../components/Icons';
import { ThemeToggle } from '../components/ThemeToggle';
import { REPO_URL } from '../content';

const LINKS = [
  { href: '#demo', label: 'Demo' },
  { href: '#how', label: 'How it works' },
  { href: '#add-it', label: 'Add it' },
  { href: '#faq', label: 'FAQ' },
];

export function Header() {
  return (
    <header className="site-header">
      <div className="wrap header-row">
        <a className="brand" href="#hero" aria-label="Chatwarden, back to the top">
          <Logo />
        </a>
        <nav aria-label="Main" className="nav">
          <ul className="nav-links">
            {LINKS.map((l) => (
              <li key={l.href}>
                <a href={l.href}>{l.label}</a>
              </li>
            ))}
          </ul>
          <a className="nav-gh" href={REPO_URL} target="_blank" rel="noopener noreferrer">
            <GitHubIcon />
            <span>GitHub</span>
          </a>
          <ThemeToggle />
        </nav>
      </div>
    </header>
  );
}
