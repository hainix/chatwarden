import { describe, expect, it } from 'vitest';
import type { Store } from '@chatwarden/core';

// The contract of the Discord thread-map methods of the Store. One suite, run against every Store (MemoryStore and
// SqliteStore) so "both stores agree" is enforced, not just observed.

const ROW = { subject: 's_aaaaaaaaaaaaaaaaaaaaaa', threadId: '111222333', label: 'Case 7K2QX', createdAt: 1_800_000_000_000 };

export function discordThreadsContract(name: string, make: () => Store): void {
  describe(`discord threads contract: ${name}`, () => {
    it('an unknown subject has no thread', () => {
      expect(make().getDiscordThread('s_nobody')).toBeNull();
    });

    it('put then get returns the row', () => {
      const s = make();
      s.putDiscordThread(ROW);
      expect(s.getDiscordThread(ROW.subject)).toEqual(ROW);
    });

    it('put on the same subject replaces the thread id, label and time (repointing)', () => {
      const s = make();
      s.putDiscordThread(ROW);
      s.putDiscordThread({ ...ROW, threadId: '999', label: 'Case ABCDE', createdAt: ROW.createdAt + 5 });
      expect(s.getDiscordThread(ROW.subject)).toEqual({ ...ROW, threadId: '999', label: 'Case ABCDE', createdAt: ROW.createdAt + 5 });
    });

    it('subjects are independent, and two subjects may share a thread (an alias repointed at its canonical person)', () => {
      const s = make();
      s.putDiscordThread(ROW);
      s.putDiscordThread({ ...ROW, subject: 's_bbbbbbbbbbbbbbbbbbbbbb' });
      expect(s.getDiscordThread('s_bbbbbbbbbbbbbbbbbbbbbb')?.threadId).toBe(ROW.threadId);
      s.putDiscordThread({ ...ROW, subject: 's_bbbbbbbbbbbbbbbbbbbbbb', threadId: '5' });
      expect(s.getDiscordThread(ROW.subject)?.threadId).toBe(ROW.threadId);
    });

    it('the reserved shared-thread keys are plain keys', () => {
      const s = make();
      s.putDiscordThread({ ...ROW, subject: '__unattributed__', label: 'Unattributed reports' });
      expect(s.getDiscordThread('__unattributed__')?.label).toBe('Unattributed reports');
    });

    it('is case-sensitive', () => {
      const s = make();
      s.putDiscordThread(ROW);
      expect(s.getDiscordThread(ROW.subject.toUpperCase())).toBeNull();
    });

    it('a put inside a rolled-back transaction leaves nothing behind', () => {
      const s = make();
      expect(() =>
        s.transaction(() => {
          s.putDiscordThread(ROW);
          throw new Error('boom');
        }),
      ).toThrow('boom');
      expect(s.getDiscordThread(ROW.subject)).toBeNull();
    });

    it('a repointing put inside a rolled-back transaction restores the earlier row', () => {
      const s = make();
      s.putDiscordThread(ROW);
      expect(() =>
        s.transaction(() => {
          s.putDiscordThread({ ...ROW, threadId: 'other' });
          throw new Error('boom');
        }),
      ).toThrow('boom');
      expect(s.getDiscordThread(ROW.subject)).toEqual(ROW);
    });
  });
}
