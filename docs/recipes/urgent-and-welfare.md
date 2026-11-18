# Urgent reports and welfare reports

A guide for the person who runs the game's moderation, not a framework recipe. It says what Chatwarden does when a player reports a threat or says someone may be in trouble, what it
leaves to you, and what to wire so the right person hears of it. The kit routes and surfaces. It never judges, and it never contacts anyone.

This is not legal advice. The default guidance the kit shows moderators is a safe floor, not a legal opinion, and says so in Settings.

## What the kit does and does not do

The kit does this:

- marks a report urgent from its reason (the default `threat` reason is urgent), or when a moderator marks it;
- sorts urgent cases first in the queue and in take next, and shows one chip while any is open (it never takes a case another moderator holds);
- never lets a bulk dismissal close an urgent report, and never counts a `welfare` report against the reporter;
- shows the moderator your own guidance and your studio contact line, and a "What to do" panel with one plain line of what the kit does not do;
- shows the reporter your own thank-you and your list of help resources, for the reasons you choose;
- records when a moderator marks the case as passed to your safety team (who and when), and emits `report.handoff` with ids only;
- posts a role mention in the Discord feed, if you set `urgentMention`, with no reason and no text;
- keeps `welfare` reports for a shorter time than other reports.

The kit does not do this:

- It does not decide whether anyone is at risk, or whether a threat is real. A moderator does not decide either: the case says "pass it on".
- It does not message the person reported, the person who may be at risk, or the reporter beyond the thank-you you wrote. It does not contact the police, a crisis service, NCMEC or a regulator.
- It does not ring, email or post anywhere by itself. Only the staff channels you wired (the hub, the Discord feed, a webhook) hear of anything.
- It does not report to any authority.
- It does not store, copy, fetch or forward images, link targets or media. It holds text only. Nothing it sends carries a chat line.
- It does not promise a response time, and it is not a pager. For round-the-clock cover, route the event below into your own on-call tool.

## If anything involves a child

If anything a moderator reads involves a child in danger, or sexual material involving minors: stop. Do not save, copy, screenshot or forward it. Follow your studio's legal procedure.
Detection and reporting of child sexual abuse material go through your own legal process and the tools made for it. The kit holds no images and forwards nothing. The default guidance in the
hub says the same thing in four short paragraphs; you can replace it with your own (Settings, Advanced, Safety and urgent cases).

## Wire the event to your on-call tool

`report.created` carries `urgent: true` for an urgent report. It holds the report id, the reason id and your room tags, and nothing a player wrote. Subscribe with `cw.on` and hand the id to
whatever wakes a person up; the person opens the hub to read the case.

```ts
cw.on('report.created', (event) => {
  if (event.urgent) void pageOnCall({ reportId: event.reportId });
});
```

`pageOnCall` is yours. Keep the text of the page to the id and a link to the hub. `report.handoff` (a report id and a time) tells your own process that a moderator marked the case as
passed on; it contacts no one either. If you use a webhook endpoint instead, subscribe it to `report.created` and `report.handoff`: the body carries the same ids and no chat line.

## The studio contact and the resource text

Settings, Advanced, "Safety and urgent cases" holds three things, all written by you in your game's language (the kit does not translate them):

- **Guidance** (at most 1 500 characters, plain text, a blank line between paragraphs): what a moderator reads in "What to do". Leave it empty to use the default.
- **Studio contact** (one line, 300 characters, staff only): who to reach in your studio. It is never sent to a player and a role without `policy.read` never sees it.
- **Resources** (up to five, each a name, a short detail and an https link): shown to a reporter after a report whose reason has "Show help resources" on. Put your crisis line and your
  safety page here. The dialog never says the kit alerted anyone.

Under each reporting reason, "More" holds Urgent, a thank-you for that reason, and Show help resources. The `welfare` reason ("Someone may be in trouble") ships switched off: turn it on
only when someone is ready to act on those reports.

## Who is told what

| Who | What they see |
| --- | --- |
| The reporter | Your thank-you for the reason, and your resources when the reason shows them. Nothing about who was told. |
| The person reported | Nothing, from the kit. No notice, no message, no restriction follows from a report, urgent or not. |
| The moderator | The urgent chip, the case strip, your guidance and contact, and the hand-off mark. |
| Your own process | `report.created` (urgent), `report.handoff`, and the Discord mention if you set one. Ids only. |

## Retention

A `welfare` report (its excerpt, note, comments and decision row) is deleted after `retention.welfareReportsMs`: 30 days by default, never less than one day. It is the most sensitive text the
kit holds. Other reports keep their own clock. A report held for legal reasons is skipped by the purge. Staff comments are deleted with their report. The retention numbers are in the owner's
settings and in the privacy statement the kit generates.

## Checklist

1. Write the guidance and the studio contact; add your help resources.
2. Decide which reasons are urgent and which show resources; decide whether `welfare` is on.
3. Subscribe your on-call tool to `report.created` and read `event.urgent`.
4. Set `urgentMention` in the Discord feed if your team lives there.
5. Tell your moderators, in your own words, who they pass an urgent case to and how. The hub shows what you wrote; it does not replace the process.
