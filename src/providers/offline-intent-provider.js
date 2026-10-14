function parseAmountCents(text) {
  const match = text.match(/(?:s\$|\$|sgd\s*)\s*([0-9]+(?:\.[0-9]{1,2})?)/i);
  if (!match) return null;
  const amount = Number(match[1]);
  if (!Number.isFinite(amount) || amount <= 0) return null;
  return Math.round(amount * 100);
}

function parseMinimumRemainingCents(text) {
  const match = text.match(/(?:leave|keep|remaining|at least)\s*(?:s\$|\$|sgd\s*)\s*([0-9]+(?:\.[0-9]{1,2})?)/i);
  if (!match) return 0;
  return Math.round(Number(match[1]) * 100);
}

function parseRecipient(text) {
  const match = text.match(/\b(?:to|for|send|pay)\s+([a-z][a-z0-9 _'-]*?)(?=\s+(?:s\$|\$|sgd\s|from|but|and|leav(?:e|ing)|keep|with|at least)\b|\s*$)/i);
  return match ? match[1].trim() : null;
}

function offlineIntent(message) {
  const text = String(message || '').trim();
  const amountCents = parseAmountCents(text);
  const recipientAlias = parseRecipient(text);
  if (!amountCents || !recipientAlias) {
    return { ok: false, code: 'OFFLINE_PARSE_FAILED', message: 'Offline mode needs a request such as “Send Mum S$80 and leave at least S$500”.' };
  }
  return {
    ok: true,
    provider: 'offline',
    intent: {
      action: 'transfer',
      recipientAlias,
      sourceAccountId: 'spending',
      amountCents,
      currency: 'SGD',
      minimumRemainingCents: parseMinimumRemainingCents(text),
      requireVerifiedRecipient: true,
    },
    rawText: text,
  };
}

module.exports = { offlineIntent };
