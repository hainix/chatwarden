// Golden values computed with the 0.1.0 implementation (node:crypto createHmac/createHash) BEFORE the isomorphic
// crypto change. Moxgate stores these hashes; they must never change, on the native or the pure-JS path.
import { afterEach, describe, expect, it } from 'vitest';
import { __forcePureJs } from '../src/crypto.js';
import { decisionKey } from '../src/decide.js';
import { makeHasher } from '../src/hasher.js';
import type { SubjectIndex } from '../src/subjects.js';

/** [secret, input, clientKey(input), ip(input)] */
const HASHES: ReadonlyArray<readonly [string, string, string, string]> = [
  ["cw-test-secret", "", "627885001f518b6dfd51d7195cd3e6de", "5cedbf2ea7c5f0fba65bb492de48bcfd"],
  ["cw-test-secret", "tok-1", "3479e956cc5f4a6bf787a7d5e48d2924", "20a3ed0fa7c66b9e83ed59346cd600c6"],
  ["cw-test-secret", "203.0.113.7", "ad7c1d8a2f44e8ab17d08a6ff1cc30fc", "e46dc4c1d8ae7679e5a5871123cb155e"],
  ["cw-test-secret", "2001:db8::1", "6d70e11c9fa26a5a1ad66242c39ab98e", "8d76e0fdd97f602daccb7b5997a5d3d1"],
  ["cw-test-secret", "ünï-💬", "0a9e8b8b9e9cc80a07f1597123ba334e", "481167bbbe12eac773d83a4f64bc29d0"],
  ["cw-test-secret", "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "b31d3d26ea123c6e44899541896e3459", "28f21ba23570530409e55343f7a2633d"],
  ["cw-test-secret", "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "4cb7e20a2aa2ca813cf95905fcf52677", "b6e77859ef9fbd019f90b3a1dd295104"],
  ["cw-test-secret", "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "aff5f10fe7d6378fb85fc2e8b3d4bfe1", "1c9879f5f0cd3117c4d6b3aefa5f4b0a"],
  ["cw-test-secret", "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", "7b7655d5267b0bc9f19c332c87405f5e", "891125c25c336e12a766e70f055b7103"],
  ["cw-test-secret", "line\nbreak\u0000nul", "ef17391d020a37a6f28f7db62fc3f5df", "3f415681ff97013ba9af98957d448c3d"],
  ["secret-a", "", "bd2b79609fda5bca48415bfc3e75d0b0", "e32a28310a2ebecf7c1238edb7906043"],
  ["secret-a", "tok-1", "ddcbc2e154e8e78ba9da8ef67133bf78", "c775c2b87a09304f1daca417ebb1aeac"],
  ["secret-a", "203.0.113.7", "a042fedc992cdd9107a87b6df37e106c", "4d7ff019b7e1be09e18663bd839b3d3f"],
  ["secret-a", "2001:db8::1", "66a3278c4a94bc49872505527f1f080b", "8aa42b4fb8a07a3cca0bf7ddb0e0565a"],
  ["secret-a", "ünï-💬", "76f66d8feebb8bfc61809ec3feae398b", "fdb9b5163786e8ce4a6922dfac5d4f3f"],
  ["secret-a", "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "c572b664d8fa6925586bdb8f4fcee508", "8d69e6102d99f586e4cca8548ac3d931"],
  ["secret-a", "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "e28fe26d4a5ab2041e8fe9fdd56b0b5b", "ec66bf4932277ce4ea197e40626f13dc"],
  ["secret-a", "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "1a3863fb0b995ff782bb49c71a6ac263", "ceecc61f35cc00d21c9a0e3e5962665a"],
  ["secret-a", "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", "827abb0cf05652174c6df9a6d2538d9c", "1cf2c8682d19a4562de358bd224cb7af"],
  ["secret-a", "line\nbreak\u0000nul", "d8e7477b898563f0717a708988858824", "28c59332f0b0a15badc49db782ac72fa"],
  ["k", "", "86b50bb93adc16eac7098a43ff66ceae", "d28130d5ad729bd03efbff6aa1c95675"],
  ["k", "tok-1", "53e94cf6dc4ccec38d76fe8b9bee558e", "7beeccd377f79e961e7e139d478ccc36"],
  ["k", "203.0.113.7", "9d2a5e12b0edc96b2d0ccbd9401db345", "eb729218572d15a6658016f1226ea831"],
  ["k", "2001:db8::1", "09ac2e237b57ece422a8ae325e5c33bf", "7edfe4ee2edf868ec17727fd24fc6df5"],
  ["k", "ünï-💬", "0e0a12d89b7ceef3e8095355c5e4c01f", "6564a47044ca1d2f091c8051adfa86c3"],
  ["k", "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "f0bcf7d7e9a4f6268e93e4a558d0691c", "a265dd6630bfefe8124fc31b8438fd4f"],
  ["k", "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "f95d432867b35bd83ad157ead9c39076", "dc6069fa7051c924d5c166dadc3f48a3"],
  ["k", "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "72372ec34b94b00a943188e78c2254e6", "49ab8ad7462fdcd23d6bdd2e2f3c3e17"],
  ["k", "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", "9c84f99963b9e98168d94e27eb3237cf", "7a21db9b956a305259e1fe8295f69980"],
  ["k", "line\nbreak\u0000nul", "57f0ed14f03bf1dd36ac374977558905", "2fcd1a6d01894b21b25f18219514360d"],
  ["xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx", "", "4c3432d3274a2b508cd37fbc8102f2e7", "95c556fffdd74bd5b73f8d251840c2dc"],
  ["xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx", "tok-1", "b68da3afed7497888c2edcc0cf5ba04e", "a9aa8fa33cac23f51930beef699f1da6"],
  ["xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx", "203.0.113.7", "fe3ce2ca4fa4c66123b9e109b80b9fda", "3425b2c044c0e312d6f146a9021448b3"],
  ["xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx", "2001:db8::1", "3c0ff61af0b59fc9fd87eec3e17dc42f", "6228e71889c481b4cdfec25ed700adf2"],
  ["xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx", "ünï-💬", "f251fd40a3ea5e60fb0582542ec1a098", "4b5e3752f3c93717ec0f2e8463675c4a"],
  ["xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx", "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "61734bcccea68f349663668944d45894", "565be38a14402e5a4ee01c21ff01126d"],
  ["xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx", "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "492f34195f7c82a8d38ea263bcd5f262", "3b43425779dd9ccac0e3d681d0bb11e2"],
  ["xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx", "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "b42474a0b41cd7647961a6f11399b79f", "3ef0edd562c7c1dab98a44284b9310e0"],
  ["xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx", "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", "33a32f7a1b865ae6f9b9650c480e975b", "d76fdbf80c74e01f85a657db6fe8f9e6"],
  ["xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx", "line\nbreak\u0000nul", "0dde3743a67837bf72cc134629539413", "62a490af4cfb864abf7d2f3d3bd9ecd7"],
  ["yyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyy", "", "775deaf60f4c21ad81f2d40ed138c388", "dddee7f2835f4390da889fcca29c8d43"],
  ["yyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyy", "tok-1", "9df7404bad0fd8eeeeadc854c2d11f6d", "6e0edea5eeb37d86bdcfaf70a76ab3d4"],
  ["yyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyy", "203.0.113.7", "11f8d2ef4a15bb04a65fac3c7d952d25", "bb7cacaea044ef089fee3b0705b38d47"],
  ["yyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyy", "2001:db8::1", "52cf145a25ca4d844cdaa3d37eb1c2c1", "ada5cc66d6ab5d7598716f34bc7e7709"],
  ["yyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyy", "ünï-💬", "fb3ef2747488876915a9ab07b4811fdd", "b8129706a22174fee84faf11030aacd8"],
  ["yyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyy", "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "a0ca2909d652cdca34e18aad20aa18b9", "031a42ba90d1d53da05200971d6dc47f"],
  ["yyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyy", "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "2c07a86d5315a01e219075816f97c53b", "ba01507e25415822b0141cc143f49a84"],
  ["yyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyy", "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "6fff5ac393d2e50a380aad1ad17d495d", "f515c120c1e7866021920fb2d819e07a"],
  ["yyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyy", "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", "0d0074d6a7c22308a4fbd6ff7a2cef97", "716d461f0620cec77b5cb8d6e033c32c"],
  ["yyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyy", "line\nbreak\u0000nul", "cc1aedfbfa6bdce1a764ac5f61d7f4fd", "51c28748423e35851f316044e4b8dd99"],
  ["long-secret-long-secret-long-secret-long-secret-long-secret-long-secret-long-secret-long-secret-long-secret-long-secret-long-secret-long-secret-long-secret-long-secret-long-secret-long-secret-long-secret-long-secret-long-secret-long-secret-", "", "e19b892bcfe61e9a079a63b2fe737bee", "10c226dc1612ff59a18d884a689198c0"],
  ["long-secret-long-secret-long-secret-long-secret-long-secret-long-secret-long-secret-long-secret-long-secret-long-secret-long-secret-long-secret-long-secret-long-secret-long-secret-long-secret-long-secret-long-secret-long-secret-long-secret-", "tok-1", "981d667438e8c8d636bd134a297a9c60", "df91705be7b4ceb081f6da104de8df4b"],
  ["long-secret-long-secret-long-secret-long-secret-long-secret-long-secret-long-secret-long-secret-long-secret-long-secret-long-secret-long-secret-long-secret-long-secret-long-secret-long-secret-long-secret-long-secret-long-secret-long-secret-", "203.0.113.7", "841926c64edb8ff2de6ec49f754bcd1d", "f7e42080bd2c4e50a733c27691a6ed93"],
  ["long-secret-long-secret-long-secret-long-secret-long-secret-long-secret-long-secret-long-secret-long-secret-long-secret-long-secret-long-secret-long-secret-long-secret-long-secret-long-secret-long-secret-long-secret-long-secret-long-secret-", "2001:db8::1", "b069c49aae941f95ade929f41326d9f7", "e82705b970ea33d7930ab42953a94ab0"],
  ["long-secret-long-secret-long-secret-long-secret-long-secret-long-secret-long-secret-long-secret-long-secret-long-secret-long-secret-long-secret-long-secret-long-secret-long-secret-long-secret-long-secret-long-secret-long-secret-long-secret-", "ünï-💬", "2ec7ee0c2a1245026b22ba1044b16b97", "8dc4a765106ad97038b9b2215128b43c"],
  ["long-secret-long-secret-long-secret-long-secret-long-secret-long-secret-long-secret-long-secret-long-secret-long-secret-long-secret-long-secret-long-secret-long-secret-long-secret-long-secret-long-secret-long-secret-long-secret-long-secret-", "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "6f635709b6bf6aecfe641384c303d6d3", "32a6a3d222b81a03d2de83807d24fcee"],
  ["long-secret-long-secret-long-secret-long-secret-long-secret-long-secret-long-secret-long-secret-long-secret-long-secret-long-secret-long-secret-long-secret-long-secret-long-secret-long-secret-long-secret-long-secret-long-secret-long-secret-", "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "2b6e6a9cc6621738c0296a4b670e7765", "658b3133d1a83f1e3c8df15779e62cfd"],
  ["long-secret-long-secret-long-secret-long-secret-long-secret-long-secret-long-secret-long-secret-long-secret-long-secret-long-secret-long-secret-long-secret-long-secret-long-secret-long-secret-long-secret-long-secret-long-secret-long-secret-", "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "7ebbe5524833d07be76fa1421f4ea5fc", "45aa61fa7635a35d7103de18e92ef0eb"],
  ["long-secret-long-secret-long-secret-long-secret-long-secret-long-secret-long-secret-long-secret-long-secret-long-secret-long-secret-long-secret-long-secret-long-secret-long-secret-long-secret-long-secret-long-secret-long-secret-long-secret-", "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", "ae3d5296121aa38ddb64d9bea624cb4b", "0a901be53fa4b61a5ff72ec4404582c3"],
  ["long-secret-long-secret-long-secret-long-secret-long-secret-long-secret-long-secret-long-secret-long-secret-long-secret-long-secret-long-secret-long-secret-long-secret-long-secret-long-secret-long-secret-long-secret-long-secret-long-secret-", "line\nbreak\u0000nul", "1df4f51f3c5a7685201df5e0812dfbe7", "b0117e1136ffdfb8c1ad3473a90bdf44"],
  ["ünïcode-sécret-🔑", "", "2a541cd30edda8dae1baa48ad8b20481", "a974bf15477a8f5cb8c5db1e8eeaf015"],
  ["ünïcode-sécret-🔑", "tok-1", "7a6e89be7b53e4ffbd5824bf74cb80ca", "f90948de7ae373b48c2f568fb79df51a"],
  ["ünïcode-sécret-🔑", "203.0.113.7", "1e93ccc42d721d8ed9a6875b05b21b2d", "283eaea84e4d8c1b19f9dd2c40ab176d"],
  ["ünïcode-sécret-🔑", "2001:db8::1", "8f6ae59f98e1d56b88a78bcec98b7f23", "9f571f6b8cfd195eb64df3c800d34086"],
  ["ünïcode-sécret-🔑", "ünï-💬", "0e92d5f5ddd3f8ed54775171fee8b6e2", "c094d1b26ae37307acc855410b24b4fb"],
  ["ünïcode-sécret-🔑", "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "5e94f8cd1d496e6dc937339172486c0f", "f410ecd6964bfdd2f7024a360c452255"],
  ["ünïcode-sécret-🔑", "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "42abe623e4fa96329c3bdb4e2951efd7", "fefbb07909da3df3106122211468fed6"],
  ["ünïcode-sécret-🔑", "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "9298f27ea1e516f7b7f5d2d5413314fb", "61638440887ebcdbb6d8c90c98f2fd36"],
  ["ünïcode-sécret-🔑", "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", "86efc30cd02c854b85dd98818c0f3923", "f4bf974116c1744ff056090428d39a97"],
  ["ünïcode-sécret-🔑", "line\nbreak\u0000nul", "91064eec37adc56d91ff44b2a9935d36", "3cc367ec3cef40f0269bf7b1668d0a5a"],
];

/** [decision input, decisionKey] */
const KEYS: ReadonlyArray<readonly [unknown, string]> = [
  [{"reportId":"r1","verdict":"upheld","actions":[],"actor":"x","reason":"y"}, "c4bf43cc28b11178b0edfb06b54d2da6eee5a71744beb5b2390df8cc9748be78"],
  [{"reportId":"ab","verdict":"upheld","actions":[],"actor":"x","reason":"y"}, "c54c10bed7c0ae4eb0c17135205362e78a474b45c710d766db48bda7c13bff73"],
  [{"reportId":"a","verdict":"no_action","actions":[],"actor":"x","reason":"y"}, "ae7660fe190cb1faf7aab33bc54476e6e231ed651c4481bfea13fb907eae90e7"],
  [{"reportId":"r2","verdict":"upheld","actions":[{"subject":"s_a","kind":"ban","durationMs":null,"rule":1}],"actor":"x","reason":"y"}, "a8240e9ea88a38e91be2798ec58f23717d25ad0ee2cb3f44311bc7ab8bc321da"],
  [{"reportId":"r2","verdict":"upheld","actions":[{"subject":"s_a","kind":"chat","durationMs":3600000,"rule":1},{"subject":"s_b","kind":"warning","durationMs":null,"rule":"uncovered","gapNote":" gap ünï "}],"actor":"x","reason":"y"}, "f1109986c12892630a7494021b7feb299f2a3bb97f03cc78b73e761b852c5762"],
  [{"reportId":"r3-ünï","verdict":"upheld","actions":[{"subject":"s_a","kind":"ban","durationMs":null,"rule":1,"includeIp":true,"lineIds":["2","1","1"]}],"actor":"x","reason":"y"}, "e02d8fe0ddd2e83c08fc3c90c299fdbf2032d3e76a62b69716bee63d791dbfd7"],
  [{"reportId":"r4","verdict":"bad_faith","evidence":"false report","actions":[{"subject":"s_a","kind":"note","durationMs":null,"rule":1}],"actor":"x","reason":"y"}, "a60511e3eaed2ca883c1ad58df35b4f5e3435f72c1c63270065d1eac6fab9852"],
  [{"reportId":"r5r5r5r5r5r5r5r5r5r5r5r5r5r5r5r5r5r5r5r5r5r5r5r5r5r5r5r5r5r5r5r5r5r5r5r5r5r5r5r5","verdict":"upheld","actions":[{"subject":"s_0","kind":"chat","durationMs":0,"rule":1},{"subject":"s_1","kind":"chat","durationMs":1000,"rule":1},{"subject":"s_2","kind":"chat","durationMs":2000,"rule":1},{"subject":"s_3","kind":"chat","durationMs":3000,"rule":1},{"subject":"s_4","kind":"chat","durationMs":4000,"rule":1},{"subject":"s_5","kind":"chat","durationMs":5000,"rule":1}],"actor":"x","reason":"y"}, "662a256a598ed78e6306a04a4731f8e228a098f49365edc78c0b2d1406331c7b"],
];

const subjects = { canonical: (s: string) => s } as unknown as SubjectIndex;

afterEach(() => __forcePureJs(false));

describe.each([
  ['native', false],
  ['pure-JS', true],
] as const)('golden values from 0.1.0 (%s path)', (_name, pure) => {
  it('makeHasher clientKey and ip match the pinned hashes', () => {
    __forcePureJs(pure);
    for (const [secret, input, clientKey, ip] of HASHES) {
      const h = makeHasher(secret);
      expect(h.clientKey(input)).toBe(clientKey);
      expect(h.ip(input)).toBe(ip);
    }
  });

  it('decisionKey matches the pinned idempotency keys', () => {
    __forcePureJs(pure);
    for (const [input, key] of KEYS) expect(decisionKey(subjects, input as never)).toBe(key);
  });
});
