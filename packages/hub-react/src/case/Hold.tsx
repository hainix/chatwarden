import { useId, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { useHub } from '../context.js';
import { Dialog } from '../Dialog.js';
import { useHubAction } from '../hooks.js';
import { usePrivacyT } from '../privacy/i18n.js';
import type { PrivacyText } from '../privacy/i18n.js';
import { useToasts } from '../toasts.js';
import type { HoldCodeView, HoldView } from '../types.js';
import { Notice, Time } from '../ui.js';

// Legal hold on the case (design 6): a quiet "Held for legal reasons" line while the report is held (for everyone who can read it), and, behind one `...`, "Hold for legal..."
// (a senior's, `legal.hold`) and "Release hold..." (the owner's, fixed on the server). Each is a short dialog; a hold takes one of a closed list of reasons and no free text.
// It is its own chunk: fetched when a case is held, or when a person who may hold opens one. The hub only sends the choice; the server checks the role and the code.

/** The reasons, in the order the kit lists them. */
const CODES: readonly HoldCodeView[] = ['law_enforcement_request', 'legal_proceeding', 'platform_request', 'safety_review', 'other'];

/** What the part is given. */
export interface CaseHoldProps {
  reportId: string;
  /** The hold the server sent with the report, or null. */
  hold: HoldView | null;
  /** The caller holds `legal.hold`: show "Hold for legal...". */
  canHold: boolean;
  /** The caller is the owner: show "Release hold...". */
  canRelease: boolean;
  /** The hold changed: read the report again. */
  onChanged: () => void;
}

/** The words of a code (`other`, and a code from a newer server, read as "another reason": a key ending `.other` is a plural form in the catalog). */
const wordOf = (code: string): PrivacyText => (code !== 'other' && (CODES as readonly string[]).includes(code) ? (`hub.legal.code.${code}` as PrivacyText) : 'hub.legal.code.else');

function HoldDialog({ reportId, onClose, onDone }: { reportId: string; onClose: () => void; onDone: () => void }) {
  const t = usePrivacyT();
  const { client } = useHub();
  const toasts = useToasts();
  const id = useId();
  const picker = useRef<HTMLSelectElement>(null);
  const [code, setCode] = useState<HoldCodeView>('legal_proceeding');
  const action = useHubAction((c: HoldCodeView) => client.holdReport(reportId, c));
  const submit = async (e: FormEvent): Promise<void> => {
    e.preventDefault();
    const result = await action.run(code);
    if (!result.ok) return;
    toasts.push({ text: t('hub.legal.hold.done') });
    onDone();
  };
  const failed = action.error === null ? null : action.error.status === 409 ? t('hub.legal.hold.already') : t('hub.legal.hold.failed');
  return (
    <Dialog label={t('hub.legal.hold.title')} onClose={onClose} initialFocus={picker}>
      <form className="cw-form cw-act-dialog" onSubmit={(e) => void submit(e)}>
        <h3>{t('hub.legal.hold.title')}</h3>
        <p>{t('hub.legal.hold.lead')}</p>
        <label htmlFor={`${id}-code`}>{t('hub.legal.hold.reason')}</label>
        <select ref={picker} id={`${id}-code`} value={code} onChange={(e) => setCode(e.target.value as HoldCodeView)}>
          {CODES.map((c) => (
            <option key={c} value={c}>
              {t(wordOf(c))}
            </option>
          ))}
        </select>
        {failed !== null && (
          <Notice tone="warn" role="alert">
            {failed}
          </Notice>
        )}
        <div className="cw-actions">
          <button type="button" className="cw-btn" onClick={onClose}>
            {t('hub.legal.cancel')}
          </button>
          <button type="submit" className="cw-btn cw-btn--primary" aria-disabled={action.busy}>
            {t('hub.legal.hold.go')}
          </button>
        </div>
      </form>
    </Dialog>
  );
}

function ReleaseDialog({ reportId, onClose, onDone }: { reportId: string; onClose: () => void; onDone: () => void }) {
  const t = usePrivacyT();
  const { client } = useHub();
  const toasts = useToasts();
  const go = useRef<HTMLButtonElement>(null);
  const action = useHubAction(() => client.releaseHold(reportId));
  const submit = async (e: FormEvent): Promise<void> => {
    e.preventDefault();
    const result = await action.run();
    if (!result.ok) return;
    toasts.push({ text: t('hub.legal.release.done') });
    onDone();
  };
  return (
    <Dialog label={t('hub.legal.release.title')} onClose={onClose} initialFocus={go}>
      <form className="cw-form cw-act-dialog" onSubmit={(e) => void submit(e)}>
        <h3>{t('hub.legal.release.title')}</h3>
        <p>{t('hub.legal.release.lead')}</p>
        {action.error !== null && (
          <Notice tone="warn" role="alert">
            {t('hub.legal.release.failed')}
          </Notice>
        )}
        <div className="cw-actions">
          <button type="button" className="cw-btn" onClick={onClose}>
            {t('hub.legal.cancel')}
          </button>
          <button ref={go} type="submit" className="cw-btn cw-btn--primary" aria-disabled={action.busy}>
            {t('hub.legal.release.go')}
          </button>
        </div>
      </form>
    </Dialog>
  );
}

export function CaseHold({ reportId, hold, canHold, canRelease, onChanged }: CaseHoldProps) {
  const t = usePrivacyT();
  const id = useId();
  const [open, setOpen] = useState(false);
  const [dialog, setDialog] = useState<null | 'hold' | 'release'>(null);
  const hasItem = hold === null ? canHold : canRelease;
  const done = (): void => {
    setDialog(null);
    setOpen(false);
    onChanged();
  };
  return (
    <div className="cw-person-automation cw-case-hold">
      {hold !== null && (
        <p className="cw-hint cw-person-automation-line">
          {t('hub.legal.held', { reason: t(wordOf(hold.code)).toLowerCase() })} <Time at={hold.at} />
        </p>
      )}
      {hasItem && (
        <>
          <button type="button" className="cw-btn cw-person-more" aria-label={t('hub.legal.menu')} aria-expanded={open} aria-controls={`${id}-group`} onClick={() => setOpen(!open)}>
            <span aria-hidden="true">{'\u2026'}</span>
          </button>
          {open && (
            <fieldset className="cw-form cw-person-automation-group" id={`${id}-group`}>
              <legend>{t('hub.legal.menu')}</legend>
              {hold === null ? (
                <button type="button" className="cw-btn" onClick={() => setDialog('hold')}>
                  {t('hub.legal.hold.item')}
                </button>
              ) : (
                <button type="button" className="cw-btn" onClick={() => setDialog('release')}>
                  {t('hub.legal.release.item')}
                </button>
              )}
            </fieldset>
          )}
        </>
      )}
      {dialog === 'hold' && <HoldDialog reportId={reportId} onClose={() => setDialog(null)} onDone={done} />}
      {dialog === 'release' && <ReleaseDialog reportId={reportId} onClose={() => setDialog(null)} onDone={done} />}
    </div>
  );
}
