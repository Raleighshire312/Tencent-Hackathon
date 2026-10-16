'use strict';

// ---------------------------------------------------------------------------
// Injection guard — heuristic + Unicode-folding prompt-injection scanner.
// Two entry points:
//   * scanUserMessage(text)        — runs BEFORE the LLM call
//   * scanAdpTranscript(text)      — runs AFTER the LLM call to detect
//                                    attempts by an LLM response to inject
//                                    hidden instructions, even when wrapped
//                                    in legitimate JSON.
// Always fails closed.
// ---------------------------------------------------------------------------

const SUSPICIOUS_PATTERNS = [
  // Classic override phrasing.
  { pattern: /ignore\s+(?:all\s+)?(?:previous|prior|above|earlier)\s+(?:instructions?|directives?|prompts?)/i, code: 'IGNORE_PRIOR_INSTRUCTIONS', reason: 'A request asked the model to ignore its prior instructions.' },
  { pattern: /forget\s+(?:all\s+)?(?:previous|prior|above)\s+(?:instructions?|context|memory)/i, code: 'FORGET_CONTEXT', reason: 'A request asked the model to forget its prior context.' },
  { pattern: /disregard\s+(?:all\s+)?(?:previous|prior|above|safety)/i, code: 'DISREGARD_SAFETY', reason: 'A request asked the model to disregard safety constraints.' },
  // Recipient / amount substitution.
  { pattern: /\b(?:change|swap|replace|redirect)\s+(?:the\s+)?recipient\b/i, code: 'RECIPIENT_SWAP', reason: 'A request asked the model to change the payment recipient.' },
  { pattern: /\btransfer\s+to\s+(?:a\s+)?(?:new|different|this|my)\s+account\b/i, code: 'NEW_ACCOUNT_TARGET', reason: 'A request asked the model to redirect funds to a different account.' },
  { pattern: /\buse\s+(?:this|the)\s+(?:new\s+)?account\s+instead\b/i, code: 'NEW_ACCOUNT_TARGET', reason: 'A request asked the model to use a different account instead.' },
  // Concealment.
  { pattern: /\b(?:do\s+not|don'?t|never)\s+(?:show|ask|tell|inform)\s+(?:the\s+)?user\b/i, code: 'CONCEAL_FROM_USER', reason: 'A request asked the model to hide the transaction from the user.' },
  { pattern: /\bwithout\s+(?:the\s+)?user\s+(?:knowing|noticing|seeing|being\s+told)\b/i, code: 'CONCEAL_FROM_USER', reason: 'A request asked the model to hide the transaction from the user.' },
  // Identity / role override.
  { pattern: /\byou\s+are\s+now\s+(?:a|an|the|my)\s+(?:new|different|unrestricted|jailbroken|unfiltered)\b/i, code: 'ROLE_OVERRIDE', reason: 'A request attempted to override the model role.' },
  { pattern: /\bact\s+as\s+(?:a|an|unrestricted|unfiltered|jailbroken)\s+(?:ai|model|assistant|agent)\b/i, code: 'ROLE_OVERRIDE', reason: 'A request attempted to assign an alternate role to the model.' },
  { pattern: /\bpretend\s+(?:to\s+be|you\s+are)\b/i, code: 'ROLE_OVERRIDE', reason: 'A request asked the model to pretend to be something else.' },
  // Approval bypass.
  { pattern: /\b(?:skip|bypass|ignore|disable)\s+(?:the\s+)?(?:approval|verification|fingerprint|security)\b/i, code: 'APPROVAL_BYPASS', reason: 'A request attempted to bypass approval or verification.' },
  { pattern: /\b(?:do\s+not|don'?t|never)\s+(?:require|ask\s+for|need)\s+(?:my\s+)?(?:approval|confirmation|consent)\b/i, code: 'APPROVAL_BYPASS', reason: 'A request attempted to suppress approval.' },
  // Hidden control tokens commonly seen in prompt smuggling.
  { pattern: /<\/?system>|<\/?assistant>|<\/?user>|<\|im_start\|>|<\|im_end\|>|\[INST\]|\[\/INST\]|###\s*system|###\s*instruction/i, code: 'CONTROL_TOKEN', reason: 'A request contained a hidden control token.' },
  // Raw-mode flipping.
  { pattern: /\b(?:respond|answer|reply)\s+with\s+(?:only|just)\s+(?:yes|confirm|approve|done|ok)\b/i, code: 'RAW_RESPONSE_TRICK', reason: 'A request tried to coax a one-word "approve" reply.' },
  // Data-exfil / tool-call direction.
  { pattern: /\b(?:execute|run|trigger|call)\s+(?:the\s+)?(?:tool|function|action)\b/i, code: 'TOOL_DIRECTION', reason: 'A request tried to directly invoke a tool or function.' },
];

// Latin/Cyrillic/Greek confusable characters — a recipient alias written with
// Cyrillic "а" instead of Latin "a" should NOT be allowed to silently match
// a known, verified recipient.
const HOMOGLYPHS = {
  а: 'a', с: 'c', е: 'e', о: 'o', р: 'p', у: 'y', х: 'x', і: 'i', ј: 'j', ѕ: 's',
  α: 'a', β: 'b', γ: 'g', δ: 'd', ε: 'e', ζ: 'z', η: 'h', ι: 'i', κ: 'k', ν: 'n', ο: 'o', π: 'p', ρ: 'r', τ: 't', υ: 'y', χ: 'x', ω: 'w',
};

// Fold a string into a defensive comparison form: NFKC + lowercase + homoglyph
// substitution. Both the user text and any AI-derived alias should be folded
// before they are compared, so an attacker cannot sidestep allowlists.
function normalizeText(text) {
  let normalized = String(text || '').normalize('NFKC').toLowerCase();
  let folded = '';
  for (const ch of normalized) folded += HOMOGLYPHS[ch] !== undefined ? HOMOGLYPHS[ch] : ch;
  return folded;
}

// Compute the percentage of characters that are NOT word / whitespace.
// Anything above 70% is a strong indicator of an obfuscated payload
// (ROT13, base64, zero-width joiners, full unicode soup, …).
function opaqueRatio(text) {
  const sample = String(text || '');
  if (!sample.length) return 0;
  let weird = 0;
  for (let i = 0; i < sample.length; i += 1) {
    const code = sample.charCodeAt(i);
    const isAlnum = (code >= 0x30 && code <= 0x39) || (code >= 0x41 && code <= 0x5A) || (code >= 0x61 && code <= 0x7A);
    const isWs = code === 0x20 || code === 0x09 || code === 0x0A || code === 0x0D;
    const isPunct = "!\"#$%&'()*+,-./:;<=>?@[\\]^_`{|}~".includes(sample[i]);
    if (!isAlnum && !isWs && !isPunct) weird += 1;
  }
  return weird / sample.length;
}

function findMatchedPatterns(text) {
  return SUSPICIOUS_PATTERNS
    .filter((entry) => entry.pattern.test(text))
    .map((entry) => ({ code: entry.code, reason: entry.reason, source: entry.pattern.toString() }));
}

function scanUserMessage(message) {
  const text = String(message || '');
  const trimmed = text.trim();
  if (!trimmed) return { ok: false, blocked: true, code: 'EMPTY_MESSAGE', reasons: ['Refusing to interpret an empty message.'] };

  const matches = findMatchedPatterns(text);
  if (matches.length) {
    return {
      ok: false,
      blocked: true,
      code: 'USER_INJECTION_BLOCKED',
      reasons: ['The user message itself contained override or concealment instructions; refused without calling the LLM.'],
      matchedPatterns: matches,
    };
  }

  if (text.length > 4000) {
    return { ok: false, blocked: true, code: 'USER_MESSAGE_TOO_LONG', reasons: ['The user message exceeded the 4,000-character cap.'] };
  }
  if (opaqueRatio(text) > 0.35) {
    return { ok: false, blocked: true, code: 'USER_MESSAGE_OPAQUE', reasons: ['The user message contained an unusually high proportion of non-printable or unfamiliar characters.'] };
  }

  return { ok: true, blocked: false, normalized: normalizeText(text) };
}

// `transcript` is the raw text returned by ADP (already concatenated by
// readSseText). Even if a structured JSON object was extracted, we still
// inspect the entire transcript.
function scanAdpTranscript(transcript) {
  const text = String(transcript || '');
  const matches = findMatchedPatterns(text);
  if (matches.length) {
    return {
      ok: false,
      blocked: true,
      code: 'ADP_TRANSCRIPT_HOSTILE',
      reasons: ['The ADP transcript contained override or concealment instructions.'],
      matchedPatterns: matches,
    };
  }
  return { ok: true, blocked: false };
}

// Re-export homoglyph map for test introspection.
module.exports = {
  scanUserMessage,
  scanAdpTranscript,
  normalizeText,
  opaqueRatio,
  HOMOGLYPHS,
  SUSPICIOUS_PATTERNS,
};
