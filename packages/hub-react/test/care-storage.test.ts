import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { addOpened, careSettings, localDay, readCare, readOpened, resetCare, setCare, subscribeCare, writeCare } from '../src/care.js';
import type { StorageLike } from '../src/care.js';

// The careful view's browser storage (design 7): the setting, the counter and the break choice are read and written through localStorage in try/catch; a storage that throws leaves the
// setting for the visit and nothing breaks.

const KEY = { hide: 'chatwarden.hub.care.hide', count: 'chatwarden.hub.care.count', brk: 'chatwarden.hub.care.break', day: 'chatwarden.hub.care.day' } as const;

function memoryStorage(initial: Record<string, string> = {}): StorageLike & { data: Map<string, string> } {
  const data = new Map(Object.entries(initial));
  return { data, getItem: (k) => data.get(k) ?? null, setItem: (k, v) => void data.set(k, v), removeItem: (k) => void data.delete(k) };
}
const throwing: StorageLike = {
  getItem: () => {
    throw new Error('denied');
  },
  setItem: () => {
    throw new Error('denied');
  },
  removeItem: () => {
    throw new Error('denied');
  },
};

beforeEach(() => {
  resetCare();
  try {
    localStorage.clear();
  } catch {
    // no storage
  }
});
afterEach(() => {
  resetCare();
  vi.restoreAllMocks();
});

describe('reading', () => {
  it('everything is off with an empty storage, and with none at all', () => {
    expect(readCare(memoryStorage())).toEqual({ hideExcerpts: false, countOpened: false, breakAfter: 0 });
    expect(readCare(null)).toEqual({ hideExcerpts: false, countOpened: false, breakAfter: 0 });
  });

  it('reads what was written, each field on its own', () => {
    const s = memoryStorage();
    writeCare({ hideExcerpts: true }, s);
    expect(readCare(s)).toEqual({ hideExcerpts: true, countOpened: false, breakAfter: 0 });
    writeCare({ countOpened: true, breakAfter: 25 }, s);
    expect(readCare(s)).toEqual({ hideExcerpts: true, countOpened: true, breakAfter: 25 });
    writeCare({ hideExcerpts: false }, s);
    expect(readCare(s).hideExcerpts).toBe(false);
  });

  it('a value that is not one of ours reads as off, never as a guess', () => {
    const s = memoryStorage({ [KEY.hide]: 'yes', [KEY.count]: '2', [KEY.brk]: 'abc' });
    expect(readCare(s)).toEqual({ hideExcerpts: false, countOpened: false, breakAfter: 0 });
    expect(readCare(memoryStorage({ [KEY.brk]: '-5' })).breakAfter).toBe(0);
    expect(readCare(memoryStorage({ [KEY.brk]: '1.5' })).breakAfter).toBe(0);
    expect(readCare(memoryStorage({ [KEY.brk]: '5000' })).breakAfter).toBe(0);
    expect(readCare(memoryStorage({ [KEY.brk]: '10' })).breakAfter).toBe(10);
  });

  it('writes only the fields given, and removes a field that went back to off (nothing is left in the browser)', () => {
    const s = memoryStorage();
    writeCare({ hideExcerpts: true, breakAfter: 10 }, s);
    expect([...s.data.keys()].sort()).toEqual([KEY.brk, KEY.hide]);
    writeCare({ hideExcerpts: false, breakAfter: 0 }, s);
    expect([...s.data.keys()]).toEqual([]);
  });
});

describe('a storage that throws', () => {
  it('reading and writing never throw, and read as off', () => {
    expect(() => readCare(throwing)).not.toThrow();
    expect(readCare(throwing)).toEqual({ hideExcerpts: false, countOpened: false, breakAfter: 0 });
    expect(() => writeCare({ hideExcerpts: true }, throwing)).not.toThrow();
    expect(() => readOpened(Date.now(), throwing)).not.toThrow();
    expect(() => addOpened(Date.now(), throwing)).not.toThrow();
  });

  it('leaves the setting for the visit: the hub\'s copy follows what was set, whatever the browser did', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('denied');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('denied');
    });
    expect(careSettings().hideExcerpts).toBe(false);
    setCare({ hideExcerpts: true, countOpened: true });
    expect(careSettings()).toEqual({ hideExcerpts: true, countOpened: true, breakAfter: 0 });
    // And the count lasts for the visit too.
    const now = new Date(2027, 0, 15, 12, 0, 0).getTime();
    expect(addOpened(now)).toBe(1);
    expect(addOpened(now)).toBe(2);
    expect(readOpened(now)).toBe(2);
  });

  it('a window with no localStorage at all (the property itself throws) is the same', () => {
    const real = Object.getOwnPropertyDescriptor(window, 'localStorage');
    Object.defineProperty(window, 'localStorage', {
      configurable: true,
      get: () => {
        throw new Error('blocked');
      },
    });
    try {
      resetCare();
      expect(careSettings().hideExcerpts).toBe(false);
      setCare({ hideExcerpts: true });
      expect(careSettings().hideExcerpts).toBe(true);
    } finally {
      if (real !== undefined) Object.defineProperty(window, 'localStorage', real);
    }
  });
});

describe('the settings the hub holds', () => {
  it('setCare writes through localStorage and notifies the parts that listen (once per change)', () => {
    const seen: boolean[] = [];
    const off = subscribeCare(() => seen.push(careSettings().hideExcerpts));
    setCare({ hideExcerpts: true });
    expect(localStorage.getItem(KEY.hide)).toBe('1');
    setCare({ hideExcerpts: false });
    off();
    setCare({ hideExcerpts: true });
    expect(seen).toEqual([true, false]);
  });

  it('a setting changed to what it already is notifies no one', () => {
    let n = 0;
    subscribeCare(() => (n += 1));
    setCare({ hideExcerpts: false });
    expect(n).toBe(0);
  });
});

describe('the daily counter', () => {
  const at = (h: number, m = 0, day = 15): number => new Date(2027, 0, day, h, m, 0).getTime();

  it('keys the day by the browser\'s local date', () => {
    expect(localDay(at(0, 5))).toBe('2027-01-15');
    expect(localDay(at(23, 59))).toBe('2027-01-15');
    expect(localDay(at(0, 0, 16))).toBe('2027-01-16');
  });

  it('counts up through the day and starts over at local midnight', () => {
    const s = memoryStorage();
    expect(readOpened(at(9), s)).toBe(0);
    expect(addOpened(at(9), s)).toBe(1);
    expect(addOpened(at(23, 59), s)).toBe(2);
    expect(readOpened(at(23, 59), s)).toBe(2);
    expect(readOpened(at(0, 1, 16), s)).toBe(0);
    expect(addOpened(at(0, 1, 16), s)).toBe(1);
    // Going back (a clock set back) is another day's count, not a continuation.
    expect(readOpened(at(9), s)).toBe(0);
  });

  it('a stored count that is damaged reads as zero and is replaced, never a crash', () => {
    for (const junk of ['{', '[]', '{"day":5,"n":"x"}', '{"day":"2027-01-15","n":-3}', '{"day":"2027-01-15","n":1.5}', 'null', '']) {
      const s = memoryStorage({ [KEY.day]: junk });
      expect(readOpened(at(9), s), junk).toBe(0);
      expect(addOpened(at(9), s), junk).toBe(1);
    }
  });

  it('stores only a day and a number: no case, no person, no text', () => {
    const s = memoryStorage();
    addOpened(at(9), s);
    addOpened(at(9), s);
    expect(JSON.parse(s.data.get(KEY.day) as string)).toEqual({ day: '2027-01-15', n: 2 });
    expect([...s.data.keys()]).toEqual([KEY.day]);
  });
});
