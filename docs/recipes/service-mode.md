# Service mode: moderation for a game server in any language

A guide for the person who runs the game's backend. If your server is written in C#, Go, Python, Java or anything else, you do not need Node in your game: run Chatwarden as a small service next to it and
talk to it over HTTP. Your server says who sits in which seat and asks the service whether a line may go out; the service keeps the people, the strikes, the reports and the sanctions in its own database.

This is not legal advice. What you may keep about a player, for how long, and what you must tell them depends on where your players are, and the kit does not decide which rules apply to you. Ask your own counsel.

## What the service does

- **Judges a line.** `POST /v1/rooms/{room}/seats/{seat}/lines` with `{ "text": "..." }` answers `ok: true` with the text to broadcast (starred when your profile stars swearing) and the seats that must not be
  sent it, or `ok: false` with the reason (`blocked`, `restricted`, `slow_mode`, `flood`, `duplicate` and the rest). Only the author is told a line was refused.
- **Takes reports, mutes and blocks.** A report snapshots the chat the service itself saw; a mute or a block hides a player's lines from the muter, and `hiddenFor` says so on every later line.
- **Tells your game about a player.** Their notices, their record, what they are restricted from, whether they may join, and whether two players have blocked each other (for matchmaking).
- **Runs the staff side.** The same hub and staff routes as the library, behind the staff sign-in you choose.

Every answer is JSON, every refusal is a 200 with `ok: false`, and no answer holds an id of a person, a hash, a moderator or the word that matched. The API description is `chatwarden serve --print-openapi`.

## Run it

```sh
npx -p @chatwarden/http chatwarden init --service
cd chatwarden-service && cp .env.example .env
docker compose up --build
```

`init --service` writes a folder you own: a Dockerfile, a compose file, `.env.example`, `profile.json`, a short README and a `.dockerignore`. It writes no secret. Fill in `.env` with three values (a good one
is `openssl rand -base64 32`): `CHATWARDEN_SECRET`, `CHATWARDEN_SERVICE_KEYS` and, for the hub, `CHATWARDEN_ADMIN_TOKEN`. The image is built from your folder; nothing is pushed anywhere. Without Docker, `chatwarden
serve` runs the same process anywhere Node 22.13 runs.

Try it with the script of the five core calls, `examples/service/curl.sh`, or its Node twin `conformance.mjs`, which exits 1 on any surprise. A C# client and demo are in `examples/service-csharp`.

## The contract your server keeps

1. **Seat each player when they join a room**, and again when they reconnect. `PUT /v1/rooms/{room}/seats/{seat}` takes who they are (`clientKey` or `accountId`, and their address as you saw it) and the name
   moderators will see. A seat is your own id. The answer says whether the player is restricted, so you can tell them at once.
2. **Ask before you broadcast.** Send the line, broadcast `line.text` to every seat except `hiddenFor`, and show the author the refusal if there is one. Send an `Idempotency-Key` with it, so a retry after a
   timeout is judged once.
3. **Unseat when they leave, close the room when it ends.** The service forgets seats when it restarts: a line from a seat it does not know is refused `gate`. Seat again and carry on.
4. **Keep the key in your server's environment.** A service key is a database password. It is never in a client build, and the service belongs on a private network or behind a TLS proxy.

What the service cannot know: who a player is (you tell it), how old they are (it never learns), and which rooms are special (you tag them: `context` picks a rule set, `scope` limits a moderator to one creator's
rooms). Your game draws its own chat box and its own notice screen from `notices/pending` and `record`; the service has no player routes.

## Running more than one

One process is the default and the safe one. Seats, the recent chat the service keeps as evidence, the fixed per-seat rate and the idempotency table are in the process, so two processes work only if every call
for one room reaches the same process (sticky routing, or a hash of the room id). The pacer's state (slow mode, the burst limit and repeats) can be shared through the database with `--shared-pacing`; tell the service
how many you run with `CHATWARDEN_PROCESSES`, and its handshake warns `pacing_per_process` when you run several without sharing. The service does not promise a response time, and it is not a pager.

## What to check before you go live

- The handshake (`GET /v1`) lists `warnings`. `synthetic_terms` means the word list is the kit's test list: give it your own with `--terms-file`. `plain_http` means a proxy told it a request came over plain HTTP.
- Rotate keys by adding the new one beside the old one, deploying it to your servers, then removing the old one. Two keys work at once.
- Replace the staff sign-in (`CHATWARDEN_AUTH_MODULE`) before a team uses the hub: the token is for one or two moderators.
