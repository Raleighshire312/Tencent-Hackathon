'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { PersistentStore } = require('../src/persistent-store');
const { buildBank } = require('../server/seed');
const { assessPlan } = require('../src/risk-policy');

test('persistent store restores a visitor bank and idempotent result', () => {
  const store = new PersistentStore({ filename: ':memory:' }); const bank = buildBank(); bank.accounts.savings.balanceCents = 1234;
  store.saveSession('s1', bank); assert.equal(store.bankSnapshot('s1').accounts.savings.balanceCents, 1234);
  store.saveExecution('idem', 's1', 'p1', { ok: true, entries: [] }); assert.deepEqual(store.getExecution('idem'), { ok: true, entries: [] }); store.close();
});

test('risk policy requires separate approval for consequential debits', () => {
  const result = assessPlan({ actions: [{ amountCents: 200001 }] }, { ledger: [] }); assert.equal(result.ok, true); assert.equal(result.secondaryRequired, true);
});
