const test = require('node:test');
const assert = require('node:assert/strict');
const { offlineIntent } = require('../src/providers/offline-intent-provider');
const { AdpClient, readSseText } = require('../src/providers/adp-client');
const { createIntentProvider } = require('../src/intent-provider');
const { normalizeCandidate } = require('../src/providers/plan-provider');
const { buildBank } = require('../server/seed');

test('offline provider parses a constrained transfer without network access', () => {
  const result = offlineIntent('Send Mum S$80 and leave at least S$500');
  assert.equal(result.ok, true);
  assert.deepEqual(result.intent, { action: 'transfer', recipientAlias: 'Mum', sourceAccountId: 'spending', amountCents: 8000, currency: 'SGD', minimumRemainingCents: 50000, requireVerifiedRecipient: true });
});

test('offline provider rejects ambiguous requests', () => {
  const result = offlineIntent('Please handle my payment');
  assert.equal(result.ok, false);
  assert.equal(result.code, 'OFFLINE_PARSE_FAILED');
});

test('ADP client parses SSE content without exposing its key', async () => {
  let request;
  const client = new AdpClient({ appKey: 'test-secret-never-returned', endpoint: 'https://example.invalid/adp', fetchImpl: async (url, options) => {
    request = { url, options };
    return { ok: true, status: 200, text: async () => 'event: text.delta\ndata: {"Type":"text.delta","Text":"first"}\n\nevent: text.delta\ndata: {"Type":"text.delta","Text":" second"}\n\nevent: response.completed\ndata: {"Type":"response.completed","Response":{"Status":"success","Messages":[{"Contents":[{"Type":"text","Text":"first second"}]}]}}\n\n' };
  } });
  const result = await client.generateIntent({ message: 'Send Mum S$80', visitorId: 'demo-user' });
  assert.equal(result.ok, true);
  assert.equal(result.text, 'first second');
  assert.equal(JSON.stringify(result).includes('test-secret'), false);
  assert.equal(request.options.headers.Authorization, undefined);
  assert.equal(JSON.parse(request.options.body).AppKey, 'test-secret-never-returned');
});

test('ADP failures return a redacted error', async () => {
  const client = new AdpClient({ appKey: 'private-key', fetchImpl: async () => { throw new Error('private-key leaked in upstream error'); } });
  const result = await client.generateIntent({ message: 'Send Mum S$80' });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'ADP_NETWORK_ERROR');
  assert.equal(JSON.stringify(result).includes('private-key'), false);
});

test('provider fails closed when ADP is unavailable', async () => {
  const provider = createIntentProvider({ adpClient: new AdpClient({ appKey: 'private-key', fetchImpl: async () => { throw new Error('network down'); } }) });
  const result = await provider.interpret('Send Mum S$80 and leave at least S$500');
  assert.equal(result.ok, false);
  assert.equal(result.provider, 'adp');
});

test('plan adapter normalizes the live Planner response shape', () => {
  const result = normalizeCandidate({
    actions: [{ type: 'TRANSFER', fromAccount: 'savings', toRecipient: 'Mum', amount: { value: 100, currency: 'SGD' } }],
    constraints: [{ type: 'minimum_balance', amount: { value: 500, currency: 'SGD' } }],
    clarification: [{ question: 'Which Mum?', required: false }],
    sourceReferences: [{ source: 'customer', reference: 'turn-1' }],
  }, buildBank());
  assert.equal(result.ok, true);
  assert.equal(result.plan.actions[0].type, 'transfer');
  assert.equal(result.plan.actions[0].recipientAlias, 'Mum');
  assert.equal(result.plan.actions[0].amountCents, 10000);
  assert.equal(result.plan.minimumRemainingCents, 50000);
});

test('plan adapter normalizes the independent live Guardian response shape', () => {
  const result = normalizeCandidate({
    transactions: [{ fromAccount: 'savings', recipient: 'Mum', amount: 100, currency: 'SGD', postTransactionBalanceCheck: { minimum: 500 } }],
  }, buildBank());
  assert.equal(result.ok, true);
  assert.equal(result.plan.actions[0].type, 'transfer');
  assert.equal(result.plan.actions[0].recipientAlias, 'Mum');
  assert.equal(result.plan.actions[0].amountCents, 10000);
});
