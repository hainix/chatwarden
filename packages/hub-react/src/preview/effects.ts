import { WARNING_DAYS } from '@chatwarden/core/notice-copy';
import type { EffectCode } from '@chatwarden/core/notice-copy';
import { absoluteTime } from '../format.js';
import type { HubT } from '../i18n.js';

// The plan's effect codes in the moderator's words ("What the player sees", design 4.3). Pure: the words come from `t`, the times from the locale; no name is
// built here (the caller passes the label of each person, the hidden label while a name is flagged).

/** The person an effect is about, or null for one that is about nobody in particular. */
export function effectPerson(e: EffectCode): string | null {
  return 'to' in e ? e.to : null;
}

const when = (at: number, locale: string): string => absoluteTime(at, locale);

/** One effect as a sentence ("They cannot chat until Jan 16, 2027, 3:00 PM."). A rename that waits for a ban adds its second sentence. */
export function effectText(t: HubT, locale: string, e: EffectCode): string {
  switch (e.code) {
    case 'chat_off':
      return e.until === null ? t('hub.preview.effect.chat.open') : t('hub.preview.effect.chat', { when: when(e.until, locale) });
    case 'area_off':
      return e.until === null ? t('hub.preview.effect.area.open') : t('hub.preview.effect.area', { when: when(e.until, locale) });
    case 'banned':
      return e.until === null ? t('hub.preview.effect.ban.open') : t('hub.preview.effect.ban', { when: when(e.until, locale) });
    case 'warning_on_record':
      return t('hub.preview.effect.warning', { days: WARNING_DAYS });
    case 'warning_staff_only':
      return t('hub.preview.effect.warningStaff');
    case 'rename_asked':
      return e.later ? `${t('hub.preview.effect.rename')} ${t('hub.preview.effect.rename.later')}` : t('hub.preview.effect.rename');
    case 'reporter_not_told':
      return t('hub.preview.effect.reporterNot');
    case 'lifts':
      return e.kind === 'note' ? '' : t(`hub.preview.effect.lifts.${e.kind}`);
    case 'appeal_closed':
      return t('hub.preview.effect.appealClosed');
    case 'sanction_stays':
      return t('hub.preview.effect.stays');
    case 'first_withdrawn':
      return t('hub.preview.effect.firstWithdrawn');
    case 'removed_withdrawn':
      return t('hub.preview.effect.removed');
    case 'new_end':
      return t(`hub.preview.effect.newEnd.${e.kind}`, {
        now: e.until === null ? t('hub.preview.nowNone') : t('hub.preview.nowEnds', { when: when(e.until, locale) }),
        was: e.was === null ? t('hub.preview.wasNone') : t('hub.preview.wasEnd', { when: when(e.was, locale) }),
      });
    case 'ran_its_course':
      return t('hub.preview.effect.course');
  }
}
