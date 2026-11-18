# A weekly digest of how the team is doing

A guide for the person who runs the game's moderation. The Insights page and the digest hold the same numbers: reports filed, decided and open, urgent ones, the median time to a decision
beside the longest wait. Counts and times only. They never name a moderator, a player or a line, and there is no per-person figure. The kit does not decide anything from them.

This is not legal advice. The digest is a summary for your team; it contacts no one and promises no response time.

## Turn it on

Insights is off until the owner turns it on (`desk.insights`, in Settings, Advanced, "The desk"). While it is off the route answers 404 and the digest is empty. Turning it on also starts a
daily line counter (a date and two counts) that feeds the report rate; it holds no player data.

## The kit has no scheduler

`cw.insights.digest(days)` returns the numbers. `cw.insights.emitDigest(days)` raises the `insights.digest` event with the same numbers, and `feed.postDigest(days)` in
`@chatwarden/discord` posts them to your staff channel. Nothing calls them for you: you call them from your own timer or cron, once a week.

A timer in the game server:

```ts
setInterval(() => cw.insights.emitDigest(7), 7 * 24 * 60 * 60 * 1000).unref();
```

A cron job that calls an internal route of your own, which calls `cw.insights.emitDigest(7)` or `feed.postDigest(7)`. Either way, the kit's side is one call. A restart forgets the interval,
so a cron job is the sturdier choice; call `cw.insights.flush()` (or `cw.close()`) before the process stops so the day's line counter is written.

## Where the digest goes

- The Discord feed: `feed.postDigest(7)` posts one message of counts and times to the staff channel, and says it was queued.
- A webhook endpoint subscribed to `insights.digest`: the body carries the numbers and nothing else.
- Your own code: `cw.on('insights.digest', ...)` gets the digest object.

## What is in it

Reports filed, decided and open; urgent reports filed and open; the median and the 90th percentile of the team's time to a decision (`null` below five decided reports); the longest wait of a
report still open. The window is 7, 30 or 90 days. There is no export in 0.2.0.

## Who should read it

Read the median and the longest wait together. A median alone invites speed over care, and the kit shows both on purpose. Do not use the digest to rank people: it cannot, and nobody should.
