import { describe, expect, it } from 'vitest';
import { createR2 } from './r2.js';

describe('the Map-backed R2 bucket', () => {
  it('stores strings and bytes, reads them back, and records the order of the writes', async () => {
    const r2 = createR2();
    await r2.put('b/index.json', '{"a":1}');
    await r2.put('a/zip', new Uint8Array([1, 2, 3]));
    expect(r2.writes).toEqual(['b/index.json', 'a/zip']);
    expect(await (await r2.get('b/index.json'))?.text()).toBe('{"a":1}');
    expect(new Uint8Array((await (await r2.get('a/zip'))?.arrayBuffer()) as ArrayBuffer)).toEqual(new Uint8Array([1, 2, 3]));
    expect(await r2.get('missing')).toBeNull();
  });

  it('does not alias the caller bytes, lists by prefix in order with paging, and deletes', async () => {
    const r2 = createR2();
    const bytes = new Uint8Array([9]);
    await r2.put('x/1', bytes);
    bytes[0] = 0;
    expect(r2.bytes('x/1')).toEqual(new Uint8Array([9]));
    await r2.put('x/2', 'b');
    await r2.put('y/1', 'c');
    const first = await r2.list({ prefix: 'x/', limit: 1 });
    expect(first.objects.map((o) => o.key)).toEqual(['x/1']);
    expect(first.truncated).toBe(true);
    const next = await r2.list({ prefix: 'x/', limit: 1, cursor: first.cursor ?? '' });
    expect(next.objects.map((o) => o.key)).toEqual(['x/2']);
    expect(next.truncated).toBe(false);
    await r2.delete(['x/1', 'x/2']);
    expect((await r2.list({ prefix: 'x/' })).objects).toEqual([]);
  });

  it('can fail the Nth put once, and writes nothing for it', async () => {
    const r2 = createR2();
    r2.failPut(2);
    await r2.put('one', '1');
    await expect(r2.put('two', '2')).rejects.toThrow();
    await r2.put('two', '2');
    expect(r2.writes).toEqual(['one', 'two']);
  });
});
