// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { AUDIT_ACTIONS } from '@chatwarden/core';
import { ACTION_LABEL } from '../src/auditLabel.js';
import { en } from '../src/i18n.js';

// The eight audit actions of the urgent lane, the desk and the rooms, and the room target, in plain words.

const EIGHT = ['report.urgent', 'report.handoff', 'report.comment', 'report.comment_remove', 'report.escalate', 'room.mode', 'room.retract', 'insights.view'] as const;

describe('the hub labels the eight actions', () => {
  it('each has a catalog key and plain words, never the raw action name, never a person, a line or a note', () => {
    for (const action of EIGHT) {
      expect(AUDIT_ACTIONS, action).toContain(action);
      const key = ACTION_LABEL[action];
      const words = (en as Record<string, string>)[key];
      expect(words, action).toBeTypeOf('string');
      expect((words ?? '').length, action).toBeGreaterThan(8);
      expect(words, action).not.toBe(action);
      expect(words, action).not.toMatch(/report\.|room\.|insights\./);
    }
  });

  it('the words say what was done', () => {
    expect(en['hub.audit.label.report.urgent']).toBe('Changed whether a report is urgent');
    expect(en['hub.audit.label.report.handoff']).toBe('Marked a report as passed to the safety team');
    expect(en['hub.audit.label.report.comment']).toBe('Commented on a report');
    expect(en['hub.audit.label.report.commentRemove']).toBe('Removed a comment from a report');
    expect(en['hub.audit.label.report.escalate']).toBe('Asked for a second look at a report');
    expect(en['hub.audit.label.room.mode']).toBe('Changed the mode of a room');
    expect(en['hub.audit.label.room.retract']).toBe('Removed a line from a room');
    expect(en['hub.audit.label.insights.view']).toBe('Viewed Insights');
  });

  it('the eight labels are all different from each other and from every earlier label', () => {
    const words = EIGHT.map((a) => (en as Record<string, string>)[ACTION_LABEL[a]]);
    expect(new Set(words).size).toBe(8);
    const earlier = AUDIT_ACTIONS.filter((a) => !(EIGHT as readonly string[]).includes(a)).map((a) => (en as Record<string, string>)[ACTION_LABEL[a]]);
    for (const w of words) expect(earlier).not.toContain(w);
  });

  it('the room target has words of its own', () => {
    expect(en['hub.audit.target.room']).toBe('Room {room}');
  });
});
