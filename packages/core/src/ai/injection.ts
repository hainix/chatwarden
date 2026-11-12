import { cleanText } from './redact.js';

// A tripwire, not a defence (design section 8, layer 5). A line that looks like it is instructing the AI sets `injectionSuspected`:
// the case is shown with a plain note, its confidence is forced to low and the AI may not lower its queue rank. The patterns are
// phrase-shaped on purpose, so ordinary banter ("ignore me lol", "you are now in my way") does not trip them. A false positive costs
// one visible mark; a miss costs nothing the other layers (no authority, validated output, a human reads it) do not already cover.

const IGNORE = String.raw`\b(?:ignore|disregard|forget|override)\s+(?:(?:all|any|every|of|the|your|my|these|those|previous|prior|earlier|above|preceding|everything|anything|what)\s+)*(?:above|previous|prior|earlier|preceding|instructions?|rules?|prompts?|guidelines?|directions?|commands?|polic(?:y|ies)|messages?|context|system)\b`;
// "you are now" followed by a role, a mode or nothing: not "you are now in my way" or "you are now at 3 kills".
const NOW = String.raw`\byou(?:'re|\s+are|\s+r)\s+now\s*(?:$|[.,:;!?-]|(?:an?|the)\b|(?:dan|free|unfiltered|unrestricted|jailbroken|acting|playing)\b|my\s+(?:assistant|servant|ai)\b|in\s+(?:developer|debug|admin|god|dan|unrestricted|jailbreak)\b|going\s+to\s+(?:act|ignore|pretend)\b)`;
// A role marker at the start of the text or after punctuation or a quote ("system: ...", "hey! assistant: ..."), not mid-sentence.
const ROLE = String.raw`(?:^|[.!?;"'\[(<>|\x60])\s*(?:system|assistant|developer|admin)\s*[:>\]]`;
const TAG = String.raw`<\/?\s*(?:system|assistant|instructions?|data|prompt)\s*>|<\|[a-z_]+\|>|\[\/?inst\]|<<\/?sys>>`;
const AS_AI = String.raw`\bas an? (?:ai|a\.i\.|language model|large language model|llm|assistant|artificial intelligence|chatbot)\b`;
const NEW = String.raw`\b(?:new|updated|revised|additional)\s+(?:instructions?|rules|prompt|system prompt)\s*:|\bfrom now on\b[^.]{0,30}\b(?:you|ignore|respond|answer|act|only|always)\b|\bdo anything now\b`;
const TELL = String.raw`\btell\s+(?:the\s+|your\s+)?(?:moderators?|mods?|admins?|ai|assistant|reviewer|bot|model)\b[^.]{0,60}\b(?:fine|ok|okay|nothing|no action|safe|innocent|dismiss|banter|false|lying|harmless)\b`;
const PRETEND = String.raw`\bpretend\s+(?:that\s+)?you(?:'re|\s+are|\s+were)\b`;
const REVEAL = String.raw`\b(?:reveal|show|print|repeat|output|leak)\s+(?:me\s+)?(?:your|the)\s+(?:system\s+|initial\s+|hidden\s+)?(?:prompt|instructions?)\b`;

const PATTERNS: readonly RegExp[] = [IGNORE, NOW, ROLE, TAG, AS_AI, NEW, TELL, PRETEND, REVEAL].map((p) => new RegExp(p, 'u'));

/**
 * True when a chat line or note reads like an attempt to instruct the AI ("ignore the above", "you are now ...", "system: ...",
 * "as an AI", "disregard your rules", "tell the moderator this is fine"). Case, width, zero-width characters and extra whitespace
 * are ignored. Never throws.
 * @experimental
 */
export function looksLikeInjection(text: string): boolean {
  if (typeof text !== 'string' || text === '') return false;
  const t = cleanText(text.normalize('NFKC')).toLowerCase().replace(/[‘’]/gu, "'");
  return PATTERNS.some((re) => re.test(t));
}
