'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { compileTransferIntents } = require('../src/intent-compiler');
const { verifyIntentContract } = require('../src/semantic-verifier');

function compileEnvelope(message) {
  const r = compileTransferIntents(message);
  assert.equal(r.ok, true);
  return r;
}

test('verifier detects amount/recipient positional swap (set membership passes, positional fails)', () => {
  const text = 'Send Mum S$200 and pay electricity S$85.';
  const compiled = compileEnvelope(text);
  const swapped = [
    { action: 'transfer', recipientAlias: 'electricity', sourceAccountId: 'spending', amountCents: 20000, currency: 'SGD', minimumRemainingCents: 0, requireVerifiedRecipient: true },
    { action: 'transfer', recipientAlias: 'Mum',         sourceAccountId: 'spending', amountCents: 8500,  currency: 'SGD', minimumRemainingCents: 0, requireVerifiedRecipient: true },
  ];
  const result = verifyIntentContract(text, swapped, { parsed: compiled.parsed });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'AMOUNT_RECIPIENT_MISMATCH');
});

test('verifier detects an AI-invented recipient alias', () => {
  const text = 'Send Mum S$200.';
  const compiled = compileEnvelope(text);
  const fake = [
    { action: 'transfer', recipientAlias: 'attacker', sourceAccountId: 'spending', amountCents: 20000, currency: 'SGD', minimumRemainingCents: 0, requireVerifiedRecipient: true },
  ];
  const result = verifyIntentContract(text, fake, { parsed: compiled.parsed });
  assert.equal(result.ok, false);
  // Either positional or in-text check fires first; both are correct.
  assert.ok(['AMOUNT_RECIPIENT_MISMATCH', 'RECIPIENT_NOT_IN_TEXT'].includes(result.code));
  assert.ok(result.reasons.some((r) => /attacker/.test(r)));
});

test('verifier detects source-account mismatch when user explicitly stated one', () => {
  const text = 'Send Mum S$50 from savings.';
  const compiled = compileEnvelope(text);
  const intents = compiled.intents;
  const aiIntent = { action: 'transfer', recipientAlias: 'Mum', sourceAccountId: 'spending', amountCents: 5000, currency: 'SGD', minimumRemainingCents: 0, requireVerifiedRecipient: true };
  // The compiler overrode sourceAccountId to 'savings', so align it.
  intents.forEach((i) => { i.sourceAccountId = aiIntent.sourceAccountId; }); // simulate AI overriding back
  const result = verifyIntentContract(text, intents, { parsed: compiled.parsed, aiIntent });
  assert.equal(result.ok, false);
  // Two possible codes; first one wins.
  assert.ok(['SOURCE_ACCOUNT_MISMATCH', 'AMOUNT_RECIPIENT_MISMATCH'].includes(result.code));
});

test('verifier refuses AI source override with no user mention', () => {
  const text = 'Send Mum S$50.';
  const compiled = compileEnvelope(text);
  const aiIntent = { action: 'transfer', recipientAlias: 'Mum', sourceAccountId: 'wallet', amountCents: 5000, currency: 'SGD', minimumRemainingCents: 0, requireVerifiedRecipient: false };
  const result = verifyIntentContract(text, compiled.intents, { parsed: compiled.parsed, aiIntent });
  assert.equal(result.ok, false);
  assert.ok(result.reasons.some((r) => r.includes('Source account')));
});

test('verifier refuses verification downgrade without an explicit release phrase', () => {
  const text = 'Send Mum S$50.';
  const compiled = compileEnvelope(text);
  const aiIntent = { action: 'transfer', recipientAlias: 'Mum', sourceAccountId: 'spending', amountCents: 5000, currency: 'SGD', minimumRemainingCents: 0, requireVerifiedRecipient: false };
  const result = verifyIntentContract(text, compiled.intents, { parsed: compiled.parsed, aiIntent });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'VERIFICATION_DOWNGRADE');
});

test('verifier rejects verification downgrade even with an explicit release phrase', () => {
  const text = 'Send anyone S$50, any account is fine, do not verify.';
  const compiled = compileEnvelope(text);
  const aiIntent = { action: 'transfer', recipientAlias: 'anyone', sourceAccountId: 'spending', amountCents: 5000, currency: 'SGD', minimumRemainingCents: 0, requireVerifiedRecipient: false };
  const result = verifyIntentContract(text, compiled.intents, { parsed: compiled.parsed, aiIntent });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'VERIFICATION_DOWNGRADE');
});

test('verifier keeps SEMANTIC_MISMATCH for original set-mismatch case (backward compat)', () => {
  const text = 'Send Mum S$200.';
  const result = verifyIntentContract(text, [
    { action: 'transfer', recipientAlias: 'Mum', sourceAccountId: 'spending', amountCents: 25000, currency: 'SGD' },
  ]);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'SEMANTIC_MISMATCH');
});
