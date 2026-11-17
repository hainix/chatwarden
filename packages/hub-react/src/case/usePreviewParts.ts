import { useHub } from '../context.js';
import { personName } from '../excerpt.js';
import type { ReportDetail } from '../types.js';
import { useCase } from './CaseContext.js';

// What the "What the player sees" panel needs from the open case, in the form the panel takes: how a recipient is named (the hidden label while the server flags a
// name), and the masked text of a line the person wrote. Used by the decision bar, Simple's card and the AI's accept button, so all three name and quote the same way.

export interface CasePreviewParts {
  /** The reported person, the reporter, and how any person of the report is named. */
  target: string;
  reporter: string;
  nameOf: (ref: string) => string;
  /** The text the player's notice shows for one of their lines, with its UTC day; null for a line with no masked text (never the line as it was typed). */
  lineOf: (lineId: string) => { text: string; day: string } | null;
}

/** The preview's inputs for a case. `report` is the case's report (`detail.report`). */
export function usePreviewParts(report: ReportDetail['report'] | undefined): CasePreviewParts {
  const { t } = useHub();
  const { people } = useCase();
  return {
    target: report?.targetPerson ?? '',
    reporter: report?.reporterPerson ?? '',
    nameOf: (ref) => {
      const person = people.find((p) => p.ref === ref);
      return person === undefined ? t('hub.person.unnamed', { tag: ref.slice(0, 8) }) : personName(person, people, t);
    },
    lineOf: (id) => {
      const line = report?.excerpt.find((l) => l.lineId === id);
      return line === undefined || typeof line.noticeText !== 'string' ? null : { text: line.noticeText, day: new Date(line.ts).toISOString().slice(0, 10) };
    },
  };
}
