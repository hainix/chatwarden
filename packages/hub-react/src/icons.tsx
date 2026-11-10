import type { TabName } from './router.js';

// Small line icons, drawn inline so the package loads no image and no icon font. They are decoration: always hidden from
// assistive technology, and every control that holds one also has words.

export type IconName = TabName | 'search' | 'eye' | 'close';

const PATHS: Record<IconName, string[]> = {
  overview: ['M4 5h7v7H4zM13 5h7v4h-7zM13 11h7v8h-7zM4 14h7v5H4z'],
  reports: ['M4 6h16M4 12h16M4 18h10'],
  blocked: ['M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z', 'm6 6 12 12'],
  terms: ['M4 7h16M7 12h10M10 17h4'],
  gaps: ['M12 3v18M3 12h18'],
  audit: ['M6 3h9l3 3v15H6z', 'M9 11h6M9 15h6'],
  guide: ['M5 4h11a3 3 0 0 1 3 3v13H8a3 3 0 0 1-3-3z', 'M5 17a3 3 0 0 1 3-3h11'],
  search: ['M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14z', 'm20 20-4-4'],
  eye: ['M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6S2 12 2 12z', 'M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6z'],
  close: ['M6 6l12 12M18 6 6 18'],
};

export function Icon({ name, className }: { name: IconName; className?: string }) {
  return (
    <svg
      className={className === undefined ? 'cw-icon' : `cw-icon ${className}`}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {PATHS[name].map((d) => (
        <path key={d} d={d} {...(name === 'gaps' ? { strokeDasharray: '3 3' } : {})} />
      ))}
    </svg>
  );
}

/** The product mark: a shield with a tick, in the accent colour. */
export function Mark() {
  return (
    <svg className="cw-mark" viewBox="0 0 24 24" fill="none" aria-hidden="true" focusable="false">
      <path className="cw-mark-shield" d="M12 2 4 5v6c0 5 3.4 9.3 8 11 4.6-1.7 8-6 8-11V5l-8-3Z" />
      <path className="cw-mark-tick" d="M8.5 12.5 11 15l4.5-5" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
