import { Fragment, useId, useRef, useState } from 'react';
import { useHub } from '../context.js';
import { Dialog } from '../Dialog.js';
import { useQuickKeys } from '../quickKeys.js';
import { SHORTCUT_GROUPS, keyLabel, modKey } from '../shortcuts.js';
import { Kbd } from '../ui.js';

/** The key caps of one binding: `Ctrl` is Cmd on a Mac. */
function Caps({ keys }: { keys: readonly string[] }) {
  const { t } = useHub();
  return (
    <>
      {keys.map((k, i) => (
        <span key={k}>
          {i > 0 && (
            <span className="cw-sheet-plus" aria-hidden="true">
              +
            </span>
          )}
          <Kbd>{keyLabel(t, k === 'Ctrl' ? modKey() : k)}</Kbd>
        </span>
      ))}
    </>
  );
}

/** Every keyboard shortcut, in one window (press ?), in three groups, and the Quick keys switch. */
export function ShortcutSheet({ onClose }: { onClose: () => void }) {
  const { t } = useHub();
  const quick = useQuickKeys();
  const close = useRef<HTMLButtonElement>(null);
  const base = useId();
  const [said, setSaid] = useState('');
  const toggle = (): void => {
    const next = !quick.on;
    quick.set(next);
    setSaid(t(next ? 'hub.shortcuts.quickKeys.on' : 'hub.shortcuts.quickKeys.off'));
  };
  return (
    <Dialog label={t('hub.shortcuts.title')} onClose={onClose} initialFocus={close} className="cw-sheet">
      <div className="cw-sheet-head">
        <h2>{t('hub.shortcuts.title')}</h2>
        <button ref={close} type="button" className="cw-btn" onClick={onClose}>
          {t('hub.shortcuts.close')}
        </button>
      </div>
      <div className="cw-sheet-quick">
        <button type="button" role="switch" aria-checked={quick.on} aria-describedby={`${base}-hint`} className="cw-switch" onClick={toggle}>
          <span className="cw-switch-label">{t('hub.shortcuts.quickKeys.label')}</span>
          <span className="cw-switch-track" aria-hidden="true">
            <span className="cw-switch-thumb" />
          </span>
        </button>
        <p id={`${base}-hint`} className="cw-hint">
          {t('hub.shortcuts.quickKeys.hint')}
        </p>
        <div className="cw-sr" role="status">
          {said}
        </div>
      </div>
      {SHORTCUT_GROUPS.map((g) => (
        <section key={g.group} role="group" aria-labelledby={`${base}-${g.group}`} className="cw-sheet-group">
          <h3 id={`${base}-${g.group}`}>{t(g.title)}</h3>
          <dl className="cw-sheet-list">
            {g.rows.map((r) => (
              <div key={r.label} className="cw-sheet-row">
                <dt>
                  <Caps keys={r.keys} />
                  {r.alt !== undefined && (
                    <Fragment>
                      <span className="cw-sheet-or">{t('hub.shortcuts.or')}</span>
                      <Caps keys={r.alt} />
                    </Fragment>
                  )}
                </dt>
                <dd>
                  {t(r.label)}
                  {r.quickOnly === true && !quick.on && <span className="cw-sheet-needs">{t('hub.shortcuts.quickKeys.only')}</span>}
                </dd>
              </div>
            ))}
          </dl>
        </section>
      ))}
      <p className="cw-hint">{t('hub.shortcuts.note')}</p>
    </Dialog>
  );
}
