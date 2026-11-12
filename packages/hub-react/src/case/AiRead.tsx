import { LazyAiStrip } from '../lazyParts.js';
import type { AiReadView } from '../types.js';
import { useOptionalCase } from './CaseContext.js';

/**
 * The place the AI's read goes, between the case header and the transcript. It renders nothing without a read unless the server says one is
 * expected (`aiExpected`: the AI is on and able to read this case now); then it holds a quiet skeleton for up to 20 seconds (the strip does that).
 * With the AI off or degraded (the breaker open, a daily limit reached, the read ended without an answer) it renders as with the AI off. A closed case has none. Everything it draws is a lazy part of the hub,
 * loaded only when there is a read to show or one is expected, so the first load pays for none of it.
 */
export function AiReadSlot({ read }: { read: AiReadView | null | undefined }) {
  const c = useOptionalCase();
  // A case that is closed is history: no strip on it, and no wait for a read nobody will act on.
  const status = c?.detail.data?.report.status;
  if (status !== undefined && status !== 'open') return null;
  const expected = c?.detail.data?.aiExpected === true;
  if (read == null && !expected) return null;
  return <LazyAiStrip read={read ?? null} expected={expected} />;
}
