import { describe, expect, it } from 'vitest';
import { CORPUS_ZIP_PASSWORD, readZip, ZIP_LIMITS } from '@chatwarden/matcher/corpus';
import { writeReleaseZip } from '../src/build/zip.js';

// The release zip writer (design 6.4): the kit's own reader is the judge. A test that passes here means a game can open the file.

const enc = new TextEncoder();
const T = Date.UTC(2026, 11, 1, 10, 30, 12);
const entries = [
  { name: 'manifest.json', data: enc.encode('{"a":1}') },
  { name: 'terms.json', data: enc.encode('[' + '{"x":"zorbak"},'.repeat(200) + '{}]') },
  { name: 'empty.json', data: new Uint8Array(0) },
  { name: 'README.txt', data: enc.encode('invented words only') },
];
const text = (b: Uint8Array | undefined): string => new TextDecoder().decode(b);

describe('writeReleaseZip', () => {
  it('is read back by the kit reader with the public password: names in order, bytes intact', async () => {
    const zip = writeReleaseZip(entries, { password: CORPUS_ZIP_PASSWORD, time: T });
    const read = await readZip(zip);
    expect([...read.keys()]).toEqual(entries.map((e) => e.name));
    for (const e of entries) expect(text(read.get(e.name))).toBe(text(e.data));
  });

  it('is deterministic: the same entries and time give byte-identical archives', () => {
    const a = writeReleaseZip(entries, { password: CORPUS_ZIP_PASSWORD, time: T });
    const b = writeReleaseZip(entries.map((e) => ({ ...e })), { password: CORPUS_ZIP_PASSWORD, time: T });
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(true);
  });

  it('changes when the time or a byte changes (the time is the injected clock, nothing else)', () => {
    const base = Buffer.from(writeReleaseZip(entries, { password: CORPUS_ZIP_PASSWORD, time: T }));
    expect(base.equals(Buffer.from(writeReleaseZip(entries, { password: CORPUS_ZIP_PASSWORD, time: T + 4000 })))).toBe(false);
    const other = [{ name: 'manifest.json', data: enc.encode('{"a":2}') }, ...entries.slice(1)];
    expect(base.equals(Buffer.from(writeReleaseZip(other, { password: CORPUS_ZIP_PASSWORD, time: T })))).toBe(false);
  });

  it('is encrypted: another password is refused by the reader, and no entry text appears in the archive', async () => {
    const zip = writeReleaseZip(entries, { password: CORPUS_ZIP_PASSWORD, time: T });
    await expect(readZip(zip, { password: 'not-the-password' })).rejects.toMatchObject({ code: 'bad_zip' });
    expect(Buffer.from(zip).includes(Buffer.from('invented words only'))).toBe(false);
    expect(Buffer.from(zip).includes(Buffer.from('zorbak'))).toBe(false);
  });

  it('a flipped byte in the archive is refused by the reader (CRC and structure)', async () => {
    const zip = writeReleaseZip(entries, { password: CORPUS_ZIP_PASSWORD, time: T });
    for (const at of [40, 100, Math.floor(zip.length / 2), zip.length - 30]) {
      const bad = zip.slice();
      bad[at] = (bad[at] as number) ^ 0x55;
      await expect(readZip(bad), String(at)).rejects.toMatchObject({ code: 'bad_zip' });
    }
  });

  it('refuses names the reader would refuse, a duplicate (any case), too many entries and too long a name', () => {
    const w = (list: { name: string; data: Uint8Array }[]) => () => writeReleaseZip(list, { password: CORPUS_ZIP_PASSWORD, time: T });
    const one = (name: string) => [{ name, data: enc.encode('x') }];
    for (const name of ['a/b.json', '..', 'a..b', 'a b', '', 'caf\u00e9.json', 'x'.repeat(65)]) expect(w(one(name)), name).toThrow(RangeError);
    expect(w([...one('a.json'), ...one('A.json')])).toThrow(RangeError);
    expect(w(Array.from({ length: ZIP_LIMITS.entries + 1 }, (_, i) => ({ name: `f${i}.json`, data: enc.encode('x') })))).toThrow(RangeError);
  });

  it('refuses a time before 1980 and a missing password, and an archive over the reader limit', () => {
    expect(() => writeReleaseZip(entries, { password: CORPUS_ZIP_PASSWORD, time: Date.UTC(1970, 0, 1) })).toThrow(RangeError);
    expect(() => writeReleaseZip(entries, { password: '', time: T })).toThrow(RangeError);
    const big = [{ name: 'big.bin', data: new Uint8Array(ZIP_LIMITS.expanded + 1) }];
    expect(() => writeReleaseZip(big, { password: CORPUS_ZIP_PASSWORD, time: T })).toThrow(RangeError);
  });

  it('compresses repetitive text (deflate) and still stays within the reader limits', async () => {
    const data = enc.encode('zorbak '.repeat(100_000));
    const zip = writeReleaseZip([{ name: 'a.json', data }], { password: CORPUS_ZIP_PASSWORD, time: T });
    expect(zip.length).toBeLessThan(data.length / 20);
    expect((await readZip(zip)).get('a.json')?.length).toBe(data.length);
  });
});
