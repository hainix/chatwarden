// Buttons on a report post, in the shape Discord's message components take. The feed knows nothing about who made them:
// a function the adopter passes returns rows, and `checkRows` is the one gate between that function and the wire.

/** The most buttons in one action row (Discord's limit). */
const ROW_BUTTONS_MAX = 5;
/** The most rows a post may carry: the feed's "clean core" rule is one row, so more is refused rather than sent. */
const ROWS_MAX = 1;
const LABEL_MAX = 80;
const CUSTOM_ID_MAX = 100;
const URL_MAX = 512;
const LINK_STYLE = 5;

/** A button: styles 1 to 4 carry a `custom_id` and send it back to the bot; style 5 is a link and sends nothing. */
export type DiscordButton =
  | { type: 2; style: 1 | 2 | 3 | 4; label: string; custom_id: string }
  | { type: 2; style: 5; label: string; url: string };

export interface DiscordActionRow {
  type: 1;
  components: readonly DiscordButton[];
}

/** One button, rebuilt field by field (so nothing Discord does not know rides along), or null when it breaks a limit. */
function checkButton(raw: unknown): DiscordButton | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const b = raw as Record<string, unknown>;
  const { type, style, label } = b;
  if (type !== 2) return null;
  if (typeof style !== 'number' || !Number.isInteger(style) || style < 1 || style > 5) return null;
  if (typeof label !== 'string' || label.length < 1 || label.length > LABEL_MAX) return null;
  if (style === LINK_STYLE) {
    const { url, custom_id: customId } = b;
    if (customId !== undefined || typeof url !== 'string' || url.length > URL_MAX) return null;
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return null;
    }
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null;
    // The URL as the parser writes it is what is sent, so it cannot differ from what was checked.
    return parsed.href.length > URL_MAX ? null : { type: 2, style: LINK_STYLE, label, url: parsed.href };
  }
  const { url, custom_id: customId } = b;
  if (url !== undefined || typeof customId !== 'string' || customId.length < 1 || customId.length > CUSTOM_ID_MAX) return null;
  return { type: 2, style: style as 1 | 2 | 3 | 4, label, custom_id: customId };
}

/**
 * Check the rows a `components` function returned and return a clean copy, or null when anything is off: not an array, more than
 * one row, a row with no buttons or more than five, a style outside 1 to 5, a label empty or over 80 characters, a `custom_id`
 * empty or over 100 (or on a link), a `url` over 512 characters, not http(s), or on a button that is not a link, a type other than 2.
 * An empty list is valid and means "no buttons". Never throws, whatever it is given.
 */
export function checkRows(rows: unknown): DiscordActionRow[] | null {
  try {
    if (!Array.isArray(rows) || rows.length > ROWS_MAX) return null;
    const out: DiscordActionRow[] = [];
    for (const raw of rows as unknown[]) {
      if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
      const { type, components } = raw as Record<string, unknown>;
      if (type !== 1 || !Array.isArray(components) || components.length < 1 || components.length > ROW_BUTTONS_MAX) return null;
      const buttons: DiscordButton[] = [];
      for (const button of components as unknown[]) {
        const checked = checkButton(button);
        if (checked === null) return null;
        buttons.push(checked);
      }
      out.push({ type: 1, components: buttons });
    }
    return out;
  } catch {
    return null;
  }
}
