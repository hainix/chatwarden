# @chatwarden/discord

Posts the Chatwarden staff review queue into a Discord forum channel, through a channel webhook. Each reported person gets
one forum thread, and every later report, decision, timeout and lifted sanction for that person is posted into it, so
moderators can discuss a case where it is.

It is one function, `discordFeed`. It listens to the kit's events (`cw.on`) and posts. It reads nothing from Discord and has no
buttons: a webhook can only write.

Status: pre-release, as-is, no support promise.

## Install

```sh
npm install @chatwarden/discord @chatwarden/core
```

Node 22.13 or newer. No other dependencies; it uses the global `fetch`.

## Set up

### 1. Make the webhook

1. In Discord, create a **forum channel** for moderation (a private one, visible to your moderators only).
2. Open the channel's settings, then **Integrations**, then **Webhooks**, then **New Webhook**. Name it.
3. Click **Copy Webhook URL**. It looks like `https://discord.com/api/webhooks/<id>/<token>`.

The URL is a credential: anyone who has it can post to the channel. Keep it in an environment variable or a secret store, not
in your repository. The package never logs it.

For `mentionRoleId`, turn on Developer Mode in Discord's advanced settings, right-click the role and choose **Copy Role ID**.

### 2. Start the feed

```ts
import { discordFeed } from '@chatwarden/discord';

const feed = discordFeed(cw, {
  webhookUrl: process.env.DISCORD_WEBHOOK_URL!,
  // Where staff land when they click: a page in YOUR moderator console for a report or a person.
  hubLink: (kind, id) =>
    kind === 'report'
      ? `https://mod.example.com/reports/${encodeURIComponent(id)}`
      : `https://mod.example.com/people/${encodeURIComponent(id)}`,
  mentionRoleId: process.env.DISCORD_MENTION_ROLE_ID, // optional: pinged on severe reports and sanctions only
  severeOnly: false, // optional
});

// on shutdown
feed.dispose();
```

`cw` is what `createChatwarden` returned. If you also mount `@chatwarden/http`, `hubLink` can point at its staff routes (for
example `GET /admin/reports/:id`), or at your own console page that calls them.

The call checks everything once. A bad webhook URL, role id or option throws `RangeError` (the message never repeats the value)
and subscribes nothing.

## Options

| Option | Type | What it does |
| --- | --- | --- |
| `webhookUrl` | `string` | The forum channel's webhook. `https:` on `discord.com` or `discordapp.com` (also the `ptb.` and `canary.` hosts), path `/api/webhooks/<id>/<token>`, no port or credentials. Required. |
| `hubLink` | `(kind: 'report' \| 'person', id: string) => string` | Builds the links in each post. Required. The id is the only place an id appears in a post (see below). A result that is not an `http(s)` URL, one over 512 characters, or a throw drops that one link and keeps the post. |
| `mentionRoleId` | `string` | A Discord role id (17 to 20 digits) to ping on a severe report or a severe sanction. Nothing else ever pings anyone. |
| `severeOnly` | `boolean` | Post only severe reports, their closing, severe sanctions and the lift of a sanction under a severe rule. Skips automatic timeouts and rule gaps. Default `false`. |
| `fetch` | `typeof fetch` | The `fetch` to post with. Default: the global one. For tests. |
| `logger` | `{ warn(event, detail?) }` | Where failures are logged. Default `console.warn`. |
| `clock`, `random` | | Time source and retry jitter. For tests. |

**What counts as severe.** A report in category `hate`, or a report or sanction whose Community Rule is in
`cw.profile.severeRules` (by default Community Rule 1). Only severe posts carry the role ping.

**What a post says.** Plain staff text: the kind of event, the category, the Community Rule (number and title), the conduct level
when the report carries one, the reference code, the length of a sanction, and the links. Examples: `**New report**`,
`**Report closed** · Upheld`, `**Sanction applied** · Chat restriction · 24 hours`, `**Automatic timeout** · 30 minutes`,
`**Lifted**`, `**Rule gap filed** for review`.

**Delivery.** One queue, one request at a time (a webhook's rate limit is shared), so a thread is created exactly once and a
person's posts stay in order. A 429 waits the time Discord names (0.5 to 60 seconds). A 5xx or a network error is retried 5
times after 1, 2, 4, 8 and 16 seconds. Each request times out at 10 seconds. The queue is in memory and holds 1000 waiting
events; past that the oldest is dropped, and the drops are logged as a count (`chatwarden.discord_dropped`). Dropped hub links
are logged the same way (`chatwarden.discord_link_dropped`, with the link kind, a reason and a count, at most one line a minute
for each). A restart loses what is queued.

## Security notes

- **No chat text, ever.** A post holds no chat line, handle, reporter note, moderator reason or evidence, and no AI output.
  Rule titles are the only adopter text; they are cut, put on one line and escaped so they cannot format a post or ping anyone.
- **Subject ids appear only inside the hub links.** The visible words of a post name no one. A thread is named `Case XXXXX`
  with 5 random characters that are not derived from any id, hash or handle. A link's URL carries the id, so anyone who can see
  the forum can see ids: keep the channel private to staff, and have your console check the viewer's login when a link is opened.
- **Pings are fenced.** Every post sends `allowed_mentions` with `parse: []`, so `@everyone`, `@here` and user mentions in any
  text do nothing. Only `mentionRoleId`, on a severe post, is allowed through. Link previews are suppressed.
- **The webhook URL is a credential.** It is validated once, kept in memory, and never logged. Failures are logged as an
  operation name, an HTTP status or an error class, and a count.
- **A listener cannot hurt the kit.** Every handler is fenced: a throw or a rejection (the network, the store, your `hubLink`)
  is logged by class and goes no further, so moderation never fails because Discord did.

## Known limits

- **A duplicate thread is possible.** "One thread per person" holds unless Discord creates a thread and the answer is lost (a
  timeout, a dropped connection, an unreadable reply), or the process dies between Discord's answer and the store write. A
  webhook post has no idempotency key, so the create is retried (or the next event opens another thread) under a new label,
  and the person ends up with two threads. Staff can delete the extra one. A deleted thread is replaced once, under the same
  label.
- **`kit_discord_threads` is not purged.** The map from person to thread lives in the store table `kit_discord_threads`. Its rows
  hold subject ids (staff-only) and are not removed by `purge()`. Whatever deletes a person's data must delete their row there
  too. After two people are merged, the canonical person's thread is used; an alias's thread is reused and the map repointed.
- **Events are announced after the fact.** If the process stops before an event is posted, that post is lost. The staff API
  still has the report.
- **One webhook, one channel.** Each `discordFeed` posts to one forum. Run two feeds for two channels (for example one with
  `severeOnly: true`).
- **It cannot read Discord.** A decision made in Discord is not seen by the kit; decide through your console or the staff API.
