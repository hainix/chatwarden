import { bool, given, plain, wholeIn } from './settingsCheck.js';
import { ProfileError } from './profileError.js';

// The room settings: how long a lock or an emergency lasts, what emergency adds, probation for new accounts, and what an account with
// no known age is treated as. Pure data and validation; the modes themselves are roomModes.ts. A mode never writes a sanction.

/**
 * What an emergency adds to a room's pace. Every field optional on input.
 */
export interface EmergencySettings {
  /** The least time between one player's lines while the room is in emergency, ms, 1 000 to 600 000. Default 30 000. */
  slowModeMs?: number;
  /** Accounts younger than this many days can only read in an emergency, 0 to 30; 0 is off. Default 7. */
  newAccountDays?: number;
}

/**
 * Probation: new accounts chat slower. Every field optional on input.
 */
export interface ProbationSettings {
  /** Default false. */
  enabled?: boolean;
  /** An account younger than this many days is on probation, 1 to 30. Default 2. */
  ageDays?: number;
  /** The least time between a probationer's lines, ms, 500 to 600 000. Default 5 000. */
  slowModeMs?: number;
}

/** The modes of a room: ordinary, locked (read-only except staff) and emergency (slower, new accounts read-only). Every non-normal mode expires. */
export const ROOM_MODES = ['normal', 'locked', 'emergency'] as const;
export type RoomMode = (typeof ROOM_MODES)[number];

/** What an account whose age is unknown is treated as by probation and emergency. */
export type UnknownAge = 'allow' | 'treat_as_new';

/**
 * How rooms behave under attack. Every field optional.
 */
export interface RoomsSettings {
  /** How long a lock or emergency lasts when the caller names no length, ms, 60 000 to 86 400 000. Default 1 800 000 (30 minutes). */
  defaultModeMs?: number;
  emergency?: EmergencySettings;
  probation?: ProbationSettings;
  /** Default `'allow'`. */
  unknownAge?: UnknownAge;
}

/**
 * What the kit reads: every field filled in.
 */
export interface ResolvedRooms {
  defaultModeMs: number;
  emergency: { slowModeMs: number; newAccountDays: number };
  probation: { enabled: boolean; ageDays: number; slowModeMs: number };
  unknownAge: UnknownAge;
}

const KEYS = ['defaultModeMs', 'emergency', 'probation', 'unknownAge'] as const;
const EMERGENCY_KEYS = ['slowModeMs', 'newAccountDays'] as const;
const PROBATION_KEYS = ['enabled', 'ageDays', 'slowModeMs'] as const;

/**
 * Validate and fill. Throws ProfileError naming the field (`rooms.emergency.slowModeMs`), never echoing the value. `path` names the
 * settings in the error (default `rooms`). The result is a new object that shares nothing with the input; each value is read once.
 */
export function resolveRooms(input: RoomsSettings | undefined, path = 'rooms'): ResolvedRooms {
  const out: ResolvedRooms = {
    defaultModeMs: 1_800_000,
    emergency: { slowModeMs: 30_000, newAccountDays: 7 },
    probation: { enabled: false, ageDays: 2, slowModeMs: 5000 },
    unknownAge: 'allow',
  };
  if (input === undefined) return out;
  const o = plain(input, KEYS, path);
  const defaultModeMs = given(o, 'defaultModeMs');
  if (defaultModeMs !== undefined) out.defaultModeMs = wholeIn(defaultModeMs, 60_000, 86_400_000, `${path}.defaultModeMs`);
  const emergency = given(o, 'emergency');
  if (emergency !== undefined) {
    const ep = `${path}.emergency`;
    const e = plain(emergency, EMERGENCY_KEYS, ep);
    const slowModeMs = given(e, 'slowModeMs');
    if (slowModeMs !== undefined) out.emergency.slowModeMs = wholeIn(slowModeMs, 1000, 600_000, `${ep}.slowModeMs`);
    const newAccountDays = given(e, 'newAccountDays');
    if (newAccountDays !== undefined) out.emergency.newAccountDays = wholeIn(newAccountDays, 0, 30, `${ep}.newAccountDays`);
  }
  const probation = given(o, 'probation');
  if (probation !== undefined) {
    const pp = `${path}.probation`;
    const p = plain(probation, PROBATION_KEYS, pp);
    const enabled = given(p, 'enabled');
    if (enabled !== undefined) out.probation.enabled = bool(enabled, `${pp}.enabled`);
    const ageDays = given(p, 'ageDays');
    if (ageDays !== undefined) out.probation.ageDays = wholeIn(ageDays, 1, 30, `${pp}.ageDays`);
    const slowModeMs = given(p, 'slowModeMs');
    if (slowModeMs !== undefined) out.probation.slowModeMs = wholeIn(slowModeMs, 500, 600_000, `${pp}.slowModeMs`);
  }
  const unknownAge = given(o, 'unknownAge');
  if (unknownAge !== undefined) {
    if (unknownAge !== 'allow' && unknownAge !== 'treat_as_new') throw new ProfileError(`${path}.unknownAge`, "must be 'allow' or 'treat_as_new'");
    out.unknownAge = unknownAge;
  }
  return out;
}
