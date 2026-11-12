import { useEffect, useRef } from 'react';
import { useHub } from '../context.js';
import { isTypingTarget, modalIn } from '../dom.js';
import { useKeyListener } from '../keyScope.js';
import { actsBlocked } from './actGuard.js';
import { useCase } from './CaseContext.js';
import { useQuickActions } from './useQuickActions.js';
import type { QuickActions } from './useQuickActions.js';

// The keys that act on the open case: 1 the suggested step, 2 "nothing wrong here", 3 a warning (when offered), and, where `ctrlEnter`
// is set, Ctrl or Cmd with Enter as 1. Renders nothing. Heard where the case lives (the hub's root in the shell, the piece's own root in
// a piece), so two hubs, or a card among an adopter's own page, never answer one key between them.
//
// A key acts only when the case is usable, once (a held key repeats and is ignored), not while typing (except Ctrl+Enter, made for
// the reason box, and a digit on the rule field, a select that a digit cannot type into), not under a window, and not until
// QUICK_ACT_COOLDOWN_MS after the case appeared (see actGuard.ts).

export function QuickKeys({ quick, ctrlEnter = true, digits = true }: { quick: QuickActions; ctrlEnter?: boolean; digits?: boolean }) {
  const { shortcuts } = useHub();
  const c = useCase();
  const listen = useKeyListener();
  const latest = useRef(quick);
  latest.current = quick;
  const settledRef = useRef(c.settled);
  settledRef.current = c.settled;

  useEffect(() => {
    if (!shortcuts) return;
    const onKeyDown = (e: KeyboardEvent, hub: HTMLElement): void => {
      const q = latest.current;
      if (e.defaultPrevented || e.isComposing || e.repeat || !q.usable) return;
      if (modalIn(hub) !== null) return;
      const isCtrlEnter = e.key === 'Enter' && e.ctrlKey !== e.metaKey && !e.altKey && !e.shiftKey;
      const isDigit = digits && (e.key === '1' || e.key === '2' || e.key === '3') && !e.ctrlKey && !e.metaKey && !e.altKey;
      if (!isDigit && !(ctrlEnter && isCtrlEnter)) return;
      if (isDigit) {
        // The rule field is a select: a digit cannot type into it, so 1, 2 and 3 keep working while it has focus.
        const origin = e.composedPath()[0] ?? e.target;
        const onRuleField = origin instanceof Element && origin.closest('.cw-scard-rule') !== null;
        if (isTypingTarget(e) && !onRuleField) return;
      }
      // Not until the case has aged (a double tap is for the case just closed), and not while a move to another case is on its way.
      if (!settledRef.current() || actsBlocked(hub)) return;
      if (isCtrlEnter || e.key === '1') {
        if (q.primary === null && !q.aiOk) return;
        e.preventDefault();
        q.sendPrimary();
      } else if (e.key === '2') {
        e.preventDefault();
        q.sendDismiss();
      } else if (q.warning !== null) {
        e.preventDefault();
        q.sendWarning();
      }
    };
    // Heard on the hub's root in the shell, and on the piece's own root in a piece (see `keyScope.ts`).
    return listen(onKeyDown);
  }, [shortcuts, ctrlEnter, digits]);

  return null;
}

/**
 * The Detailed workbench's quick keys: 1, 2 and 3 act (Ctrl+Enter stays the bar's, which decides the form the moderator filled in).
 * Mounted by the decision bar only while Quick keys are on.
 */
export function DetailedQuickKeys() {
  const quick = useQuickActions({ refresh: true });
  return <QuickKeys quick={quick} ctrlEnter={false} />;
}
