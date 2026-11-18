import { useId } from 'react';
import { readOpened, setCare } from '../care.js';
import { useCareSettings } from '../case/useCare.js';
import { useHub } from '../context.js';
import { Panel } from '../ui.js';

// Settings > Advanced > "Your own view" (design 7), first on the screen because it needs no server data: a person can set it before anything else has loaded. Two switches and a select,
// kept in this browser only (never sent, never readable by the owner): hide excerpts until they are opened, count what was opened today (shown only here), and offer a break. It says
// plainly what it is: care, not protection. Not behind a permission: it is about the person's own screen.

const BREAKS = [10, 25, 50] as const;

export function YourView() {
  const { t, now } = useHub();
  const care = useCareSettings();
  const id = useId();
  return (
    <div className="cw-settings cw-care">
      <Panel title={t('hub.care.title')}>
        <div className="cw-form cw-panel-pad">
          <p className="cw-hint">{t('hub.care.help')}</p>
          <label className="cw-choice cw-flowopt">
            <input type="checkbox" checked={care.hideExcerpts} aria-labelledby={`${id}-hide-t`} aria-describedby={`${id}-hide`} onChange={(e) => setCare({ hideExcerpts: e.target.checked })} />
            <span>
              <strong id={`${id}-hide-t`}>{t('hub.care.hide')}</strong>
              <span id={`${id}-hide`} className="cw-hint cw-flowopt-line">
                {t('hub.care.hide.line')}
              </span>
            </span>
          </label>
          <label className="cw-choice cw-flowopt">
            <input type="checkbox" checked={care.countOpened} aria-labelledby={`${id}-count-t`} aria-describedby={`${id}-count`} onChange={(e) => setCare({ countOpened: e.target.checked })} />
            <span>
              <strong id={`${id}-count-t`}>{t('hub.care.count')}</strong>
              <span id={`${id}-count`} className="cw-hint cw-flowopt-line">
                {t('hub.care.count.line')}
              </span>
            </span>
          </label>
          {care.countOpened && <p className="cw-care-count">{t('hub.care.today', { count: readOpened(now()) })}</p>}
          <div className="cw-field">
            <label htmlFor={`${id}-break`}>{t('hub.care.break.label')}</label>
            <select id={`${id}-break`} value={String(care.breakAfter)} onChange={(e) => setCare({ breakAfter: Number(e.target.value) })}>
              <option value="0">{t('hub.care.break.off')}</option>
              {BREAKS.map((n) => (
                <option key={n} value={String(n)}>
                  {t('hub.care.break.after', { count: n })}
                </option>
              ))}
            </select>
          </div>
        </div>
      </Panel>
    </div>
  );
}
