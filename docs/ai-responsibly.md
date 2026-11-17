# Using the AI responsibly

**Draft for legal review.** This page ships with AI level 3 (acting). Until then, it describes levels 0 to 2 and shadow mode, which are what
the kit can do today (0.1.14). It is not legal advice. Whether your use is lawful is for you and your lawyer to decide.

## What the AI does, level by level

| Level | What happens | Who decides |
|---|---|---|
| 0, Off (the default) | Nothing is sent anywhere. | A moderator. |
| 1, Read | Each new report is read in the background. The hub shows what the AI found. | A moderator. |
| 2, Recommend | As Read, and the decision form opens with a suggestion the moderator accepts or edits. The suggestion is never a ban, an area ban or longer than 24 hours. | A moderator. |
| Shadow | As Recommend, and the kit also records what level 3 would have done. Nothing is sent to a player and nothing is applied. | A moderator. |
| 3, Act (not released) | For rules where the AI has a proven record, it may apply a short restriction on its own, within daily caps. A person can confirm or undo it, and any player can appeal. | The AI, checked by a person. |

The AI is off until the game's code gives it a provider and the owner turns it on in the hub.

## What is sent to the AI provider

- The lines of the reported conversation the kit chooses, with each speaker replaced by `P1`, `P2` and so on.
- The reporter's reason and note, redacted.
- The game's Community Rules.

Never sent: player ids, names, handles, IP addresses, hashes, rooms, tags, flags, mutes or report counts. A line the word filter blocked is
sent as typed unless the game sets `blockedLines: 'mask'`. Chat text can still identify a person, so treat it as personal data.

## The safeguards

- A person can see, confirm or undo every AI action, and the owner can switch the AI off at once (the kill switch).
- Any player can appeal. An appeal is always decided by a person, and while it is open the AI takes no further action on that player.
- The AI never acts on a report marked as made in bad faith, or from a reporter marked that way.
- A moderator can mark a player "Do not automate". The AI then never acts on them.
- Level 3 is earned per rule: the AI must first agree with moderators often enough, over enough decisions, and it loses the right when
  moderators undo it too often.
- Every row says who or what made it (a moderator, the AI, the word filter). Records are kept for 365 days by default.

## Template paragraph for your privacy policy

> We use automated tools to help moderate chat. When a player reports a message, the reported conversation, with player names replaced by
> placeholders, may be sent to [PROVIDER], an AI service, to help our moderators review the report. [If you use level 3:] For some clear
> breaches of our Community Rules, the tool may apply a short chat restriction automatically. Every automatic action is labelled as automatic,
> can be checked or reversed by our moderators, and can be appealed to a person. We keep moderation records for [365 days]. [PROVIDER]
> processes this data for us under a data-processing agreement and [does not / does] keep or train on it. Contact [CONTACT] with questions.

Fill in the brackets. Remove the level 3 sentence if you do not use level 3.

## Questions to put to your lawyer

1. Is a short automatic chat restriction a "decision based solely on automated processing" with a "similarly significant effect" (GDPR
   Article 22) for your players? Does the answer change for streamers, teams or minors?
2. Does the template paragraph give players enough information (GDPR Articles 13 to 15)?
3. Is your service in scope for the EU Digital Services Act's statement of reasons and complaint handling (Articles 17 and 20)?
4. If children play, what do COPPA (US) or the Age Appropriate Design Code (UK) require before chat is sent to a provider?
5. Do you need a data-processing agreement with the provider, and a data-protection impact assessment?
