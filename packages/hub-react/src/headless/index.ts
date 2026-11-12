// @chatwarden/hub-react/headless: the moderator hub's behaviour with no React, for Vue, Svelte, Solid or plain code.
// The React hub is built on exactly this, so there is one implementation of the queue, the Undo hold, claims and toasts.
//
//   const hub = createHubController({ client });
//   await hub.start();
//   hub.queue.subscribe(() => render(hub.queue.getSnapshot()));
//
// Its timers and page helpers default to the browser's (`document`, `window`), optional and injectable. Its types need no DOM lib.
// Every store has `subscribe(listener)` and `getSnapshot()`, and a snapshot is the same object until something changes.

export { createHubController } from './controller.js';
export type { DecideCommand, HubController, HubControllerOptions, HubControllerSettings, HubHost, StartResult } from './controller.js';

// The store contract, and what the controller needs from its runtime
export { createStore } from './store.js';
export type { Store, WritableStore } from './store.js';
export { browserPage, browserTimers } from './env.js';
export type { ActionResult, PageSource, Timers } from './env.js';

// The live queue
export { QUEUE_MAX_PAGES, QUEUE_PAGE, createLiveQueue, visibleRows } from './liveQueue.js';
export type { Connection, LiveQueueOptions, LiveQueueState, LiveQueueStore, QueueHold } from './liveQueue.js';

// Cases and claims
export { CLAIM_BEAT_MS, TAKE_COOLDOWN_MS, VIEWING_BEAT_MS, createCaseStore } from './cases.js';
export type { CaseStore, CaseStoreOptions, ContinueOutcome, OpenCase, TakeOutcome } from './cases.js';

// Decisions
export { createDecisionStore, hasLeft, isWaiting } from './decisions.js';
export type {
  DecideOptions,
  DecisionEntry,
  DecisionHost,
  DecisionOutcome,
  DecisionState,
  DecisionStore,
  DecisionStoreOptions,
  DismissOpenOutcome,
  DismissOpenRequest,
  SubmitDecision,
} from './decisions.js';

// Toasts
export { TOAST_ERROR_MS, TOAST_HELD_MAX, TOAST_MAX, TOAST_MS, UNDO_MS, createToastStore } from './toasts.js';
export type { Hold, HoldInput, ToastInput, ToastRecord, ToastStore, ToastStoreOptions, Toasts } from './toasts.js';

// The session cache, and reads, writes and paged lists
export { SESSION_REPORTERS_MAX, SESSION_TTL_MS, createSession } from './session.js';
export type { Handoff, Session } from './session.js';
export { createAction, createPagedList, createResource } from './resources.js';
export type { ActionState, ActionStore, PagedListStore, PagedState, ResourceState, ResourceStore } from './resources.js';

// The staff client, the words, and the pure rules the stores use
export { createHubClient, fetchAll, HubError, toHubError } from '../client.js';
export type { HubClient } from '../client.js';
export { fetchTransport, routerTransport } from '../transport.js';
export type { FetchTransportOptions, RouterTransportOptions, Transport, TransportRequest, TransportResponse } from '../transport.js';
export { createT, en } from '../i18n.js';
export type { HubCatalog, HubParams, HubT, HubText } from '../i18n.js';
export { filterGroups, groupQueue, loadAiRank, nextOpenReport, queueStats } from '../queue.js';
export type { NextReport, QueueFilter, QueueGroup, QueueSort, QueueStats, RankSignals } from '../queue.js';
export { actorInitial, actorName, holderOf, liveClaim, teamOf } from '../claims.js';
export type { Holder, TeamMember } from '../claims.js';
export { emptyForm } from '../decision.js';
export type { DecisionForm } from '../decision.js';
export { absoluteTime, formatDuration, personTag, relativeTime, waitTone } from '../format.js';
export type * from '../types.js';
