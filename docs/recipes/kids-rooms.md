# Kids rooms: phrase-only chat and a strict pace

A guide for the person who runs the game's moderation. A room for young players can be a room where nobody types: a player picks a line from a list the game wrote, and the room goes at a slower
pace than the rest of your game. Chatwarden gives you the room type (a context), the phrase list and the checks. It does not know who is a child.

This is not legal advice. Rules about children's data and children's chat differ by place, and the kit does not decide which apply to you. Ask your own counsel.

## What the kit does

A **context** is a named set of chat-time rules, declared in code (`profile.contexts`, the `overrides.contexts` option of `createChatwarden`) and chosen for a room by a tag when the room is seated.
A context can set the profanity handling, the pace (`slowModeMs` and the rest), the chat filters and `chat.phrases`, the id of a phrase book. It cannot change the ladder, the reporting reasons, the
appeals or the names: those stay the game's one policy.

- **Phrase-only chat.** In a room whose context sets `chat.phrases`, typed text is refused `phrases_only`, and `cw.chat.acceptPhrase(room, seat, id)` delivers one phrase of the book. An id the
  book lacks is `phrase_unknown`. The line is kept as evidence with the phrase's own text, so a report about it shows what the player picked.
- **A strict pace.** The context's `pace` is the room's pace, over the base profile and the hub's stored settings. `cw.rooms.setPace` for one room still wins.
- **A minimum account age.** `chat.minAccountAgeDays` refuses a younger account, a guest, or an account whose age your `signals.accountAgeDays` hook cannot tell, with `account_too_new`.
- **A typo fails shut.** A room tagged with a context the profile does not declare refuses every line `gate` and logs one `chatwarden.context_unknown` for the room, so a typo in the context name fails shut instead of falling back to the relaxed rules.
- **The same safety net.** Reports, mutes, blocks, restrictions, the urgent lane and the hub work in a kids room as in any other. Staff can see every room.

## What is yours

- **Age.** The kit never learns how old a player is. It has an account age (how long the account has existed, from your hook), and an account age is not a person's age. Whether someone is a child, how you
  know it, and what you may do with that are yours: your login, your parental consent flow, your counsel.
- **Which rooms are kids' rooms.** Which rooms are kids' rooms is your decision, and your code makes it: you tag the room, the kit reads the tag. Nothing in the kit moves a player into or out of one.
- **The words.** The kit ships no phrase text. You write every phrase, and each one must be fine for every room that uses the book. At start-up each phrase is run through the matcher and every
  profanity filter in force, and a hit stops the start with an error that names the book and the id, never the text.
- **Other languages.** Give each viewer's own catalogue a `phrase.<id>` entry per phrase; the chat box shows it in place of the text you sent, and falls back to your text when a key is missing.

## What you wire

The snippets use the memory store so they run as written. Use `@chatwarden/store-sqlite` and a stable secret in a game.

```ts
import { createChatwarden, type Platform } from '@chatwarden/core';
import { createMemoryStore } from '@chatwarden/store-memory';
```

The book, declared once: an id and the text for each phrase, and an optional `group` the chat box uses as a heading.

```ts
const phrases = {
  junior: [
    { id: 'gg', text: 'Good game!' },
    { id: 'help', text: 'Can you help me?', group: 'Ask' },
  ],
};
```

The context, and the kit with both. A context names its book; a book no context names is allowed and unused.

```ts
const platform: Platform = { identify: (ctx) => ({ clientKey: String(ctx) }) };
const kids = { label: 'Kids rooms', pace: { slowModeMs: 3000 }, chat: { phrases: 'junior' } };
const cw = await createChatwarden({ store: createMemoryStore(), secret: 'a-long-random-secret-for-this-run', platform, phrases, overrides: { contexts: { kids } } });
```

Your rule decides which rooms are kids' rooms, and the room carries the answer as its `context` tag.

```ts
const roomId = 'room-1';
const tags = isKidsRoom(roomId) ? { context: 'kids' } : undefined; // your rule, your data
cw.rooms.seat(roomId, 'seat-1', { clientKey: 'player-1' }, 'Mia', tags);
const typed = cw.chat.accept(roomId, 'seat-1', 'hello there'); // refused `phrases_only` in a kids room
const picked = cw.chat.acceptPhrase(roomId, 'seat-1', 'gg'); // delivers "Good game!" with `phrase: 'gg'`
```

1. In a game with a chat box, mount `chatRoutes` and `createRoomBroadcaster` from `@chatwarden/http` (`POST /rooms/:room/phrases` sends a phrase, and `hello.phrases` carries the book), and
   `ChatBox` from `@chatwarden/player-react/chat`: in a kids room it shows a phrase picker in place of the input.
2. Tag the room at `cw.rooms.seat` and nowhere else. A room's `context` cannot change while the room is open.
3. Read `cw.contexts.of(roomId)` and `cw.contexts.effective('kids')` in a test, and try a typed line and a phrase in a staging room before you open it.
4. Set `chat.minAccountAgeDays` only if you have the `accountAgeDays` hook; without it every account is too new.

## What it does not do

It does not detect a child or an adult, and it does not make a room safe by itself: a phrase list takes away typed text, not the other things a player can do in your game. It does not
promise a response time on a report. For a report that involves a child in danger, follow the urgent guide, [urgent-and-welfare.md](urgent-and-welfare.md).
