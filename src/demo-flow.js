const { compileTransferIntents } = require('./intent-compiler');
const { verifyIntentContract } = require('./semantic-verifier');
const { inspectUntrustedContent } = require('./attack-lab');

function prepareDemoRequest(message, untrustedContent = '') {
  const compiled = compileTransferIntents(message);
  if (!compiled.ok) return compiled;
  const semantic = verifyIntentContract(message, compiled.intents);
  if (!semantic.ok) return { ok: false, stage: 'semantic-verification', ...semantic, intents: compiled.intents };
  const attackCheck = inspectUntrustedContent(untrustedContent);
  if (!attackCheck.ok) return { ok: false, stage: 'untrusted-content', ...attackCheck, intents: compiled.intents };
  return { ok: true, intents: compiled.intents, semantic, attackCheck };
}

module.exports = { prepareDemoRequest };
