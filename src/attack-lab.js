'use strict';

// Adversarial scanner for *untrusted* content (e.g. an invoice body fetched
// from a third party). The user's own message is now defended by
// `src/injection-guard.js`; this module is the second line of defence for
// tool outputs and external blobs. The return shape is preserved exactly
// so existing tests (`tests/demo-flow.test.js`) continue to pass.
//
// Both modules share the same pattern set via injection-guard's exports.

const { scanAdpTranscript } = require('./injection-guard');

const SUSPICIOUS_INSTRUCTIONS = [
  /ignore\s+(?:all\s+)?previous\s+instructions?/i,
  /change\s+(?:the\s+)?recipient/i,
  /use\s+(?:this|the)\s+(?:new\s+)?account/i,
  /do\s+not\s+(?:show|ask)\s+(?:the\s+)?user/i,
  /transfer\s+to\s+(?:account|bank)/i,
];

function inspectUntrustedContent(content, trustedProposal) {
  const text = String(content || '');

  // First-line defence: regex hit (kept identical to original semantics).
  const matched = SUSPICIOUS_INSTRUCTIONS.filter((pattern) => pattern.test(text)).map(String);
  if (matched.length) {
    return {
      ok: false,
      code: 'UNTRUSTED_INSTRUCTION_BLOCKED',
      blocked: true,
      reasons: ['Untrusted content attempted to issue transaction instructions.'],
      matchedPatterns: matched,
      trustedProposalFingerprint: trustedProposal?.fingerprint || null,
    };
  }

  // Second-line: share the broader injection-guard scanner. If a future
  // attacker uses phrasing the simple regex misses (e.g. Unicode lookalikes,
  // role overrides), this catches it.
  const transcript = scanAdpTranscript(text);
  if (!transcript.ok) {
    return {
      ok: false,
      code: 'UNTRUSTED_INSTRUCTION_BLOCKED',
      blocked: true,
      reasons: transcript.reasons,
      matchedPatterns: (transcript.matchedPatterns || []).map((m) => m.source),
      trustedProposalFingerprint: trustedProposal?.fingerprint || null,
    };
  }

  return { ok: true, blocked: false, trustedProposalFingerprint: trustedProposal?.fingerprint || null };
}

module.exports = { inspectUntrustedContent };
