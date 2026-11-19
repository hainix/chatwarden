import { setupContract } from '../../../test/contract/setup.contract.js';
import { MemoryStore } from '../src/index.js';

// M5 (review R1): `getSetupState` and `saveSetupState` are optional on the Store interface, so the contract skips a store without the pair instead of throwing.
// The suite registered here runs against a store that lacks them: it must report skipped tests, not failures. (MemoryStore itself runs it in contract.test.ts.)
function bare(): MemoryStore {
  const s = new MemoryStore();
  Object.defineProperty(s, 'getSetupState', { value: undefined });
  Object.defineProperty(s, 'saveSetupState', { value: undefined });
  return s;
}
setupContract('a store without the setup pair', bare);
