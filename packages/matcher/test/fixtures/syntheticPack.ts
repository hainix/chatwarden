// Synthetic term pack for the matcher tests. Every word here is invented: none is a real word in en, es or pt,
// and the pack carries no real slur, hate term or profanity. Each term exists to exercise one mechanism of the
// matcher, so a regression names the mechanism it broke.
//
// A plain data module (no imports, no logic): Task 7 builds the TermPack type on top of it.

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
      'zórbák',
      'ｚｏｒｂａｋ',
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
export const SYNTHETIC_EXCEPTIONS: SyntheticException[] = [
  { id: 'syn-ex:tarvo-lake', phrase: 'tarvo lake', language: 'en' },
  { id: 'syn-ex:glarn-zorbak', phrase: 'glarn zorbak', language: 'en' },
];

/** Invented words that are not in the pack: they must never block. */
export const UNLISTED_WORDS: string[] = ['blorft', 'snoddle', 'wumpity', 'grizzlebop', 'flimbo', 'quorvit'];
