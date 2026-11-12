import { sha256Hex } from '../crypto.js';
import type { AIReadInput } from './types.js';

/**
 * The input hash a stored read is valid for (design section 6): sha256 over the prompt version, the rendered stable prefix (the
 * policy text that changes meaning), the case's own rendered inputs and the adapter id, in that order. The casebook examples are
 * NOT part of it: a growing casebook must not make every stored read look stale, and the read records the ids of the examples it
 * used instead (`AIStoredRead.exampleIds`). The `example:` rows are therefore left out of the variable part before hashing; no
 * other row of the data block can begin that way (a chat line starts `L<n> `, the rest are fixed keys). The fields are framed as a
 * JSON array, so no part can slide into the next. Object key order in `input` cannot matter: only those values are read. A hex
 * string of 64 characters.
 * @experimental
 */
export function inputHash(input: AIReadInput, adapterId: string): string {
  const caseInputs = input.prompt.variable
    .split('\n')
    .filter((row) => !row.startsWith('example: '))
    .join('\n');
  return sha256Hex(JSON.stringify([input.promptVersion, input.prompt.stable, caseInputs, adapterId]));
}
