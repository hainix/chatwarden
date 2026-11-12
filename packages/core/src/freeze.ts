/** Freeze a value and everything inside it (plain data: objects, arrays, numbers, strings). Returns the same value. */
export function deepFreeze<T>(v: T): T {
  if (typeof v === 'object' && v !== null && !Object.isFrozen(v)) {
    Object.freeze(v);
    for (const item of Object.values(v)) deepFreeze(item);
  }
  return v;
}
