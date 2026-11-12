import { LazyAiStrip } from '../lazyParts.js';
import type { AiReadView } from '../types.js';
import { useOptionalCase } from './CaseContext.js';

/**
 * The place the AI's read goes, between the case header and the transcript. It renders nothing at level 0 or without a read; with the AI
 * on and no read yet it holds a quiet skeleton for up to 20 seconds (the strip does that). A closed case has none. Everything it draws is a lazy part of the hub,
 * loaded only when there is a read to show or one is expected, so the first load pays for none of it.
 */
export function AiReadSlot({ read }: { read: AiReadView | null | undefined }) {
  const c = useOptionalCase();
  // A case that is closed is history: no strip on it, and no wait for a read nobody will act on.
  const status = c?.detail.data?.report.status;
  if (status !== undefined && status !== 'open') return null;
  if (read == null && (c === null || c.draft.aiLevel < 1)) return null;
  return <LazyAiStrip read={read ?? null} />;
}
