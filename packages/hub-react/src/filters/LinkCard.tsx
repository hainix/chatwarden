import type { LinkSettings } from '@chatwarden/core';
import { FILTER_RULE_DEFAULTS } from '@chatwarden/core';
import { useHub } from '../context.js';
import { ActionChoice, Card, ChipList, NumField, ProblemLine, RuleField } from './parts.js';
import type { Problem } from './parts.js';

/** Links: allowed and denied domains, what to do with a link on neither, the built-in invite and shortener lists and an account-age rule. */
export function LinkCard({
  value,
  onChange,
  problem,
  flagCap,
  accountAge,
}: {
  value: LinkSettings | null;
  onChange: (v: LinkSettings | null) => void;
  problem: Problem | null;
  flagCap: number;
  /** The kit can read an account's age (`limits.filters.accountAge`). Without it the new-account rule does nothing, and says so. */
  accountAge: boolean;
}) {
  const { t } = useHub();
  const v = value;
  const set = (patch: Partial<LinkSettings>): void => {
    if (v !== null) onChange({ ...v, ...patch });
  };
  return (
    <Card
      title={t('hub.settings.filters.links.title')}
      hint={t('hub.settings.filters.links.hint')}
      on={v !== null}
      onToggle={(on) =>
        onChange(on ? { action: 'count', rule: FILTER_RULE_DEFAULTS.links, allow: [], deny: [], unlisted: 'act', invites: true, shorteners: true, newAccountDays: null } : null)
      }
    >
      {v !== null && (
        <>
          <ActionChoice
            value={v.action}
            onChange={(action) => set({ action })}
            about={(a) => (a === 'flag' ? t('hub.settings.filters.action.flag.about', { count: flagCap }) : t(`hub.settings.filters.action.${a}.about` as never))}
          />
          <RuleField value={v.rule} onChange={(rule) => set({ rule })} />
          <ChipList
            entries={v.allow ?? []}
            onChange={(allow) => set({ allow })}
            label={t('hub.settings.filters.links.allow')}
            addLabel={t('hub.settings.filters.links.allow.add')}
            addButton={t('hub.settings.filters.links.allow.button')}
            hint={t('hub.settings.filters.links.domains.hint')}
          />
          <ChipList
            entries={v.deny ?? []}
            onChange={(deny) => set({ deny })}
            label={t('hub.settings.filters.links.deny')}
            addLabel={t('hub.settings.filters.links.deny.add')}
            addButton={t('hub.settings.filters.links.deny.button')}
          />
          <div className="cw-field">
            <label htmlFor="cw-fl-unlisted">{t('hub.settings.filters.links.unlisted')}</label>
            <select id="cw-fl-unlisted" value={v.unlisted ?? 'act'} onChange={(e) => set({ unlisted: e.target.value === 'allow' ? 'allow' : 'act' })}>
              <option value="act">{t('hub.settings.filters.links.unlisted.act')}</option>
              <option value="allow">{t('hub.settings.filters.links.unlisted.allow')}</option>
            </select>
          </div>
          <label className="cw-choice">
            <input type="checkbox" checked={v.invites !== false} onChange={(e) => set({ invites: e.target.checked })} />
            <span>{t('hub.settings.filters.links.invites')}</span>
          </label>
          <label className="cw-choice">
            <input type="checkbox" checked={v.shorteners !== false} onChange={(e) => set({ shorteners: e.target.checked })} />
            <span>{t('hub.settings.filters.links.shorteners')}</span>
          </label>
          <NumField
            label={t('hub.settings.filters.links.newAccount')}
            value={v.newAccountDays}
            onChange={(n) => set({ newAccountDays: n ?? null })}
            min={1}
            max={365}
            hint={accountAge ? t('hub.settings.filters.links.newAccount.hint') : `${t('hub.settings.filters.links.newAccount.hint')} ${t('hub.settings.filters.links.newAccount.needs')}`}
          />
          <ProblemLine problem={problem} card="links" />
        </>
      )}
    </Card>
  );
}
