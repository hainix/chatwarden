import { saveBlob } from '../dom.js';

// One JSON file for the owner to keep: an export of a person, or an erasure receipt. The page does the saving (see `saveBlob`); the hub keeps nothing of it.

/** Save `value` as a pretty-printed JSON file named `filename`. */
export function downloadJson(filename: string, value: unknown): void {
  saveBlob(filename, new Blob([`${JSON.stringify(value, null, 2)}\n`], { type: 'application/json' }));
}
