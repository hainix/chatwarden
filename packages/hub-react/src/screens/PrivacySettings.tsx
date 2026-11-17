import { useId, useState } from 'react';
import type { FormEvent } from 'react';
import { toHubError } from '../client.js';
import type { HubError } from '../client.js';
import { useHub } from '../context.js';
import { useHubData } from '../hooks.js';
import { errorText } from '../labels.js';
import { usePrivacyT } from '../privacy/i18n.js';
import type { PrivacyText } from '../privacy/i18n.js';
import { Fetched, Notice, Panel } from '../ui.js';

// Settings > Advanced > "Privacy requests" (design 5.2): the owner's door to a person's data. A find box that takes the account id the game gave you and opens that person's
// page (where the data can be exported or erased), and a table of what the kit keeps and for how long, from the kit's own registry and the retention in force. The kit never
// verifies who is asking: that is the adopter's job, and the panel says so. Its own lazy chunk; only the owner is offered it.

const DAY_MS = 86_400_000;

/** The panel. Takes no policy: it reads and writes none. */
export function PrivacySettings() {
  const t = usePrivacyT();
  const { client, go, t: hubT } = useHub();
  const id = useId();
  const [account, setAccount] = useState('');
  const [busy, setBusy] = useState(false);
  const [missing, setMissing] = useState(false);
  const [error, setError] = useState<HubError | null>(null);
  const statement = useHubData('privacy:statement', () => client.privacyStatement());

  const find = (e: FormEvent): void => {
    e.preventDefault();
    const value = account.trim();
    if (value === '' || busy) return;
    setBusy(true);
    setMissing(false);
    setError(null);
    client.privacyFind(value).then(
      (answer) => {
        setBusy(false);
        if (answer.ref === null) setMissing(true);
        else go({ name: 'person', ref: answer.ref });
      },
      (cause: unknown) => {
        setBusy(false);
        setError(toHubError(cause));
      },
    );
  };

  return (
    <Panel title={t('hub.privacy.settings.title')}>
      <div className="cw-panel-pad cw-privacy">
        <p className="cw-hint">{t('hub.privacy.settings.intro')}</p>
        <form className="cw-form" onSubmit={find}>
          <label htmlFor={`${id}-account`}>{t('hub.privacy.find.label')}</label>
          <input id={`${id}-account`} type="text" value={account} autoComplete="off" spellCheck={false} maxLength={128} onChange={(e) => setAccount(e.target.value)} />
          <div className="cw-actions">
            <button type="submit" className="cw-btn" aria-disabled={busy || account.trim() === ''}>
              {t('hub.privacy.find.go')}
            </button>
          </div>
        </form>
        {missing && (
          <Notice tone="idle" role="status">
            {t('hub.privacy.find.none')}
          </Notice>
        )}
        {error !== null && (
          <Notice tone="warn" role="alert">
            {t('hub.privacy.find.failed')} {errorText(hubT, error)}
          </Notice>
        )}
        <h3>{t('hub.privacy.statement.title')}</h3>
        <Fetched state={statement} what={t('hub.privacy.statement.title')}>
          {(s) => (
            <>
              <div className="cw-privacy-table" tabIndex={0} role="region" aria-label={t('hub.privacy.statement.title')}>
                <table>
                  <thead>
                    <tr>
                      <th scope="col">{t('hub.privacy.statement.col.what')}</th>
                      <th scope="col">{t('hub.privacy.statement.col.export')}</th>
                      <th scope="col">{t('hub.privacy.statement.col.safety')}</th>
                      <th scope="col">{t('hub.privacy.statement.col.none')}</th>
                      <th scope="col">{t('hub.privacy.statement.col.kept')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {s.categories.map((c) => (
                      <tr key={c.category}>
                        <th scope="row">{t(`hub.privacy.statement.cat.${c.category}` as PrivacyText)}</th>
                        <td>{c.export}</td>
                        <td>{c.eraseSafety}</td>
                        <td>{c.eraseNone}</td>
                        <td>{c.retentionMs === null ? t('hub.privacy.statement.until') : t('hub.privacy.statement.days', { count: Math.round(c.retentionMs / DAY_MS) })}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p className="cw-hint">{t('hub.privacy.statement.note')}</p>
            </>
          )}
        </Fetched>
      </div>
    </Panel>
  );
}
