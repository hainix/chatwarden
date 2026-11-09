/** True for the "SQLite is an experimental feature" warning Node 22 prints when node:sqlite loads. */
export function isSqliteExperimental(warning: unknown, type?: unknown): boolean {
  const text = warning instanceof Error ? warning.message : String(warning);
  const name =
    warning instanceof Error ? warning.name : typeof type === 'string' ? type : (type as { type?: string } | undefined)?.type;
  return name === 'ExperimentalWarning' && /sqlite/i.test(text);
}

/** Drop only that warning from `process.emitWarning`; every other warning still goes through. */
export function silenceSqliteExperimentalWarning(): void {
  const original = process.emitWarning.bind(process) as (...args: unknown[]) => void;
  process.emitWarning = ((warning: unknown, type?: unknown, ...rest: unknown[]) => {
    if (isSqliteExperimental(warning, type)) return;
    original(warning, type, ...rest);
  }) as typeof process.emitWarning;
}
