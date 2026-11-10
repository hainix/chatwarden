import { useRef } from 'react';
import { useHub } from '../context.js';
import { Dialog } from '../Dialog.js';
import { SHORTCUTS, keyLabel, modKey } from '../shortcuts.js';
import { Kbd } from '../ui.js';

/** Every keyboard shortcut, in one window (press ?). */
export function ShortcutSheet({ onClose }: { onClose: () => void }) {
  const { t } = useHub();
  const close = useRef<HTMLButtonElement>(null);
  return (
    <Dialog label={t('hub.shortcuts.title')} onClose={onClose} initialFocus={close} className="cw-sheet">
      <div className="cw-sheet-head">
        <h2>{t('hub.shortcuts.title')}</h2>
        <button ref={close} type="button" className="cw-btn" onClick={onClose}>
          {t('hub.shortcuts.close')}
        </button>
      </div>
      <dl className="cw-sheet-list">
        {SHORTCUTS.map((s) => (
          <div key={s.action} className="cw-sheet-row">
            <dt>
              {s.keys.map((k, i) => (
                <span key={k}>
                  {i > 0 && <span className="cw-sheet-plus" aria-hidden="true">+</span>}
                  <Kbd>{keyLabel(t, k === 'Ctrl' ? modKey() : k)}</Kbd>
                </span>
              ))}
            </dt>
            <dd>{t(s.label)}</dd>
          </div>
        ))}
      </dl>
      <p className="cw-hint">{t('hub.shortcuts.note')}</p>
    </Dialog>
  );
}
