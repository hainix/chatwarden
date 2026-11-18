import type { ReactNode } from 'react';
import { createPortal } from 'react-dom';

/** Renders `children` where they are, or into `container` when one is given. */
export function Portal({ container, children }: { container: HTMLElement | null | undefined; children: ReactNode }) {
  return container === undefined || container === null ? <>{children}</> : createPortal(children, container);
}
