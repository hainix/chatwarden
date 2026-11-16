// A small, strict argument reader for the maintainers' tools: `--name value`, `--flag`, no abbreviations, no positional arguments. An unknown name,
// a missing value or a repeated name is a refusal (a UsageError whose message is fixed text plus the flag's name, never a value: a value may be a path
// or a secret).

export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UsageError';
  }
}

export type ArgSpec = Record<string, 'value' | 'flag'>;

export function parseArgs(argv: readonly string[], spec: ArgSpec): Record<string, string | true> {
  const out: Record<string, string | true> = {};
  for (let i = 0; i < argv.length; i += 1) {
    const raw = argv[i] as string;
    if (!raw.startsWith('--') || raw.length < 3) throw new UsageError('unexpected argument; every argument is --name or --name value');
    const name = raw.slice(2);
    const kind = Object.hasOwn(spec, name) ? spec[name] : undefined;
    if (kind === undefined) throw new UsageError(`unknown option --${name}`);
    if (Object.hasOwn(out, name)) throw new UsageError(`--${name} given twice`);
    if (kind === 'flag') {
      out[name] = true;
      continue;
    }
    const value = argv[i + 1];
    if (value === undefined || value.startsWith('--')) throw new UsageError(`--${name} needs a value`);
    out[name] = value;
    i += 1;
  }
  return out;
}

/** The value of a `value` option, or undefined. */
export const valueOf = (args: Record<string, string | true>, name: string): string | undefined => {
  const v = args[name];
  return typeof v === 'string' ? v : undefined;
};
