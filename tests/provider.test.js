const test = require('node:test');
const assert = require('node:assert/strict');
const { offlineIntent } = require('../src/providers/offline-intent-provider');
const { AdpClient, readSseText } = require('../src/providers/adp-client');
const { createIntentProvider } = require('../src/intent-provider');

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
    return { ok: true, status: 200, text: async () => 'data: {"content":"first"}\ndata: {"answer":" second"}\ndata: [DONE]\n' };
  } });
  const result = await client.generateIntent({ message: 'Send Mum S$80', visitorId: 'demo-user' });
  assert.equal(result.ok, true);
  assert.equal(result.text, 'first second');
  assert.equal(JSON.stringify(result).includes('test-secret'), false);
  assert.equal(request.options.headers.Authorization, 'Bearer test-secret-never-returned');
  assert.equal(JSON.stringify(request.options.body).includes('test-secret'), false);
});

test('ADP failures return a redacted error', async () => {
  const client = new AdpClient({ appKey: 'private-key', fetchImpl: async () => { throw new Error('private-key leaked in upstream error'); } });
  const result = await client.generateIntent({ message: 'Send Mum S$80' });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'ADP_REQUEST_FAILED');
  assert.equal(JSON.stringify(result).includes('private-key'), false);
});

test('provider automatically falls back offline when ADP is unavailable', async () => {
  const provider = createIntentProvider({ adpClient: new AdpClient({ appKey: 'private-key', fetchImpl: async () => { throw new Error('network down'); } }) });
  const result = await provider.interpret('Send Mum S$80 and leave at least S$500');
  assert.equal(result.ok, true);
  assert.equal(result.provider, 'offline');
});
