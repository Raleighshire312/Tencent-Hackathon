const SUSPICIOUS_INSTRUCTIONS = [
  /ignore\s+(?:all\s+)?previous\s+instructions?/i,
  /change\s+(?:the\s+)?recipient/i,
  /use\s+(?:this|the)\s+(?:new\s+)?account/i,
  /do\s+not\s+(?:show|ask)\s+(?:the\s+)?user/i,
  /transfer\s+to\s+(?:account|bank)/i,
];

function inspectUntrustedContent(content, trustedProposal) {
  const text = String(content || '');
  const matched = SUSPICIOUS_INSTRUCTIONS.filter((pattern) => pattern.test(text)).map(String);
  if (matched.length) return { ok: false, code: 'UNTRUSTED_INSTRUCTION_BLOCKED', blocked: true, reasons: ['Untrusted content attempted to issue transaction instructions.'], matchedPatterns: matched, trustedProposalFingerprint: trustedProposal?.fingerprint || null };
  return { ok: true, blocked: false, trustedProposalFingerprint: trustedProposal?.fingerprint || null };
}

module.exports = { inspectUntrustedContent };
