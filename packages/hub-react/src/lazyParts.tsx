import { Component, Suspense, lazy } from 'react';
import type { ComponentType, ReactNode } from 'react';
import { useHub } from './context.js';
import type { CommandBarProps } from './shell/CommandBar.js';
import type { AiPartsProps } from './case/AiParts.js';
import type { CaseHoldProps } from './case/Hold.js';
import type { PersonAutomationProps } from './person/Automation.js';
import type { PersonPrivacyProps } from './person/Privacy.js';
import type { PlayerPreviewProps } from './preview/PlayerPreview.js';
import type { ReportTermProps } from './terms/ReportTerm.js';
import type { ShareTermProps } from './terms/ShareTerm.js';
import type { UsePolicy } from './policyHooks.js';
import type { AiReadView, PolicyState, SignalCountView } from './types.js';

// Parts of the hub that few moderators open often are loaded the first time they are shown, so the hub's first load carries only
// what every moderator uses: the sweep disclosure and its window (behind a closed disclosure), the shortcut sheet (opened by `?`) and the
// command bar (opened by Ctrl+K). Each is fetched once and kept, and the shell asks for all three just after its first paint, so by the
// time a key is pressed the code is almost always there; until it is, nothing is drawn (a window opens a moment later, never lost).
// A failed fetch draws nothing and the next opening fetches again: these are optional extras, not screens.
//
// With a bundler that does not split (the single-file `<chatwarden-hub>`), the `import()` is part of the one file: nothing is fetched.

/** A failed fetch of a part's code, told apart from a part that breaks while it renders (which is not ours to catch). */
class LoadFailure extends Error {
  constructor() {
    super('A part of the hub could not be loaded.');
    this.name = 'LoadFailure';
  }
}

class Boundary extends Component<{ children: ReactNode; onFail: () => void; hide: boolean; unavailable?: ReactNode }, { error: unknown }> {
  override state: { error: unknown } = { error: null };

  static getDerivedStateFromError(error: unknown): { error: unknown } {
    return { error };
  }

  override componentDidCatch(error: unknown): void {
    if (error instanceof LoadFailure || this.props.hide) this.props.onFail();
  }

  override render(): ReactNode {
    const { error } = this.state;
    // A part that breaks while it renders is not ours to catch, except the AI's: those hide themselves (the case is never taken down by advice).
    if (error !== null && !(error instanceof LoadFailure) && !this.props.hide) throw error;
    // A part that is asked for to be useful (the player preview) says so when its code could not be fetched; the others draw nothing.
    if (error === null) return this.props.children;
    return error instanceof LoadFailure || this.props.hide ? (this.props.unavailable ?? null) : null;
  }
}

/** What a panel of the Advanced settings screen is given: the policy as the screen read it (one read for all its panels). */
export interface PanelProps {
  state: PolicyState;
  policy: UsePolicy;
}

/** What a part asks of the page to get its code. Exposed so a test can make a fetch fail or wait; nothing else replaces them. */
export const partLoaders: {
  bulk: () => Promise<ComponentType<Record<string, never>>>;
  sheet: () => Promise<ComponentType<{ onClose: () => void }>>;
  bar: () => Promise<ComponentType<CommandBarProps>>;
  strip: () => Promise<ComponentType<{ read: AiReadView | null; expected: boolean }>>;
  aiParts: () => Promise<ComponentType<AiPartsProps>>;
  signalLines: () => Promise<ComponentType<{ signals: readonly SignalCountView[] | undefined }>>;
  pacePanel: () => Promise<ComponentType<PanelProps>>;
  signalPanel: () => Promise<ComponentType<PanelProps>>;
  appealPanel: () => Promise<ComponentType<PanelProps>>;
  namePanel: () => Promise<ComponentType<PanelProps>>;
  filterPanel: () => Promise<ComponentType<PanelProps>>;
  safetyPanel: () => Promise<ComponentType<PanelProps>>;
  privacyPanel: () => Promise<ComponentType<Record<string, never>>>;
  appealList: () => Promise<ComponentType<{ selected: string | null }>>;
  shareTerm: () => Promise<ComponentType<ShareTermProps>>;
  reportTerm: () => Promise<ComponentType<ReportTermProps>>;
  personAutomation: () => Promise<ComponentType<PersonAutomationProps>>;
  personPrivacy: () => Promise<ComponentType<PersonPrivacyProps>>;
  caseHold: () => Promise<ComponentType<CaseHoldProps>>;
  playerPreview: () => Promise<ComponentType<PlayerPreviewProps>>;
  whatToDo: () => Promise<ComponentType<{ id: string }>>;
  commentThread: () => Promise<ComponentType<Record<string, never>>>;
  deskPanel: () => Promise<ComponentType<PanelProps>>;
} = {
  bulk: () => import('./case/BulkDismiss.js').then((m) => m.BulkDismiss),
  sheet: () => import('./shell/ShortcutSheet.js').then((m) => m.ShortcutSheet),
  bar: () => import('./shell/CommandBar.js').then((m) => m.CommandBar),
  strip: () => import('./case/AiStrip.js').then((m) => m.AiStrip),
  aiParts: () => import('./case/AiParts.js').then((m) => m.AiParts),
  signalLines: () => import('./person/SignalLines.js').then((m) => m.SignalLines),
  pacePanel: () => import('./screens/PaceSettings.js').then((m) => m.PaceSettings),
  signalPanel: () => import('./screens/SignalSettings.js').then((m) => m.SignalSettings),
  appealPanel: () => import('./screens/AppealSettings.js').then((m) => m.AppealSettings),
  namePanel: () => import('./screens/NameSettings.js').then((m) => m.NameSettings),
  filterPanel: () => import('./screens/FilterSettings.js').then((m) => m.FilterSettings),
  safetyPanel: () => import('./screens/SafetySettings.js').then((m) => m.SafetySettings),
  privacyPanel: () => import('./screens/PrivacySettings.js').then((m) => m.PrivacySettings),
  appealList: () => import('./appeals/AppealList.js').then((m) => m.AppealList),
  shareTerm: () => import('./terms/ShareTerm.js').then((m) => m.ShareTerm),
  reportTerm: () => import('./terms/ReportTerm.js').then((m) => m.ReportTerm),
  personAutomation: () => import('./person/Automation.js').then((m) => m.PersonAutomation),
  personPrivacy: () => import('./person/Privacy.js').then((m) => m.PersonPrivacy),
  caseHold: () => import('./case/Hold.js').then((m) => m.CaseHold),
  playerPreview: () => import('./preview/PlayerPreview.js').then((m) => m.PlayerPreview),
  whatToDo: () => import('./case/WhatToDo.js').then((m) => m.WhatToDo),
  commentThread: () => import('./case/CommentThread.js').then((m) => m.CommentThread),
  deskPanel: () => import('./screens/DeskSettings.js').then((m) => m.DeskSettings),
};

/** A part that is asked for by the moderator (a window) is told when its code could not be fetched, so it can close and say so. */
export interface FailureAware {
  onFailed?: () => void;
}

function lazyPart<P extends object>(load: () => Promise<ComponentType<P>>, hide = false, fallback: ReactNode = null, unavailable: ReactNode = null): { Part: ComponentType<P & FailureAware>; preload: () => void; reset: () => void } {
  const make = () =>
    lazy(() =>
      load().then(
        (component) => ({ default: component }),
        () => {
          throw new LoadFailure();
        },
      ),
    );
  let Inner = make();
  let failed = false;
  const Part = ({ onFailed, ...props }: P & FailureAware) => {
    // After a failure the next time the part is drawn asks for the code again (React keeps a failed lazy component failed).
    if (failed) {
      failed = false;
      Inner = make();
    }
    return (
      <Boundary
        hide={hide}
        unavailable={unavailable}
        onFail={() => {
          failed = true;
          onFailed?.();
        }}
      >
        <Suspense fallback={fallback}>
          <Inner {...(props as unknown as P)} />
        </Suspense>
      </Boundary>
    );
  };
  return {
    Part,
    preload: () => {
      void load().catch(() => undefined);
    },
    reset: () => {
      failed = false;
      Inner = make();
    },
  };
}

const bulk = lazyPart(() => partLoaders.bulk());
const sheet = lazyPart(() => partLoaders.sheet());
const bar = lazyPart(() => partLoaders.bar());
const strip = lazyPart(() => partLoaders.strip(), true);
const aiParts = lazyPart(() => partLoaders.aiParts(), true);
const signalLines = lazyPart(() => partLoaders.signalLines(), true);
const pacePanel = lazyPart(() => partLoaders.pacePanel());
const signalPanel = lazyPart(() => partLoaders.signalPanel());
const appealPanel = lazyPart(() => partLoaders.appealPanel());
const namePanel = lazyPart(() => partLoaders.namePanel());
const filterPanel = lazyPart(() => partLoaders.filterPanel());
const safetyPanel = lazyPart(() => partLoaders.safetyPanel());
const privacyPanel = lazyPart(() => partLoaders.privacyPanel());
const appealList = lazyPart(() => partLoaders.appealList());
const shareTerm = lazyPart(() => partLoaders.shareTerm(), true);
const reportTerm = lazyPart(() => partLoaders.reportTerm(), true);
const personAutomation = lazyPart(() => partLoaders.personAutomation(), true);
const personPrivacy = lazyPart(() => partLoaders.personPrivacy(), true);
const caseHold = lazyPart(() => partLoaders.caseHold(), true);
// "What the player sees": until its code arrives the slot holds one line of height, so the form below it does not jump (an empty hint line, hidden from a screen reader).
// If its code cannot be fetched the slot says so in one short line (a moderator who sends with no preview should know), and the next drawing asks again.
function PreviewUnavailable() {
  const { t } = useHub();
  return (
    <p className="cw-hint cw-pv-hold" role="status">
      {t('hub.preview.unavailable')}
    </p>
  );
}
const whatToDo = lazyPart(() => partLoaders.whatToDo(), true);
const commentThread = lazyPart(() => partLoaders.commentThread());
const deskPanel = lazyPart(() => partLoaders.deskPanel());
const playerPreview = lazyPart(() => partLoaders.playerPreview(), true, <p className="cw-hint cw-pv-hold" aria-hidden="true">{'\u00a0'}</p>, <PreviewUnavailable />);

/** "Close more reports at once": the disclosure at the bottom of the decision bar. */
export const LazyBulkDismiss: ComponentType<Record<string, never>> = bulk.Part as ComponentType<Record<string, never>>;
export const LazyShortcutSheet = sheet.Part;
export const LazyCommandBar = bar.Part;
/** The AI's read on the case (the strip and its menu): loaded when a case has a read or expects one. */
export const LazyAiStrip = strip.Part;
/** The AI's suggestion on a case (level 2): the bar's header, and the Simple card's suggestion, Accept button and reason. */
export const LazyAiParts = aiParts.Part;

/** The Person page's signal lines (inside the Timeline panel): loaded when the record has counts to show; an optional extra, never an error. */
export const LazySignalLines = signalLines.Part;

/** The "Slow mode and flooding" panel of Settings > Advanced: loaded when that screen is opened. */
export const LazyPaceSettings = pacePanel.Part;

/** The "Signals" panel of Settings > Advanced: loaded when that screen is opened. */
export const LazySignalSettings = signalPanel.Part;

/** The "Appeals" panel of Settings > Advanced: loaded when that screen is opened. */
export const LazyAppealSettings = appealPanel.Part;

/** The "Names" panel of Settings > Advanced: loaded when that screen is opened. */
export const LazyNameSettings = namePanel.Part;

/** The "Chat filters" panel of Settings > Advanced: loaded when that screen is opened. */
export const LazyFilterSettings = filterPanel.Part;

/** The "Safety and urgent cases" panel of Settings > Advanced: loaded when that screen is opened. */
export const LazySafetySettings = safetyPanel.Part;

/** The "Privacy requests" panel of Settings > Advanced (the owner's): loaded when that screen is opened. */
export const LazyPrivacySettings = privacyPanel.Part as ComponentType<FailureAware>;

/** The list of open appeals in the queue pane (the Appeals view): loaded when that view is first opened. */
export const LazyAppealList = appealList.Part;

/** The "Share with the community list" disclosure in the term editor: loaded when an editor opens on a term of the adopter's own; an optional extra, never an error. */
export const LazyShareTerm = shareTerm.Part;

/** The report disclosure in the term editor: loaded when an editor opens on a row the shared list added; an optional extra, never an error. */
export const LazyReportTerm = reportTerm.Part;

/** The Person page's "do not automate" mark and its `...` item: loaded when a senior opens a person, or the person is marked; an optional extra, never an error. */
export const LazyPersonAutomation = personAutomation.Part;

/** The Person page's "Data requests" (export and erase, the owner's): loaded when the owner opens a person; an optional extra, never an error. */
export const LazyPersonPrivacy = personPrivacy.Part;

/** The case's "Legal hold" line and its `...` items: loaded when a case is held, or when someone who may hold it opens one; an optional extra, never an error. */
export const LazyCaseHold = caseHold.Part;

/** "What the player sees", inside an action (the decision bar, Simple's card, the Person forms, revoke, the appeal card): loaded the first time an action shows it; an optional extra, never an error. */
export const LazyPlayerPreview = playerPreview.Part;

/** The urgent case's "What to do" panel (the owner's guidance, the studio contact and the two buttons): loaded when an urgent case opens with the panel showing; an optional extra, never an error. */
export const LazyWhatToDo = whatToDo.Part;

/** The case's staff comment thread (behind `desk.workflow`): loaded when the thread is opened. */
export const LazyCommentThread = commentThread.Part as ComponentType<FailureAware>;

/** The "The desk" panel of Settings > Advanced (the workflow, Insights and surge switches): loaded when that screen is opened. */
export const LazyDeskSettings = deskPanel.Part;

/** Forgets what was fetched, so the next drawing of each part asks again (tests). */
export function resetLazyParts(): void {
  bulk.reset();
  sheet.reset();
  bar.reset();
  strip.reset();
  aiParts.reset();
  signalLines.reset();
  pacePanel.reset();
  signalPanel.reset();
  appealPanel.reset();
  namePanel.reset();
  filterPanel.reset();
  safetyPanel.reset();
  privacyPanel.reset();
  appealList.reset();
  shareTerm.reset();
  reportTerm.reset();
  personAutomation.reset();
  personPrivacy.reset();
  caseHold.reset();
  playerPreview.reset();
  whatToDo.reset();
  commentThread.reset();
  deskPanel.reset();
}

/** Asks for the code of all three (the sweep disclosure only for a role that may sweep), once, just after the hub's first paint. */
export function preloadShellParts(withBulk: boolean): () => void {
  const id = setTimeout(() => {
    bar.preload();
    sheet.preload();
    if (withBulk) bulk.preload();
  }, 0);
  return () => clearTimeout(id);
}
