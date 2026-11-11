import { useRef, useState } from 'react';
import type { MutableRefObject, RefObject } from 'react';
import type { HubError } from '../client.js';
import { REASON_MAX } from '../decision.js';
import type { Problem } from '../decision.js';
import type { UsePolicy } from '../policyHooks.js';
import type { PolicyLayer, PolicySection } from '../types.js';
import { fieldKeyOf } from './model.js';

/** What the screen is waiting for after a save or a reset: the new state, for all of the draft or for some sections. */
export type Pending = MutableRefObject<'all' | readonly PolicySection[] | null>;

export interface SaveFlow {
  /** The reason form is open. */
  asking: boolean;
  setAsking: (open: boolean) => void;
  reason: string;
  setReason: (reason: string) => void;
  /** The reason problem to show (only after a first try). */
  reasonProblem: Problem | undefined;
  trimmed: string;
  reasonBox: RefObject<HTMLTextAreaElement | null>;
  saveError: HubError | null;
  /** Save changes: opens the reason form, or says the draft has a problem. */
  start: () => void;
  /** The form's send. */
  submit: () => Promise<void>;
  /** Close the form and forget the last error (a discard, a reload). */
  close: () => void;
}

/**
 * Saving the draft: ask for a reason, send, and sort out how it ended. A refusal that names a field closes the form and says which
 * (`onRefused(key)`); one that names none keeps the form open with a plain sentence; a conflict closes the form for the Reload.
 * Nothing is sent unless the role may edit.
 */
export function useSaveFlow({
  policy,
  layer,
  dirty,
  editable,
  pending,
  onBlocked,
  onSaved,
  onRefused,
  fieldOf = fieldKeyOf,
}: {
  policy: UsePolicy;
  /** The layer to send, or null when the draft has a problem. */
  layer: PolicyLayer | null;
  dirty: boolean;
  editable: boolean;
  pending: Pending;
  onBlocked: () => void;
  onSaved: () => void;
  onRefused: (key: string) => void;
  /** The field a refusal's path names (the ladder's by default). */
  fieldOf?: (path: string) => string | null;
}): SaveFlow {
  const [asking, setAsking] = useState(false);
  const [reason, setReason] = useState('');
  const [shown, setShown] = useState(false);
  const [saveError, setSaveError] = useState<HubError | null>(null);
  const reasonBox = useRef<HTMLTextAreaElement>(null);
  const trimmed = reason.trim();
  const problem: Problem | undefined = trimmed === '' ? { key: 'hub.settings.save.reason.required' } : trimmed.length > REASON_MAX ? { key: 'hub.decide.error.reasonLong', params: { max: REASON_MAX } } : undefined;

  const start = (): void => {
    if (!editable || !dirty) return;
    if (layer === null) return onBlocked();
    setSaveError(null);
    setAsking(true);
    queueMicrotask(() => reasonBox.current?.focus());
  };
  const submit = async (): Promise<void> => {
    if (!editable || layer === null || policy.busy) return;
    setShown(true);
    if (problem !== undefined) {
      reasonBox.current?.focus();
      return;
    }
    pending.current = 'all';
    const res = await policy.save(layer, trimmed);
    if (res.ok) {
      setAsking(false);
      setReason('');
      setShown(false);
      setSaveError(null);
      onSaved();
      return;
    }
    pending.current = null;
    setSaveError(res.error);
    if (res.error.code === 'invalid_profile') {
      const key = fieldOf(res.error.path ?? '');
      // A field named: the form closes (the reason is kept) and the field is marked. None named: the form stays, with the sentence.
      if (key !== null) {
        setAsking(false);
        onRefused(key);
      }
    } else if (res.error.code === 'conflict') setAsking(false);
  };
  const close = (): void => {
    setAsking(false);
    setSaveError(null);
  };

  return { asking, setAsking, reason, setReason, reasonProblem: shown ? problem : undefined, trimmed, reasonBox, saveError, start, submit, close };
}
