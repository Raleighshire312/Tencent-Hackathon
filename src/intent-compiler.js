'use strict';

// Deterministic regex-based transfer extractor. Emits the same per-intent
// shape that downstream consumers deep-equal against, plus an OPTIONAL
// `parsed` envelope at the top level with positional markers so the
// hardended semantic verifier can do amount↔recipient pairing checks
// instead of relying on set-membership alone.

function parseMoneyCents(value) {
  const amount = Number(value);
  return Number.isFinite(amount) && amount > 0 ? Math.round(amount * 100) : null;
}

function fold(text) {
  // Lightweight fold for alias comparison. NFKC + lowercase.
  return String(text || '').normalize('NFKC').toLowerCase();
}

// Walk an additional position-aware scan so we can record the *exact*
// (aliasStart, aliasEnd, amountStart, amountEnd) span of every transfer.
function compileTransferIntents(message) {
  const text = String(message || '').trim();
  if (!text) return { ok: false, code: 'NO_TRANSFER_INTENTS', message: 'No explicit transfer instruction was found.' };

  const transfers = [];
  const transferPattern = /\b(?:send|pay|transfer)\s+([a-z][a-z0-9 _'-]*?)\s+(?:s\$|\$|sgd\s*)\s*([0-9]+(?:\.[0-9]{1,2})?)/gi;
  let match;
  while ((match = transferPattern.exec(text)) !== null) {
    const amountCents = parseMoneyCents(match[2]);
    if (!amountCents) continue;

    // Anchor positions of (aliasStart, amountStart, amountEnd) within `text`.
    const groupStart = match.index + match[0].indexOf(match[1]);
    const aliasStart = groupStart;
    const aliasEnd = aliasStart + match[1].length;
    const amountTokenStart = text.indexOf(match[2], aliasEnd);
    const amountTokenEnd = amountTokenStart + match[2].length;
    const actionToken = (match[0].match(/^(?:\s*)(?:send|pay|transfer)/i) || [''])[0].trim();
    const actionStart = match.index;
    const actionEnd = actionStart + (actionToken ? actionToken.length : 0);

    transfers.push({
      // Per-intent shape — unchanged so existing tests still deep-equal.
      action: 'transfer',
      recipientAlias: match[1].trim(),
      sourceAccountId: 'spending',
      amountCents,
      currency: 'SGD',
      minimumRemainingCents: 0,
      requireVerifiedRecipient: true,
    });
    transfers[transfers.length - 1].position = {
      action: { start: actionStart, end: actionEnd, token: actionToken.toLowerCase() },
      aliasRaw: match[1].trim(),
      aliasFolded: fold(match[1].trim()),
      aliasSpan: { start: aliasStart, end: aliasEnd },
      amountRaw: `${match[2]}`,
      amountSpan: { start: amountTokenStart, end: amountTokenEnd },
      span: { start: match.index, end: text.indexOf(match[2], aliasEnd) + match[2].length },
    };
  }

  // Also accept the natural order "transfer S$100 to Mum". The same
  // positional envelope is emitted so semantic verification binds the pair.
  const amountFirstPattern = /\btransfer\s+(?:s\$|\$|sgd\s*)\s*([0-9]+(?:\.[0-9]{1,2})?)\s+to\s+([a-z][a-z0-9 _'-]*?)(?=\s+(?:from|but|and|leav(?:e|ing)|keep(?:ing)?|while\s+keeping|with|at least)\b|\s*$)/gi;
  while ((match = amountFirstPattern.exec(text)) !== null) {
    const amountCents = parseMoneyCents(match[1]);
    if (!amountCents) continue;
    const aliasStart = match.index + match[0].indexOf(match[2]);
    const aliasEnd = aliasStart + match[2].length;
    const amountTokenStart = match.index + match[0].indexOf(match[1]);
    const amountTokenEnd = amountTokenStart + match[1].length;
    transfers.push({ action: 'transfer', recipientAlias: match[2].trim(), sourceAccountId: 'spending', amountCents, currency: 'SGD', minimumRemainingCents: 0, requireVerifiedRecipient: true });
    transfers[transfers.length - 1].position = {
      action: { start: match.index, end: match.index + 8, token: 'transfer' },
      aliasRaw: match[2].trim(), aliasFolded: fold(match[2].trim()), aliasSpan: { start: aliasStart, end: aliasEnd },
      amountRaw: match[1], amountSpan: { start: amountTokenStart, end: amountTokenEnd }, span: { start: match.index, end: match.index + match[0].length },
    };
  }

  // Optional minimum-balance phrase (e.g. "leave at least S$500").
  const minimumMatch = text.match(/(?:leave|keep|remaining|at least)\s*(?:s\$|\$|sgd\s*)\s*([0-9]+(?:\.[0-9]{1,2})?)/i);
  let minimumRemainingCents = 0;
  let minimumSpan = null;
  if (minimumMatch) {
    minimumRemainingCents = parseMoneyCents(minimumMatch[1]) || 0;
    minimumSpan = {
      raw: minimumMatch[0],
      amount: minimumMatch[1],
      start: minimumMatch.index,
      end: minimumMatch.index + minimumMatch[0].length,
      cents: minimumRemainingCents,
    };
    transfers.forEach((transfer) => { transfer.minimumRemainingCents = minimumRemainingCents; });
  }

  // Optional source-account phrase (e.g. "from savings", "out of wallet").
  const sourceMatch = text.match(/\b(?:from|out\s+of|using)\s+(spending|savings|wallet)\b/i);
  const sourceOverride = sourceMatch ? sourceMatch[1].toLowerCase() : null;
  if (sourceOverride) {
    transfers.forEach((transfer) => { transfer.sourceAccountId = sourceOverride; });
  }

  if (!transfers.length) return { ok: false, code: 'NO_TRANSFER_INTENTS', message: 'No explicit transfer instruction was found.' };

  return {
    ok: true,
    rawText: text,
    intents: transfers,
    parsed: {
      amounts: transfers.map((t) => ({ cents: t.amountCents, raw: t.position.amountRaw, span: t.position.amountSpan })),
      recipients: transfers.map((t) => ({ aliasRaw: t.position.aliasRaw, aliasFolded: t.position.aliasFolded, span: t.position.aliasSpan })),
      minimum: minimumSpan,
      source: sourceMatch ? { raw: sourceMatch[0], account: sourceOverride, span: { start: sourceMatch.index, end: sourceMatch.index + sourceMatch[0].length } } : null,
      normalized: fold(text),
    },
  };
}

module.exports = { compileTransferIntents, parseMoneyCents, fold };
