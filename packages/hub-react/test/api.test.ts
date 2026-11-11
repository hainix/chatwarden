// @vitest-environment node
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { exportsOf } from './apiNames.js';

// The public API is locked: every export name of each entry point, as committed inline snapshots. Changing one is a deliberate
// snapshot edit, so the diff shows exactly what was added or removed, and the changeset says which way. Names are read from the
// source by the TypeScript checker (so type-only exports count) and the values are checked against what actually loads.
//
// `@experimental` names (see the README's list) may change before 0.2; the lock still shows when they do.

const root = process.cwd();

async function loaded(entry: string): Promise<string[]> {
  const mod = (await import(/* @vite-ignore */ pathToFileURL(join(root, entry)).href)) as Record<string, unknown>;
  return Object.keys(mod).sort();
}

const HUB = 'packages/hub-react/src/index.ts';
const HEADLESS = 'packages/hub-react/src/headless/index.ts';
const PLAYER = 'packages/player-react/src/index.ts';

describe('@chatwarden/hub-react', () => {
  it('exports exactly these values', () => {
    expect(exportsOf(HUB).values).toMatchInlineSnapshot(`
      [
        "AuditLog",
        "BlockedList",
        "CaseCard",
        "CaseList",
        "CaseWorkbench",
        "Guide",
        "Hub",
        "HubError",
        "HubProvider",
        "PersonRecord",
        "RecentActions",
        "RuleGaps",
        "TermsManager",
        "UNDO_MS",
        "VERSION",
        "absoluteTime",
        "actorInitial",
        "actorName",
        "buildPath",
        "createHubClient",
        "createT",
        "en",
        "fetchAll",
        "fetchTransport",
        "filterGroups",
        "formatDuration",
        "groupQueue",
        "hashRouter",
        "holderOf",
        "liveClaim",
        "memoryRouter",
        "normalizePath",
        "parseRoute",
        "personTag",
        "queueStats",
        "relativeTime",
        "routerTransport",
        "shortcutFor",
        "tabOf",
        "teamOf",
        "toHubError",
        "useBlocked",
        "useCase",
        "useCases",
        "useClaim",
        "useDecide",
        "useHub",
        "useHubAction",
        "useHubController",
        "useHubData",
        "useMe",
        "usePagedList",
        "usePerson",
        "useTerms",
        "useToasts",
        "waitTone",
      ]
    `);
  });

  it('exports exactly these types', () => {
    expect(exportsOf(HUB).types).toMatchInlineSnapshot(`
      [
        "ActionRecord",
        "ActionResult",
        "AuditAction",
        "AuditItem",
        "AuditLogProps",
        "BlockedDays",
        "BlockedLine",
        "BlockedListProps",
        "CaseCardProps",
        "CaseListProps",
        "CaseWorkbenchProps",
        "Changes",
        "Claim",
        "ClaimResult",
        "CloseGapInput",
        "CommunityRule",
        "ConductLevel",
        "DecideInput",
        "DecideResult",
        "DecisionAction",
        "ExceptionInput",
        "ExceptionPatch",
        "ExceptionRow",
        "FetchTransportOptions",
        "GapRow",
        "GuideProps",
        "GuideSection",
        "Hold",
        "HoldInput",
        "Holder",
        "HubAction",
        "HubCatalog",
        "HubClient",
        "HubContextValue",
        "HubControllerSource",
        "HubData",
        "HubMode",
        "HubParams",
        "HubProps",
        "HubProviderOptions",
        "HubProviderProps",
        "HubRead",
        "HubRouter",
        "HubT",
        "HubText",
        "ListAuditQuery",
        "ListReportsQuery",
        "ListSanctionsQuery",
        "Me",
        "MemoryRouter",
        "NextCase",
        "ObservableRouter",
        "Page",
        "PagedList",
        "PermissionKey",
        "PersonHistory",
        "PersonRecordProps",
        "PieceLinks",
        "PieceProps",
        "PolicyDocs",
        "PolicyFormat",
        "QueueFilter",
        "QueueGroup",
        "QueueSort",
        "QueueStats",
        "QueueStatus",
        "Reason",
        "RecentActionsProps",
        "ReportCategory",
        "ReportDetail",
        "ReportStatus",
        "ReportSummary",
        "ReporterRecord",
        "Role",
        "Route",
        "RouterTransportOptions",
        "RuleGapsProps",
        "SanctionGroupView",
        "SanctionInput",
        "SanctionKind",
        "SanctionRow",
        "SanctionSource",
        "ShortcutAction",
        "StaffReport",
        "SuggestInput",
        "Suggestion",
        "TabName",
        "TeamMember",
        "TermInput",
        "TermPatch",
        "TermRow",
        "TermsList",
        "TermsManagerProps",
        "TextVerdict",
        "ToastInput",
        "Toasts",
        "Transport",
        "TransportRequest",
        "TransportResponse",
        "UseCase",
        "UseCaseOptions",
        "UseCases",
        "UseClaim",
        "UseDecide",
        "UseMe",
      ]
    `);
  });

  it('what loads is what the source says (no value lost to a type-only export, none invented)', async () => {
    expect(await loaded(HUB)).toEqual(exportsOf(HUB).values);
  });
});

describe('@chatwarden/hub-react/headless', () => {
  it('exports exactly these values', () => {
    expect(exportsOf(HEADLESS).values).toMatchInlineSnapshot(`
      [
        "CLAIM_BEAT_MS",
        "HubError",
        "QUEUE_MAX_PAGES",
        "QUEUE_PAGE",
        "SESSION_REPORTERS_MAX",
        "SESSION_TTL_MS",
        "TAKE_COOLDOWN_MS",
        "TOAST_ERROR_MS",
        "TOAST_MAX",
        "TOAST_MS",
        "UNDO_MS",
        "VIEWING_BEAT_MS",
        "absoluteTime",
        "actorInitial",
        "actorName",
        "browserPage",
        "browserTimers",
        "createAction",
        "createCaseStore",
        "createDecisionStore",
        "createHubClient",
        "createHubController",
        "createLiveQueue",
        "createPagedList",
        "createResource",
        "createSession",
        "createStore",
        "createT",
        "createToastStore",
        "emptyForm",
        "en",
        "fetchAll",
        "fetchTransport",
        "filterGroups",
        "formatDuration",
        "groupQueue",
        "hasLeft",
        "holderOf",
        "isWaiting",
        "liveClaim",
        "nextOpenReport",
        "personTag",
        "queueStats",
        "relativeTime",
        "routerTransport",
        "teamOf",
        "toHubError",
        "visibleRows",
        "waitTone",
      ]
    `);
  });

  it('exports exactly these types', () => {
    expect(exportsOf(HEADLESS).types).toMatchInlineSnapshot(`
      [
        "ActionRecord",
        "ActionResult",
        "ActionState",
        "ActionStore",
        "AuditAction",
        "AuditItem",
        "BlockedDays",
        "BlockedLine",
        "CaseStore",
        "CaseStoreOptions",
        "Changes",
        "Claim",
        "ClaimResult",
        "CloseGapInput",
        "CommunityRule",
        "ConductLevel",
        "Connection",
        "ContinueOutcome",
        "DecideCommand",
        "DecideInput",
        "DecideOptions",
        "DecideResult",
        "DecisionAction",
        "DecisionEntry",
        "DecisionForm",
        "DecisionHost",
        "DecisionOutcome",
        "DecisionState",
        "DecisionStore",
        "DecisionStoreOptions",
        "ExceptionInput",
        "ExceptionPatch",
        "ExceptionRow",
        "FetchTransportOptions",
        "GapRow",
        "GuideSection",
        "Handoff",
        "Hold",
        "HoldInput",
        "Holder",
        "HubCatalog",
        "HubClient",
        "HubController",
        "HubControllerOptions",
        "HubControllerSettings",
        "HubHost",
        "HubParams",
        "HubT",
        "HubText",
        "ListAuditQuery",
        "ListReportsQuery",
        "ListSanctionsQuery",
        "LiveQueueOptions",
        "LiveQueueState",
        "LiveQueueStore",
        "Me",
        "NextCase",
        "NextReport",
        "OpenCase",
        "Page",
        "PageSource",
        "PagedListStore",
        "PagedState",
        "PermissionKey",
        "PersonHistory",
        "PolicyDocs",
        "PolicyFormat",
        "QueueFilter",
        "QueueGroup",
        "QueueSort",
        "QueueStats",
        "Reason",
        "ReportCategory",
        "ReportDetail",
        "ReportStatus",
        "ReportSummary",
        "ReporterRecord",
        "ResourceState",
        "ResourceStore",
        "Role",
        "RouterTransportOptions",
        "SanctionGroupView",
        "SanctionInput",
        "SanctionKind",
        "SanctionRow",
        "SanctionSource",
        "Session",
        "StaffReport",
        "Store",
        "SubmitDecision",
        "SuggestInput",
        "Suggestion",
        "TakeOutcome",
        "TeamMember",
        "TermInput",
        "TermPatch",
        "TermRow",
        "TermsList",
        "TextVerdict",
        "Timers",
        "ToastInput",
        "ToastRecord",
        "ToastStore",
        "ToastStoreOptions",
        "Toasts",
        "Transport",
        "TransportRequest",
        "TransportResponse",
        "WritableStore",
      ]
    `);
  });

  it('what loads is what the source says', async () => {
    expect(await loaded(HEADLESS)).toEqual(exportsOf(HEADLESS).values);
  });
});

describe('@chatwarden/player-react', () => {
  it('exports exactly these values', () => {
    expect(exportsOf(PLAYER).values).toMatchInlineSnapshot(`
      [
        "MyRecord",
        "NoticeQueue",
        "PlayerError",
        "ReportDialog",
        "RestrictedChatLine",
        "RulesPage",
        "VERSION",
        "createT",
        "dayText",
        "en",
        "fetchTransport",
        "playerClient",
        "routerTransport",
        "timeLeft",
        "toPlayerError",
        "untilText",
      ]
    `);
  });

  it('exports exactly these types', () => {
    expect(exportsOf(PLAYER).types).toMatchInlineSnapshot(`
      [
        "FetchTransportOptions",
        "MyRecordProps",
        "NoticeKind",
        "NoticeQueueProps",
        "PlayerCatalog",
        "PlayerClient",
        "PlayerClientOptions",
        "PlayerNotice",
        "PlayerParams",
        "PlayerRule",
        "PlayerRules",
        "PlayerT",
        "PlayerText",
        "PlayerUiProps",
        "ReportCategory",
        "ReportDialogProps",
        "ReportDraft",
        "ReportRefusal",
        "ReportResult",
        "RestrictedChatLineProps",
        "RouterRequest",
        "RouterResponse",
        "RouterTransportOptions",
        "RulesPageProps",
        "Transport",
        "TransportRequest",
        "TransportResponse",
      ]
    `);
  });

  it('what loads is what the source says', async () => {
    expect(await loaded(PLAYER)).toEqual(exportsOf(PLAYER).values);
  });
});

describe('what is marked @experimental', () => {
  it('hub-react: the provider, the pieces, the hooks and their types', () => {
    expect(exportsOf(HUB).experimental).toMatchInlineSnapshot(`
      [
        "AuditLog",
        "AuditLogProps",
        "BlockedList",
        "BlockedListProps",
        "CaseCard",
        "CaseCardProps",
        "CaseList",
        "CaseListProps",
        "CaseWorkbench",
        "CaseWorkbenchProps",
        "Guide",
        "GuideProps",
        "HubControllerSource",
        "HubProvider",
        "HubProviderOptions",
        "HubProviderProps",
        "HubRead",
        "PersonRecord",
        "PersonRecordProps",
        "PieceLinks",
        "PieceProps",
        "RecentActions",
        "RecentActionsProps",
        "RuleGaps",
        "RuleGapsProps",
        "TermsManager",
        "TermsManagerProps",
        "UseCase",
        "UseCaseOptions",
        "UseCases",
        "UseClaim",
        "UseDecide",
        "UseMe",
        "useBlocked",
        "useCase",
        "useCases",
        "useClaim",
        "useDecide",
        "useHubController",
        "useMe",
        "usePerson",
        "useTerms",
      ]
    `);
  });

  it('hub-react/headless: the host and configure (names, and the members of the controller and its options)', () => {
    const headless = exportsOf(HEADLESS);
    expect(headless.experimental).toMatchInlineSnapshot(`
      [
        "HubControllerSettings",
        "HubHost",
      ]
    `);
    expect(headless.experimentalMembers).toMatchInlineSnapshot(`
      [
        "HubController.configure",
        "HubControllerOptions.host",
      ]
    `);
  });

  it('player-react marks nothing: it is the small, settled side', () => {
    expect(exportsOf(PLAYER).experimental).toEqual([]);
  });

  it('every new value export of the main entry is marked (nothing slips in unmarked)', () => {
    const hub = exportsOf(HUB);
    const settled = new Set(exportsOf(HEADLESS).values);
    const embedding = hub.values.filter((name) => /^(Hub.*Provider|HubProvider|use(Cases?|Decide|Claim|Terms|Blocked|Person|Me|HubController)|CaseList|CaseCard|CaseWorkbench|PersonRecord|TermsManager|BlockedList|AuditLog|RuleGaps|Guide|RecentActions)$/.test(name) && !settled.has(name));
    expect(embedding.length).toBe(20);
    for (const name of embedding) expect(hub.experimental, name).toContain(name);
  });
});

describe('the lock itself', () => {
  it('a name that is not exported is not in the list (control), and a type-only export is a type, not a value', () => {
    const hub = exportsOf(HUB);
    expect(hub.values).not.toContain('NotExportedAnywhere');
    expect(hub.values).not.toContain('HubClient');
    expect(hub.types).toContain('HubClient');
    expect(hub.types).not.toContain('Hub');
  });
});
