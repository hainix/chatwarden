import { useId, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { useHub } from '../context.js';
import { formatDuration } from '../format.js';
import { useHubData } from '../hooks.js';
import type { HubT } from '../i18n.js';
import type { InsightsView } from '../types.js';
import { Fetched } from '../ui.js';

// Insights (design 8, behind `desk.insights`): how the team is doing, read-only. Counts and times in tables with captions and header cells; the median beside the longest wait on
// purpose (a median alone invites speed over care); no chart, no export, no name and no per-person number (the server never sends one). A number that is not there yet reads in words.
// It is a lazy screen, reached from the Overview's link and the command bar, not a tab.

type Days = 7 | 30 | 90;
const WINDOWS: ReadonlyArray<{ days: Days; label: 'hub.insights.window.week' | 'hub.insights.window.month' | 'hub.insights.window.quarter' }> = [
  { days: 7, label: 'hub.insights.window.week' },
  { days: 30, label: 'hub.insights.window.month' },
  { days: 90, label: 'hub.insights.window.quarter' },
];

function Table({ caption, head, rows }: { caption: string; head: [string, string]; rows: Array<[string, ReactNode]> }) {
  return (
    <table className="cw-insights-table">
      <caption>{caption}</caption>
      <thead>
        <tr>
          <th scope="col">{head[0]}</th>
          <th scope="col">{head[1]}</th>
        </tr>
      </thead>
      <tbody>
        {rows.map(([label, value], i) => (
          <tr key={`${label}-${i}`}>
            <th scope="row">{label}</th>
            <td>{value}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function View({ data }: { data: InsightsView }) {
  const { t, locale } = useHub();
  const num = useMemo(() => new Intl.NumberFormat(locale), [locale]);
  const n = (v: number): string => num.format(v);
  const time = (ms: number | null): string => (ms === null ? t('hub.insights.notYet') : formatDuration(ms, locale));
  const head: [string, string] = [t('hub.insights.col.measure'), t('hub.insights.col.value')];
  const backlog = data.wait.backlog;
  const chat = data.chat;
  const rate = chat === null ? null : chat.reportsPer1000;
  return (
    <div className="cw-insights-tables">
      <p className="cw-hint">{t('hub.insights.counted', { days: data.days })}</p>
      {data.partial && (
        <p className="cw-hint" role="status">
          {t('hub.insights.partial')}
        </p>
      )}
      <Table
        caption={t('hub.insights.reports')}
        head={head}
        rows={[
          [t('hub.insights.reports.filed'), n(data.reports.filed)],
          [t('hub.insights.reports.decided'), n(data.reports.decided)],
          [t('hub.insights.reports.open'), n(data.reports.open)],
        ]}
      />
      <Table
        caption={t('hub.insights.decision')}
        head={head}
        rows={[
          [t('hub.insights.decision.median'), time(data.decision.medianMs)],
          [t('hub.insights.decision.p90'), time(data.decision.p90Ms)],
          [t('hub.insights.decision.longest'), data.wait.longestOpenMs === 0 ? t('hub.insights.noneOpen') : formatDuration(data.wait.longestOpenMs, locale)],
        ]}
      />
      <Table
        caption={t('hub.insights.urgent')}
        head={head}
        rows={[
          [t('hub.insights.reports.filed'), n(data.urgent.filed)],
          [t('hub.insights.reports.decided'), n(data.urgent.decided)],
          [t('hub.insights.decision.median'), time(data.urgent.medianMs)],
        ]}
      />
      <Table
        caption={t('hub.insights.backlog')}
        head={head}
        rows={[
          [t('hub.insights.backlog.under1h'), n(backlog.under1h)],
          [t('hub.insights.backlog.under4h'), n(backlog.under4h)],
          [t('hub.insights.backlog.under1d'), n(backlog.under1d)],
          [t('hub.insights.backlog.under3d'), n(backlog.under3d)],
          [t('hub.insights.backlog.over3d'), n(backlog.over3d)],
        ]}
      />
      {data.byReason.length === 0 ? (
        <p className="cw-hint">{t('hub.insights.byReason.empty')}</p>
      ) : (
        <Table caption={t('hub.insights.byReason')} head={[t('hub.insights.col.reason'), t('hub.insights.col.reports')]} rows={data.byReason.map((r): [string, ReactNode] => [r.label, n(r.count)])} />
      )}
      <Table
        caption={t('hub.insights.outcome')}
        head={head}
        rows={[
          [t('hub.insights.outcome.actioned'), n(data.byOutcome.actioned)],
          [t('hub.insights.outcome.dismissed'), n(data.byOutcome.dismissed)],
          [t('hub.insights.outcome.badFaith'), n(data.byOutcome.badFaith)],
        ]}
      />
      {data.byRule === null ? (
        <p className="cw-hint">{t('hub.insights.byRule.unavailable')}</p>
      ) : data.byRule.length === 0 ? (
        <p className="cw-hint">{t('hub.insights.byRule.empty')}</p>
      ) : (
        <Table caption={t('hub.insights.byRule')} head={[t('hub.insights.col.rule'), t('hub.insights.col.sanctions')]} rows={data.byRule.map((r): [string, ReactNode] => [ruleLabel(t, r.rule), n(r.count)])} />
      )}
      {chat === null ? (
        <p className="cw-hint">{t('hub.insights.chat.off')}</p>
      ) : (
        <>
          <Table
            caption={t('hub.insights.chat')}
            head={head}
            rows={[
              [t('hub.insights.chat.delivered'), n(chat.delivered)],
              [t('hub.insights.chat.refused'), n(chat.refused)],
              [t('hub.insights.chat.rate'), rate === null ? t('hub.insights.notShown') : num.format(rate)],
            ]}
          />
          {rate === null && <p className="cw-hint">{chat.delivered === 0 ? t('hub.insights.chat.none') : t('hub.insights.chat.partWay')}</p>}
        </>
      )}
    </div>
  );
}

const ruleLabel = (t: HubT, rule: number | 'uncovered'): string => (rule === 'uncovered' ? t('hub.insights.rule.uncovered') : t('hub.insights.rule', { number: rule }));

export function Insights() {
  const { t, client } = useHub();
  const [days, setDays] = useState<Days>(30);
  const id = useId();
  const state = useHubData(`insights:${days}`, () => client.insights(days));
  return (
    <div className="cw-screen">
      <div className="cw-bar">
        <h2 className="cw-screen-title" tabIndex={-1}>
          {t('hub.insights.title')}
        </h2>
      </div>
      <p className="cw-hint">{t('hub.insights.intro')}</p>
      <div className="cw-field cw-insights-window">
        <label htmlFor={`${id}-days`}>{t('hub.insights.window')}</label>
        <select id={`${id}-days`} value={days} onChange={(e) => setDays(Number(e.target.value) as Days)}>
          {WINDOWS.map((w) => (
            <option key={w.days} value={w.days}>
              {t(w.label)}
            </option>
          ))}
        </select>
      </div>
      <Fetched state={state} what={t('hub.state.what.insights')}>
        {(data) => <View data={data} />}
      </Fetched>
    </div>
  );
}
