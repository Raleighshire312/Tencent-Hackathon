function extractAmounts(text) {
  return [...String(text || '').matchAll(/(?:s\$|\$|sgd\s*)\s*([0-9]+(?:\.[0-9]{1,2})?)/gi)]
    .map((match) => Math.round(Number(match[1]) * 100));
}

function verifyIntentContract(originalMessage, intents) {
  const text = String(originalMessage || '');
  if (!Array.isArray(intents) || intents.length === 0) return { ok: false, code: 'NO_INTENTS', reasons: ['No transaction intents were supplied.'] };
  const reasons = [];
  const requestedAmounts = extractAmounts(text);
  const proposedAmounts = intents.map((intent) => intent.amountCents);
  if (requestedAmounts.length < intents.length) reasons.push('The proposal contains more payments than the user stated.');
  const unmatchedAmounts = proposedAmounts.filter((amount) => !requestedAmounts.includes(amount));
  if (unmatchedAmounts.length) reasons.push('At least one proposed amount is absent from the original request.');
  if (intents.some((intent) => intent.action !== 'transfer' || intent.currency !== 'SGD')) reasons.push('Only SGD transfers are allowed by the banking contract.');
  if (intents.some((intent) => !intent.recipientAlias || !intent.sourceAccountId)) reasons.push('Every transfer must identify a recipient and source account.');
  const minimums = intents.map((intent) => intent.minimumRemainingCents || 0);
  if (new Set(minimums).size > 1) reasons.push('A multi-payment request must use one shared minimum-balance constraint.');
  return reasons.length ? { ok: false, code: 'SEMANTIC_MISMATCH', reasons } : { ok: true, checked: ['action', 'currency', 'amounts', 'recipient', 'source', 'shared_constraints'] };
}

module.exports = { verifyIntentContract };
