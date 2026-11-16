# Coop signal: Chatwarden AI severity

A copy-in plugin for [Coop](https://github.com/roostorg/coop). It adds one numeric signal, "Chatwarden AI severity", so a Coop rule can sort reported
items by how serious your Chatwarden kit thinks the thread is.

This example is not published to npm. It is private and is not one of the kit's packages. Copy `src/index.ts` into your own plugin package.

## How it works

1. Coop asks the signal about a reported item. The signal asks Coop for the last 20 messages of the thread.
2. The plugin posts those messages to your kit at `POST /coop/signal`. Each line is `{ label, text }`. The labels are the kit's own: `reporter`,
   `reported`, `other 1`. No id of a person, a line or a report is sent.
3. The request is signed with the kit's HMAC scheme (the same one as `webhooksOut`). The kit checks the signature, the time and replays.
4. Your kit's `read` function answers a severity from 0 to 100. The plugin hands it to Coop as the signal's score.
5. If anything fails, the plugin returns no score. It never guesses.

## Set up the kit

```ts
import { coop } from '@chatwarden/http/coop';

const adapter = coop(cw, {
  // ...the usual options...
  signal: {
    secret: process.env.COOP_SIGNAL_SECRET!, // at least 32 characters
    read: async (lines) => myAiRead(lines),  // your function: lines in, a number from 0 to 100 out
  },
});
router.add(adapter.routes); // now also POST /coop/signal
```

`read` is yours. Your own AI cost limits apply inside it. The route answers `503` with an empty body when `read` throws, takes more than 8 seconds
or answers something that is not a number.

The route has one rate limit, shared by every verified request (default 60 a minute; set `signal.rateLimit` on the adapter to change it). If Coop evaluates a burst of jobs
at once, some calls can get `429`, so raise it when your Coop is busy.

## Set up Coop

1. Build the plugin: `npx tsc -p examples/coop-signal`. The output is `examples/coop-signal/dist/src/index.js`.
2. List it by local path in Coop's `integrations.config.json`. A local package is a path relative to that file:

   ```json
   { "integrations": [{ "package": "../chatwarden-coop-signal", "enabled": true }] }
   ```

3. Open the integration in Coop's settings and fill the form: the kit URL (for example `https://game.example.com`) and the secret. The secret is
   a password field. Never put it in `integrations.config.json`.

## Not confirmed yet

This was written from Coop's public docs, not run against a Coop. These are checked in the owner's local end-to-end run:

- The exact shape `createSignals` returns, and whether Coop wants a model card.
- The shape of the input `run` receives, and of a "disabled" answer.
- Whether a report job evaluates signals when a rule routes it.
- The name of the types package. Coop's docs say `@roostorg/coop-types`; its example plugin imports `@roostorg/types`. This file declares the types
  it needs and imports neither.

The plugin tests run the real kit route (`coop(cw, { signal })`) behind a scripted `fetch`. No network is used.
