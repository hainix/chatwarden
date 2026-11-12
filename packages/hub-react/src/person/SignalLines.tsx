import { useHub } from '../context.js';
import { relativeTime } from '../format.js';
import type { SignalCountView } from '../types.js';

/** A count the kit sent: well-formed, above zero. Anything else is skipped, never drawn. */
function usable(s: unknown): s is SignalCountView {
  if (typeof s !== 'object' || s === null) return false;
  const o = s as Record<string, unknown>;
  return (
    typeof o['label'] === 'string' &&
    (o['polarity'] === 'negative' || o['polarity'] === 'positive') &&
    typeof o['distinct'] === 'number' &&
    o['distinct'] > 0 &&
    typeof o['windowDays'] === 'number' &&
    typeof o['firstAt'] === 'number' &&
    typeof o['lastAt'] === 'number'
  );
}

/**
 * What other players have signalled about this person, as plain lines in the Timeline panel: "Muted by other players: 5 (last 14 days)", in words
 * ("counts against" / "counts for", never a colour), with when the first and the latest of them said it, so five in two hours reads differently from
 * five in twelve days. Staff only. A signal never acts on its own: a person decides.
 */
export function SignalLines({ signals }: { signals: readonly SignalCountView[] | undefined }) {
  const { t, now, locale } = useHub();
  const rows = (Array.isArray(signals) ? signals : []).filter(usable);
  if (rows.length === 0) return null;
  return (
    <ul className="cw-recs cw-panel-pad cw-signals" aria-label={t('hub.person.signals.title')}>
      {rows.map((s) => (
        <li key={s.kind} className="cw-rec cw-rec--signal">
          <div className="cw-rec-body">
            <p className="cw-rec-head">
              {t('hub.person.signals.line', { label: s.label, count: s.distinct, days: t('hub.person.signals.days', { count: s.windowDays }) })}
            </p>
            <p className="cw-facts cw-rec-meta">
              <span>{t(s.polarity === 'negative' ? 'hub.person.signals.negative' : 'hub.person.signals.positive')}</span>
              <span>
                {t('hub.person.signals.spread', { first: relativeTime(s.firstAt, now(), locale), last: relativeTime(s.lastAt, now(), locale) })}
              </span>
            </p>
          </div>
        </li>
      ))}
    </ul>
  );
}
