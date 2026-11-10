import { useHub } from '../context.js';

/**
 * What an AI read says about the case. Not built yet: no route returns one, so nothing passes it and the slot renders nothing.
 * When a read exists it is shown here, labelled as the AI's, with the level that made it, and it never decides anything.
 */
export interface AiReadData {
  /** The AI level that wrote it (1 to 4). */
  level: number;
  /** One or two plain sentences. */
  text: string;
}

/** The place an AI read goes, between the case header and the transcript. Renders nothing without data. */
export function AiReadSlot({ read }: { read: AiReadData | null | undefined }) {
  const { t } = useHub();
  if (read === null || read === undefined) return null;
  return (
    <section className="cw-ai" aria-label={t('hub.ai.label')}>
      <h3>{t('hub.ai.title', { level: read.level })}</h3>
      <p>{read.text}</p>
      <p className="cw-hint">{t('hub.ai.note')}</p>
    </section>
  );
}
