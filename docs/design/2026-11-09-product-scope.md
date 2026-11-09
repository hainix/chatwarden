---
status: approved direction (owner 2026-11-09)
updated: 2026-11-09
---

# Chatwarden as a complete product: capability map and roadmap

> Owner, 2026-11-09: "We want this to be completely turnkey. All of the work that people normally would have to
> do, we've probably already done it or will need to do it. Make this a full-fledged proper product that could be
> acquired or bought by someone, but instead we're providing it for free, open source. Make it as complete and
> thorough as possible. It's fine if the project scopes and bloats and we don't use all the features in Moxgate,
> but ideally we're the first customer."

The test for "complete": a small studio with chat and no trust-and-safety staff can adopt Chatwarden and get
everything a funded T&S team would build. That means policy, enforcement, review tooling, automation, player
safety, transparency, compliance, analytics and integrations, all with good defaults and every knob
configurable (`2026-11-09-moderation-standards.md`).

Legend:
- ✅ built
- 🔨 in progress
- 📐 designed
- 🆕 new in this doc
- Moxgate column: **uses** / opt-in / no

## 1. Policy

| Capability | Status | Moxgate |
|---|---|---|
| Numbered Community Rules, retire-never-reuse, rule-gap loop | ✅ K2 | uses |
| Conduct levels, Note outcome, verdicts, bad-faith evidence | 🔨 K3a | uses |
| Profiles (relaxed / standard / strict), deep overrides, validation | 🔨 K3a | uses (relaxed) |
| Team guidelines tiers; generated code of conduct, moderator guide, agent brief, policy JSON | 🔨 K3a | uses |
| 🆕 **Policy versioning**: every decision records the policy version it was made under; a policy change log page | K3a+ | uses |
| 🆕 **Per-context policy**: different profiles for ranked vs casual rooms, or kids vs adults, chosen per room via room tags | K9 | opt-in |

## 2. Enforcement engine

| Capability | Status | Moxgate |
|---|---|---|
| Subjects across browsers and accounts, IP never links | ✅ K1 | uses |
| Server-witnessed evidence buffer | ✅ K1 | uses |
| Slur matcher with evasion handling, live term editing behind a never-block gate | ✅ K1 | uses |
| Sanctions (chat / area / ban / warning / note), groups, ref codes, provenance, IP cap | ✅ K1–K3a | uses |
| Strikes and automatic timeouts, mutes, door checks, retention | ✅ K1 | uses |
| Profanity package (allow / star / refuse, styles, word lists) | 🔨 K3a | uses (star) |
| 🆕 **AutoMod rules engine.** Declarative rules: `when` (keyword, regex, link, mention count, caps ratio, repeated message, account age, trust level, room tag) → `then` (refuse, hold for review, star, flag to the queue, timeout, note). Ordered, with dry-run mode and per-rule hit stats. Config-only, like Discord AutoMod. Osprey is the heavyweight alternative. | K9 | opt-in |
| 🆕 **Spam and flood**: duplicate-message detection, burst detection across seats, slow mode per room, caps and emoji floods | K9 | uses |
| 🆕 **Links**: allow / deny domains, block invites, optional URL reputation lookup (Safe Browsing adapter), "links need trust level N" | K9 | uses |
| 🆕 **Personal-info guard**: detect phone numbers, emails and street addresses in chat. Refuse or mask by profile (strict profiles refuse, to protect minors and stop doxxing) | K9 | opt-in (mask) |
| 🆕 **Name moderation API**: `names.check(text)` for handles, room names, team names and deck names, using the same matcher and term list | K3b | uses |
| 🆕 **Hold for review** (Twitch-style): flagged messages wait for a moderator or time out; the sender sees "held" | K9 | no |

## 3. Review tooling (the hub)

| Capability | Status | Moxgate |
|---|---|---|
| Queue sorted by AI severity, report page, decision panel, ladder suggestion, player history, notes, terms editor, rules and gaps, guide | 📐 K4 | uses |
| 🆕 **Content-exposure care**: severe excerpts blurred until clicked, a daily exposure counter per moderator, a "take a break" prompt (industry practice for moderator wellbeing) | K4 | uses |
| 🆕 **Team workflow**: claim or assign a report, "second opinion" request, escalate to owner, internal comments on a report, saved replies and macros, keyboard shortcuts | K4 | uses |
| 🆕 **Bulk actions** for spam waves: select many reports or players, apply one decision | K4 | opt-in |
| 🆕 **Search**: by handle, ref code or rule; within a player's evidence (staff-only, audited) | K4 | uses |
| 🆕 **Linked-accounts view**: the identifiers graph behind a subject (counts only, hashed), recent devices, ban-evasion hints | K4 | uses |
| 🆕 **Roles and permissions**: moderator / senior / owner (configurable), plus per-action permissions such as "ban needs senior" | K3b/K4 | uses |
| 🆕 **Calibration**: a shared practice set of real-shaped reports; moderators label them and the hub shows agreement per moderator and per tier. It is the same set as the AI eval. This directly answers "consistency". | K4 | uses |
| 🆕 **Moderator audit**: every action, view of evidence, and config change, with who and when; exportable | K3b | uses |
| 🆕 **Notifications**: severe report → Discord, email or webhook ping; daily digest | K3b | uses |

## 4. AI

| Capability | Status | Moxgate |
|---|---|---|
| Levels 1–4 (read, recommend, act on clear cases, watch), hard ceilings, agreement tracking, cost caps | 📐 K3c | level 2 at launch |
| 🆕 **Provider adapters**: Anthropic, OpenAI-compatible, local (Ollama / gpt-oss-safeguard); a test double for adopters' CI | K3c | Anthropic |
| 🆕 **Explain-why for players**: optional plain-language reason in a notice ("This message was a personal attack"), generated from the rule and tier, never from the moderator's private reason | K3c | opt-in |
| 🆕 **Multilingual reads**: the AI read handles any language; the term packs cover en, es, pt first | K3c/K7 | uses |

## 5. Player safety and experience

| Capability | Status | Moxgate |
|---|---|---|
| Report, lasting mute, notices, My record, reporter feedback, refusal cites rule | ✅ K1–K2 | uses |
| 🆕 **Block** (mute plus never matched together again, no DMs), an extension of mute with a matchmaking hook | K10 | uses |
| 🆕 **Appeals**: "Think this is a mistake?" becomes an in-app appeal (one per sanction, rate limited) → appeal queue → upheld / overturned → the notice updates. Optional Coop appeal API mapping. | K10 | opt-in (link only at first) |
| 🆕 **Personal chat settings**: hide profanity for me, chat off, team-only, who can message me. Stored per subject; applied by `visibleTo` | K10 | uses |
| 🆕 **Minor mode**: the adopter flags a player as a minor → strict profile for their view and their messages, personal-info guard on, adult-to-minor DMs off | K10 | no |
| 🆕 **Trust levels** (Discourse-style): new players get slow mode and no links; trust grows with clean playtime; trusted players' reports weigh more in queue order only, never in sanctions. Builds on Moxgate's Trusted players spec | K11 | uses |
| 🆕 **Raid and new-account protection**: join-velocity alarms, temporary "new accounts read-only" switch per room or globally | K11 | opt-in |
| 🆕 **Room-level tools**: host mute, host kick, vote mute and vote kick with safeguards (not against the host, cooldown, needs a majority, logged as evidence, never a sanction by itself) | K11 | opt-in |

## 6. Transparency and compliance

| Capability | Status | Moxgate |
|---|---|---|
| Retention with floors, privacy defaults, no identifiers in player values | ✅ | uses |
| 🆕 **Data subject requests**: `privacy.export(who)` returns everything held about a person (evidence they wrote, notices, sanctions); `privacy.erase(who)` follows a documented policy (keep sanctions for safety, drop the rest) | K12 | uses |
| 🆕 **Evidence export**: a report as a signed bundle (JSON + hash), for appeals, platform escalations or legal requests, with a chain-of-custody record | K12 | opt-in |
| 🆕 **Transparency report generator**: monthly counts by rule, outcome, AI share and appeal overturn rate; a public page or markdown | K12 | uses |
| 🆕 **Legal templates** (labelled "not legal advice"): privacy policy paragraphs, terms clauses, DSA notice-and-action wording, retention statement | K12 | uses |
| 🆕 **Immutable audit**: an append-only audit table with a hash chain, so tampering is detectable | K12 | uses |

## 7. Analytics

| Capability | Status | Moxgate |
|---|---|---|
| 🆕 **Moderation dashboard**: report volume, time to decision, outcomes by rule and tier, repeat-offender rate, false-report rate, AI agreement, top terms blocked | K13 | uses |
| 🆕 **Health signals**: share of chats with a refusal, mute rate, report rate per 1 000 messages, trend alarms | K13 | uses |
| 🆕 **CSV export and a Prometheus metrics endpoint** | K13 | opt-in |

## 8. Integrations and platform

| Capability | Status | Moxgate |
|---|---|---|
| Express + ws adapter, tiny-chat example, SQLite store | ✅ | uses |
| HTTP admin and player APIs, signed webhooks in and out, Discord forum feed | 📐 K3b | uses |
| Socket.IO, Colyseus, Fastify, Next.js recipes; `npx chatwarden init`; service mode (Docker); Claude Code plugin; `llms.txt` | 📐 K4b | — |
| React hub and player components (themable) | 📐 K4 | uses |
| Coop adapter, EOS sanctions and reports | 📐 K5 | no |
| 🆕 **Discord bot**: report and outcome feed plus button deep links (exists); slash commands `/chatwarden lookup <ref>`; optional "act from Discord" with role checks | K5 | uses (feed) |
| 🆕 **Game-engine SDKs**: Unity (C#), Godot (GDScript), Unreal (C++) clients for service mode, covering chat check, report, notices, and the code of conduct screen | K14 | no |
| 🆕 **Postgres store** and **Redis** (shared rate limits and indexes) for multi-instance deployments; service mode horizontal scaling | K14 | no |
| 🆕 **Browser build of core** (the landing demo, edge runtimes) | K8 | — |
| 🆕 **Observability**: structured logs, health and readiness endpoints, OpenTelemetry traces (opt-in) | K3b | uses |
| 🆕 **i18n**: every player-facing string has a key and a catalog; en first, community translations; Moxgate's 6 locales seed it | K4 | uses |
| 🆕 **Upgrade safety**: semver, changesets, migration notes, config migration (`chatwarden migrate-config`), deprecation warnings | ongoing | uses |
| 🆕 **Test kit for adopters**: `@chatwarden/testing` with a memory store, fake clock, a scripted chat simulator, and policy assertions ("under my profile, this conversation yields these outcomes") | K4b | uses |

## 9. Community corpus

| Capability | Status | Moxgate |
|---|---|---|
| Shared slur list on our own corpus service, signed zipped releases, Zenodo mirror, "Share with the community list" button | 📐 K7 | uses |
| 🆕 **Calibration and eval sets** published the same way (synthetic plus contributed and anonymized), feeding moderator calibration and the AI eval | K7 | uses |

## 10. Chat itself (optional, drop-in) 🆕

> Owner, 2026-11-09: "Should we provide any of the other chat features that we support, like some of the UI, the
> translation layer… people could definitely just take the moderation part, but someone just wants to throw in
> chat and hook up their buttons or just take our default buttons. Nice to give as much out of the box that works
> as possible."

Three layers. Each is optional, and each works without the one above it. Moderation is built in, never bolted on:
every message goes through `chat.accept`, and every line has Report and Mute.

| Package | What | From Moxgate |
|---|---|---|
| `@chatwarden/chat-server` | Channels: room, team, whisper/DM, system/announcements, spectators. Short configurable history. Typing and presence (hidden for muted and restricted people). Read markers and unread counts. Delete own message (N s window); moderator remove (removed for everyone, kept as evidence). Pinned messages, slow mode, quick chat and pings, reactions, mentions. A documented JSON protocol over `ws`, Socket.IO or service mode. | team chat, typing, system lines |
| `@chatwarden/client` | Headless, framework-free client: connection plus reconnect, an observable store, optimistic send, refusal handling (reason, rule, notice link), notices, mutes, personal settings. Plus React hooks (`useChat`, `useNotices`, `useChatSettings`). Bring your own buttons. | chatSlice, useChatActions |
| `@chatwarden/chat-react` | Default UI, themable via CSS variables, also available unstyled:<br>• `ChatPanel`: virtualized list, scroll anchoring, unread pill, compact mode, typing line, `/t` team prefix, quick-chat bar, emoji/reaction picker<br>• `ChatDock`, `LineMenu` (mute, report, copy, translate, show original)<br>• `ReportDialog` (shows the profile summary), `NoticeDialog`, `MyRecord`, `RulesPage` (renders `codeOfConduct`), `ChatSettings` (hide profanity for me, chat off, team only) | ChatPanel, ChatDock, ChatLineMenu, ReportDialog, chatCompact |
| `@chatwarden/translate` | Per-viewer automatic translation of other players' lines, with "show original". Pluggable engines:<br>• Chrome on-device Translator (used only when the model is already downloaded)<br>• Cloudflare Workers AI<br>• LibreTranslate (self-host)<br>• DeepL / Google adapters<br>• language detection, an edge/LRU cache keyed by text hash, per-IP limits on the server route<br>Moderation always runs on the ORIGINAL text, never the translation. | chatTranslation (engines.ts), cards-api `/translate` |

Game-friendly extras:
- **Quick chat:** preset phrases and pings, shown in each viewer's own language, so no translation is needed. A
  strict profile can be set to quick-chat-only, the safest mode for young players.
- **An emote wheel and "gg" buttons.**
- **Chat off per player, and spectator chat kept separate from players.**

UI strings ship in en plus Moxgate's 6 locales, with community translations after that.

Moxgate is the first customer. At K6 it swaps its own ChatPanel, ReportDialog and translation for these packages,
keeping its own styling through theme variables.

## Roadmap (sequence)

Each phase is its own plan, written when it starts, against the code as built. Moxgate adopts after K4b so it
runs the full product early (K6); later phases ship as Chatwarden releases that Moxgate upgrades into.

| Phase | Contents |
|---|---|
| K3a 🔨 | standards, profiles, profanity, limits, staff queue, policy documents |
| K3b | HTTP admin + player APIs, roles, audit, webhooks, Discord feed, notifications, names API, observability |
| K3c | AI read levels 1–2 (3–4 behind flags), providers, eval set, explain-why |
| K4 | React hub (queue, decisions, history, guidelines, gaps, terms, calibration, wellbeing, team workflow, search) + player components + i18n |
| K4c | chat layer: chat-server, headless client + hooks, chat-react default UI, translate package, quick chat |
| K4b | init CLI (can scaffold the full chat too), service mode, recipes, testing kit, docs CLI, Claude Code plugin, agent eval |
| K8 | landing page with live in-browser demo, docs site, browser build of core |
| K6 | **Moxgate adopts** (on Moxgate's LOCAL main; the owner pushes) |
| K9 | AutoMod rules engine, spam / links / personal-info guard, hold-for-review, per-context policy |
| K10 | block, appeals, personal chat settings, minor mode |
| K11 | trust levels, raid protection, room tools (host and vote) |
| K12 | privacy export / erase, evidence bundles, transparency reports, legal templates, immutable audit |
| K13 | analytics dashboard, health signals, metrics endpoint |
| K5 | Coop, EOS and Discord bot commands |
| K14 | Postgres + Redis, horizontal scaling, game-engine SDKs |
| K7 | community corpus service and published eval sets |

Non-goals that stay non-goals:
- child-sexual-abuse detection (point to Coop + HMA)
- voice and image moderation
- shadow bans
- AI that bans
