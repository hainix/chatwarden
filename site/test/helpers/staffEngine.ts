// The tests of the kit behind the demo look at the staff's side of it (the report as a moderator reads it, a decision) directly. The
// page does not: its moderator is the real hub, over the staff routes. So this engine adds the few staff calls the tests use.
import type { DecisionInput, DecisionResult, StaffReport } from '@chatwarden/core';
import type { ReportPage } from '@chatwarden/core';
import { DEMO_ACTOR, KitEngine } from '../../src/demo/kitEngine';

export class StaffEngine extends KitEngine {
  readonly staff = {
    get: async (id: string): Promise<StaffReport | null> => (await this.kit()).reports.get(id),
    list: async (query: { status?: StaffReport['status'] } = {}): Promise<ReportPage> => (await this.kit()).reports.list(query),
    /** A moderator's decision, as the staff route sends it: the demo's made-up owner. A store failure rejects. */
    decide: async (input: Omit<DecisionInput, 'actor' | 'source'>): Promise<DecisionResult> =>
      (await this.kit()).decide({ ...input, actor: DEMO_ACTOR, source: 'moderator' }),
  };
}
