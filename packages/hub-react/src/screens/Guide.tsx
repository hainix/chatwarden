import { LADDER_TABLE } from '@chatwarden/core';
import type { LadderCell, LadderRow } from '@chatwarden/core';
import { useHub } from '../context.js';
import { useHubData } from '../hooks.js';
import { choiceLabel } from '../labels.js';
import { Markdown } from '../markdown.js';
import type { CommunityRule } from '../types.js';
import { Card, Fetched, Panel, Scroll, Tag } from '../ui.js';

/** One cell of the ladder: the referee card for the kind of action, and the action in words. */
function Cell({ cell }: { cell: LadderCell }) {
  const { t, locale } = useHub();
  return (
    <span className="cw-ladder-cell">
      <Card kind={cell.kind} />
      <span>{choiceLabel(t, locale, { kind: cell.kind, durationMs: cell.durationMs })}</span>
    </span>
  );
}

function Rules({ rules }: { rules: readonly CommunityRule[] }) {
  const { t } = useHub();
  return (
    <ul className="cw-rules">
      {[...rules]
        .sort((a, b) => a.number - b.number)
        .map((r) => (
          <li key={r.number} className="cw-rule">
            <div className="cw-rule-head">
              <strong>{t('hub.guide.rule.number', { number: r.number })}</strong>
              <span className="cw-rule-title">{r.title}</span>
              {r.retired === true && <Tag>{t('hub.guide.rules.retired')}</Tag>}
            </div>
            <p className="cw-rule-text">{r.text}</p>
          </li>
        ))}
    </ul>
  );
}

function Ladder({ ladder }: { ladder: readonly LadderRow[] }) {
  const { t } = useHub();
  return (
    <>
      <p className="cw-hint cw-panel-pad">{t('hub.guide.ladder.hint')}</p>
      <Scroll label={t('hub.guide.ladder.table')}>
        <table className="cw-table cw-ladder">
          <thead>
            <tr>
              <th scope="col">{t('hub.guide.ladder.step')}</th>
              <th scope="col">{t('hub.guide.ladder.low')}</th>
              <th scope="col">{t('hub.guide.ladder.high')}</th>
            </tr>
          </thead>
          <tbody>
            {ladder.map((row) => (
              <tr key={row.step}>
                <th scope="row">{t('hub.guide.ladder.stepN', { n: row.step })}</th>
                <td>
                  <Cell cell={row.lowMedium} />
                </td>
                <td>
                  <Cell cell={row.high} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Scroll>
    </>
  );
}

/**
 * The moderator guide: the Community Rules and the escalation ladder drawn from the policy data (the profile's own ladder, else
 * core's `LADDER_TABLE`), then the generated guide itself as markdown through the safe renderer. The rules and the ladder are
 * data, never parsed back out of the text. The policy is read once per hub session (it is audited as one `policy.view`).
 */
export function Guide() {
  const { t, session } = useHub();
  const state = useHubData('guide', () => session.policy());
  return (
    <div className="cw-screen">
      <div className="cw-bar">
        <h2 className="cw-screen-title" tabIndex={-1}>
          {t('hub.guide.title')}
        </h2>
      </div>
      <p className="cw-hint">{t('hub.guide.intro')}</p>
      <Fetched state={state} what={t('hub.state.what.guide')}>
        {(doc) => {
          // A profile always carries its ladder; a server on an older kit might not, and then the default table is the truth.
          const ladder = (doc.profile as { ladder?: readonly LadderRow[] }).ladder ?? LADDER_TABLE;
          return (
            <>
              <Panel title={t('hub.guide.rules')}>
                <Rules rules={doc.rules} />
              </Panel>
              <Panel title={t('hub.guide.ladder')}>
                <Ladder ladder={ladder} />
              </Panel>
              <Panel title={t('hub.guide.full')}>
                <div className="cw-panel-pad">
                  <Markdown source={doc.documents.moderatorGuide} tableLabel={(n) => t('hub.guide.table', { n })} />
                </div>
              </Panel>
            </>
          );
        }}
      </Fetched>
    </div>
  );
}
