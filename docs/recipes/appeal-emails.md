# Appeal links and emails to your players

A guide for the person who runs the game's moderation and the developer who wires it. When a player is sanctioned, the kit can hand your game the words of the notice and a link where the player
can read the decision and ask for a second look. Your game sends the email. This guide says what the kit gives you, what a good email says, and what to keep safe.

This is not legal advice. Whether you may email a player, what you must say and how long you may keep it depends on where your players are, and the kit does not decide which rules apply to you. Ask your own counsel.

## What the kit does and does not do

The kit hands over the words and the link. **The kit never sends email and never stores an email address.** It has no mail server, no address book and no way to contact a player: it calls a function of yours,
once, after a decision is committed, and what happens next is yours.

- It calls your hook for a sanction (a moderator's decision, or the automatic restriction from the slur list) and for the outcome of an appeal. A replayed decision delivers nothing.
- The call carries an account id, because that is what your game gave the kit. An email is only possible for a person the kit holds an account id for. For a guest who was only ever seen by a client key or an address,
  nothing is delivered and the kit logs `chatwarden.delivery_skipped_no_account` (at most once a minute, with a count). That player still gets the notice in your game, and its `appealUrl`, as before.
- The message holds no line the player wrote, no chat excerpt, no moderator, no private reason and no other person.

## Turn it on

Appeals must be enabled in the profile for `/appeal` to show: `appeals.enabled` is off by default, and while it is off the landing routes answer as if they did not exist. Then tell the kit where the page lives and give it your hook:

- `createChatwarden({ appeals: { landingUrl, landingOrigins }, notices: { deliver, localeOf } })`. `appeals.landingUrl` is the page's address (for example `https://game.example/appeal`, served by `playerRoutes` or `chatwarden serve`). The kit adds `?t=<token>` to make a link.
  `landingOrigins` lists the origins of your own pages that may read the case as JSON (leave it out when the served page is all you use). Both are code or environment, never the profile.
- In the profile: `appeals.linkTtlMs` (how long a link works, one hour to 365 days, default 30 days, and never longer than the sanction stays appealable), `appeals.contact` (one line shown on the page, such as a support address),
  `appeals.emailsOutcome` (the page then says "We will email you when it is decided", so set it only when your hook really does) and `appeals.words` (your own wording by language).
- `notices.localeOf({ accountId })` picks the language of a message (`es-MX`, `pt-BR`; nothing is English).

## The hook

The `notices.deliver` option of `createChatwarden` (with `notices.localeOf` beside it) is your hook: `notices.deliver(d)` gets a `NoticeDelivery`: `kind` (`sanction` or `appeal_outcome`), `noticeId`, `to.accountId`, `locale`, `subject`, `text`, `html`, `appealUrl` and the `sanction` it is about. The subject, text and html are ready to send, in the
player's language, with the link in them. Look the address up in your own account system with `d.to.accountId`, and send through whatever mail function you already have:

```ts
import type { NoticeDelivery } from '@chatwarden/core';
export async function deliver(d: NoticeDelivery): Promise<void> {
  if (d.kind === 'sanction' && d.sanction.automated && d.sanction.until !== null && d.sanction.until - Date.now() < 3_600_000) return;
  const to = await emailOf(d.to.accountId);
  if (to !== null) await sendMail({ to, subject: d.subject, text: d.text, html: d.html });
}
```

`emailOf` is yours, and so is `sendMail({ to, subject, text, html })`. The example skips the first email for a short automatic restriction (`d.kind === 'sanction'`, `d.sanction.automated`, `d.sanction.until`): an hour-long timeout does not need an email, and you decide where that line is. An outcome is always sent: for `appeal_outcome` the `sanction` is the original one, and a player who was told "we will email you when it is decided" (`appeals.emailsOutcome`) must get that email.
Never log `d`: it holds the link, and the link is a capability. The hook is not awaited and a throw is logged by class only, so it never holds up or fails a sanction. `d.noticeId` is the stable key for dedupe and for a retry of your own. The kit calls the hook once per
notice and has no retry or queue of its own: a hook that fails, or a process that stops before it runs, loses that call. So make the hook durable on your side (put the mail in your own queue) and let the player ask again from the game.

## What a good appeal email says

Write it for a person who is upset and has ten seconds.

- **What happened,** in plain words: "You were restricted from chat", not "Violation 4.2".
- **Until when:** the end date and time, with the time zone, or that it has no end.
- **The rule,** by its number and title, so the player knows what it was about.
- **The link,** once, with a plain line that says it opens the decision and the form for a second look.
- **A way to reach a person,** your support address, for a player who cannot use the link or wants to say something else.
- **No blame:** say what was decided, not what kind of person the player is. No mention of who decided it, and no excerpt of the chat.

What it must not do: it does not promise an outcome ("we will review it" is true, "we will lift it" is not), it does not include the private reason a moderator wrote, and it does not name another player or a reporter. The text the kit writes follows these rules; if you
write your own, hold to them.

A game that does not want an email for every automatic timeout sets `deliverAutomatic: false` in `notices` (`CHATWARDEN_DELIVER_AUTOMATIC=0` in service mode): a moderator's sanction and every appeal outcome are still delivered.

## The link is a capability

The link is a capability for one sanction: anyone who holds it can read that one sanction and file one appeal. It is not a login, it names no account, and it opens nothing else. It stops working when it expires
(`appeals.linkTtlMs`), when the sanction ends, or when the appeal is moot (the sanction is gone or was replaced). A decided appeal's link keeps showing the outcome until it expires. Treat it like a password reset link:

- **Keep query strings out of your access logs,** and out of the click-tracking of your mail service: the token is in the query string (`?t=`). The served page sends no referrer, and sets `cache-control: no-store`, but a proxy that logs full URLs keeps the token.
- Never post it in a public channel, a ticket that many people read or an analytics event.
- Switching appeals off breaks every mailed link: the landing routes then answer as if they did not exist, so leave them on for as long as you have mail out. While they are on, the link of a decided appeal still shows the outcome until it expires.

## The banned screen

A player who is banned never gets in, so they never see a notice. The door refusal (`cw.doors.check` in the library, `POST /v1/doors/check` in service mode) carries `appealUrl` when there is a link. Put it on the banned screen
of your game: "This account is banned. Read why and ask for a second look: <link>". It is the same capability, with the same care.

## Service mode

If your game is not written in Node, `chatwarden serve` runs the hook for you. Set `CHATWARDEN_PUBLIC_URL` (where the service is reached from outside; the page is `<it>/appeal`), `CHATWARDEN_DELIVERY_URL` (where a notice is POSTed) and
`CHATWARDEN_DELIVERY_SECRET` (its own secret, 32 or more characters, never the same as another of the service's secrets). The service POSTs the `NoticeDelivery` as JSON to your URL and signs it:

- The header `X-Chatwarden-Signature` is `sha256=` and the hex HMAC-SHA256 of the exact body, with your secret. There is no timestamp. Compare in constant time:

```ts
import { createHmac, timingSafeEqual } from 'node:crypto';
export function verifyDelivery(secret: string, body: string, header: string): boolean {
  const want = Buffer.from(`sha256=${createHmac('sha256', secret).update(body).digest('hex')}`);
  const got = Buffer.from(header);
  return want.length === got.length && timingSafeEqual(want, got);
}
```

- The header `x-chatwarden-delivery` is the notice id, the same on every retry. Deduplicate on `x-chatwarden-delivery`: a retry after a slow answer, or a delivery your receiver saw twice, is the same notice. A captured delivery can be replayed
  indefinitely, because the signature has no time in it: keep the transport on https, and use a separate endpoint from your `webhooksOut` receiver, whose signature (`v1=`, with a timestamp) is a different scheme under the same header name.
- Answer 2xx to accept. A network error, a timeout, a 408, a 429 or a 5xx is retried after 1, 3 and 6 minutes (four tries in all); any other 4xx or a redirect is final. The queue is in memory (at most 1000 waiting) and lost on a restart, so your game must be able to ask
  again: `POST /v1/appeals/link` with the `noticeId` answers a fresh link, and `appealUrl` is on the notices in `POST /v1/notices/pending` and `POST /v1/record`.

Behind a TLS proxy (the normal way to serve `chatwarden serve`), set `CHATWARDEN_TRUST_PROXY` to the number of proxies of your own in front of it (`1` for one), so that the page's rate limits tell players apart by the address the proxy reports in
`X-Forwarded-For`. Without it the page has no per-address limit for players behind the proxy (a proxy on a private or loopback address is not counted as a person, so each appeal link is limited by its own token only), and the kit logs `chatwarden.landing_shared_address` once. Set it only behind a proxy you run.

## What an appeal does for you

A granted appeal (a revoke, or a reduction) on an automatic restriction no longer counts toward the next restriction: the kit forgives that strike. The kit also records the overturn without any text, so the hub can show you which term or
chat filter is being overturned: a term overturned twice in 90 days gets a quiet flag, and a filter shows its count. The kit never changes a term by itself: a person reads the flag and decides. A report that led to an overturned decision is no longer counted as a
confirmed report for the reporter, and is never counted as a false one. A Discord feed posts one line, "Overturned on appeal", with where the decision came from and nothing else.

One limit to know: the strike forgiveness is per process. The process that decides the appeal forgives at once; another process of the same game, with the strikes already in its memory, keeps counting the forgiven strike until it restarts, so for a time it
can time out a player for longer than they should have been. If you run more than one process, decide appeals on one of them or restart the others after a batch.

## Languages

The page and the messages come in English, Spanish and Portuguese, chosen by `?lang=`, the browser's language or `notices.localeOf`. Spanish and Portuguese are machine-drafted (by an AI model) and have not been reviewed by a person. Have someone who speaks the language
read them before you rely on them, especially the nine fixed reasons a player is shown and the line that says a decision is final. `appeals.words` replaces any of them, by language, and adds a language of your own.
