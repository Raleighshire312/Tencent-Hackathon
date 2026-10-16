'use strict';

// Glue between compiler, verifier, attack-lab, and (now) the user-message
// injection guard. The legacy top-level shape is preserved exactly so
// `tests/demo-flow.test.js` continues to pass; the new adversarial layer
// adds an extra stage on top.

const { compileTransferIntents } = require('./intent-compiler');
const { verifyIntentContract } = require('./semantic-verifier');
const { inspectUntrustedContent } = require('./attack-lab');
const { scanUserMessage } = require('./injection-guard');

function prepareDemoRequest(message, untrustedContent = '') {
  // NEW: scan the user's own message for self-injection before doing
  // anything else. The legacy test fixtures use benign messages, so this
  // is a no-op for them; it is a hard gate for adversarial messages.
  const userGuard = scanUserMessage(message);
  if (!userGuard.ok) {
    return {
      ok: false,
      stage: 'user-injection',
      code: userGuard.code,
      reasons: userGuard.reasons,
      matchedPatterns: userGuard.matchedPatterns || [],
      intents: [],
    };
  }

  const compiled = compileTransferIntents(message);
  if (!compiled.ok) return compiled;
  const semantic = verifyIntentContract(message, compiled.intents, { parsed: compiled.parsed });
  if (!semantic.ok) return { ok: false, stage: 'semantic-verification', ...semantic, intents: compiled.intents };
  const attackCheck = inspectUntrustedContent(untrustedContent);
  if (!attackCheck.ok) return { ok: false, stage: 'untrusted-content', ...attackCheck, intents: compiled.intents };
  return { ok: true, intents: compiled.intents, semantic, attackCheck, parsed: compiled.parsed };
}

module.exports = { prepareDemoRequest };
