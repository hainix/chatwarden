import { afterEach, describe, expect, it, vi } from 'vitest';
import { CORPUS_ZIP_PASSWORD, CorpusError } from '../src/corpus/index.js';
import { ZIP_LIMITS, readZip } from '../src/corpus/zip.js';
import { crc32, deflatedZeros, prng, writeZip, type ZipEntrySpec } from './corpus-zip-writer.js';

const enc = new TextEncoder();
const dec = new TextDecoder();
const PW = CORPUS_ZIP_PASSWORD;

async function code(bytes: Uint8Array, options?: Parameters<typeof readZip>[1]): Promise<string> {
  try {
    await readZip(bytes, options);
  } catch (e) {
    expect(e).toBeInstanceOf(CorpusError);
    expect((e as CorpusError).stage).toBe('unpack');
    return (e as CorpusError).code;
  }
  return 'ok';
}
const text = (m: Map<string, Uint8Array>, name: string): string => dec.decode(m.get(name));
/** A deflated entry whose headers (both) claim `usize` bytes and `crc`, over a ready-made deflate stream. */
const claim = (name: string, raw: Uint8Array, usize: number, crc: number): ZipEntrySpec => ({ name, method: 8, rawData: raw, usize, crc, localUsize: usize, localCrc: crc });
const one = (over: Partial<ZipEntrySpec> = {}): ZipEntrySpec => ({ name: 'terms.json', data: '[{"term":"zorbak"}]', method: 8, ...over });

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('the limits', () => {
  it('are the documented ones, frozen', () => {
    expect(ZIP_LIMITS).toEqual({ entries: 32, compressed: 8 * 1024 * 1024, expanded: 32 * 1024 * 1024, name: 64 });
    expect(Object.isFrozen(ZIP_LIMITS)).toBe(true);
  });
});

describe('reading', () => {
  it('reads stored and deflated entries, with the right password', async () => {
    const zip = writeZip([
      { name: 'plain-stored.txt', data: 'hello zorbak', method: 0 },
      { name: 'plain-deflated.txt', data: 'hello vlemmo '.repeat(50), method: 8 },
      { name: 'secret-stored.json', data: '{"a":1}', method: 0, password: PW },
      { name: 'secret-deflated.json', data: '["quissel"]'.repeat(40), method: 8, password: PW },
      { name: 'secret-descriptor.json', data: '["drakkuun"]', method: 8, password: PW, descriptor: true },
    ]);
    const files = await readZip(zip, { password: PW });
    expect([...files.keys()]).toEqual(['plain-stored.txt', 'plain-deflated.txt', 'secret-stored.json', 'secret-deflated.json', 'secret-descriptor.json']);
    expect(text(files, 'plain-stored.txt')).toBe('hello zorbak');
    expect(text(files, 'plain-deflated.txt')).toBe('hello vlemmo '.repeat(50));
    expect(text(files, 'secret-stored.json')).toBe('{"a":1}');
    expect(text(files, 'secret-deflated.json')).toBe('["quissel"]'.repeat(40));
    expect(text(files, 'secret-descriptor.json')).toBe('["drakkuun"]');
    // the password defaults to the public one
    expect((await readZip(zip)).size).toBe(5);
    // a password given for a zip that has none is harmless (control)
    expect((await readZip(writeZip([one()]), { password: 'anything' })).size).toBe(1);
    // a view over a larger buffer is read as the view
    const padded = new Uint8Array(zip.length + 20);
    padded.set(zip, 7);
    expect((await readZip(padded.subarray(7, 7 + zip.length))).size).toBe(5);
  });

  it('a wrong password is bad_zip (the check byte or the CRC), not a throw of another class', async () => {
    const stored = writeZip([{ name: 'a.json', data: '["fenrisk","tarvo"]', method: 0, password: PW }]);
    const deflated = writeZip([{ name: 'a.json', data: '["fenrisk","tarvo"]'.repeat(30), method: 8, password: PW }]);
    const rand = prng(7);
    const wrong = ['', 'x', 'chatwarden-term', 'chatwarden-terms ', 'Chatwarden-terms', 'caf\u00e9', '\u0000', 'chatwarden-termS'];
    for (let i = 0; i < 300; i += 1) wrong.push(Array.from({ length: 1 + Math.floor(rand() * 20) }, () => String.fromCharCode(33 + Math.floor(rand() * 90))).join(''));
    for (const password of wrong) {
      expect(await code(stored, { password }), JSON.stringify(password)).toBe('bad_zip');
      expect(await code(deflated, { password }), JSON.stringify(password)).toBe('bad_zip');
    }
    // the check byte alone: a header whose check byte is wrong is refused even with the right password
    expect(await code(writeZip([{ name: 'a.json', data: 'abc', password: PW, badCheckByte: true }]))).toBe('bad_zip');
    // non-string passwords never throw anything else
    for (const password of [undefined, null, 12, {}] as unknown[]) {
      const c = await code(stored, { password: password as string });
      expect(['ok', 'bad_zip']).toContain(c);
    }
  });

  it('the expanded bytes equal the bytes written, for an empty file, a 1-byte file, a 1 MiB file and non-ASCII UTF-8 content', async () => {
    const rand = prng(99);
    const mib = new Uint8Array(1024 * 1024);
    for (let i = 0; i < mib.length; i += 1) mib[i] = i % 3 === 0 ? Math.floor(rand() * 256) : 97 + (i % 7);
    const utf8 = enc.encode('caf\u00e9 na\u00efve \u65e5\u672c\u8a9e \u{1f600} \u00f1and\u00fa \u00e7\u00e3o');
    const cases: Array<[string, Uint8Array]> = [
      ['empty.json', new Uint8Array(0)],
      ['one.bin', new Uint8Array([0])],
      ['one-ff.bin', new Uint8Array([255])],
      ['mib.bin', mib],
      ['utf8.txt', utf8],
    ];
    for (const method of [0, 8]) {
      for (const password of [undefined, PW]) {
        const zip = writeZip(cases.map(([name, data]) => ({ name, data, method, ...(password === undefined ? {} : { password }) })));
        const files = await readZip(zip);
        expect([...files.keys()]).toEqual(cases.map(([n]) => n));
        for (const [name, data] of cases) {
          const got = files.get(name)!;
          expect(got.length, `${name} m${method}`).toBe(data.length);
          expect(Buffer.from(got).equals(Buffer.from(data)), `${name} m${method} pw=${password !== undefined}`).toBe(true);
        }
      }
    }
    // the result is a fresh copy, not a view over the input
    const zip = writeZip([{ name: 'a.txt', data: 'abc', method: 0 }]);
    const files = await readZip(zip);
    zip.fill(0);
    expect(text(files, 'a.txt')).toBe('abc');
    // an archive of no entries is an empty map
    expect((await readZip(writeZip([]))).size).toBe(0);
  });
});

describe('malformed archives', () => {
  it('a CRC mismatch, a truncated archive, a truncated central directory, a comment longer than the file, an offset past the end: bad_zip', async () => {
    const base = writeZip([{ name: 'a.txt', data: 'abcdefgh', method: 0 }, one({ name: 'b.json' })]);
    expect(await code(base)).toBe('ok');
    // a flipped data byte (stored): the CRC no longer matches
    const flipped = base.slice();
    flipped[35 + 2] = (flipped[35 + 2] as number) ^ 1; // the third data byte of the first entry (30 header bytes, then a 5-byte name)
    expect(await code(flipped)).toBe('bad_zip');
    // the CRC field in the central directory wrong
    const wrong = crc32(enc.encode('abcdefgh')) ^ 1;
    expect(await code(writeZip([{ name: 'a.txt', data: 'abcdefgh', method: 0, crc: wrong }]))).toBe('bad_zip');
    // both headers agree on a wrong CRC: only the check of the data against it can refuse this
    expect(await code(writeZip([{ name: 'a.txt', data: 'abcdefgh', method: 0, crc: wrong, localCrc: wrong }]))).toBe('bad_zip');
    expect(await code(writeZip([{ name: 'a.txt', data: 'abcdefgh'.repeat(9), method: 8, crc: wrong, localCrc: wrong }]))).toBe('bad_zip');
    // a local header that disagrees with the central one about the CRC (no descriptor)
    expect(await code(writeZip([{ name: 'a.txt', data: 'abcdefgh', localCrc: 1 }]))).toBe('bad_zip');
    // every proper prefix of a small archive is refused (a truncation anywhere)
    for (let n = 0; n < base.length; n += 1) expect(await code(base.subarray(0, n)), `prefix ${n}`).toBe('bad_zip');
    // the central directory cut: its size says more than is there
    expect(await code(writeZip([one()], { eocd: { cdSize: 9999 } }))).toBe('bad_zip');
    expect(await code(writeZip([one()], { eocd: { cdSize: 10 } }))).toBe('bad_zip');
    expect(await code(writeZip([one()], { eocd: { cdOffset: 0 } }))).toBe('bad_zip');
    expect(await code(writeZip([one()], { eocd: { cdOffset: 0x7fffffff } }))).toBe('bad_zip');
    // the entry count says more than the directory holds, or less
    expect(await code(writeZip([one()], { eocd: { entries: 2, entriesDisk: 2 } }))).toBe('bad_zip');
    expect(await code(writeZip([one(), one({ name: 'b.json' })], { eocd: { entries: 1, entriesDisk: 1 } }))).toBe('bad_zip');
    // a comment longer than the file, and one that does not reach the end of it
    expect(await code(writeZip([one()], { comment: 'x', eocd: { commentLength: 60000 } }))).toBe('bad_zip');
    expect(await code(writeZip([one()], { comment: 'abc', eocd: { commentLength: 1 } }))).toBe('bad_zip');
    expect(await code(writeZip([one()], { comment: 'abc', eocd: { commentLength: 5 } }))).toBe('bad_zip');
    // an offset past the end, and one into the middle of the central directory
    expect(await code(writeZip([one({ offset: 0xfffffff0 })]))).toBe('bad_zip');
    expect(await code(writeZip([one({ offset: 1000 })]))).toBe('bad_zip');
    expect(await code(writeZip([one({ offset: 3 })]))).toBe('bad_zip');
    // a local signature that is not one
    expect(await code(writeZip([one({ localSignature: 0x04034b51 })]))).toBe('bad_zip');
    // not a zip at all: nothing, one byte, text, zeros, the signature alone
    for (const junk of [new Uint8Array(0), new Uint8Array(1), enc.encode('PK\u0005\u0006'), enc.encode('not a zip, zorbak'), new Uint8Array(100), new Uint8Array(22).fill(0x50)]) {
      expect(await code(junk)).toBe('bad_zip');
    }
    // a valid archive with a comment (even one that contains the end-of-directory signature) and an honest length is fine
    expect(await code(writeZip([one()], { comment: 'plain comment' }))).toBe('ok');
    // things that are not bytes
    for (const bad of [null, undefined, 'PK', 12, [1, 2], {}, new Uint16Array(30)] as unknown[]) expect(await code(bad as Uint8Array)).toBe('bad_zip');
  });

  it('a local header that disagrees with the central directory, overlapping entries and data past the directory: bad_zip', async () => {
    expect(await code(writeZip([one({ centralName: 'other.json' })]))).toBe('bad_zip');
    expect(await code(writeZip([one({ centralMethod: 0 })]))).toBe('bad_zip');
    expect(await code(writeZip([one({ localMethod: 0 })]))).toBe('bad_zip');
    expect(await code(writeZip([one({ centralFlags: 0x800 })]))).toBe('bad_zip');
    expect(await code(writeZip([one({ localUsize: 5 })]))).toBe('bad_zip');
    expect(await code(writeZip([one({ localCsize: 5 })]))).toBe('bad_zip');
    // the central sizes claim more data than there is room for
    expect(await code(writeZip([one({ csize: 5000, localCsize: 5000 })]))).toBe('bad_zip');
    // an entry whose local header and data sit inside another entry's data (a quine-style overlap): every cross-check passes, the overlap does not
    const inner = writeZip([{ name: 'b.txt', data: 'bee', method: 0 }]).slice(0, 30 + 5 + 3);
    const nested = writeZip([{ name: 'a.txt', data: inner, method: 0 }, { name: 'b.txt', data: 'bee', method: 0, offset: 30 + 5 }]);
    expect(await code(nested)).toBe('bad_zip');
    expect(await code(writeZip([{ name: 'a.txt', data: inner, method: 0 }, { name: 'b.txt', data: 'bee', method: 0 }]))).toBe('ok');
    // a declared size that disagrees with the data (stored)
    expect(await code(writeZip([{ name: 'a.txt', data: 'abcdef', method: 0, usize: 3, localUsize: 3 }]))).toBe('bad_zip');
    expect(await code(writeZip([{ name: 'a.txt', data: 'abcdef', method: 0, usize: 9, localUsize: 9 }]))).toBe('bad_zip');
    // deflated data that is not deflate, and deflate that ends early or runs on
    expect(await code(writeZip([claim('a.txt', enc.encode('this is not a deflate stream'), 5, 0)]))).toBe('bad_zip');
    expect(await code(writeZip([{ name: 'a.txt', data: 'abcdef'.repeat(20), method: 8, usize: 10, localUsize: 10 }]))).toBe('bad_zip');
    expect(await code(writeZip([{ name: 'a.txt', data: 'abcdef', method: 8, usize: 600, localUsize: 600 }]))).toBe('bad_zip');
    // bytes before the first header and after the archive (a leading offset breaks every offset; a trailer breaks the comment rule)
    expect(await code(Uint8Array.from([...enc.encode('zzzz'), ...writeZip([one()])]))).toBe('bad_zip');
    expect(await code(writeZip([one()], { trailing: enc.encode('zzzz') }))).toBe('bad_zip');
  });

  it('zip64 records, an encrypted entry with the AES flag, a data descriptor with a zero size, method 12 (bzip2): refused', async () => {
    const zip64Extra = Uint8Array.from([0x01, 0x00, 0x08, 0x00, 1, 0, 0, 0, 0, 0, 0, 0]);
    expect(await code(writeZip([one()], { zip64Locator: true }))).toBe('bad_zip');
    expect(await code(writeZip([one({ centralExtra: zip64Extra })]))).toBe('bad_zip');
    expect(await code(writeZip([one({ localExtra: zip64Extra })]))).toBe('bad_zip');
    expect(await code(writeZip([one({ usize: 0xffffffff })]))).toBe('bad_zip');
    expect(await code(writeZip([one({ csize: 0xffffffff })]))).toBe('bad_zip');
    expect(await code(writeZip([one({ offset: 0xffffffff })]))).toBe('bad_zip');
    expect(await code(writeZip([one()], { eocd: { entries: 0xffff, entriesDisk: 0xffff } }))).toBe('bad_zip');
    expect(await code(writeZip([one()], { eocd: { cdOffset: 0xffffffff } }))).toBe('bad_zip');
    expect(await code(writeZip([one()], { eocd: { cdSize: 0xffffffff } }))).toBe('bad_zip');
    // AES: method 99, the encrypted bit and the strong-encryption bit, and its extra field
    const aesExtra = Uint8Array.from([0x01, 0x99, 0x07, 0x00, 2, 0, 0x41, 0x45, 3, 8, 0]);
    expect(await code(writeZip([one({ method: 99, flags: 0x41, password: PW, localExtra: aesExtra, centralExtra: aesExtra })]))).toBe('bad_zip');
    expect(await code(writeZip([one({ flags: 0x41, password: PW })]))).toBe('bad_zip');
    expect(await code(writeZip([one({ centralExtra: aesExtra, localExtra: aesExtra })]))).toBe('bad_zip');
    // a data descriptor with a zero size in the directory (the reader does not read descriptors)
    expect(await code(writeZip([{ name: 'a.txt', data: 'abc', method: 0, descriptor: true, csize: 0, usize: 0, crc: 0, localCsize: 0, localUsize: 0, localCrc: 0 }]))).toBe('bad_zip');
    expect(await code(writeZip([{ name: 'a.txt', data: '', method: 0, descriptor: true }]))).toBe('bad_zip');
    // a descriptor with the real sizes in the directory is readable (control)
    expect(await code(writeZip([{ name: 'a.txt', data: 'abc', method: 0, descriptor: true }]))).toBe('ok');
    // other methods: bzip2 (12), lzma (14), shrink (1), implode (6), deflate64 (9), ppmd (98), and 7
    for (const method of [1, 6, 9, 12, 14, 93, 95, 98, 99, 7, 65535]) {
      expect(await code(writeZip([{ name: 'a.txt', data: 'abc', method }])), `method ${method}`).toBe('bad_zip');
    }
    // other flag bits: patched data (5), strong encryption (6), a masked header (13), reserved bits
    for (const flags of [0x20, 0x40, 0x2000, 0x10, 0x1000, 0x4000, 0x8000, 0x80, 0x100, 0x200, 0x400]) {
      expect(await code(writeZip([{ name: 'a.txt', data: 'abc', flags }])), `flags ${flags}`).toBe('bad_zip');
    }
    // multi-disk archives
    expect(await code(writeZip([one()], { eocd: { disk: 1 } }))).toBe('bad_zip');
    expect(await code(writeZip([one()], { eocd: { cdDisk: 1 } }))).toBe('bad_zip');
    expect(await code(writeZip([one()], { eocd: { entriesDisk: 2 } }))).toBe('bad_zip');
    expect(await code(writeZip([one({ disk: 1 })]))).toBe('bad_zip');
  });
});

describe('names', () => {
  it('a name with a slash, a backslash, .., a leading dot-dot, 65 characters, a duplicate, or a control character is refused', async () => {
    const refused = [
      'a/b.json',
      '/abs.json',
      'dir/',
      'a\\b.json',
      '..',
      '.',
      '../evil.json',
      '..evil',
      'a..b',
      'x'.repeat(65),
      '',
      'tab\there',
      'new\nline',
      'nul\u0000x',
      'esc\u001bx',
      'del\u007fx',
      'has space',
      'colon:x',
      'caf\u00e9.json',
      '\u65e5\u672c.json',
      'a*b',
      'a?b',
      '%2e%2e',
      'C:evil',
      'con.json\u0000.txt',
    ];
    for (const name of refused) expect(await code(writeZip([{ name, data: 'x' }])), JSON.stringify(name)).toBe('bad_zip');
    // the same name in the central directory only
    expect(await code(writeZip([{ name: 'ok.json', data: 'x', centralName: '../ok.json' }]))).toBe('bad_zip');
    // duplicates, exact and by case
    expect(await code(writeZip([{ name: 'a.json', data: 'x' }, { name: 'a.json', data: 'y' }]))).toBe('bad_zip');
    expect(await code(writeZip([{ name: 'a.json', data: 'x' }, { name: 'A.JSON', data: 'y' }]))).toBe('bad_zip');
    // the accepted names, including the 64-character edge and the names the release uses
    const accepted = ['a', 'x'.repeat(64), 'manifest.json', 'terms.json', 'negative.en.json', 'LICENSE.txt', 'README.txt', 'a-b_c.d', '.hidden', 'UPPER.JSON', '0'];
    for (const name of accepted) expect(await code(writeZip([{ name, data: 'x' }])), name).toBe('ok');
    // the limit is a parameter: 8 characters refuses 9
    expect(await code(writeZip([{ name: 'abcdefghi', data: 'x' }]), { limits: { name: 8 } })).toBe('bad_zip');
    expect(await code(writeZip([{ name: 'abcdefgh', data: 'x' }]), { limits: { name: 8 } })).toBe('ok');
  });
});

describe('limits and bombs', () => {
  it('33 entries and an archive of 8 MiB + 1 are refused; a deflate bomb (a few KB expanding past 32 MiB) stops at the budget and allocates no more than it', async () => {
    const entries = (n: number): ZipEntrySpec[] => Array.from({ length: n }, (_, i) => ({ name: `f${i}.txt`, data: String(i), method: 0 }));
    expect(await code(writeZip(entries(32)))).toBe('ok');
    expect(await code(writeZip(entries(33)))).toBe('bad_zip');
    expect(await code(writeZip(entries(0xfffe)))).toBe('bad_zip');
    expect(await code(writeZip(entries(5)), { limits: { entries: 4 } })).toBe('bad_zip');
    // an archive over 8 MiB is refused for its length alone (the bytes need not be a zip)
    expect(await code(new Uint8Array(8 * 1024 * 1024 + 1))).toBe('bad_zip');
    // and one just under it that is a real zip is read
    const big = new Uint8Array(4 * 1024 * 1024);
    const rand = prng(5);
    for (let i = 0; i < big.length; i += 1) big[i] = Math.floor(rand() * 256);
    expect(await code(writeZip([{ name: 'big.bin', data: big, method: 0 }]))).toBe('ok');
    expect(await code(writeZip([{ name: 'big.bin', data: new Uint8Array(8 * 1024 * 1024 - 400), method: 0 }]))).toBe('ok');
    expect(await code(writeZip([{ name: 'big.bin', data: new Uint8Array(8 * 1024 * 1024 + 1), method: 0 }]))).toBe('bad_zip');

    // the bomb: 300 MiB of zeros in a few hundred KB. First as it would be declared truthfully, then lying about its size.
    const bomb = await deflatedZeros(300);
    expect(bomb.length).toBeLessThan(1024 * 1024);
    const truthful = writeZip([claim('bomb.bin', bomb, 300 * 1024 * 1024, 0)]);
    expect(await code(truthful)).toBe('bad_zip');
    // the size claimed small, the data enormous: stopped by the declared size, not trusted to be honest
    const lying = writeZip([claim('bomb.bin', bomb, 1000, 0)]);
    // how much the reader pulls out of the inflater is counted, through a stand-in for DecompressionStream
    let pulled = 0;
    const Real = globalThis.DecompressionStream;
    class Counting {
      readonly readable: ReadableStream<Uint8Array>;
      readonly writable: WritableStream<Uint8Array>;
      constructor(format: ConstructorParameters<typeof DecompressionStream>[0]) {
        const real = new Real(format);
        this.writable = real.writable as WritableStream<Uint8Array>;
        this.readable = (real.readable as ReadableStream<Uint8Array>).pipeThrough(
          new TransformStream<Uint8Array, Uint8Array>({
            transform(chunk, controller) {
              pulled += chunk.length;
              controller.enqueue(chunk);
            },
          }),
        );
      }
    }
    vi.stubGlobal('DecompressionStream', Counting);
    const started = Date.now();
    expect(await code(lying)).toBe('bad_zip');
    expect(pulled).toBeLessThan(ZIP_LIMITS.expanded);
    expect(pulled).toBeLessThan(8 * 1024 * 1024);
    // a bomb whose declared size is honest but over the budget is refused before any inflating
    pulled = 0;
    expect(await code(truthful)).toBe('bad_zip');
    expect(pulled).toBe(0);
    // an honest entry of exactly the budget is read; the budget is across entries, declared and counted
    pulled = 0;
    const exact = await deflatedZeros(32);
    const zExact = writeZip([claim('z.bin', exact, 32 * 1024 * 1024, crc32(new Uint8Array(32 * 1024 * 1024)))]);
    const files = await readZip(zExact);
    expect(files.get('z.bin')!.length).toBe(32 * 1024 * 1024);
    expect(pulled).toBe(32 * 1024 * 1024);
    // 3 x 12 MiB of honest declared sizes is over the 32 MiB total: refused up front, though each alone is fine
    const twelve = await deflatedZeros(12);
    const crc12 = crc32(new Uint8Array(12 * 1024 * 1024));
    const spec = (name: string): ZipEntrySpec => claim(name, twelve, 12 * 1024 * 1024, crc12);
    pulled = 0;
    expect(await code(writeZip([spec('a'), spec('b'), spec('c')]))).toBe('bad_zip');
    expect(pulled).toBe(0);
    expect(await code(writeZip([spec('a'), spec('b')]))).toBe('ok');
    // the whole run of bombs was quick
    expect(Date.now() - started).toBeLessThan(20_000);
  }, 30_000);

  it('the limits are parameters: a smaller expanded budget refuses a file that fits the default, and a bad parameter falls back to the default', async () => {
    const zip = writeZip([{ name: 'a.txt', data: 'x'.repeat(5000), method: 8 }]);
    expect(await code(zip)).toBe('ok');
    expect(await code(zip, { limits: { expanded: 1000 } })).toBe('bad_zip');
    expect(await code(zip, { limits: { compressed: 100 } })).toBe('bad_zip');
    for (const bad of [-1, 0, NaN, Infinity, '5000' as unknown as number, null as unknown as number]) {
      expect(await code(zip, { limits: { expanded: bad } }), String(bad)).toBe('ok');
      expect(await code(zip, { limits: { entries: bad } }), String(bad)).toBe('ok');
    }
    // a limit cannot be raised above the documented one
    expect(await code(new Uint8Array(8 * 1024 * 1024 + 1), { limits: { compressed: 64 * 1024 * 1024 } })).toBe('bad_zip');
  });
});

describe('hostile bytes', () => {
  it('the reader never reads outside the buffer: 500 mutated archives, each a map or a CorpusError, and the answer is the same whatever surrounds the buffer', async () => {
    const seeds = [
      writeZip([{ name: 'manifest.json', data: '{"kind":"terms"}', method: 8, password: PW }, { name: 'terms.json', data: '[{"term":"glarn"}]'.repeat(5), method: 0, password: PW }]),
      writeZip([{ name: 'a.txt', data: 'abc', method: 0 }, { name: 'b.txt', data: 'defgh'.repeat(10), method: 8 }], { comment: 'a comment' }),
      writeZip([{ name: 'c.txt', data: 'snerp', method: 8, password: PW, descriptor: true }]),
    ];
    const rand = prng(1234);
    const results: string[] = [];
    for (let n = 0; n < 500; n += 1) {
      const base = seeds[n % seeds.length]!;
      let mutated = base.slice();
      const kind = n % 5;
      if (kind === 0) {
        const i = Math.floor(rand() * mutated.length);
        mutated[i] = Math.floor(rand() * 256);
      } else if (kind === 1) {
        for (let k = 0; k < 1 + Math.floor(rand() * 6); k += 1) mutated[Math.floor(rand() * mutated.length)] = Math.floor(rand() * 256);
      } else if (kind === 2) {
        mutated = mutated.slice(0, Math.floor(rand() * mutated.length));
      } else if (kind === 3) {
        // a field somewhere in the last 100 bytes (the end record and the tail of the directory) set to an extreme
        const i = Math.max(0, mutated.length - 1 - Math.floor(rand() * 100));
        mutated[i] = rand() < 0.5 ? 0xff : 0x00;
        mutated[Math.min(mutated.length - 1, i + 1)] = 0xff;
      } else {
        const i = Math.floor(rand() * mutated.length);
        mutated = Uint8Array.from([...mutated.slice(0, i), ...mutated.slice(i + 1 + Math.floor(rand() * 8))]);
      }
      // the same archive surrounded by zeros and by 0xff: an out-of-range read would see a different neighbour
      const surround = (fill: number): Uint8Array => {
        const buf = new Uint8Array(mutated.length + 64).fill(fill);
        buf.set(mutated, 32);
        return buf.subarray(32, 32 + mutated.length);
      };
      const outcomes: string[] = [];
      for (const view of [mutated, surround(0), surround(0xff)]) {
        try {
          const files = await readZip(view);
          outcomes.push(`ok:${[...files.entries()].map(([k, v]) => `${k}=${Buffer.from(v).toString('hex')}`).join(',')}`);
        } catch (e) {
          expect(e, `case ${n}`).toBeInstanceOf(CorpusError);
          outcomes.push(`err:${(e as CorpusError).code}`);
        }
      }
      expect(outcomes[1], `case ${n}`).toBe(outcomes[0]);
      expect(outcomes[2], `case ${n}`).toBe(outcomes[0]);
      results.push(outcomes[0]!.slice(0, 3));
    }
    // the mutations are not all trivially refused (a control: some archives still read, most do not)
    expect(results.filter((r) => r === 'ok:').length).toBeGreaterThan(0);
    expect(results.filter((r) => r === 'err').length).toBeGreaterThan(100);
  });

  it('CorpusError from the reader: no message contains any string from the archive', async () => {
    const words = ['zorbak', 'vlemmo', 'quissel', 'drakkuun', 'fenrisk', 'tarvo', 'snerp', 'glarn'];
    const archives = [
      writeZip(words.map((w) => ({ name: `${w}/..`, data: w }))),
      writeZip(words.map((w) => ({ name: `${w}.txt`, data: w, method: 12 }))),
      writeZip([{ name: 'a.txt', data: words.join(' '), password: 'quissel-vlemmo' }]),
      writeZip([{ name: 'a.txt', data: words.join(' '), crc: 7 }], { comment: words.join(' ') }),
      enc.encode(words.join(' ')),
    ];
    for (const a of archives) {
      let err: CorpusError | null = null;
      try {
        await readZip(a);
      } catch (e) {
        err = e as CorpusError;
      }
      expect(err).toBeInstanceOf(CorpusError);
      for (const t of [err!.message, String(err), JSON.stringify(err), JSON.stringify(Object.getOwnPropertyNames(err))]) {
        for (const w of words) expect(t.toLowerCase()).not.toContain(w);
      }
    }
  });
});
