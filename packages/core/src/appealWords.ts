// The English words of the appeal page and of the text a game delivers when a sanction is given or an appeal is decided (0.2.1). Part of the subpath
// `@chatwarden/core/notice-locales`. Pure data: no Node module, nothing read from a store. `{name}` marks a value filled in at the time of use.
//
// The keys follow the notice words (`player.notice.*`): `player.appeal.reason.*` are the nine fixed reasons a moderator gives with a decision (the
// private free text is never shown), `player.appealPage.*` the page, `delivery.*` the subject, hints, labels and footer of the delivered text.

const WORDS = {
  // The nine fixed reasons: the outcome and the code the moderator chose.
  'player.appeal.reason.upheld.rule_applies': 'The rule applies to what was said.',
  'player.appeal.reason.upheld.evidence_clear': 'The chat record shows the rule was broken.',
  'player.appeal.reason.upheld.context_considered': 'We looked at the whole conversation, and the decision stands.',
  'player.appeal.reason.reduced.first_offence': 'We lightened it because this was a first offence.',
  'player.appeal.reason.reduced.lighter_fits': 'A lighter action fits what happened.',
  'player.appeal.reason.reduced.context_considered': 'We looked at the whole conversation and lightened it.',
  'player.appeal.reason.revoked.mistake': 'This was our mistake. We are sorry.',
  'player.appeal.reason.revoked.not_a_violation': 'What was said does not break the rules.',
  'player.appeal.reason.revoked.context_considered': 'We looked at the whole conversation and lifted it.',
  // The page.
  'player.appealPage.title': 'Appeal a decision',
  'player.appealPage.invalid': 'This link is no longer valid.',
  'player.appealPage.contact': 'Need help? {contact}',
  'player.appealPage.expires': 'This link works until {when}.',
  'player.appealPage.loading': 'Loading',
  'player.appealPage.form.label': 'Why do you think this was a mistake?',
  'player.appealPage.form.hint': 'Up to {max} characters. A different moderator will review it, and the decision is final.',
  'player.appealPage.form.send': 'Send appeal',
  'player.appealPage.form.count': '{count} of {max} characters',
  'player.appealPage.sent': 'Appeal sent {when}.',
  'player.appealPage.sent.email': 'We will email you when it is decided.',
  'player.appealPage.sent.return': 'Come back to this page to see the outcome.',
  'player.appealPage.decided': 'Decision on your appeal',
  'player.appealPage.outcome.upheld': 'We kept the decision.',
  'player.appealPage.outcome.reduced': 'We made the decision lighter.',
  'player.appealPage.outcome.revoked': 'We lifted the decision.',
  'player.appealPage.standing': 'As it stands now',
  'player.appealPage.standing.none': 'Nothing from this decision is on your record.',
  'player.appealPage.refused.invalid': 'Your appeal is empty or too long. Write up to {max} characters.',
  'player.appealPage.refused.rate': 'You have sent too many appeals this week. Try again {when}.',
  'player.appealPage.refused.busy': 'Too many requests. Try again in a little while.',
  'player.appealPage.refused.not_appealable': 'This decision can no longer be appealed.',
  'player.appealPage.refused.already': 'An appeal for this decision was already sent.',
  'player.appealPage.refused.failed': 'Something went wrong. Try again in a little while.',
  // The delivered text.
  'delivery.subject.warning': 'You have received a warning',
  'delivery.subject.chat.timed': 'Your chat has been restricted for {length}',
  'delivery.subject.chat.noEnd': 'Your chat has been restricted',
  'delivery.subject.area': 'You cannot join public rooms',
  'delivery.subject.ban.timed': 'You have been banned for {length}',
  'delivery.subject.ban.noEnd': 'You have been banned',
  'delivery.subject.appeal_upheld': 'We reviewed your appeal: the decision stands',
  'delivery.subject.appeal_reduced': 'We reviewed your appeal: the decision was made lighter',
  'delivery.subject.appeal_revoked': 'We reviewed your appeal: the decision was lifted',
  'delivery.appealHint': 'If you think this was a mistake, you can appeal it here.',
  'delivery.appealLink': 'Appeal this decision',
  'delivery.outcomeHint': 'You can see the decision here.',
  'delivery.outcomeLink': 'See the decision',
  'delivery.reason': 'Reason',
  'delivery.standing': 'On your record now',
  'delivery.times': 'Times are in UTC.',
  'delivery.footer': 'You are receiving this message because of a moderation decision about your account.',
};

/** A key of {@link APPEAL_WORDS}. */
export type AppealWordKey = keyof typeof WORDS;

/** The English words of the appeal page and the delivered text: every key a template (`{name}` marks a value). Frozen. */
export const APPEAL_WORDS: Readonly<Record<AppealWordKey, string>> = Object.freeze({ ...WORDS });

/** What a drafted catalogue says about itself: who made it and whether anyone has read it (the same shape as player-react's locale meta). */
export interface NoticeLocaleMeta {
  readonly locale: string;
  /** `'machine-draft'` while no person has read the words. */
  readonly status: 'machine-draft' | (string & {});
  readonly reviewedBy: readonly string[];
  readonly reviewedAt: string | null;
}
