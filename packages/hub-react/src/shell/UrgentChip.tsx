import { useEffect, useRef, useState } from 'react';
import { actorName } from '../claims.js';
import { useHub } from '../context.js';
import { formatDuration } from '../format.js';
import { useQueue } from '../liveQueue.js';
import type { LiveQueue } from '../liveQueue.js';
import { urgentSummary } from '../queue.js';

// The one urgent chip (design 5.2 and 16): a single button in the queue pane's header, there only while the count of open urgent reports is above zero. It says the count and the
// oldest wait in words ("2 urgent, oldest 14m"), opens the oldest urgent case nobody else holds (the oldest of all when every one is held, and then says who holds it), and
// carries no colour: the words do. A new urgent report is announced once, politely, by `useUrgentAnnouncement`.

/** The chip, or nothing: while the queue is loading, failed, or holds no urgent report there is no element at all. */
export function UrgentChip() {
  const { t, locale, now, me, go } = useHub();
  const queue = useQueue();
  if (queue.status !== 'ready' || queue.urgent <= 0) return null;
  const summary = urgentSummary(queue.groups, me.actor, now());
  const wait = summary.oldestAt === null ? null : formatDuration(Math.max(0, now() - summary.oldestAt), locale);
  const label =
    wait === null
      ? t('hub.urgent.chip.count', { count: queue.urgent })
      : summary.heldBy === null
        ? t('hub.urgent.chip', { count: queue.urgent, wait })
        : t('hub.urgent.chip.held', { count: queue.urgent, wait, name: actorName(summary.heldBy) });
  // With nothing to open (the urgent list could not be read) the chip reads the queue again.
  const open = (): void => (summary.open === null ? void queue.reload() : go({ name: 'report', id: summary.open.reportId }));
  return (
    <button type="button" className="cw-urgent-chip" onClick={open}>
      {label}
    </button>
  );
}

/**
 * What the polite region says: "An urgent report arrived", once, when the urgent count rises (from none to some, or by more). The first read is the baseline (what was already
 * waiting is not news), a poll that changes nothing says nothing, and a fall says nothing. `key` changes with each announcement so a screen reader hears each one.
 */
export function useUrgentAnnouncement(queue: LiveQueue): { key: number; text: string } | null {
  const { t } = useHub();
  const before = useRef<number | null>(null);
  const [heard, setHeard] = useState(0);
  useEffect(() => {
    if (queue.status !== 'ready') return;
    const was = before.current;
    before.current = queue.urgent;
    if (was !== null && queue.urgent > was) setHeard((n) => n + 1);
  }, [queue.status, queue.urgent]);
  return heard === 0 ? null : { key: heard, text: t('hub.urgent.arrived') };
}
