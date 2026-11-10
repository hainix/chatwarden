import type { ReactNode } from 'react';

// Demo-only inline icons (kept out of the main bundle). 24x24 grid, 2px round strokes, currentColor, decorative.
function Svg({ children, size = 16 }: { children: ReactNode; size?: number }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth="2.2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {children}
    </svg>
  );
}

export const FlagIcon = () => (
  <Svg>
    <path d="M5 21V4" />
    <path d="M5 4h11l-2 4 2 4H5" />
  </Svg>
);
export const SendIcon = () => (
  <Svg>
    <path d="M4 12 20 4l-4 16-4-6-8-2Z" />
    <path d="m12 14 8-10" />
  </Svg>
);
export const PauseIcon = () => (
  <Svg>
    <path d="M8 5v14M16 5v14" />
  </Svg>
);
export const PlayIcon = () => (
  <Svg>
    <path d="M7 4v16l13-8L7 4Z" />
  </Svg>
);
export const CodeIcon = () => (
  <Svg>
    <path d="m8 7-5 5 5 5M16 7l5 5-5 5M14 4l-4 16" />
  </Svg>
);
export const CheckIcon = () => (
  <Svg>
    <path d="m5 12.5 4.5 4.5L19 7" />
  </Svg>
);
export const StarIcon = () => (
  <Svg size={14}>
    <path d="m12 3 2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1-4.4-4.3 6.1-.9L12 3Z" />
  </Svg>
);
