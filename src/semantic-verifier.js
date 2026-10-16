'use strict';

// Deterministic semantic verifier. Backward-compatible with the original
// set-membership signatures so existing tests still pass; layered with
// positional, source-account, and verification-downgrade checks when the
// compiler's positional envelope (`parsed`) or the AI's structured output
// (`aiIntent`) is available.

const { fold } = require('./intent-compiler');

function extractAmounts(text) {
  return [...String(text || '').matchAll(/(?:s\$|\$|sgd\s*)\s*([0-9]+(?:\.[0-9]{1,2})?)/gi)]
    .map((match) => Math.round(Number(match[1]) * 100));
}

// Built-in always-on checks. These mirror the original behaviour so any
// caller (existing tests included) gets the same result on the same input.
function baseChecks(text, intents, reasons) {
  if (intents.some((intent) => intent.action !== 'transfer' || intent.currency !== 'SGD')) reasons.push('Only SGD transfers are allowed by the banking contract.');
  if (intents.some((intent) => !intent.recipientAlias || !intent.sourceAccountId)) reasons.push('Every transfer must identify a recipient and source account.');
  if (!Number.isInteger(intents.reduce((sum, intent) => sum + Math.max(0, intent.amountCents), 0))) reasons.push('Proposed amounts must be non-negative integers.');

  const minimums = intents.map((intent) => intent.minimumRemainingCents || 0);
  if (new Set(minimums).size > 1) reasons.push('A multi-payment request must use one shared minimum-balance constraint.');
}

// Set-membership amount check. Original behaviour.
function checkAmountsInText(text, intents, reasons) {
  const requestedAmounts = extractAmounts(text);
  const proposedAmounts = intents.map((intent) => intent.amountCents);
  if (requestedAmounts.length < intents.length) reasons.push('The proposal contains more payments than the user stated.');
  const unmatchedAmounts = proposedAmounts.filter((amount) => !requestedAmounts.includes(amount));
  if (unmatchedAmounts.length) reasons.push('At least one proposed amount is absent from the original request.');
  return { requestedAmounts, proposedAmounts };
}

// Positional binding check. Uses the compiler's `parsed.amounts` and
// `parsed.recipients` to ensure each proposed (recipient, amount) pair sits
// inside the user message in the same order. Catches the "swap two amounts
// across two recipients" attack that set-membership lets through.
function checkPositionalBinding(intents, parsed, reasons, codes) {
  if (!parsed || !Array.isArray(parsed.recipients) || !Array.isArray(parsed.amounts)) return;
  if (parsed.recipients.length !== intents.length) {
    reasons.push('The number of parsed recipients does not match the number of proposed intents.');
    codes.push('SEMANTIC_MISMATCH');
    return;
  }
  for (let i = 0; i < intents.length; i += 1) {
    const intent = intents[i];
    const expectedRecipient = parsed.recipients[i];
    const expectedAmount = parsed.amounts[i];

    const aliasMatch = expectedRecipient.aliasFolded === fold(intent.recipientAlias);
    if (!aliasMatch) {
      reasons.push(`Recipient at position ${i + 1} differs: expected "${expectedRecipient.aliasRaw}", got "${intent.recipientAlias}".`);
      codes.push('AMOUNT_RECIPIENT_MISMATCH');
    }

    if (Number(expectedAmount.cents) !== Number(intent.amountCents)) {
      reasons.push(`Amount at position ${i + 1} differs: expected ${expectedAmount.cents} cents, got ${intent.amountCents} cents.`);
      codes.push('AMOUNT_RECIPIENT_MISMATCH');
    }
  }
}

// Recipient must appear in the user message after Unicode folding.
function checkRecipientsInText(text, intents, reasons, codes) {
  const lowered = fold(text);
  for (const intent of intents) {
    const foldedAlias = fold(intent.recipientAlias);
    if (!foldedAlias || !lowered.includes(foldedAlias)) {
      reasons.push(`Recipient alias "${intent.recipientAlias}" does not appear in the user message.`);
      codes.push('RECIPIENT_NOT_IN_TEXT');
    }
  }
}

// Source-account reconciliation between user text and the AI's structured
// output (or the compiler's positional source phrase).
function checkSourceAccount(text, aiIntent, parsed, intents, reasons, codes) {
  if (!aiIntent || typeof aiIntent.sourceAccountId !== 'string') return;
  const userSource =
    (parsed && parsed.source && parsed.source.account) ||
    extractSourceAccount(text);

  if (userSource && userSource !== aiIntent.sourceAccountId) {
    reasons.push(`Source account differs: user said "${userSource}", AI proposed "${aiIntent.sourceAccountId}".`);
    codes.push('SOURCE_ACCOUNT_MISMATCH');
    return;
  }
  if (!userSource && aiIntent.sourceAccountId !== 'spending') {
    reasons.push(`Source account "${aiIntent.sourceAccountId}" was not stated by the user; defaulting is not allowed.`);
    codes.push('SOURCE_ACCOUNT_MISMATCH');
  }
  if (intents.some((intent) => intent.sourceAccountId !== aiIntent.sourceAccountId)) {
    reasons.push(`At least one compiled intent diverges from the AI's stated source account.`);
    codes.push('SOURCE_ACCOUNT_MISMATCH');
  }
}

function extractSourceAccount(text) {
  const m = String(text || '').match(/\b(?:from|out\s+of|using)\s+(spending|savings|wallet)\b/i);
  return m ? m[1].toLowerCase() : null;
}

// Recipient verification is a trusted application policy. Natural-language
// release phrases must never disable it, and an AI output cannot weaken it.
function checkVerificationDowngrade(text, aiIntent, reasons, codes) {
  if (!aiIntent || aiIntent.requireVerifiedRecipient !== false) return;
  reasons.push('The AI attempted to disable trusted-recipient verification; natural-language release phrases cannot weaken this policy.');
  codes.push('VERIFICATION_DOWNGRADE');
}

function checkAiAgreement(compiledIntents, aiIntent, reasons, codes) {
  if (!aiIntent) return;
  if (!Array.isArray(compiledIntents) || compiledIntents.length !== 1) {
    reasons.push('Exactly one deterministic transfer is required for one AI proposal.');
    codes.push('AI_INTENT_MISMATCH');
    return;
  }
  const expected = compiledIntents[0];
  const fields = [
    ['action', expected.action, aiIntent.action],
    ['recipientAlias', fold(expected.recipientAlias), fold(aiIntent.recipientAlias)],
    ['sourceAccountId', expected.sourceAccountId, aiIntent.sourceAccountId],
    ['amountCents', expected.amountCents, aiIntent.amountCents],
    ['currency', expected.currency, aiIntent.currency],
    ['minimumRemainingCents', expected.minimumRemainingCents || 0, aiIntent.minimumRemainingCents || 0],
  ];
  for (const [name, expectedValue, actualValue] of fields) {
    if (expectedValue !== actualValue) {
      reasons.push(`AI ${name} differs from the deterministic interpretation of the user request.`);
      codes.push('AI_INTENT_MISMATCH');
    }
  }
}

function verifyIntentContract(originalMessage, intents, options = {}) {
  const text = String(originalMessage || '');
  if (!Array.isArray(intents) || intents.length === 0) return { ok: false, code: 'NO_INTENTS', reasons: ['No transaction intents were supplied.'] };
  const reasons = [];
  const codes = [];

  baseChecks(text, intents, reasons);
  const { requestedAmounts, proposedAmounts } = checkAmountsInText(text, intents, reasons);

  if (Array.isArray(options.parsed)) {
    throw new TypeError('verifyIntentContract: `parsed` must be an object, not an array.');
  }
  const parsed = options.parsed;
  const aiIntent = options.aiIntent;

  checkPositionalBinding(intents, parsed, reasons, codes);
  checkRecipientsInText(text, intents, reasons, codes);
  checkSourceAccount(text, aiIntent, parsed, intents, reasons, codes);
  checkVerificationDowngrade(text, aiIntent, reasons, codes);
  checkAiAgreement(intents, aiIntent, reasons, codes);

  if (reasons.length) {
    return {
      ok: false,
      code: codes[0] || 'SEMANTIC_MISMATCH',
      reasons,
      allCodes: Array.from(new Set(codes.concat(['SEMANTIC_MISMATCH']))),
      proposedAmounts,
      requestedAmounts,
      checked: ['action', 'currency', 'amounts', 'recipient', 'source', 'shared_constraints', 'positional_binding', 'recipient_in_text', 'source_account', 'verification_downgrade'],
    };
  }
  return {
    ok: true,
    checked: ['action', 'currency', 'amounts', 'recipient', 'source', 'shared_constraints', 'positional_binding', 'recipient_in_text', 'source_account', 'verification_downgrade'],
    proposedAmounts,
    requestedAmounts,
  };
}

module.exports = {
  verifyIntentContract,
  extractAmounts,
  extractSourceAccount,
  checkAiAgreement,
};
