'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { loadConfig } = require('../src/config');
const { AdpClient } = require('../src/providers/adp-client');
const { buildBank } = require('../server/seed');
const { AuditLog } = require('../src/audit-log');
const { injectIntentPipeline } = require('../server/intent-pipeline');

function digest(value) { return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex'); }

async function main() {
  const config = loadConfig();
  if (config.INTENTLOCK_MODE !== 'LIVE') throw new Error('Set INTENTLOCK_MODE=LIVE before running npm run verify:adp.');
  const client = new AdpClient({ appKey: config.ADP_APP_KEY, endpoint: config.ADP_ENDPOINT, timeoutMs: config.ADP_TIMEOUT_MS, maxResponseBytes: config.ADP_MAX_RESPONSE_BYTES });
  const pipeline = injectIntentPipeline({ bank: buildBank(), audit: new AuditLog(), env: config, adpClient: client, mode: 'LIVE' });
  const report = { verifiedAt: new Date().toISOString(), mode: 'LIVE', scenarios: [], provider: null };

  const valid = await pipeline.prepare({ message: 'Transfer S$100 to Mum while keeping at least S$500.', userId: 'live-verification-user' });
  report.provider = pipeline.providerStatus();
  report.scenarios.push({ name: 'legitimate', ok: valid.ok, stage: valid.stage, code: valid.code || null, provider: valid.provider || null, requestId: report.provider.lastSuccess?.requestId || null, intentHash: valid.aiIntent ? digest(valid.aiIntent) : null });
  if (!valid.ok || valid.provider !== 'adp' || !report.provider.liveVerified) throw new Error(`Live ADP did not produce a validated intent: ${valid.code || valid.message || 'unknown failure'}`);
  const approval = pipeline.approve({ proposalFingerprint: valid.proposal.fingerprint, userId: 'live-verification-user' });
  const executed = approval.ok ? await pipeline.execute({ approvalId: approval.approval.approvalId, userId: 'live-verification-user' }) : approval;
  report.scenarios[0].approval = approval.ok;
  report.scenarios[0].executed = executed.ok;
  if (!approval.ok || !executed.ok) throw new Error('The legitimate live scenario did not complete approval and mock execution.');

  const minimum = await pipeline.prepare({ message: 'Transfer S$1200 to Mum while keeping at least S$500.', userId: 'live-verification-user' });
  report.scenarios.push({ name: 'minimum-balance', ok: !minimum.ok && minimum.code === 'VALIDATION_FAILED', stage: minimum.stage, code: minimum.code || null, provider: minimum.provider || null, intentHash: minimum.aiIntent ? digest(minimum.aiIntent) : null });
  if (minimum.ok || minimum.code !== 'VALIDATION_FAILED') throw new Error('Minimum-balance scenario did not block as expected.');

  const outputPath = path.join(process.cwd(), 'verification', 'adp-live-report.json');
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  console.log(JSON.stringify({ ok: true, reportPath: outputPath, provider: report.provider, scenarios: report.scenarios }, null, 2));
}

main().catch((error) => { console.error(`[verify:adp] ${error.message}`); process.exitCode = 1; });
