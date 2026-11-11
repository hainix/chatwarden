// Where the tour points in the hub. hub-react has no tour-hook option and the page does not change it, so the tour finds the hub's
// controls the way a screen reader does: by role and accessible name. The names are the hub's English words (its `en` catalog),
// which is what the demo shows. A control that is not on screen yet gives null, and the tour falls back to something that is.

/** The text a screen reader would read for a control: its aria-label, else its text. */
function nameOf(el: Element): string {
  return (el.getAttribute('aria-label') ?? el.textContent ?? '').replace(/\s+/g, ' ').trim();
}

function find(root: ParentNode, selector: string, test: (name: string, el: HTMLElement) => boolean): HTMLElement | null {
  for (const el of root.querySelectorAll<HTMLElement>(selector)) {
    if (el.closest('[hidden], [inert]') === null && test(nameOf(el), el)) return el;
  }
  return null;
}

/** The "1 new case" pill: a case that arrives after the list was shown waits behind it, so the list never moves under the cursor. */
export const newCasesPill = (hub: ParentNode): HTMLElement | null => find(hub, 'button', (name) => /^\d+ new cases?$/.test(name));

/** A link to a case in the queue (the hub's case rows are links to `#/reports/<id>`). */
export const queueLink = (hub: ParentNode): HTMLElement | null => find(hub, 'a[href*="/reports/"]', () => true);

/** "Which rule does this break?": the Simple card's rule picker, shown when a report named no clear rule. */
export const rulePicker = (hub: ParentNode): HTMLElement | null => find(hub, 'select', (name) => /which rule does this break/i.test(name) || /choose a rule/i.test(name));

/** The ladder's suggested step on the Simple card: the first of its step buttons ("Restrict chat, 24 hours", "Send a warning", ...). */
export const suggestedStep = (hub: ParentNode): HTMLElement | null =>
  find(hub, 'button', (name) => /^(Restrict chat|Restrict area|Ban|Send a warning|Add a note)\b/.test(name));

/** The Undo of a decision that is waiting to be sent. */
export const undoButton = (hub: ParentNode): HTMLElement | null => find(hub, 'button', (name) => name === 'Undo');

/** The Simple/Detailed switch's Detailed button. */
export const detailedSwitch = (hub: ParentNode): HTMLElement | null => find(hub, 'button', (name) => name === 'Detailed');

/** "More" in the Simple menu, and, once it is open, the link to Steps and ladder. */
export const moreMenu = (hub: ParentNode): HTMLElement | null => find(hub, 'button', (name) => name === 'More');
/** In the Detailed view the same screen is under Settings. */
export const settingsLink = (hub: ParentNode): HTMLElement | null => find(hub, 'a', (name) => name === 'Settings');
export const stepsAndLadder = (hub: ParentNode): HTMLElement | null => find(hub, 'a', (name) => name === 'Steps and ladder');
