// The matcher no longer imports obscenity at run time (its root also loads a ready-made English word list, a real slur
// list, which then rode along into every browser bundle: see scripts/browser-bundle.test.ts). `src/vendored/wordEngine.ts`
// carries the few pieces it used: a copy of obscenity's English-preset transformers and of its regexp matcher, cut down to what
// `buildMatcher` calls. Matching behaviour must not change by a single verdict, so these tests hold the copy against the real
// thing. Tests are not bundled for browsers, so they may import obscenity (and its preset) as the reference.
//
// Only synthetic words and harmless text: no real term anywhere.
import { DataSet, RegExpMatcher, englishRecommendedBlacklistMatcherTransformers, englishRecommendedTransformers, parseRawPattern } from 'obscenity';
import { describe, expect, it } from 'vitest';
import { compileWords, transformLikePreset } from '../src/vendored/wordEngine.js';

/** The reference: obscenity's own transformer objects, applied one code point at a time (stateful ones from their factory),
 *  exactly as its matcher does. */
function referenceTransform(input: string): string {
  const chain = englishRecommendedBlacklistMatcherTransformers.map((t) => (t.type === 1 ? { stateful: t.factory() } : { simple: t.transform }));
  let out = '';
  for (const ch of input) {
    let cp: number | undefined = ch.codePointAt(0)!;
    for (const step of chain) {
      if (cp === undefined) break;
      cp = 'simple' in step ? step.simple!(cp) : step.stateful!.transform(cp);
    }
    if (cp !== undefined) out += String.fromCodePoint(cp);
  }
  return out;
}

/** What buildMatcher used to do with obscenity, word for word. */
function referenceMatcher(words: readonly string[]) {
  const dataset = new DataSet<{ i: number }>();
  words.forEach((w, i) => dataset.addPhrase((p) => p.setMetadata({ i }).addPattern(parseRawPattern(`|${w}|`))));
  return new RegExpMatcher({ blacklistedTerms: dataset.build().blacklistedTerms, ...englishRecommendedTransformers });
}

const WORDS = ['zorbak', 'glarn', 'vlemmo', 'drakkuun', 'fenrisk', 'bloop', 'tass'];

// leet, look-alike letters, repeats, spacing, case, Unicode. All harmless; the synthetic WORDS above are what the cases hide.
const TRICKY: [string, string][] = [
  ['plain', 'hello there, nothing to see'],
  ['empty', ''],
  ['one letter', 'z'],
  ['leet digits', 'z0rb4k and gl4rn and vl3mm0'],
  ['leet punctuation', 'zorb@k gl@rn fenr!sk (glarn) zorbak! |zorbak| $tass'],
  ['leet 5 and 7', 'tas5 7ass bl00p 8l00p'],
  ['leet slash', 'v/emmo vlemmo/ /ass'],
  ['confusables cyrillic', 'зорбак zorbаk glаrn'],
  ['confusables fullwidth', 'ｚｏｒｂａｋ ＧＬＡＲＮ'],
  ['confusables circled', 'ⓩⓞⓡⓑⓐⓚ'],
  ['confusables math bold', '𝐳𝐨𝐫𝐛𝐚𝐤 𝐙orbak'],
  ['repeats', 'zzzorrrbbbaaakkk glaaaarrrn vlemmmmmo drakkkuuuun'],
  ['repeats kept at two', 'bloop bloooop blooooooop tass tasss taaaass'],
  ['repeats of the kept letters', 'gg ll ee oo ss bb gggg llll eeee oooo ssss bbbb'],
  ['repeated spaces', 'zorbak     glarn      tass'],
  ['spacing apart', 'z o r b a k  g l a r n  f e n r i s k'],
  ['separators', 'zor-bak zor_bak zor.bak zor,bak'],
  ['tabs and newlines', 'zorbak\tglarn\nfenrisk\r\ntass'],
  ['case', 'ZORBAK Zorbak zOrBaK GLARN gLaRn FENRISK'],
  ['whole word edges', 'unzorbak zorbakish xglarn glarnx 9glarn glarn9 _tass_ -tass-'],
  ['digits touching', 'zorbak1 1zorbak zorbak123 123glarn'],
  ['accents', 'zorbák glärn fenrïsk zörbak'],
  ['combining marks', 'zórbak glar̂n z̲orbak'],
  ['surrogate pairs', '😀zorbak😀 😀 glarn😀😀 tass😀x'],
  ['lone surrogates', '\ud800zorbak \udc00glarn zorbak\ud800 \ud800'],
  ['zero width', 'zor​bak gl‌arn fen‍risk ﻿zorbak'],
  ['right to left', 'אבג zorbak العربية glarn'],
  ['two hits and overlap', 'zorbak zorbak zorbakzorbak zorbak glarn zorbak'],
  ['hit at both ends', 'zorbak middle glarn'],
  ['long line', `${'lorem ipsum '.repeat(300)}zorbak${' dolor sit'.repeat(300)}`],
  ['all punctuation', '!|(/$@[]{}.*+?^\\ zorbak !|(/$@'],
  ['regexp specials around', '(zorbak) [glarn] {tass} zorbak? zorbak* zorbak+ ^zorbak$ zorbak\\ zorbak|'],
];

describe("transformLikePreset: the same transformed text as obscenity's English preset", () => {
  it.each(TRICKY)('%s', (_name, text) => {
    expect(transformLikePreset(text).text).toBe(referenceTransform(text));
  });

  it('agrees on every single code point of the first three Unicode planes (so no table entry was lost or changed in the copy)', () => {
    const bad: string[] = [];
    for (let cp = 0; cp < 0x30000; cp++) {
      if (cp >= 0xd800 && cp <= 0xdfff) continue; // lone surrogates: covered by name above
      const ch = String.fromCodePoint(cp);
      if (transformLikePreset(ch).text !== referenceTransform(ch)) bad.push(cp.toString(16));
    }
    expect(bad).toEqual([]);
  });

  it('agrees on every pair of letters and marks that the collapse step could treat as a run', () => {
    const chars = [...'abcdeglostz0123456789@!|$(/ -_AEGLOSZ'];
    const bad: string[] = [];
    for (const a of chars) for (const b of chars) for (const c of chars) {
      const s = a + b + c;
      if (transformLikePreset(s).text !== referenceTransform(s)) bad.push(s);
    }
    expect(bad).toEqual([]);
  });

  it('maps every transformed character back into the original text, in order', () => {
    for (const [, text] of TRICKY) {
      const { text: out, toOrig } = transformLikePreset(text);
      expect(toOrig).toHaveLength(out.length);
      for (let i = 0; i < toOrig.length; i++) {
        expect(toOrig[i]).toBeGreaterThanOrEqual(0);
        expect(toOrig[i]).toBeLessThan(Math.max(text.length, 1));
        if (i > 0) expect(toOrig[i]!).toBeGreaterThanOrEqual(toOrig[i - 1]!);
      }
    }
  });

  it('resolves the documented classes: leetspeak, look-alikes, ASCII case, runs', () => {
    expect(transformLikePreset('Z0RB4K').text).toBe('zorbak');
    expect(transformLikePreset('ｚｏｒ').text).toBe('zor');
    expect(transformLikePreset('zzzorrrbak').text).toBe('zorbak');
    expect(transformLikePreset('bloooop').text).toBe('bloop'); // o is kept at two
    expect(transformLikePreset('').text).toBe('');
  });

  it('resets its run state between calls: a run never carries over from the previous text', () => {
    expect(transformLikePreset('aaa').text).toBe('a');
    expect(transformLikePreset('aaa').text).toBe('a');
    expect(transformLikePreset('a').text).toBe('a');
    const first = transformLikePreset('xx').text;
    expect(transformLikePreset('x').text).toBe('x');
    expect(transformLikePreset('xx').text).toBe(first);
  });
});

describe("compileWords: the same hits as obscenity's RegExpMatcher with the English preset transformers", () => {
  const ours = compileWords(WORDS);
  const theirs = referenceMatcher(WORDS);

  it.each(TRICKY)('%s', (_name, text) => {
    expect(ours.getAllMatches(text)).toEqual(theirs.getAllMatches(text, true));
  });

  it('numbers the terms by their position in the list, like the dataset did', () => {
    const hits = ours.getAllMatches('glarn zorbak');
    expect(hits.map((h) => h.termId)).toEqual([1, 0]);
    expect(hits.map((h) => h.termId)).toEqual(theirs.getAllMatches('glarn zorbak', true).map((h) => h.termId));
  });

  it('reports the hits sorted by position, then by term', () => {
    const text = 'fenrisk zorbak glarn zorbak';
    const hits = ours.getAllMatches(text);
    for (let i = 1; i < hits.length; i++) expect(hits[i]!.startIndex).toBeGreaterThanOrEqual(hits[i - 1]!.startIndex);
    expect(hits).toEqual(theirs.getAllMatches(text, true));
  });

  it('a word listed twice is two terms with their own ids, both reported, like the dataset', () => {
    const twice = compileWords(['zorbak', 'zorbak']);
    const ref = referenceMatcher(['zorbak', 'zorbak']);
    expect(twice.getAllMatches('zorbak')).toEqual(ref.getAllMatches('zorbak', true));
    expect(twice.getAllMatches('zorbak').map((h) => h.termId)).toEqual([0, 1]);
  });

  it('an empty list matches nothing', () => {
    expect(compileWords([]).getAllMatches('zorbak glarn')).toEqual([]);
    expect(referenceMatcher([]).getAllMatches('zorbak glarn', true)).toEqual([]);
  });

  it('is reusable: the same text twice gives the same hits, and an unrelated call in between changes nothing', () => {
    const a = ours.getAllMatches('zzzorbak glaaarn');
    ours.getAllMatches('xxxxxxxxxx');
    expect(ours.getAllMatches('zzzorbak glaaarn')).toEqual(a);
  });

  it('agrees on a few thousand generated lines (seeded, so a failure reproduces)', () => {
    // A small alphabet that keeps hitting the interesting cases: the term letters, leet marks, look-alikes, separators, case,
    // digits, an astral character, a lone surrogate and a zero-width character.
    const alphabet = [
      ...'zorbakglnvlemdufis',
      ...'ZORBAKGLN',
      ...'0134567@!|$(/',
      ' ', ' ', ' ', '-', '_', '.', '\t',
      'а', 'о', 'ｚ', 'ⓞ',
      'é', '́', '​',
      '😀', '\ud800',
      'a', 'a', 'o', 'o', 'e', 'e', 's', 's', 'l', 'g', 'b',
    ];
    let seed = 0x2f6e2b1;
    const next = () => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed / 2 ** 32;
    };
    let hitLines = 0;
    for (let n = 0; n < 4000; n++) {
      const length = 1 + Math.floor(next() * 40);
      let text = '';
      for (let i = 0; i < length; i++) {
        // Sometimes splice a whole word, so hits are common and the boundary cases are exercised, not just noise.
        text += next() < 0.12 ? WORDS[Math.floor(next() * WORDS.length)]! : alphabet[Math.floor(next() * alphabet.length)]!;
      }
      const want = theirs.getAllMatches(text, true);
      if (want.length > 0) hitLines++;
      expect(ours.getAllMatches(text), JSON.stringify(text)).toEqual(want);
    }
    expect(hitLines).toBeGreaterThan(150); // the generator really does produce hits
  });
});
