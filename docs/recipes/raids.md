# Raids: lock, emergency, retraction and probation

A guide for the person who runs the game's moderation. A raid is many accounts flooding a room faster than anyone can act. Chatwarden gives a moderator four tools and one hint. None of them
is a sanction: nobody is told, nobody is struck, and every mode ends by itself.

This is not legal advice, and the kit does not decide who is attacking. A person decides.

## The modes

`cw.rooms.setMode(roomId, mode, { forMs })` puts a room in `normal`, `locked` or `emergency`. The hub's Settings, Advanced, "Rooms" panel and a case's `...` menu do the same.

- **Locked.** A line from anyone except a staff member is refused with the reason `locked` and the time the lock ends. Who is staff is your word: the `staff: true` your `join` hook gives a
  `ChatMember`, or `{ staff: true }` on `cw.chat.accept`. A game that sets it for everyone has no lock.
- **Emergency.** Slow mode at `rooms.emergency.slowModeMs` (the stricter of it and the room's own pace), and accounts younger than `rooms.emergency.newAccountDays` can only read (refused
  `new_account`, with the end time). If the filter theme's "links off" is present it joins; without it emergency is slow mode and read-only new accounts.
- **Every mode expires.** `forMs` is 60 seconds to 24 hours, else `rooms.defaultModeMs` (30 minutes). There is no "until I turn it off". Setting a mode again replaces the earlier one and
  restarts the clock. `normal` clears at once. `cw.rooms.close(roomId)` clears a room's mode.
- **A mode is checked before the matcher.** A line refused for the mode is never matched, so a slur in a locked room earns no strike and no automatic timeout.

## Retraction: take a line back

`cw.rooms.retract(roomId, lineId, { allFromAuthor })` marks a delivered line removed for everyone and keeps it as evidence. With `allFromAuthor: true` it also removes every delivered line of
the same occupant still in the evidence buffer (the spam wave). It works only while the line is in the evidence buffer: 15 minutes and 100 lines a room; after that it is `not_found`.

The kit raises `line.retracted`. The room broadcaster in `@chatwarden/http` listens, sends a `retract` frame to every stream and drops the text from its history, so a new joiner never sees
it. A game on its own socket listens to the same event. A report on a retracted line is still valid, and a report already filed keeps the text it holds. A retraction says nothing to the author.

## Probation for new accounts

With `rooms.probation.enabled`, an account younger than `ageDays` (from your `signals.accountAgeDays` hook) is paced at least `slowModeMs` between lines in every room, whatever the room's own
pace says. It is a pause: no rule, no notice, no strike. With no hook, or an age the hook cannot tell, `rooms.unknownAge` decides (`allow` by default). Have the hook answer the **oldest**
age across a person's accounts, so a veteran on a new alt is not slowed.

## The surge hint

With `desk.surge.enabled`, a case that has had at least `reports` reports from many players inside `windowMinutes` shows one line: "12 reports in 10 minutes from 12 players, 10 of them
accounts under 2 days old." with the hint "A hint, not a reason to set reports aside." It appears on the case only, never in the queue, and changes no order. A report from a new account
is as valid as any.

## Per process, and a restart

A mode lives in the memory of the process that serves the room, like pace. A game with several processes sets it in the process that holds the room, or calls it in each. A restart forgets
every mode and every probation cache. A game that wants a lock to survive a restart sets it again from its own start-up. The "Rooms" panel says "This server only" for this reason, and
lists at most 500 rooms.

## What you wire

1. Mark staff in your `join` hook (`staff: true`), never from anything the player sent.
2. Mount the broadcaster in `@chatwarden/http` so `mode` and `retract` frames reach your players' chat box (chat wire version 2).
3. Give moderators `rooms.manage` (a moderator by default; raise it with the `permissions` option if you want it to be a senior's).
4. Test a lock in a staging room before you need it.
