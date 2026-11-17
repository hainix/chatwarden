import { useId } from 'react';
import { useHub } from '../context.js';
import { absoluteTime } from '../format.js';
import { usePagedList } from '../hooks.js';
import { choiceLabel, ruleLabel } from '../labels.js';
import type { AiActionView } from '../types.js';
import { Card, ErrorBlock, Link, PersonChip, Scroll } from '../ui.js';
import { useAiT } from './i18n.js';

// Settings > AI > Advanced > "Would have acted" (AI levels 3 and 4, release 2, design 9.1 and 9.2). What the AI would have applied in shadow, newest first, as the
// server sent it: the person (the usual short tag), the rule and level, the step and when. The owner reads this before acting can start, so it is a plain table with
// the time written out. No row has a button, nothing here can change anything, and nothing is offered for download. It is asked for when Advanced is opened.

function Row({ item }: { item: AiActionView }) {
  const { t: hubT, locale } = useHub();
  const t = useAiT();
  return (
    <tr>
      <td>
        <time dateTime={new Date(item.actedAt).toISOString()}>{absoluteTime(item.actedAt, locale)}</time>
      </td>
      <td>
        <PersonChip person={item.person} />
      </td>
      <th scope="row">
        {ruleLabel(hubT, item.rule)}, {t(`hub.decide.suggest.level.${item.level}`)}
      </th>
      <td>
        <Card kind={item.kind} /> {t('hub.settings.ai.shadow.applied', { step: choiceLabel(hubT, locale, { kind: item.kind, durationMs: item.durationMs }) })}
      </td>
      <td>
        <Link to={{ name: 'report', id: item.reportId }} className="cw-link">
          {t('hub.settings.ai.shadow.open')}
        </Link>
      </td>
    </tr>
  );
}

export function ShadowList() {
  const t = useAiT();
  const { client, can } = useHub();
  const id = useId();
  const allowed = can('ai.review');
  const list = usePagedList<AiActionView>(allowed ? 'ai:shadow' : 'ai:shadow:none', (cursor) =>
    allowed ? client.aiActions({ state: 'shadow', ...(cursor === undefined ? {} : { cursor }) }) : Promise.resolve({ items: [], next: null }),
  );

  let body;
  if (!allowed) body = <p className="cw-hint">{t('hub.settings.ai.shadow.noAccess')}</p>;
  else if (list.error !== null && list.items.length === 0) body = <ErrorBlock error={list.error} what={t('hub.settings.ai.shadow.what')} onRetry={list.reload} />;
  else if (list.loading && list.items.length === 0) body = <p role="status">{t('hub.state.loading')}</p>;
  else if (list.items.length === 0) body = <p className="cw-hint">{t('hub.settings.ai.shadow.none')}</p>;
  else
    body = (
      <>
        <Scroll label={t('hub.settings.ai.shadow.scroll')}>
          <table className="cw-table cw-shadow-table" aria-label={t('hub.settings.ai.shadow.title')}>
            <thead>
              <tr>
                <th scope="col">{t('hub.settings.ai.shadow.col.when')}</th>
                <th scope="col">{t('hub.settings.ai.shadow.col.person')}</th>
                <th scope="col">{t('hub.settings.ai.shadow.col.cell')}</th>
                <th scope="col">{t('hub.settings.ai.shadow.col.step')}</th>
                <th scope="col">{t('hub.settings.ai.shadow.col.case')}</th>
              </tr>
            </thead>
            <tbody>
              {list.items.map((item) => (
                <Row key={item.actionId} item={item} />
              ))}
            </tbody>
          </table>
        </Scroll>
        {list.error !== null && <ErrorBlock error={list.error} what={t('hub.settings.ai.shadow.what')} onRetry={() => void list.loadMore()} />}
        {list.next !== null && (
          <button type="button" className="cw-btn" disabled={list.loadingMore} onClick={() => void list.loadMore()}>
            {t('hub.settings.ai.shadow.more')}
          </button>
        )}
      </>
    );

  return (
    <section className="cw-gates cw-shadow" aria-labelledby={`${id}-title`}>
      <h3 id={`${id}-title`}>{t('hub.settings.ai.shadow.title')}</h3>
      <p className="cw-hint">{t('hub.settings.ai.shadow.intro')}</p>
      {body}
    </section>
  );
}
