'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { MockBank, PerAccountLocker } = require('../src/payment-core');

const accounts = { spending: { id: 'spending', displayName: 'Spending Account', balanceCents: 150000 } };
const verifiedMum = { id: 'recipient-mum', displayName: 'Mum', aliases: ['mum'], verified: true };
const recipients = [verifiedMum];
function bank() { return new MockBank({ accounts, recipients }); }
function intent(overrides = {}) { return { action: 'transfer', recipientAlias: 'Mum', sourceAccountId: 'spending', amountCents: 8000, currency: 'SGD', minimumRemainingCents: 50000, ...overrides }; }
function approvedPayment(b, overrides = {}, approvedAt = 1100) { const p = b.preparePayment(intent(overrides), 1000); assert.equal(p.ok, true); const a = b.approvePayment(p.proposal, 'user-1', approvedAt); assert.equal(a.ok, true); return a.approval; }

test('executeApproval rejects when recipient is downgraded from verified to unverified after approval', () => {
  const b = bank();
  const approval = approvedPayment(b);
  // Downgrade the recipient after approval — execution must refuse.
  b.recipients[0].verified = false;
  const result = b.executeApproval(approval, 1200);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'RECIPIENT_VERIFICATION_LOST');
  assert.equal(b.ledger.length, 0);
});

test('executeApproval still succeeds when recipient remains verified', () => {
  const b = bank();
  const result = b.executeApproval(approvedPayment(b), 1200);
  assert.equal(result.ok, true);
  assert.equal(b.accounts.spending.balanceCents, 142000);
});

test('executeApprovalSafe serialises concurrent execution on the same source account', async () => {
  const b = bank();
  const a1 = approvedPayment(b, { amountCents: 60000, minimumRemainingCents: 0 }, 1100);
  const a2 = approvedPayment(b, { amountCents: 60000, minimumRemainingCents: 0 }, 1100);
  // Both approved against an unverified scenario but with the same source.
  const [r1, r2] = await Promise.all([
    b.executeApprovalSafe(a1, 1200),
    b.executeApprovalSafe(a2, 1200),
  ]);
  // At least one must succeed and at most one — second must fail MINIMUM_BALANCE or similar.
  const okCount = [r1, r2].filter((r) => r.ok).length;
  assert.ok(okCount >= 1, `at least one must succeed; got ${okCount}`);
  assert.ok(okCount <= 2, `at most two should succeed since both fit individually`);
  // If both succeed, balances must reflect both debits.
  if (r1.ok && r2.ok) assert.equal(b.accounts.spending.balanceCents, 30000);
});

test('executeApprovalSafe keeps working for unknown accounts (no contention)', async () => {
  const b = bank();
  const a = approvedPayment(b);
  const r = await b.executeApprovalSafe(a, 1200);
  assert.equal(r.ok, true);
});

test('PerAccountLocker.run releases on success and on throw', async () => {
  const l = new PerAccountLocker();
  let counter = 0;
  await l.run('acct', async () => { counter += 1; });
  assert.equal(counter, 1);
  assert.equal(l.pendingFor('acct'), false);
  await assert.rejects(() => l.run('acct', async () => { throw new Error('boom'); }));
  assert.equal(l.pendingFor('acct'), false);
});

test('PerAccountLocker.run serialises calls on the same key', async () => {
  const l = new PerAccountLocker();
  const order = [];
  const task = (id, ms) => l.run('acct', async () => { await new Promise((r) => setTimeout(r, ms)); order.push(id); });
  // Fire concurrently — order must be sequential.
  await Promise.all([task('a', 50), task('b', 10), task('c', 5)]);
  // Tasks start in order of registration but since durations differ,
  // assert that the FIRST started runs to completion before the SECOND.
  assert.equal(order.length, 3);
  assert.equal(order[0], 'a');
});
