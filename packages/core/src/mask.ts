/** A range on a text: `start` inclusive, `end` exclusive. The matcher's `spans` return this plus a term id. */
export interface MaskSpan { start: number; end: number }

/**
 * Replaces each span of `text` with `*` repeated for its length. Spans may overlap, repeat or arrive unsorted;
 * bounds are clamped to the text, fractions truncated, and a span that is empty, inverted or not a finite
 * range is ignored. Never throws and never changes the text length.
 */
export function maskSpans(text: string, spans: readonly MaskSpan[]): string {
  if (!Array.isArray(spans) || spans.length === 0 || text.length === 0) return text;
  const clamp = (v: number) => Math.min(text.length, Math.max(0, Math.trunc(v)));
  const ranges: Array<[number, number]> = [];
  for (const s of spans) {
    if (!s || typeof s.start !== 'number' || typeof s.end !== 'number' || Number.isNaN(s.start) || Number.isNaN(s.end)) continue;
    const start = clamp(s.start);
    const end = clamp(s.end);
    if (end > start) ranges.push([start, end]);
  }
  if (ranges.length === 0) return text;
  ranges.sort((a, b) => a[0] - b[0]);
  let out = '';
  let at = 0;
  for (const [start, end] of ranges) {
    const from = Math.max(start, at);
    if (end <= from) continue;
    out += text.slice(at, from) + '*'.repeat(end - from);
    at = end;
  }
  return out + text.slice(at);
}
