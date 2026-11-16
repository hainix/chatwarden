import { useId, useState } from 'react';
import { useAiT } from '../ai/i18n.js';
import type { AiText } from '../ai/i18n.js';
import { useHub } from '../context.js';
import { useHubAction } from '../hooks.js';
import { errorText } from '../labels.js';
import { useToasts } from '../toasts.js';
import type { AutomationCode, AutomationInput, PersonHistory } from '../types.js';
import { Time } from '../ui.js';

// "Do not automate" on the Person page (AI levels 3 and 4, design 6.4 and 9.3). Two small things, both quiet: a line while the person is marked (for everyone who can
// read the page), and, for a senior, a `...` item that opens one group: pick a reason and mark the person, or allow the AI again. It is its own chunk: fetched when a
// senior opens a person or the person is marked. The hub only sends the choice; the server checks the role and the code, and the line is read back from the server.
// Nothing here makes the AI act, and the AI still reads and drafts for a marked person.

const CODES: ReadonlyArray<{ code: AutomationCode; label: AiText }> = [
  { code: 'vulnerable', label: 'hub.person.automation.code.vulnerable' },
  { code: 'under_review', label: 'hub.person.automation.code.under_review' },
  { code: 'staff', label: 'hub.person.automation.code.staff' },
  { code: 'sensitive_case', label: 'hub.person.automation.code.sensitive_case' },
  { code: 'other', label: 'hub.person.automation.code.else' },
];

/** What the part is given. @experimental */
export interface PersonAutomationProps {
  person: string;
  /** The mark the server sent with the person's history, or null. */
  mark: PersonHistory['automation'] | null;
  /** The caller holds `automation.write`: show the `...` item. */
  canWrite: boolean;
  /** The mark changed: read the page again. */
  onChanged: () => void;
}

/** The words of a reason code (an unknown code from a newer server reads as "another reason"). */
const labelOf = (code: string): AiText => CODES.find((c) => c.code === code)?.label ?? 'hub.person.automation.code.else';

export function PersonAutomation({ person, mark, canWrite, onChanged }: PersonAutomationProps) {
  const t = useAiT();
  const { client, t: hubT } = useHub();
  const toasts = useToasts();
  const id = useId();
  const [open, setOpen] = useState(false);
  const [code, setCode] = useState<AutomationCode>('vulnerable');
  // A double click sends once: the second call gets the first call's answer.
  const action = useHubAction((input: AutomationInput) => client.setAutomation(person, input));

  const send = async (input: AutomationInput): Promise<void> => {
    const result = await action.run(input);
    if (!result.ok) return;
    toasts.push({ text: t(input.allowed ? 'hub.person.automation.cleared' : 'hub.person.automation.set') });
    setOpen(false);
    onChanged();
  };
  const busy = action.busy;
  const failed = action.error === null ? null : errorText(hubT, action.error);

  return (
    <div className="cw-person-automation">
      {mark !== null && mark !== undefined && (
        <p className="cw-hint cw-person-automation-line">
          {t('hub.person.automation.marked', { reason: t(labelOf(mark.code)).toLowerCase() })}
          {mark.at !== null && (
            <>
              {' '}
              <Time at={mark.at} />
            </>
          )}
        </p>
      )}
      {canWrite && (
        <>
          <button type="button" className="cw-btn cw-person-more" aria-label={t('hub.person.automation.more')} aria-expanded={open} aria-controls={`${id}-group`} onClick={() => setOpen(!open)}>
            <span aria-hidden="true">{'\u2026'}</span>
          </button>
          {open && (
            <fieldset className="cw-form cw-person-automation-group" id={`${id}-group`}>
              <legend>{t('hub.person.automation.title')}</legend>
              <p className="cw-hint">{t('hub.person.automation.hint')}</p>
              {mark === null || mark === undefined ? (
                <>
                  <label>
                    {t('hub.person.automation.reason')}
                    <select value={code} onChange={(e) => setCode(e.target.value as AutomationCode)}>
                      {CODES.map((c) => (
                        <option key={c.code} value={c.code}>
                          {t(c.label)}
                        </option>
                      ))}
                    </select>
                  </label>
                  <button type="button" className="cw-btn" aria-disabled={busy} onClick={() => void send({ allowed: false, code })}>
                    {t('hub.person.automation.mark')}
                  </button>
                </>
              ) : (
                <button type="button" className="cw-btn" aria-disabled={busy} onClick={() => void send({ allowed: true })}>
                  {t('hub.person.automation.allow')}
                </button>
              )}
              {failed !== null && (
                <div className="cw-error" role="alert">
                  <strong>{t('hub.person.automation.failed')}</strong> {failed}
                </div>
              )}
            </fieldset>
          )}
        </>
      )}
    </div>
  );
}
