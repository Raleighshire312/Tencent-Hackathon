'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { buildBank } = require('../server/seed');
const { parsePlan, calculatePlan, resolvePlan } = require('../src/transaction-plan');
const { AuthorizationStore } = require('../src/authorization');

const flagship = 'From my savings, send Mum five hundred, pay my electricity bill, and buy DBS shares with half of what remains after those payments. Keep at least two thousand in savings.';

test('flagship request creates a three-action dependent plan', () => {
  const bank = buildBank(); const result = calculatePlan(parsePlan(flagship, bank), bank);
  assert.equal(result.state, 'ready_for_approval');
  assert.deepEqual(result.actions.map((a) => a.type), ['transfer', 'bill_payment', 'stock_purchase']);
  assert.equal(result.actions[2].quantity, 122);
  assert.equal(result.projectedBalanceCents, 446200);
});

test('ambiguous beneficiary becomes a clarification instead of a guess', () => {
  const bank = buildBank(); const result = parsePlan('Send John S$100 from savings.', bank);
  assert.equal(result.state, 'awaiting_clarification');
  assert.equal(result.unresolved[0].candidates.length, 2);
  const resolved = resolvePlan(result, 'John Smith ending 8892', bank);
  assert.equal(resolved.state, 'ready_for_approval');
  assert.equal(resolved.actions[0].recipientId, 'recipient-john-smith');
});

test('authorization simulator verifies the exact plan and rejects replay', () => {
  const store = new AuthorizationStore(); const challenge = store.issue({ planId: 'p1', planHash: 'h1', sessionId: 's1' });
  const keys = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' }); const signer = crypto.createSign('SHA256'); signer.update(`${challenge.nonce}.h1.p1`); signer.end();
  const der = signer.sign(keys.privateKey);
  const verified = store.verify({ challengeId: challenge.id, signature: der.toString('base64url'), publicKey: keys.publicKey.export({ type: 'spki', format: 'der' }).toString('base64url'), sessionId: 's1' });
  assert.equal(verified.ok, true);
  const replay = store.verify({ challengeId: challenge.id, signature: der.toString('base64url'), publicKey: keys.publicKey.export({ type: 'spki', format: 'der' }).toString('base64url'), sessionId: 's1' });
  assert.equal(replay.ok, false); assert.equal(replay.code, 'AUTH_CHALLENGE_INVALID');
});
