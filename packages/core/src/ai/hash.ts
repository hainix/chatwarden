import { sha256Hex } from '../crypto.js';
import type { AIReadInput } from './types.js';

/**
 * The input hash a stored read is valid for (design section 6): sha256 over the prompt version, the rendered stable prefix, the
 * rendered variable part and the adapter id, in that order. The fields are framed as a JSON array, so no part can slide into
 * the next. Object key order in `input` cannot matter: only those four values are read. A hex string of 64 characters.
 * @experimental
 */
export function inputHash(input: AIReadInput, adapterId: string): string {
  return sha256Hex(JSON.stringify([input.promptVersion, input.prompt.stable, input.prompt.variable, adapterId]));
}
