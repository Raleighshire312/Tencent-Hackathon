'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseDotEnv, loadConfig } = require('../src/config');
const { parseSseTranscript } = require('../src/providers/adp-client');
const { buildBank } = require('../server/seed');
const { AuditLog } = require('../src/audit-log');
const { injectIntentPipeline } = require('../server/intent-pipeline');
const { AdpClient } = require('../src/providers/adp-client');

test('configuration parses .env values while caller environment remains authoritative', () => {
  assert.deepEqual(parseDotEnv('A=one\nB="two"\n# ignored\n'), { A: 'one', B: 'two' });
  const config = loadConfig({ cwd: '/tmp/intentlock-no-env', env: { INTENTLOCK_MODE: 'OFFLINE_DEMO', ADP_TIMEOUT_MS: '5000', ADP_MAX_RESPONSE_BYTES: '4096' } });
  assert.equal(config.INTENTLOCK_MODE, 'OFFLINE_DEMO');
  assert.equal(config.ADP_TIMEOUT_MS, 5000);
});

test('SSE parser handles delta, replacement, completion, and provider errors', () => {
  const ok = parseSseTranscript('event: text.delta\ndata: {"Type":"text.delta","Text":"old"}\n\nevent: text.replace\ndata: {"Type":"text.replace","Text":"new"}\n\nevent: response.completed\ndata: {"Type":"response.completed","Response":{"Status":"success","ExtraInfo":{"RequestId":"req-1"}}}\n\n');
  assert.equal(ok.text, 'new'); assert.equal(ok.completed, true); assert.equal(ok.requestId, 'req-1');
  const bad = parseSseTranscript('event: error\ndata: {"Type":"error","Error":{"Message":"private failure"}}\n\n');
  assert.equal(bad.error, 'private failure'); assert.equal(bad.completed, false);
});

function responseFor(intent) {
  const text = JSON.stringify(intent);
  return `event: text.replace\ndata: ${JSON.stringify({ Type: 'text.replace', Text: text })}\n\nevent: response.completed\ndata: ${JSON.stringify({ Type: 'response.completed', Response: { Status: 'success', Messages: [{ Contents: [{ Type: 'text', Text: text }] }] } })}\n\n`;
}

test('pipeline blocks a live AI amount manipulation before preparation', async () => {
  const client = new AdpClient({ appKey: 'test', fetchImpl: async () => ({ ok: true, status: 200, text: async () => responseFor({ action: 'transfer', recipientAlias: 'Mum', sourceAccountId: 'spending', amountCents: 90000, currency: 'SGD', minimumRemainingCents: 0, requireVerifiedRecipient: true }) }) });
  const pipeline = injectIntentPipeline({ bank: buildBank(), audit: new AuditLog(), env: {}, adpClient: client, mode: 'LIVE' });
  const result = await pipeline.prepare({ message: 'Send Mum S$100.', userId: 'test-user' });
  assert.equal(result.ok, false); assert.equal(result.code, 'AI_INTENT_MISMATCH');
});

test('pipeline supports amount-first transfer phrasing and refuses multiple transfers', async () => {
  const single = injectIntentPipeline({ bank: buildBank(), audit: new AuditLog(), env: { INTENTLOCK_MODE: 'OFFLINE_DEMO' }, mode: 'OFFLINE_DEMO' });
  const accepted = await single.prepare({ message: 'Transfer S$100 to Mum while keeping at least S$500.', userId: 'u1' });
  assert.equal(accepted.ok, true);
  const multiple = await single.prepare({ message: 'Send Mum S$100 and pay electricity S$20.', userId: 'u1' });
  assert.equal(multiple.ok, false); assert.equal(multiple.code, 'MULTIPLE_TRANSFER_INTENTS');
});
