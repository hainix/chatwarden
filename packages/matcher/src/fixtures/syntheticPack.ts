// Synthetic term pack, shipped as `@chatwarden/matcher/fixtures`. Every word here is invented: none is a real word in en,
// es or pt, and the pack carries no real slur, hate term or profanity. Each term exists to exercise one mechanism
// of the matcher, so a regression names the mechanism it broke.
//
// A plain data module (no imports, no logic).

export interface SyntheticTerm {
  /** Row id the tests give the term (the matcher reports it back as `termId`). */
  id: string;
  term: string;
  language: string;
  /** What the term exercises. */
  mechanism: string;
  /** Lines that must block, and must block because of THIS term. */
  positive: string[];
  /** Lines that must never block (under the whole pack). */
  negative: string[];
}

export interface SyntheticException {
  id: string;
  phrase: string;
  language: string;
}

export const SYNTHETIC_TERMS: SyntheticTerm[] = [
  {
    id: 'syn:zorbak',
    term: 'zorbak',
    language: 'en',
    mechanism: 'plain word: case, accents, fullwidth, invisible characters, glued punctuation',
    positive: [
      'zorbak',
      'ZORBAK',
      'you zorbak',
      'Zorbak!',
      'zorbak!!',
      '(zorbak)',
      '"zorbak"',
      '$zorbak',
      '@zorbak',
      'zorbak,',
      'z\u00f3rb\u00e1k',
      '\uff5a\uff4f\uff52\uff42\uff41\uff4b',
      'z0rbak',
    ],
    negative: ['zorba', 'zorbek', 'zorbakian', 'zorbaking', 'szorbak', 'zor bek', 'zorba!'],
  },
  {
    id: 'syn:vlemmo',
    term: 'vlemmo',
    language: 'en',
    mechanism: 'a doubled letter (m) that the preset collapses, so the term must be collapsed too',
    positive: ['vlemmo', 'VLEMMO', 'vlemo', 'vlemmmo', 'you vlemmo?', 'vlemmo;'],
    negative: ['vlem', 'vlemmoid', 'vlemmos', 'uvlemmo', 'vlemma'],
  },
  {
    id: 'syn:quissel',
    term: 'quissel',
    language: 'en',
    mechanism: 'a doubled letter (s) that the preset keeps, so a single s is a different word',
    positive: ['quissel', 'QUISSEL', 'quisssel', 'qu1ssel', 'qu!ssel', 'qui$$el', 'quissel.', 'you quissel!!! leave'],
    negative: ['quisel', 'quissels', 'quisselish', 'quiss', 'equissel'],
  },
  {
    id: 'syn:drakkuun',
    term: 'drakkuun',
    language: 'en',
    mechanism: 'two collapsing doubles (kk and uu)',
    positive: ['drakkuun', 'drakun', 'drakkun', 'DRAKKUUUN', 'seu drakkuun|', 'drakkuun/vlemmo'],
    negative: ['draku', 'drakunk', 'drakkuuns', 'idrakkuun', 'drakuunk'],
  },
  {
    id: 'syn:fenrisk',
    term: 'fenrisk',
    language: 'en',
    mechanism: 'leetspeak digits and punctuation standing for letters',
    positive: ['fenrisk', 'f3nr1sk', 'f3nr1sk!', 'fenr!sk', 'f3nri$k', 'F3NR1SK', 'you fenrisk;'],
    negative: ['fenris', 'fenrisks', 'fenriskian', 'ofenrisk', 'f3nr1sks'],
  },
  {
    id: 'syn:tarvo',
    term: 'tarvo',
    language: 'en',
    mechanism: 'the first word of an exception phrase (tarvo lake); the exception edges are word-bounded',
    positive: [
      'tarvo',
      'you tarvo',
      'tarvo lakes',
      'tarvo lakeside',
      'tarvo lake9',
      'tarvo, lake',
      'tarvo lake tarvo',
      'tarvo tarvo lake',
      'tarvo lake, you tarvo, tarvo lake',
    ],
    negative: [
      'tarvo lake',
      'TARVO LAKE',
      'tarvo lake!',
      'sorry, tarvo lake today',
      '(tarvo lake)',
      'atarvo lake',
      'tarvos',
      'tarvoish',
    ],
  },
  {
    id: 'syn:snerp',
    term: 'snerp',
    language: 'en',
    mechanism: 'a term that sits inside an innocent longer word (Scunthorpe-style); whole-word only',
    positive: ['snerp', 'you snerp', 'SNERP!', 'snerp/zorbak'],
    negative: ['snerpington', 'Snerpington Abbey', 'snerpington!', 'snerping', 'unsnerp', 'snerpy'],
  },
];

/** Exceptions: a phrase containing a term whose match is suppressed. Two shapes, so both word-bounded edges
 *  are exercised: the term first ("tarvo lake") and the term last ("glarn zorbak"). */
/** A synthetic term in a script written without spaces (Han, Hiragana, Katakana, Thai), with the mode it is matched in (absent: `segment`, the default for such a term). */
export interface SyntheticUnspacedTerm extends SyntheticTerm {
  matchMode?: 'segment' | 'contains';
}

// Terms in scripts written without spaces. Every string is invented: transliterations of the test word zorbak, and two fragments of ordinary place names (an Albanian-sounding Han sequence inside the Chinese name
// of Albania, and the start of the Thai word for a country) that exist to show a term not hitting inside a longer dictionary word. Each ships lines it must hit and lines it must not hit, in its own script;
// a negative line must not be blocked by ANY of these terms. How the dictionary segmenter cuts a line moves between ICU versions, so the corpus gate runs on every supported Node.
export const SYNTHETIC_UNSPACED_TERMS: SyntheticUnspacedTerm[] = [
  {
    id: 'syn:han-zorbak',
    term: '\u4f50\u5c14\u5df4\u514b',
    language: 'zh',
    mechanism: 'Han, segment: an unknown term the segmenter splits into single characters, so its edges are always segment edges; a space or a gap inside it ends the run',
    positive: ['\u4f50\u5c14\u5df4\u514b', '\u4f60\u597d\u4f50\u5c14\u5df4\u514b\u518d\u89c1', '\u4f60\u597d\uff0c\u4f50\u5c14\u5df4\u514b\u3002'],
    negative: ['\u4f60\u597d\u518d\u89c1', '\u4f50\u5c14\u5df4 \u514b', '\u4f50\u5c14\u5df4'],
  },
  {
    id: 'syn:han-erbani',
    term: '\u5c14\u5df4\u5c3c',
    language: 'zh',
    mechanism: 'Han, segment: the same characters inside the one dictionary word \u963f\u5c14\u5df4\u5c3c\u4e9a do not hit, because the term does not occupy whole segments there',
    positive: ['\u5c14\u5df4\u5c3c', '\u4f60\u597d\uff0c\u5c14\u5df4\u5c3c\u3002\u518d\u89c1'],
    negative: ['\u6211\u53bb\u8fc7\u963f\u5c14\u5df4\u5c3c\u4e9a\u65c5\u6e38', '\u963f\u5c14\u5df4\u5c3c\u4e9a'],
  },
  {
    id: 'syn:kata-zorbak',
    term: '\u30be\u30eb\u30d0\u30af',
    language: 'ja',
    mechanism: 'Katakana, segment: a katakana run is one segment, so the term hits as a whole word and not at the start of a longer one',
    positive: ['\u30be\u30eb\u30d0\u30af', '\u3053\u308c\u306f\u30be\u30eb\u30d0\u30af\u3067\u3059', '\u30be\u30eb\u30d0\u30af\u3001\u30be\u30eb\u30d0\u30af'],
    negative: ['\u30be\u30eb\u30d0\u30af\u30b9\u30ad\u30fc', '\u3053\u308c\u306f\u30be\u30eb\u30d0\u3067\u3059', '\u30be\u30eb \u30d0\u30af'],
  },
  {
    id: 'syn:hira-zorbak',
    term: '\u305e\u308b\u3070\u304f',
    language: 'ja',
    mechanism: 'Hiragana, segment: read as katakana, so the hiragana and the katakana spelling of one term both hit',
    positive: ['\u305e\u308b\u3070\u304f', '\u3072\u3089\u304c\u306a\u306e\u305e\u308b\u3070\u304f\u3067\u3059', '\u3053\u308c\u306f\u30be\u30eb\u30d0\u30af\u3067\u3059'],
    negative: ['\u305e\u308b\u3070\u304b', '\u305e \u308b\u3070\u304f'],
  },
  {
    id: 'syn:thai-zorbak',
    term: '\u0e0b\u0e2d\u0e23\u0e4c\u0e1a\u0e31\u0e01',
    language: 'th',
    mechanism: 'Thai, segment: a term with a vowel sign and a thanthakhat that NFKC keeps, found between words with no space',
    positive: ['\u0e0b\u0e2d\u0e23\u0e4c\u0e1a\u0e31\u0e01', '\u0e09\u0e31\u0e19\u0e40\u0e2b\u0e47\u0e19\u0e0b\u0e2d\u0e23\u0e4c\u0e1a\u0e31\u0e01\u0e17\u0e35\u0e48\u0e19\u0e31\u0e48\u0e19', '\u0e0b\u0e2d\u0e23\u0e4c\u0e1a\u0e31\u0e01 \u0e0b\u0e2d\u0e23\u0e4c\u0e1a\u0e31\u0e01'],
    negative: ['\u0e09\u0e31\u0e19\u0e40\u0e2b\u0e47\u0e19\u0e17\u0e35\u0e48\u0e19\u0e31\u0e48\u0e19', '\u0e0b\u0e2d\u0e23\u0e4c \u0e1a\u0e31\u0e01'],
  },
  {
    id: 'syn:thai-prathe',
    term: '\u0e1b\u0e23\u0e30\u0e40\u0e17',
    language: 'th',
    mechanism: 'Thai, segment: the start of the dictionary word \u0e1b\u0e23\u0e30\u0e40\u0e17\u0e28 is not a whole segment of it, so the term does not hit there',
    positive: ['\u0e1b\u0e23\u0e30\u0e40\u0e17', '\u0e09\u0e31\u0e19 \u0e1b\u0e23\u0e30\u0e40\u0e17 \u0e2a\u0e27\u0e22'],
    negative: ['\u0e1b\u0e23\u0e30\u0e40\u0e17\u0e28\u0e44\u0e17\u0e22\u0e2a\u0e27\u0e22\u0e07\u0e32\u0e21', '\u0e1b\u0e23\u0e30\u0e40\u0e17\u0e28'],
  },
];

export const SYNTHETIC_EXCEPTIONS: SyntheticException[] = [
  { id: 'syn-ex:tarvo-lake', phrase: 'tarvo lake', language: 'en' },
  { id: 'syn-ex:glarn-zorbak', phrase: 'glarn zorbak', language: 'en' },
];

/** Invented words that are not in the pack: they must never block. */
export const UNLISTED_WORDS: string[] = ['blorft', 'snoddle', 'wumpity', 'grizzlebop', 'flimbo', 'quorvit'];
