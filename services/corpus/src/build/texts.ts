import { CORPUS_ZIP_PASSWORD } from '@chatwarden/matcher/corpus';

// The plain files every release zip carries besides its data (design 6.4). Fixed text: nothing here depends on the data, and no word of the list
// is in it.

export const LICENSE_SPDX = 'CC-BY-4.0';
export const ATTRIBUTION = 'Contains the Chatwarden community term list (chatwarden.dev), CC BY 4.0.';

export const LICENSE_TXT = `${ATTRIBUTION}

This work is licensed under the Creative Commons Attribution 4.0 International licence (CC BY 4.0).
You may share and adapt it for any purpose, including commercially, if you give credit (the sentence above is enough), link to the licence
and say whether you changed it. The full legal text is at https://creativecommons.org/licenses/by/4.0/legalcode

The licence covers the compilation: the selection, the categories and the lines. It gives no warranty. A word on the list is a word that the
list's reviewers judged to be used as abuse; it is not a statement about any person.
`;

export const termsReadme = (version: string): string => `Chatwarden community term list, release ${version}

CONTENT WARNING. This archive is a list of abusive words, kept so that software can filter them. It is made for moderation and research. The
files are zipped with a public password only so that scanners and indexers do not read them: the password is ${CORPUS_ZIP_PASSWORD}. It is not a secret.

What is inside: manifest.json (what this release holds, with a hash of every file), terms.json, exceptions.json, negative.<language>.json
(lines the list must never block), positive.json (lines it must keep blocking), this file and LICENSE.txt.

How to check it before you trust it. The signature file next to the zip (the same name with .sig added) is an Ed25519 signature over the bytes
  "chatwarden-corpus/1" 0x00 "zip" 0x00 <the zip file's bytes>
made with one of the project's published keys (the public keys are printed on the project's docs page and in the matcher package's source, in
packages/matcher/src/corpus/keys.ts). The kit's loader (@chatwarden/matcher/corpus) does this for you, and refuses anything that does not verify.

${LICENSE_TXT.split('\n')[0]}
`;

export const evalReadme = (version: string): string => `Chatwarden eval and calibration set, release ${version}

CONTENT WARNING. The cases are short chats written for testing moderation: they may contain abusive words. Every case is synthetic or has been
paraphrased by a reviewer so that no original wording, name, account or contact detail remains. The files are zipped with the public password
${CORPUS_ZIP_PASSWORD}; it only keeps scanners from reading the text and is not a secret.

What is inside: manifest.json (with a hash of every file), cases.<language>.json, this file and LICENSE.txt. The reference labels (expect) are the
consensus of at least three reviewers.

Verify the signature file next to the zip before you use it (an Ed25519 signature over "chatwarden-corpus/1" 0x00 "zip" 0x00 <the zip's bytes>, by
a key published on the project's docs page). The kit's loader does this for you.

${LICENSE_TXT.split('\n')[0]}
`;
