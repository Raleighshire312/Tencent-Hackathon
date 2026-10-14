function parseMoneyCents(value) {
  const amount = Number(value);
  return Number.isFinite(amount) && amount > 0 ? Math.round(amount * 100) : null;
}

function compileTransferIntents(message) {
  const text = String(message || '').trim();
  const transfers = [];
  const transferPattern = /\b(?:send|pay|transfer)\s+([a-z][a-z0-9 _'-]*?)\s+(?:s\$|\$|sgd\s*)\s*([0-9]+(?:\.[0-9]{1,2})?)/gi;
  let match;
  while ((match = transferPattern.exec(text)) !== null) {
    const amountCents = parseMoneyCents(match[2]);
    if (amountCents) transfers.push({
      action: 'transfer',
      recipientAlias: match[1].trim(),
      sourceAccountId: 'spending',
      amountCents,
      currency: 'SGD',
      minimumRemainingCents: 0,
      requireVerifiedRecipient: true,
    });
  }
  const minimumMatch = text.match(/(?:leave|keep|remaining|at least)\s*(?:s\$|\$|sgd\s*)\s*([0-9]+(?:\.[0-9]{1,2})?)/i);
  if (minimumMatch) {
    const minimumRemainingCents = parseMoneyCents(minimumMatch[1]);
    transfers.forEach((transfer) => { transfer.minimumRemainingCents = minimumRemainingCents; });
  }
  if (!transfers.length) return { ok: false, code: 'NO_TRANSFER_INTENTS', message: 'No explicit transfer instruction was found.' };
  return { ok: true, rawText: text, intents: transfers };
}

module.exports = { compileTransferIntents };
