const test = require('node:test');
const assert = require('node:assert/strict');
const { MockBank } = require('../src/payment-core');

const accounts = { spending: { id: 'spending', displayName: 'Spending Account', balanceCents: 150000 } };
const recipients = [{ id: 'recipient-mum', displayName: 'Mum', aliases: ['mum', 'mother'], verified: true }];
function bank() { return new MockBank({ accounts, recipients }); }
function intent(overrides = {}) { return { action: 'transfer', recipientAlias: 'Mum', sourceAccountId: 'spending', amountCents: 8000, currency: 'SGD', minimumRemainingCents: 50000, ...overrides }; }
function approvedPayment(b, overrides = {}, approvedAt = 1100) { const prepared = b.preparePayment(intent(overrides), 1000); assert.equal(prepared.ok, true); const approved = b.approvePayment(prepared.proposal, 'user-1', approvedAt); assert.equal(approved.ok, true); return approved.approval; }

test('valid payment is approved and executed exactly once', () => {
  const b = bank(); const result = b.executeApproval(approvedPayment(b), 1200); assert.equal(result.ok, true);
  assert.equal(b.accounts.spending.balanceCents, 142000); assert.equal(b.ledger.length, 1);
});
test('minimum-balance violation is blocked before approval', () => {
  const result = bank().preparePayment(intent({ amountCents: 120000 }), 1000);
  assert.equal(result.ok, false); assert.equal(result.code, 'VALIDATION_FAILED'); assert.deepEqual(result.violations, ['MINIMUM_BALANCE']);
});
test('approval is bound to the exact recipient and amount', () => {
  const b = bank(); const approval = approvedPayment(b); approval.proposal.amountCents = 9000;
  const result = b.executeApproval(approval, 1200); assert.equal(result.ok, false); assert.equal(result.code, 'APPROVAL_TAMPERED'); assert.equal(b.ledger.length, 0);
});
test('approval metadata is bound to the approving user', () => {
  const b = bank(); const approval = approvedPayment(b); approval.userId = 'attacker';
  const result = b.executeApproval(approval, 1200); assert.equal(result.ok, false); assert.equal(result.code, 'APPROVAL_TAMPERED'); assert.equal(b.ledger.length, 0);
});
test('approval expires before execution', () => {
  const b = bank(); const approval = approvedPayment(b, { ttlMs: 100 }, 1050);
  const result = b.executeApproval(approval, 1100); assert.equal(result.ok, false); assert.equal(result.code, 'APPROVAL_EXPIRED');
});
test('executed approval cannot be replayed', () => {
  const b = bank(); const approval = approvedPayment(b); assert.equal(b.executeApproval(approval, 1200).ok, true);
  const replay = b.executeApproval(approval, 1300); assert.equal(replay.ok, false); assert.equal(replay.code, 'INVALID_APPROVAL'); assert.equal(b.ledger.length, 1);
});
test('current balance is rechecked after approval', () => {
  const b = bank(); const approval = approvedPayment(b, { amountCents: 80000 });
  b.accounts.spending.balanceCents = 100000;
  const result = b.executeApproval(approval, 1200); assert.equal(result.ok, false); assert.equal(result.code, 'MINIMUM_BALANCE'); assert.equal(b.ledger.length, 0);
});
test('removed source account cannot be used after approval', () => {
  const b = bank(); const approval = approvedPayment(b); delete b.accounts.spending;
  const result = b.executeApproval(approval, 1200); assert.equal(result.ok, false); assert.equal(result.code, 'SOURCE_NOT_FOUND');
});
test('removed recipient cannot be used after approval', () => {
  const b = bank(); const approval = approvedPayment(b); b.recipients.length = 0;
  const result = b.executeApproval(approval, 1200); assert.equal(result.ok, false); assert.equal(result.code, 'RECIPIENT_NOT_FOUND');
});
test('unknown recipient is rejected', () => {
  const result = bank().preparePayment(intent({ recipientAlias: 'new account' })); assert.equal(result.ok, false); assert.equal(result.code, 'RECIPIENT_NOT_FOUND');
});
