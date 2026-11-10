import type { ReactNode } from 'react';

// Inline SVG icons, drawn here: 24x24 grid, 2px round strokes, currentColor. All decorative (aria-hidden).
function Svg({ children, size = 24, className }: { children: ReactNode; size?: number; className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      className={className}
    >
      {children}
    </svg>
  );
}

type P = { size?: number; className?: string };

export const CopyIcon = (p: P) => (
  <Svg size={16} {...p}>
    <rect x="9" y="9" width="11" height="11" rx="2" />
    <path d="M5 15V6a2 2 0 0 1 2-2h8" />
  </Svg>
);
export const CheckIcon = (p: P) => (
  <Svg size={16} {...p}>
    <path d="m5 12.5 4.5 4.5L19 7" />
  </Svg>
);
export const SunIcon = (p: P) => (
  <Svg size={20} {...p}>
    <circle cx="12" cy="12" r="4" />
    <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
  </Svg>
);
export const MoonIcon = (p: P) => (
  <Svg size={20} {...p}>
    <path d="M20 14.5A8 8 0 0 1 9.5 4 8 8 0 1 0 20 14.5Z" />
  </Svg>
);
export const GitHubIcon = (p: P) => (
  <Svg size={20} {...p}>
    <path d="M9 19c-4.3 1.4-4.3-2.5-6-3m12 5v-3.5c0-1 .1-1.4-.5-2 2.8-.3 5.5-1.4 5.5-6a4.6 4.6 0 0 0-1.3-3.2 4.2 4.2 0 0 0-.1-3.2s-1.1-.3-3.5 1.3a12.3 12.3 0 0 0-6.2 0C6.5 2.8 5.4 3.1 5.4 3.1a4.2 4.2 0 0 0-.1 3.2A4.6 4.6 0 0 0 4 9.5c0 4.6 2.7 5.7 5.5 6-.6.6-.6 1.2-.5 2V21" />
  </Svg>
);
export const ReplayIcon = (p: P) => (
  <Svg size={16} {...p}>
    <path d="M3 12a9 9 0 1 0 3-6.7L3 8" />
    <path d="M3 3v5h5" />
  </Svg>
);
export const ChevronIcon = (p: P) => (
  <Svg size={20} {...p}>
    <path d="m6 9 6 6 6-6" />
  </Svg>
);
export const LockIcon = (p: P) => (
  <Svg size={18} {...p}>
    <rect x="4" y="11" width="16" height="10" rx="2" />
    <path d="M8 11V7a4 4 0 0 1 8 0v4" />
  </Svg>
);
export const ExternalIcon = (p: P) => (
  <Svg size={14} {...p}>
    <path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5" />
  </Svg>
);

// Feature and integration icons (larger, in the warden colour).
export const EyeShieldIcon = (p: P) => (
  <Svg size={26} {...p}>
    <path d="M12 3 4 6v5.5c0 4.6 3.2 8 8 9.5 4.8-1.5 8-4.9 8-9.5V6l-8-3Z" />
    <circle cx="12" cy="11" r="2.5" />
    <path d="M8 11s1.6-3 4-3 4 3 4 3-1.6 3-4 3-4-3-4-3Z" />
  </Svg>
);
export const EvidenceIcon = (p: P) => (
  <Svg size={26} {...p}>
    <path d="M6 3h9l4 4v14H6z" />
    <path d="M14 3v5h5M9 13h7M9 17h5" />
  </Svg>
);
export const LadderIcon = (p: P) => (
  <Svg size={26} {...p}>
    <path d="M7 3v18M17 3v18M7 7h10M7 12h10M7 17h10" />
  </Svg>
);
export const NoticeIcon = (p: P) => (
  <Svg size={26} {...p}>
    <path d="M5 4h14a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2h-6l-5 4v-4H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2Z" />
    <path d="M12 8v4M12 14.5v.01" />
  </Svg>
);
export const HubIcon = (p: P) => (
  <Svg size={26} {...p}>
    <rect x="3" y="4" width="18" height="12" rx="2" />
    <path d="M8 20h8M12 16v4M7 9l2 2 3-3M14 10h3" />
  </Svg>
);
export const DiscordIcon = (p: P) => (
  <Svg size={26} {...p}>
    <path d="M5.5 6.5C8 4.8 10 4.5 10 4.5l.6 1.2a13 13 0 0 1 2.8 0L14 4.5s2 .3 4.5 2C20 9 21 12.5 20.7 16.5c-1.4 1.4-3.3 2-3.3 2l-1-1.7M18.5 6.5 10 4.5M5.5 6.5C4 9 3 12.5 3.3 16.5c1.4 1.4 3.3 2 3.3 2l1-1.7" />
    <path d="M7 15.5c3.2 1.4 6.8 1.4 10 0" />
    <circle cx="9" cy="11.5" r="1" />
    <circle cx="15" cy="11.5" r="1" />
  </Svg>
);
export const ServerIcon = (p: P) => (
  <Svg size={26} {...p}>
    <rect x="3" y="4" width="18" height="7" rx="2" />
    <rect x="3" y="13" width="18" height="7" rx="2" />
    <path d="M7 7.5h.01M7 16.5h.01M12 7.5h5M12 16.5h5" />
  </Svg>
);
export const ExpressIcon = (p: P) => (
  <Svg size={26} {...p}>
    <path d="M4 8h9M4 12h13M4 16h9" />
    <path d="m15 6 5 6-5 6" />
  </Svg>
);
export const WebhookIcon = (p: P) => (
  <Svg size={26} {...p}>
    <circle cx="6" cy="17" r="3" />
    <circle cx="18" cy="17" r="3" />
    <circle cx="12" cy="6" r="3" />
    <path d="m10.5 8.6-3.8 5.8M13.5 8.6l3.8 5.8M9 17h6" />
  </Svg>
);
export const ShieldCheckIcon = (p: P) => (
  <Svg size={18} {...p}>
    <path d="M12 3 4 6v5.5c0 4.6 3.2 8 8 9.5 4.8-1.5 8-4.9 8-9.5V6l-8-3Z" />
    <path d="m8.5 12 2.5 2.5 4.5-5" />
  </Svg>
);
export const PadIcon = (p: P) => (
  <Svg size={18} {...p}>
    <path d="M6 8h12a3 3 0 0 1 3 3.2l-.6 5a2.4 2.4 0 0 1-4.1 1.4L14.5 16h-5l-1.8 1.6a2.4 2.4 0 0 1-4.1-1.4l-.6-5A3 3 0 0 1 6 8Z" />
    <path d="M8 10.5v3M6.5 12h3M15.5 11.5h.01M17.5 13h.01" />
  </Svg>
);
