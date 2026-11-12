import type { MutableRefObject } from 'react';
import type { AiFromState, DecisionForm, FormSource } from '../decision.js';
import type { DecideInput } from '../types.js';
import type { AiGate } from './offer.js';

// What the AI's part of a case (case/AiCase.tsx) and the case (case/CaseContext.tsx) say to each other. Types only: nothing here is in the first load.

/** What a decision says about the AI read it was shown. */
export type AiEcho = NonNullable<DecideInput['ai']>;

/** What the AI's part of the case publishes for the buttons, the keys and the form. */
export interface AiCaseApi {
  /** The suggestion the form was filled from, or null when the AI was not sure enough to fill anything. */
  from: AiFromState | null;
  /** Whether the suggestion can be accepted with one key, and if not, why. Null with no suggestion. */
  gate: AiGate | null;
  /** Whose form it is: the ladder's, the AI's as it stands, or the AI's after the moderator changed anything. */
  source: FormSource;
  /** The case is open, read, fresh, editable, nobody else holds it and nothing is waiting: a quick action may be sent. */
  usable: boolean;
  /** Sends the suggestion through the Undo hold and goes on to the next case (the same guards as 1, 2 and 3). A no-op unless `gate` is open. */
  accept: (click?: { detail?: number }) => void;
  echo: (accepted: boolean | undefined, form: DecisionForm) => AiEcho | undefined;
}

/** The case's side of the conversation. */
export interface AiBus {
  /** The form the case opens with (the AI's suggestion), or null. */
  first: (form: DecisionForm | null) => void;
  /** The AI's part has decided what the case opens with, or could not load. */
  decided: (done: boolean) => void;
  publish: (api: AiCaseApi | null) => void;
  /** Opens the editor: set by the decision bar (Detailed) or the card's "Something else" (Simple). */
  edit: MutableRefObject<(() => void) | null>;
}
