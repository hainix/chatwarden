import { describe, expectTypeOf, it } from 'vitest';
import type { EffectCode, NoticeOp, NoticePlan, PlanAction, PlanContext, PlanLine, PlannedNotice } from '../src/noticeCopy.js';

// Review Focus 1: the plan's input has no moderator-only field. A leak needs a type change, which a reviewer sees.

type Forbidden = 'reason' | 'evidence' | 'gapNote' | 'actor' | 'ref' | 'staffRef' | 'groupId' | 'includeIp' | 'ip' | 'ai' | 'statement' | 'note' | 'sanctionId' | 'modNote';

/** Every key at any depth of a type's object members, as a union. */
type KeysDeep<T> = T extends readonly (infer U)[]
  ? KeysDeep<U>
  : T extends (...args: never[]) => unknown
    ? never
    : T extends object
      ? { [K in keyof T & string]: K | KeysDeep<T[K]> }[keyof T & string]
      : never;

describe('types: the plan input and context carry no moderator-only field', () => {
  it('the op has no reason, evidence, gapNote, actor, ref, groupId, includeIp, ai or statement field at any depth', () => {
    expectTypeOf<Extract<KeysDeep<NoticeOp>, Forbidden>>().toEqualTypeOf<never>();
    expectTypeOf<Extract<KeysDeep<PlanAction>, Forbidden>>().toEqualTypeOf<never>();
    expectTypeOf<Extract<KeysDeep<PlanContext>, Forbidden>>().toEqualTypeOf<never>();
    expectTypeOf<Extract<KeysDeep<PlanLine>, Forbidden>>().toEqualTypeOf<never>();
  });

  it('a line is only text and day; an action is a person, a kind, a length, a rule and lines', () => {
    expectTypeOf<keyof PlanLine>().toEqualTypeOf<'text' | 'day'>();
    expectTypeOf<keyof PlanAction>().toEqualTypeOf<'person' | 'kind' | 'durationMs' | 'rule' | 'lines'>();
  });

  it('the decide op has exactly the documented fields', () => {
    type Decide = Extract<NoticeOp, { op: 'decide' }>;
    expectTypeOf<keyof Decide>().toEqualTypeOf<'op' | 'verdict' | 'target' | 'reporter' | 'actions' | 'rename'>();
    expectTypeOf<Decide['rename']>().toEqualTypeOf<{ rule: number } | null>();
  });

  it('the control: the probe sees a forbidden key when one is there', () => {
    type Leaky = { op: 'x'; nested: Array<{ reason: string }> };
    expectTypeOf<Extract<KeysDeep<Leaky>, Forbidden>>().toEqualTypeOf<'reason'>();
  });

  it('the plan and its notices expose only what the player may read, plus the recipient and the effects', () => {
    expectTypeOf<keyof NoticePlan>().toEqualTypeOf<'notices' | 'effects' | 'nothing'>();
    expectTypeOf<keyof PlannedNotice>().toEqualTypeOf<'to' | 'notice'>();
    expectTypeOf<Extract<KeysDeep<EffectCode>, Forbidden>>().toEqualTypeOf<never>();
    expectTypeOf<NoticePlan['nothing']>().toEqualTypeOf<'note' | 'dismissal' | 'direct' | null>();
  });
});
